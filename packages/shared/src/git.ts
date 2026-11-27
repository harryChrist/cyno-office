import { z } from "zod";

/**
 * Credenciais e clone de repositórios git pela plataforma.
 * O segredo (token ou chave privada SSH) NUNCA é devolvido pela API: apenas `hasSecret: true`.
 */
export const GIT_CREDENTIAL_KINDS = ["token", "ssh"] as const;
export type GitCredentialKind = (typeof GIT_CREDENTIAL_KINDS)[number];

export const GIT_CLONE_STATUSES = ["running", "done", "error"] as const;
export type GitCloneStatus = (typeof GIT_CLONE_STATUSES)[number];

export const GIT_LIMITS = {
  label: 80,
  host: 253,
  username: 120,
  tokenBytes: 4 * 1024,
  sshKeyBytes: 64 * 1024,
  url: 1024,
  name: 80,
  branch: 120,
  parent: 1024,
  maxCredentials: 100,
} as const;

/** Id de credencial: slug seguro gerado pelo servidor. */
export const GIT_CREDENTIAL_ID_PATTERN = /^[a-z0-9][a-z0-9-]{2,47}$/;
export const gitCredentialIdSchema = z.string().regex(GIT_CREDENTIAL_ID_PATTERN, "Id de credencial inválido.");

/** Id de job de clone gerado pelo servidor. */
export const GIT_CLONE_ID_PATTERN = /^clone-[a-z0-9-]{3,40}$/;
export const gitCloneIdSchema = z.string().regex(GIT_CLONE_ID_PATTERN, "Id de clone inválido.");

/** Hostname simples (sem esquema, porta, barra ou espaços). */
const SIMPLE_HOST_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

/** Normaliza e valida um hostname simples (ex.: `github.com`, `git.empresa.local`). Devolve `null` se inválido. */
export function normalizeGitHost(raw: string): string | null {
  const host = raw.trim().toLowerCase();
  if (!host || host.length > GIT_LIMITS.host) return null;
  return SIMPLE_HOST_PATTERN.test(host) ? host : null;
}

function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.codePointAt(i) ?? 0;
    if (code > 0xffff) i += 1;
    bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
  }
  return bytes;
}

/** Valida um token de acesso (até 4 KB, sem quebras de linha). Devolve mensagem em pt-BR ou `null`. */
export function validateGitToken(raw: string): string | null {
  const token = raw.trim();
  if (!token) return "Informe o token de acesso.";
  if (/[\r\n\0]/.test(token)) return "O token não pode ter quebras de linha.";
  if (utf8ByteLength(token) > GIT_LIMITS.tokenBytes) return "O token pode ter no máximo 4 KB.";
  return null;
}

const SSH_BEGIN_LINE = /^-----BEGIN [A-Z0-9 -]+-----$/;
const SSH_END_LINE = /^-----END [A-Z0-9 -]+-----$/;

/**
 * Valida uma chave privada SSH: começa por `-----BEGIN ... -----`, termina com uma linha
 * `-----END ... -----` e tem conteúdo no meio. Devolve mensagem em pt-BR ou `null`.
 */
export function validateGitSshKey(raw: string): string | null {
  if (raw.includes("\0")) return "A chave SSH contém caracteres inválidos.";
  const normalized = raw.replace(/\r\n?/g, "\n").trim();
  if (!normalized) return "Cole a chave privada SSH.";
  if (utf8ByteLength(normalized) > GIT_LIMITS.sshKeyBytes) return "A chave SSH excede o tamanho máximo permitido.";
  const lines = normalized.split("\n").map((line) => line.trim());
  if (lines.length < 3) return "Chave SSH inválida. Cole a chave completa, de -----BEGIN até -----END.";
  const first = lines[0] ?? "";
  const last = lines[lines.length - 1] ?? "";
  if (!SSH_BEGIN_LINE.test(first)) return "A chave SSH precisa começar com uma linha -----BEGIN ... -----.";
  if (!SSH_END_LINE.test(last)) return "A chave SSH precisa terminar com uma linha -----END ... -----.";
  const body = lines.slice(1, -1).some((line) => line.length > 0);
  if (!body) return "A chave SSH está vazia entre o cabeçalho e o rodapé.";
  return null;
}

/** Credencial como é devolvida pela API (nunca contém o segredo). */
export type GitCredentialView = {
  id: string;
  label: string;
  host: string;
  kind: GitCredentialKind;
  username?: string;
  createdAt: string;
  hasSecret: true;
};

/** Corpo de `POST /api/git/credentials`. */
export const createGitCredentialSchema = z
  .strictObject({
    label: z.string().trim().min(1, "Dê um nome para a credencial.").max(GIT_LIMITS.label, `O nome pode ter até ${GIT_LIMITS.label} caracteres.`),
    host: z.string().trim().min(1, "Informe o host (ex.: github.com).").max(GIT_LIMITS.host),
    kind: z.enum(GIT_CREDENTIAL_KINDS),
    username: z.string().trim().max(GIT_LIMITS.username, `O usuário pode ter até ${GIT_LIMITS.username} caracteres.`).optional(),
    secret: z.string().min(1, "Informe o segredo da credencial."),
  })
  .superRefine((data, ctx) => {
    if (!normalizeGitHost(data.host)) {
      ctx.addIssue({ code: "custom", path: ["host"], message: "Informe apenas o host, sem https://, caminho ou espaços (ex.: github.com)." });
    }
    if (data.username && /[\r\n\0]/.test(data.username)) {
      ctx.addIssue({ code: "custom", path: ["username"], message: "O usuário não pode ter quebras de linha." });
    }
    if (data.kind === "token") {
      const err = validateGitToken(data.secret);
      if (err) ctx.addIssue({ code: "custom", path: ["secret"], message: err });
    } else {
      const err = validateGitSshKey(data.secret);
      if (err) ctx.addIssue({ code: "custom", path: ["secret"], message: err });
    }
  });
export type CreateGitCredentialBody = z.input<typeof createGitCredentialSchema>;

export type GitCredentialsResponse = { credentials: GitCredentialView[] };
export type GitCredentialResponse = { credential: GitCredentialView };

/** Corpo de `POST /api/git/clone`. */
export const gitCloneBodySchema = z.strictObject({
  url: z.string().trim().min(1, "Informe a URL do repositório.").max(GIT_LIMITS.url, "A URL é longa demais."),
  name: z.string().trim().min(1).max(GIT_LIMITS.name, `O nome pode ter até ${GIT_LIMITS.name} caracteres.`).optional(),
  credentialId: gitCredentialIdSchema.optional(),
  branch: z.string().trim().min(1).max(GIT_LIMITS.branch, `A branch pode ter até ${GIT_LIMITS.branch} caracteres.`).optional(),
  parent: z.string().trim().min(1).max(GIT_LIMITS.parent).optional(),
  addToWorkspace: z.string().trim().min(1).max(64).optional(),
});
export type GitCloneBody = z.input<typeof gitCloneBodySchema>;

export type GitCloneResult = {
  path: string;
  folderAdded?: boolean;
  folderWarning?: string;
};

export type GitCloneJob = {
  id: string;
  status: GitCloneStatus;
  url: string;
  name: string;
  startedAt: string;
  finishedAt?: string;
  log: string[];
  progress?: number;
  result?: GitCloneResult;
  error?: string;
};

export type GitCloneJobResponse = { job: GitCloneJob };

export const GIT_CREDENTIALS_PATH = "/api/git/credentials";
export const gitCredentialItemPath = (id: string) => `${GIT_CREDENTIALS_PATH}/${encodeURIComponent(id)}`;
export const GIT_CLONE_PATH = "/api/git/clone";
export const gitCloneJobPath = (id: string) => `${GIT_CLONE_PATH}/${encodeURIComponent(id)}`;
