import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, readFile, realpath, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ACCOUNT_ENGINES,
  ENGINE_ACCOUNT_ID_PATTERN,
  MAX_ACCOUNTS_PER_ENGINE,
  engineAccountSchema,
  isAccountEngine,
  type AccountEngine,
  type EngineAccount,
} from "@cyno/shared";
import type { FastifyBaseLogger } from "fastify";
import { HttpError } from "../../platform/http/errors";
import { writeJsonAtomic } from "../../store/atomic-write";
import { platformPaths } from "../../store/paths";
import { WriteQueue } from "../../store/write-queue";

/**
 * Itens do HOME real ligados (symlink) dentro do HOME isolado do Antigravity (motor `gemini`):
 * mantém configuração do git, binários locais (~/.local/bin) e npm sem expor chaves SSH (`.ssh` NUNCA é ligado).
 */
const GEMINI_HOME_SYMLINKS = [".gitconfig", ".local", ".npmrc"] as const;

type AccountsFile = { version: 1; accounts: EngineAccount[] };

export type EngineAccountStoreOptions = {
  /** HOME real usado como origem dos symlinks do Antigravity (nos testes, sempre uma pasta temporária). */
  realHomeDir?: string;
  now?: () => Date;
  log?: Pick<FastifyBaseLogger, "warn">;
  /** Gerador de sufixo curto aleatório (injetável para testes determinísticos). */
  randomSuffix?: () => string;
};

const defaultSuffix = () => randomBytes(2).toString("hex");

function normalizeLabel(raw: string): string {
  const label = raw.trim();
  if (label.length < 1 || label.length > 40) throw new HttpError(400, "O nome da conta deve ter entre 1 e 40 caracteres.");
  return label;
}

function assertValidEngine(engine: string): AccountEngine {
  if (!isAccountEngine(engine)) throw new HttpError(400, `Motor "${engine}" não aceita contas extras.`);
  return engine;
}

function assertValidAccountId(id: string): string {
  if (!ENGINE_ACCOUNT_ID_PATTERN.test(id)) throw new HttpError(400, "Identificador de conta inválido.");
  return id;
}

/** Gera um slug válido (3..40, [a-z0-9-]) a partir do rótulo; acrescenta sufixo curto aleatório se colidir ou ficar curto. */
function makeAccountId(label: string, taken: ReadonlySet<string>, suffix: () => string): string {
  const base = label
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");

  if (base.length >= 3 && ENGINE_ACCOUNT_ID_PATTERN.test(base) && !taken.has(base)) return base;

  const prefix = (base || "conta").slice(0, 35).replace(/-+$/g, "") || "conta";
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const rawSuffix = suffix().toLowerCase().replace(/[^a-z0-9]/g, "") || defaultSuffix();
    const candidate = `${prefix}-${rawSuffix}`.slice(0, 40).replace(/-+$/g, "");
    if (ENGINE_ACCOUNT_ID_PATTERN.test(candidate) && !taken.has(candidate)) return candidate;
  }
  throw new Error("Não foi possível gerar um identificador único para a conta.");
}

function parseAccountsFile(raw: unknown): EngineAccount[] {
  if (typeof raw !== "object" || raw === null) return [];
  const list = Array.isArray((raw as { accounts?: unknown }).accounts) ? (raw as { accounts: unknown[] }).accounts : [];
  const seen = new Set<string>();
  const accounts: EngineAccount[] = [];
  for (const item of list) {
    const parsed = engineAccountSchema.safeParse(item);
    if (!parsed.success || seen.has(parsed.data.id)) continue;
    seen.add(parsed.data.id);
    accounts.push(parsed.data);
  }
  return accounts;
}

async function existsLstat(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Cadastro das contas extras de motores (Claude Code e Antigravity) e isolamento das pastas de perfil.
 * - Lista em `DATA_DIR/platform/engine-accounts.json` (escrita atômica).
 * - Pastas em `DATA_DIR/platform/engines/<motor>/accounts/<id>/` com modo `0700`.
 * - A conta padrão (a do HOME real) é implícita e não entra aqui.
 */
export class EngineAccountStore {
  private readonly queue = new WriteQueue();
  private readonly file: string;
  private readonly realHomeDir: string;
  private readonly now: () => Date;
  private readonly randomSuffix: () => string;

  private constructor(
    private readonly dataDir: string,
    private accounts: EngineAccount[],
    options: EngineAccountStoreOptions,
  ) {
    this.file = platformPaths(dataDir).engineAccountsFile;
    this.realHomeDir = path.resolve(options.realHomeDir ?? os.homedir());
    this.now = options.now ?? (() => new Date());
    this.randomSuffix = options.randomSuffix ?? defaultSuffix;
  }

  static async open(dataDir: string, options: EngineAccountStoreOptions = {}): Promise<EngineAccountStore> {
    const file = platformPaths(dataDir).engineAccountsFile;
    let accounts: EngineAccount[] = [];
    try {
      accounts = parseAccountsFile(JSON.parse(await readFile(file, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        options.log?.warn({ err: error }, "engine-accounts.json ilegível: começando vazio");
      }
    }
    return new EngineAccountStore(dataDir, accounts, options);
  }

  /** Lista as contas extras (opcionalmente filtradas por motor). Nunca inclui caminhos em disco. */
  list(engine?: AccountEngine): EngineAccount[] {
    const filtered = engine ? this.accounts.filter((account) => account.engine === engine) : this.accounts;
    return filtered.map((account) => ({ ...account }));
  }

  /** Busca uma conta pelo id (cópia), ou `undefined` se não existir. */
  get(id: string): EngineAccount | undefined {
    const found = this.accounts.find((account) => account.id === id);
    return found ? { ...found } : undefined;
  }

  /** Cria uma conta extra, prepara a pasta de perfil (0700) e persiste atomicamente. */
  async create(engine: AccountEngine, rawLabel: string): Promise<EngineAccount> {
    const validEngine = assertValidEngine(engine);
    const label = normalizeLabel(rawLabel);
    const sameEngine = this.accounts.filter((account) => account.engine === validEngine);
    if (sameEngine.length >= MAX_ACCOUNTS_PER_ENGINE) {
      throw new HttpError(409, `Limite de ${MAX_ACCOUNTS_PER_ENGINE} contas por motor atingido.`);
    }
    if (sameEngine.some((account) => account.label.toLowerCase() === label.toLowerCase())) {
      throw new HttpError(409, `Já existe uma conta chamada "${label}" neste motor.`);
    }
    const taken = new Set(this.accounts.map((account) => account.id));
    const account: EngineAccount = {
      id: makeAccountId(label, taken, this.randomSuffix),
      engine: validEngine,
      label,
      createdAt: this.now().toISOString(),
    };
    await this.prepareProfileDir(account);
    this.accounts = [...this.accounts, account];
    try {
      await this.save();
    } catch (error) {
      this.accounts = this.accounts.filter((item) => item.id !== account.id);
      await this.removeProfileDir(account).catch(() => undefined);
      throw error;
    }
    return { ...account };
  }

  /** Renomeia uma conta existente (404 se desconhecida; 409 se o nome já existir no mesmo motor). */
  async rename(id: string, rawLabel: string): Promise<EngineAccount> {
    assertValidAccountId(id);
    const label = normalizeLabel(rawLabel);
    const index = this.accounts.findIndex((account) => account.id === id);
    if (index === -1) throw new HttpError(404, `Conta "${id}" não encontrada.`);
    const current = this.accounts[index]!;
    const duplicate = this.accounts.some(
      (account) => account.engine === current.engine && account.id !== current.id && account.label.toLowerCase() === label.toLowerCase(),
    );
    if (duplicate) throw new HttpError(409, `Já existe uma conta chamada "${label}" neste motor.`);
    const updated: EngineAccount = { ...current, label };
    const previous = this.accounts;
    this.accounts = this.accounts.map((account, i) => (i === index ? updated : account));
    try {
      await this.save();
    } catch (error) {
      this.accounts = previous;
      throw error;
    }
    return { ...updated };
  }

  /** Remove a conta e apaga a pasta de perfil dela (sem nunca seguir symlinks nem tocar o HOME real). */
  async remove(id: string): Promise<EngineAccount> {
    assertValidAccountId(id);
    const index = this.accounts.findIndex((account) => account.id === id);
    if (index === -1) throw new HttpError(404, `Conta "${id}" não encontrada.`);
    const account = this.accounts[index]!;
    await this.removeProfileDir(account);
    const previous = this.accounts;
    this.accounts = this.accounts.filter((item) => item.id !== account.id);
    try {
      await this.save();
    } catch (error) {
      this.accounts = previous;
      throw error;
    }
    return { ...account };
  }

  /** Caminho interno da pasta de perfil da conta (validado contra escape; nunca expor pela API). */
  profileDir(account: Pick<EngineAccount, "id" | "engine">): string {
    const engine = assertValidEngine(account.engine);
    const id = assertValidAccountId(account.id);
    const root = this.accountsRoot(engine);
    const target = path.resolve(root, id);
    if (path.dirname(target) !== root || path.basename(target) !== id) {
      throw new HttpError(400, "Caminho de conta inválido.");
    }
    return target;
  }

  /**
   * Variáveis de ambiente de isolamento para esta conta:
   * - `claude`: `{ CLAUDE_CONFIG_DIR: <pasta do perfil> }`
   * - `gemini`: `{ HOME: <pasta do perfil>/home }`
   */
  profileEnv(account: Pick<EngineAccount, "id" | "engine">): Record<string, string> {
    const dir = this.profileDir(account);
    if (account.engine === "claude") return { CLAUDE_CONFIG_DIR: dir };
    return { HOME: path.join(dir, "home") };
  }

  /** Caminho do `.credentials.json` de uma conta Claude. */
  credentialsFile(account: Pick<EngineAccount, "id" | "engine">): string {
    if (account.engine !== "claude") throw new HttpError(400, "Apenas contas Claude têm arquivo .credentials.json.");
    return path.join(this.profileDir(account), ".credentials.json");
  }

  flush(): Promise<void> {
    return this.queue.idle();
  }

  private accountsRoot(engine: AccountEngine): string {
    if (!(ACCOUNT_ENGINES as readonly string[]).includes(engine)) throw new HttpError(400, `Motor inválido: "${engine}".`);
    return path.resolve(this.dataDir, "platform", "engines", engine, "accounts");
  }

  private async prepareProfileDir(account: EngineAccount): Promise<void> {
    const dir = this.profileDir(account);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
    if (account.engine !== "gemini") return;

    const homeDir = path.join(dir, "home");
    await mkdir(homeDir, { recursive: true, mode: 0o700 });
    await chmod(homeDir, 0o700);

    for (const name of GEMINI_HOME_SYMLINKS) {
      const source = path.join(this.realHomeDir, name);
      if (!(await existsLstat(source))) continue;
      const dest = path.join(homeDir, name);
      try {
        await symlink(source, dest);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
  }

  /** Apaga a pasta do perfil SÓ depois de conferir que ela está dentro de `engines/<motor>/accounts/` e não é symlink para fora. */
  private async removeProfileDir(account: Pick<EngineAccount, "id" | "engine">): Promise<void> {
    const root = this.accountsRoot(account.engine);
    const target = this.profileDir(account);
    let stats;
    try {
      stats = await lstat(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (stats.isSymbolicLink()) {
      throw new HttpError(400, "Recusado remover pasta de perfil que aponta para symlink externo.");
    }
    const [realRoot, realTarget] = await Promise.all([realpath(root), realpath(target)]);
    if (path.dirname(realTarget) !== realRoot || !realTarget.startsWith(`${realRoot}${path.sep}`)) {
      throw new HttpError(400, "Caminho resolvido da conta está fora da pasta permitida.");
    }
    const realHome = await realpath(this.realHomeDir).catch(() => this.realHomeDir);
    if (realTarget === realHome || realHome.startsWith(`${realTarget}${path.sep}`)) {
      throw new HttpError(400, "Recusado remover pasta que alcança o HOME real.");
    }
    // `rm -rf` no Node desfaz symlinks internos sem entrar nem apagar o alvo deles.
    await rm(realTarget, { recursive: true, force: true });
  }

  private async save(): Promise<void> {
    const payload: AccountsFile = { version: 1, accounts: this.accounts.map((account) => ({ ...account })) };
    await this.queue.enqueue(async () => {
      await mkdir(path.dirname(this.file), { recursive: true });
      await writeJsonAtomic(this.file, payload);
    });
  }
}
