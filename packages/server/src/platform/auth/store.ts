import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { writeJsonAtomic } from "../../store/atomic-write";
import { hashPassword, passwordHashSchema, verifyPassword, type PasswordHash } from "./password";
import { generateRecoveryCodes, generateTotpSecret, hashRecoveryCode, normalizeRecoveryCode, otpauthUri, verifyTotp } from "./totp";

/** Sessão deslizante: vale 30 dias desde o último uso. */
export const SESSION_TTL_MS = 30 * 24 * 3_600_000;
/** O `lastSeenAt` só vai para o disco de tempos em tempos (reiniciar não desloga, mas não grava a cada request). */
const PERSIST_SEEN_EVERY_MS = 10 * 60_000;

/** Segundo fator (TOTP). O segredo precisa ficar legível para o server: por isso o auth.json é 0600. */
const totpSchema = z.object({
  secret: z.string().min(16),
  /** Último passo de 30 s aceito: o mesmo código não vale duas vezes. */
  lastStep: z.number().int(),
  /** sha256 dos códigos de recuperação que ainda não foram usados. */
  recovery: z.array(z.string().length(64)),
  enabledAt: z.string(),
});

const authFileSchema = z.object({
  version: z.literal(1),
  /** Muda a cada senha nova: as sessões de outra senha deixam de valer. */
  passwordId: z.string().min(1),
  password: passwordHashSchema,
  updatedAt: z.string(),
  totp: totpSchema.optional(),
});
type AuthFile = z.infer<typeof authFileSchema>;

const sessionSchema = z.object({
  /** sha256 do token (o token em si só existe no cookie). */
  tokenHash: z.string().length(64),
  passwordId: z.string(),
  createdAt: z.string(),
  lastSeenAt: z.string(),
  userAgent: z.string(),
});
type Session = z.infer<typeof sessionSchema>;
const sessionsFileSchema = z.object({ version: z.literal(1), sessions: z.array(sessionSchema) });

export const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/** Rótulo curto do aparelho (ex.: "Chrome · Linux"), sem guardar o user-agent inteiro. */
export function userAgentLabel(raw: string | undefined): string {
  const ua = raw ?? "";
  const browser = /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Navegador";
  const os = /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Windows/.test(ua) ? "Windows" : /Mac OS X/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : "";
  return (os ? `${browser} · ${os}` : browser).slice(0, 40);
}

/** Lê o auth.json (null se não existe ou está ilegível). */
export async function readAuthFile(dataDir: string): Promise<AuthFile | null> {
  try {
    return authFileSchema.parse(JSON.parse(await readFile(path.join(dataDir, "auth.json"), "utf8")));
  } catch {
    return null;
  }
}

/**
 * Grava DATA_DIR/auth.json (0600) com um passwordId novo: as sessões antigas deixam de valer. Usado pelo
 * CLI, pela configuração inicial e pela troca de senha. O segundo fator (TOTP), se houver, continua.
 */
export async function writeAuthFile(dataDir: string, password: string, now: Date = new Date(), params?: PasswordHash["params"]): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  const existing = await readAuthFile(dataDir);
  const file: AuthFile = { version: 1, passwordId: randomUUID(), password: await hashPassword(password, params), updatedAt: now.toISOString(), ...(existing?.totp ? { totp: existing.totp } : {}) };
  await writeJsonAtomic(path.join(dataDir, "auth.json"), file, 0o600);
}

/** CLI de emergência: desliga o segundo fator (quem perdeu o celular). Devolve false se não havia 2FA. */
export async function resetTotp(dataDir: string): Promise<boolean> {
  const existing = await readAuthFile(dataDir);
  if (!existing?.totp) return false;
  const { totp: _removed, ...rest } = existing;
  await writeJsonAtomic(path.join(dataDir, "auth.json"), rest, 0o600);
  return true;
}

const TWO_FACTOR_TOKEN_TTL_MS = 5 * 60_000;
const TWO_FACTOR_TOKEN_ATTEMPTS = 5;
const TOTP_SETUP_TTL_MS = 15 * 60_000;

/**
 * Senha de acesso e sessões. `DATA_DIR/auth.json` (hash scrypt, gravado pelo CLI `auth:set-password`)
 * é relido quando o arquivo muda (mtime/tamanho), então trocar ou limpar a senha vale sem reiniciar.
 * As sessões ficam em `DATA_DIR/auth-sessions.json` (só o hash do token).
 */
export class AuthStore {
  private readonly authFile: string;
  private readonly sessionsFile: string;
  private cachedStamp = "";
  private cached: { passwordId: string; password: PasswordHash; totp: AuthFile["totp"] } | null = null;
  private lock: Promise<unknown> = Promise.resolve();
  private pendingTotp: { secret: string; expires: number } | null = null;
  private readonly twoFactorTokens = new Map<string, { ip: string; expires: number; attempts: number; passwordId: string }>();
  private sessions = new Map<string, Session>();
  private sessionsLoaded = false;
  private lastPersistedSeen = new Map<string, number>();
  private writing: Promise<void> = Promise.resolve();

  constructor(
    dataDir: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.authFile = path.join(dataDir, "auth.json");
    this.sessionsFile = path.join(dataDir, "auth-sessions.json");
  }

  /** O hash atual (null = sem senha: o app fica aberto). */
  async current(): Promise<{ passwordId: string; password: PasswordHash; totp: AuthFile["totp"] } | null> {
    let stamp: string;
    try {
      const info = await stat(this.authFile);
      stamp = `${info.mtimeMs}:${info.size}`;
    } catch {
      this.cachedStamp = "";
      this.cached = null;
      return null;
    }
    if (stamp !== this.cachedStamp) {
      try {
        const parsed = authFileSchema.parse(JSON.parse(await readFile(this.authFile, "utf8")));
        this.cached = { passwordId: parsed.passwordId, password: parsed.password, totp: parsed.totp };
      } catch {
        // Existe mas está ilegível: falha fechada (ninguém entra) em vez de abrir o app.
        this.cached = { passwordId: "invalid", password: { algo: "scrypt", params: { N: 1024, r: 8, p: 1, keylen: 16 }, salt: "AA==", hash: "AA==" }, totp: undefined };
      }
      this.cachedStamp = stamp;
    }
    return this.cached;
  }

  async enabled(): Promise<boolean> {
    return (await this.current()) !== null;
  }

  async checkPassword(password: string): Promise<boolean> {
    const current = await this.current();
    return current ? verifyPassword(password, current.password) : false;
  }

  /** Troca a senha (UI) ou cria a primeira (configuração inicial): grava o hash novo e invalida todas as sessões. O 2FA continua. */
  async setPassword(password: string): Promise<void> {
    await this.locked(() => writeAuthFile(path.dirname(this.authFile), password, this.now()));
    this.cachedStamp = "";
    await this.clearSessions();
  }

  /** Serializa as escritas no auth.json (último passo do TOTP, códigos de recuperação, senha). */
  private locked<T>(work: () => Promise<T>): Promise<T> {
    const run = this.lock.then(work, work);
    this.lock = run.catch(() => undefined);
    return run;
  }

  private async mutateFile(change: (file: AuthFile) => AuthFile): Promise<void> {
    const dir = path.dirname(this.authFile);
    const file = await readAuthFile(dir);
    if (!file) throw new Error("sem senha definida");
    await writeJsonAtomic(this.authFile, change(file), 0o600);
    this.cachedStamp = "";
  }

  // ---- Segundo fator (TOTP) ----

  async twoFactorEnabled(): Promise<boolean> {
    return Boolean((await this.current())?.totp);
  }

  async recoveryRemaining(): Promise<number> {
    return (await this.current())?.totp?.recovery.length ?? 0;
  }

  /** Começa a ativação: gera o segredo (só em memória até confirmar um código). */
  async beginTotpSetup(): Promise<{ secret: string; uri: string }> {
    const secret = generateTotpSecret();
    this.pendingTotp = { secret, expires: this.now().getTime() + TOTP_SETUP_TTL_MS };
    return { secret, uri: otpauthUri(secret) };
  }

  /** Confirma com um código válido: grava o segredo e devolve os códigos de recuperação (só aqui, em texto). null = código errado. */
  async confirmTotpSetup(code: string): Promise<string[] | null> {
    const pending = this.pendingTotp;
    const now = this.now().getTime();
    if (!pending || pending.expires < now) return null;
    const step = verifyTotp(pending.secret, code, now);
    if (step === null) return null;
    const recoveryCodes = generateRecoveryCodes();
    await this.locked(() =>
      this.mutateFile((file) => ({ ...file, totp: { secret: pending.secret, lastStep: step, recovery: recoveryCodes.map(hashRecoveryCode), enabledAt: new Date(now).toISOString() } })),
    );
    this.pendingTotp = null;
    return recoveryCodes;
  }

  /** Confere o código do app (uma vez só por passo) ou um código de recuperação (uso único). */
  async verifySecondFactor(input: string): Promise<"totp" | "recovery" | null> {
    return this.locked(async () => {
      const file = await readAuthFile(path.dirname(this.authFile));
      const totp = file?.totp;
      if (!file || !totp) return null;
      const now = this.now().getTime();
      const step = verifyTotp(totp.secret, input, now, totp.lastStep);
      if (step !== null) {
        await this.mutateFile((current) => ({ ...current, totp: current.totp && { ...current.totp, lastStep: step } }));
        return "totp" as const;
      }
      const normalized = normalizeRecoveryCode(input);
      if (normalized.length !== 10) return null;
      const hash = hashRecoveryCode(normalized);
      if (!totp.recovery.includes(hash)) return null;
      await this.mutateFile((current) => ({ ...current, totp: current.totp && { ...current.totp, recovery: current.totp.recovery.filter((item) => item !== hash) } }));
      return "recovery" as const;
    });
  }

  async disableTotp(): Promise<void> {
    await this.locked(() => this.mutateFile(({ totp: _removed, ...rest }) => rest));
    this.pendingTotp = null;
  }

  /** Token curto (5 min) do segundo passo do login: não é uma sessão. */
  issueTwoFactorToken(ip: string): string {
    const now = this.now().getTime();
    for (const [hash, entry] of this.twoFactorTokens) if (entry.expires < now) this.twoFactorTokens.delete(hash);
    if (this.twoFactorTokens.size > 1000) this.twoFactorTokens.clear();
    const token = randomBytes(24).toString("base64url");
    const passwordId = this.cached?.passwordId ?? "";
    this.twoFactorTokens.set(sha256(token), { ip, expires: now + TWO_FACTOR_TOKEN_TTL_MS, attempts: 0, passwordId });
    return token;
  }

  /** O token vale (não expirou, é do mesmo IP e da senha atual)? */
  checkTwoFactorToken(token: string, ip: string): boolean {
    const entry = this.twoFactorTokens.get(sha256(token));
    if (!entry) return false;
    if (entry.expires < this.now().getTime() || entry.ip !== ip || entry.passwordId !== (this.cached?.passwordId ?? "")) {
      this.twoFactorTokens.delete(sha256(token));
      return false;
    }
    return true;
  }

  /** Código errado: depois de 5 o token morre (precisa digitar a senha de novo). */
  twoFactorTokenFailed(token: string): void {
    const hash = sha256(token);
    const entry = this.twoFactorTokens.get(hash);
    if (!entry) return;
    entry.attempts++;
    if (entry.attempts >= TWO_FACTOR_TOKEN_ATTEMPTS) this.twoFactorTokens.delete(hash);
  }

  consumeTwoFactorToken(token: string): void {
    this.twoFactorTokens.delete(sha256(token));
  }

  private async load(): Promise<void> {
    if (this.sessionsLoaded) return;
    this.sessionsLoaded = true;
    try {
      const parsed = sessionsFileSchema.parse(JSON.parse(await readFile(this.sessionsFile, "utf8")));
      this.sessions = new Map(parsed.sessions.map((session) => [session.tokenHash, session]));
    } catch {
      this.sessions = new Map();
    }
  }

  private persist(): Promise<void> {
    const data = { version: 1, sessions: [...this.sessions.values()] };
    this.writing = this.writing.then(async () => {
      await mkdir(path.dirname(this.sessionsFile), { recursive: true });
      await writeJsonAtomic(this.sessionsFile, data, 0o600);
    });
    return this.writing.catch(() => undefined);
  }

  /** Cria a sessão e devolve o token (vai para o cookie, nunca para o disco). */
  async createSession(userAgent: string | undefined): Promise<string> {
    await this.load();
    const current = await this.current();
    if (!current) throw new Error("sem senha definida");
    this.prune();
    const token = randomBytes(32).toString("base64url");
    const stamp = this.now().toISOString();
    const tokenHash = sha256(token);
    this.sessions.set(tokenHash, { tokenHash, passwordId: current.passwordId, createdAt: stamp, lastSeenAt: stamp, userAgent: userAgentLabel(userAgent) });
    await this.persist();
    return token;
  }

  /** A sessão do token vale? (senha atual, dentro dos 30 dias.) Renova o prazo. */
  async validate(token: string | undefined): Promise<boolean> {
    if (!token) return false;
    await this.load();
    const current = await this.current();
    if (!current) return false;
    const hash = sha256(token);
    const session = this.sessions.get(hash);
    if (!session) return false;
    const now = this.now().getTime();
    if (session.passwordId !== current.passwordId || now - Date.parse(session.lastSeenAt) > SESSION_TTL_MS) {
      this.sessions.delete(hash);
      void this.persist();
      return false;
    }
    session.lastSeenAt = new Date(now).toISOString();
    if (now - (this.lastPersistedSeen.get(hash) ?? 0) > PERSIST_SEEN_EVERY_MS) {
      this.lastPersistedSeen.set(hash, now);
      void this.persist();
    }
    return true;
  }

  async revoke(token: string | undefined): Promise<void> {
    if (!token) return;
    await this.load();
    if (this.sessions.delete(sha256(token))) await this.persist();
  }

  async clearSessions(): Promise<void> {
    await this.load();
    this.sessions.clear();
    this.lastPersistedSeen.clear();
    await this.persist();
  }

  private prune(): void {
    const now = this.now().getTime();
    for (const [hash, session] of this.sessions) if (now - Date.parse(session.lastSeenAt) > SESSION_TTL_MS) this.sessions.delete(hash);
  }

  /** Espera as gravações pendentes (fechar o app, testes). */
  flush(): Promise<void> {
    return this.writing.catch(() => undefined);
  }
}
