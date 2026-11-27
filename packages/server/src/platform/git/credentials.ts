import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  GIT_CREDENTIAL_ID_PATTERN,
  GIT_LIMITS,
  normalizeGitHost,
  validateGitSshKey,
  validateGitToken,
  type CreateGitCredentialBody,
  type GitCredentialKind,
  type GitCredentialView,
} from "@cyno/shared";
import { HttpError } from "../http/errors";
import { isPathInside, isWindows } from "../os";

/** Registro salvo em `credentials.json` (nunca contém o segredo). */
export type GitCredentialRecord = {
  id: string;
  label: string;
  host: string;
  kind: GitCredentialKind;
  username?: string;
  createdAt: string;
};

type CredentialsFile = {
  version: 1;
  credentials: GitCredentialRecord[];
};

export type GitCredentialStoreOptions = {
  now?: () => Date;
  platform?: NodeJS.Platform;
};

/** Aplica `chmod` no Linux/macOS; ignora no Windows ou se o sistema de arquivos não suportar. */
export async function safeChmod(target: string, mode: number, platform: NodeJS.Platform = process.platform): Promise<void> {
  if (isWindows(platform)) return;
  try {
    await chmod(target, mode);
  } catch {
    // sistemas sem permissão POSIX (ex.: Windows/NTFS ou montagens especiais)
  }
}

function makeCredentialId(label: string, taken: ReadonlySet<string>): string {
  const slug =
    label
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 28) || "cred";
  for (;;) {
    const id = `${slug}-${randomBytes(4).toString("hex")}`;
    if (GIT_CREDENTIAL_ID_PATTERN.test(id) && !taken.has(id)) return id;
  }
}

function toView(record: GitCredentialRecord): GitCredentialView {
  return {
    id: record.id,
    label: record.label,
    host: record.host,
    kind: record.kind,
    ...(record.username ? { username: record.username } : {}),
    createdAt: record.createdAt,
    hasSecret: true,
  };
}

function isValidRecord(value: unknown): value is GitCredentialRecord {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.id === "string" &&
    GIT_CREDENTIAL_ID_PATTERN.test(item.id) &&
    typeof item.label === "string" &&
    item.label.length > 0 &&
    typeof item.host === "string" &&
    item.host.length > 0 &&
    (item.kind === "token" || item.kind === "ssh") &&
    typeof item.createdAt === "string" &&
    (item.username === undefined || typeof item.username === "string")
  );
}

/**
 * Cofre de credenciais do git:
 * - Metadados em `<DATA_DIR>/platform/git/credentials.json` (0600);
 * - Segredos (token ou chave privada SSH) em arquivos separados `<DATA_DIR>/platform/git/secrets/<id>` (0600);
 * - O segredo nunca aparece em `list()`, `get()`, `create()`, logs ou mensagens de erro.
 */
export class GitCredentialStore {
  readonly gitDir: string;
  readonly indexFile: string;
  readonly secretsDir: string;
  private records: GitCredentialRecord[];
  private writeChain: Promise<void> = Promise.resolve();
  private readonly now: () => Date;
  private readonly platform: NodeJS.Platform;

  private constructor(dataDir: string, records: GitCredentialRecord[], options: GitCredentialStoreOptions) {
    this.gitDir = path.join(dataDir, "platform", "git");
    this.indexFile = path.join(this.gitDir, "credentials.json");
    this.secretsDir = path.join(this.gitDir, "secrets");
    this.records = records;
    this.now = options.now ?? (() => new Date());
    this.platform = options.platform ?? process.platform;
  }

  static async open(dataDir: string, options: GitCredentialStoreOptions = {}): Promise<GitCredentialStore> {
    const indexFile = path.join(dataDir, "platform", "git", "credentials.json");
    let records: GitCredentialRecord[] = [];
    try {
      const raw = await readFile(indexFile, "utf8");
      const parsed = JSON.parse(raw) as Partial<CredentialsFile> | unknown[];
      const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.credentials) ? parsed.credentials : [];
      records = list.filter(isValidRecord).map((item) => ({
        id: item.id,
        label: item.label,
        host: item.host,
        kind: item.kind,
        ...(item.username ? { username: item.username } : {}),
        createdAt: item.createdAt,
      }));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        records = [];
      }
    }
    return new GitCredentialStore(dataDir, records, options);
  }

  /** Lista as credenciais cadastradas (sempre com `hasSecret: true`, nunca o segredo). */
  list(): GitCredentialView[] {
    return this.records.map(toView);
  }

  /** Metadados de uma credencial (sem o segredo). */
  get(id: string): GitCredentialView | undefined {
    const found = this.records.find((item) => item.id === id);
    return found ? toView(found) : undefined;
  }

  /** Cadastra uma nova credencial validando host, token (até 4 KB) ou chave SSH. */
  async create(input: CreateGitCredentialBody): Promise<GitCredentialView> {
    const label = input.label.trim();
    if (!label || label.length > GIT_LIMITS.label) {
      throw new HttpError(400, "Dê um nome válido para a credencial.");
    }
    const host = normalizeGitHost(input.host);
    if (!host) {
      throw new HttpError(400, "Host inválido. Informe apenas o hostname (ex.: github.com).");
    }
    if (input.kind !== "token" && input.kind !== "ssh") {
      throw new HttpError(400, "Tipo de credencial inválido.");
    }
    const username = input.kind === "token" ? input.username?.trim() || undefined : undefined;
    if (username && (username.length > GIT_LIMITS.username || /[\r\n\0]/.test(username))) {
      throw new HttpError(400, "Usuário inválido.");
    }

    let secretToStore: string;
    if (input.kind === "token") {
      const err = validateGitToken(input.secret);
      if (err) throw new HttpError(400, err);
      secretToStore = input.secret.trim();
    } else {
      const err = validateGitSshKey(input.secret);
      if (err) throw new HttpError(400, err);
      // OpenSSH exige quebra de linha final no arquivo de chave privada.
      secretToStore = `${input.secret.replace(/\r\n?/g, "\n").trim()}\n`;
    }

    return this.enqueue(async () => {
      if (this.records.length >= GIT_LIMITS.maxCredentials) {
        throw new HttpError(409, `Limite de ${GIT_LIMITS.maxCredentials} credenciais atingido. Remova alguma antes de cadastrar outra.`);
      }
      const taken = new Set(this.records.map((item) => item.id));
      const id = makeCredentialId(label, taken);
      const record: GitCredentialRecord = {
        id,
        label,
        host,
        kind: input.kind,
        ...(username ? { username } : {}),
        createdAt: this.now().toISOString(),
      };
      const secretFile = this.secretFilePath(id);
      await this.ensureDirs();
      await this.writeFileSecure(secretFile, secretToStore);
      const next = [...this.records, record];
      try {
        await this.persistIndex(next);
      } catch (error) {
        await rm(secretFile, { force: true }).catch(() => undefined);
        throw error;
      }
      this.records = next;
      return toView(record);
    });
  }

  /** Remove a credencial e apaga o arquivo do segredo. */
  async remove(id: string): Promise<GitCredentialView> {
    if (!GIT_CREDENTIAL_ID_PATTERN.test(id)) {
      throw new HttpError(404, "Credencial não encontrada.");
    }
    return this.enqueue(async () => {
      const existing = this.records.find((item) => item.id === id);
      if (!existing) throw new HttpError(404, "Credencial não encontrada.");
      const next = this.records.filter((item) => item.id !== id);
      await this.persistIndex(next);
      this.records = next;
      await rm(this.secretFilePath(id), { force: true }).catch(() => undefined);
      return toView(existing);
    });
  }

  /**
   * Uso interno do servidor (apenas para `clone.ts`): lê o segredo de uma credencial.
   * Nunca exponha o resultado deste método em rotas HTTP, logs ou Atividade.
   */
  async readSecret(id: string): Promise<{ credential: GitCredentialView; secret: string }> {
    if (!GIT_CREDENTIAL_ID_PATTERN.test(id)) {
      throw new HttpError(404, "Credencial não encontrada.");
    }
    const found = this.records.find((item) => item.id === id);
    if (!found) throw new HttpError(404, "Credencial não encontrada.");
    const secretFile = this.secretFilePath(id);
    try {
      const secret = await readFile(secretFile, "utf8");
      if (!secret) throw new HttpError(404, "O segredo desta credencial não foi encontrado. Cadastre novamente.");
      return { credential: toView(found), secret };
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(404, "O segredo desta credencial não foi encontrado. Cadastre novamente.");
    }
  }

  /** Espera gravações pendentes (shutdown e testes). */
  flush(): Promise<void> {
    return this.writeChain;
  }

  private secretFilePath(id: string): string {
    if (!GIT_CREDENTIAL_ID_PATTERN.test(id)) throw new HttpError(400, "Id de credencial inválido.");
    const resolved = path.resolve(this.secretsDir, id);
    if (!isPathInside(resolved, this.secretsDir, { strict: true, platform: this.platform })) {
      throw new HttpError(400, "Id de credencial inválido.");
    }
    return resolved;
  }

  private async ensureDirs(): Promise<void> {
    await mkdir(this.gitDir, { recursive: true, mode: 0o700 });
    await safeChmod(this.gitDir, 0o700, this.platform);
    await mkdir(this.secretsDir, { recursive: true, mode: 0o700 });
    await safeChmod(this.secretsDir, 0o700, this.platform);
  }

  private async writeFileSecure(target: string, content: string): Promise<void> {
    const tmp = `${target}.tmp-${randomBytes(4).toString("hex")}`;
    await writeFile(tmp, content, { mode: 0o600, encoding: "utf8" });
    await safeChmod(tmp, 0o600, this.platform);
    await rename(tmp, target);
    await safeChmod(target, 0o600, this.platform);
  }

  private async persistIndex(records: GitCredentialRecord[]): Promise<void> {
    await this.ensureDirs();
    const payload: CredentialsFile = { version: 1, credentials: records };
    await this.writeFileSecure(this.indexFile, `${JSON.stringify(payload, null, 2)}\n`);
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.writeChain.then(task, task);
    this.writeChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}
