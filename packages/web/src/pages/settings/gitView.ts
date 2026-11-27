import {
  GIT_LIMITS,
  normalizeGitHost,
  validateGitSshKey,
  validateGitToken,
  type GitCloneJob,
  type GitCredentialKind,
  type GitCredentialView,
} from "@cyno/shared";

const SCP_SSH = /^([a-zA-Z0-9._-]+)@([a-zA-Z0-9.-]+):([^\s]+)$/;
const UNSAFE_NAME = /[,*?[\]{}()\r\n]/;

function hasControlChar(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** Validação local da URL do repositório (espelha a validação do servidor, em pt-BR). */
export function validateCloneUrlClient(raw: string): string | null {
  const url = raw.trim();
  if (!url) return "Informe a URL do repositório.";
  if (url.length > GIT_LIMITS.url) return "A URL é longa demais.";
  if (url.startsWith("-")) return "URL inválida. A URL não pode começar com hífen.";
  const lower = url.toLowerCase();
  if (lower.startsWith("file://") || lower.startsWith("ext::")) {
    return "URL inválida. Protocolos file:// e ext:: não são permitidos.";
  }
  if (/\s/.test(url) || hasControlChar(url)) return "URL inválida. A URL não pode conter espaços.";
  if (lower.startsWith("https://")) {
    try {
      const parsed = new URL(url);
      if (parsed.username || parsed.password) {
        return "Não coloque usuário ou token na URL. Use uma credencial salva.";
      }
      if (!normalizeGitHost(parsed.hostname)) return "URL inválida. Confira o endereço do servidor.";
      if (!parsed.pathname.replace(/^\/+|\/+$/g, "")) return "URL inválida. Informe o caminho do repositório.";
      return null;
    } catch {
      return "URL inválida. Confira o endereço https:// do repositório.";
    }
  }
  if (lower.startsWith("ssh://")) {
    try {
      const parsed = new URL(url);
      if (parsed.password) return "Não coloque senha na URL SSH. Use uma chave SSH salva.";
      if (!normalizeGitHost(parsed.hostname)) return "URL inválida. Confira o host SSH.";
      if (!parsed.pathname.replace(/^\/+|\/+$/g, "")) return "URL inválida. Informe o caminho do repositório.";
      return null;
    } catch {
      return "URL inválida. Confira o endereço ssh:// do repositório.";
    }
  }
  const scp = SCP_SSH.exec(url);
  if (scp && !url.includes("://")) {
    const [, user, rawHost, repoPath] = scp;
    if (!user || user.startsWith("-") || !normalizeGitHost(rawHost ?? "") || !repoPath || repoPath.startsWith("-")) {
      return "URL inválida. Use o formato git@host:organizacao/repositorio.git.";
    }
    return null;
  }
  return "URL inválida. Use https://, ssh:// ou git@host:caminho.";
}

/** Valida o nome opcional da pasta antes de enviar ao servidor. */
export function validateCloneNameClient(raw: string): string | null {
  const name = raw.trim();
  if (!name) return null;
  if (name.length > GIT_LIMITS.name) return `O nome pode ter até ${GIT_LIMITS.name} caracteres.`;
  if (
    name === "." ||
    name === ".." ||
    name.includes("..") ||
    name.includes("/") ||
    name.includes("\\") ||
    name.startsWith("-") ||
    UNSAFE_NAME.test(name)
  ) {
    return "Nome de pasta inválido. Use apenas o nome, sem barras nem '..'.";
  }
  return null;
}

/** Deriva o nome sugerido da pasta a partir da URL para mostrar como placeholder. */
export function suggestRepoName(rawUrl: string): string {
  const url = rawUrl.trim().replace(/[\\/]+$/, "");
  if (!url) return "meu-repositorio";
  let segment: string;
  const scp = SCP_SSH.exec(url);
  if (scp && !url.includes("://")) {
    segment = (scp[3] ?? "").replace(/\/+$/, "").split("/").filter(Boolean).pop() ?? "";
  } else if (url.includes("://")) {
    try {
      segment = new URL(url).pathname.split("/").filter(Boolean).pop() ?? "";
    } catch {
      segment = url.split(/[\\/]/).filter(Boolean).pop() ?? "";
    }
  } else {
    segment = url.split(/[\\/]/).filter(Boolean).pop() ?? "";
  }
  const clean = segment
    .replace(/\.git$/i, "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/\.{2,}/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 60);
  return clean || "repositorio";
}

/** Extrai o host da URL (ex.: `github.com`) para pré-preencher o formulário de credencial. */
export function suggestHostFromUrl(rawUrl: string): string {
  const url = rawUrl.trim();
  if (!url) return "";
  if (url.toLowerCase().startsWith("https://") || url.toLowerCase().startsWith("ssh://")) {
    try {
      return normalizeGitHost(new URL(url).hostname) ?? "";
    } catch {
      return "";
    }
  }
  const scp = SCP_SSH.exec(url);
  if (scp && !url.includes("://")) {
    return normalizeGitHost(scp[2] ?? "") ?? "";
  }
  return "";
}

/** Tipo de credencial compatível com a URL informada (`null` se indeterminado). */
export function expectedCredentialKind(rawUrl: string): GitCredentialKind | null {
  const lower = rawUrl.trim().toLowerCase();
  if (lower.startsWith("https://")) return "token";
  if (lower.startsWith("ssh://") || SCP_SSH.test(rawUrl.trim())) return "ssh";
  return null;
}

export type CredentialFormInput = {
  label: string;
  host: string;
  kind: GitCredentialKind;
  username: string;
  secret: string;
};

/** Valida o formulário de nova credencial do git no cliente. */
export function validateCredentialForm(input: CredentialFormInput): string | null {
  if (!input.label.trim()) return "Dê um nome para a credencial.";
  if (input.label.trim().length > GIT_LIMITS.label) return `O nome pode ter até ${GIT_LIMITS.label} caracteres.`;
  if (!normalizeGitHost(input.host)) return "Informe apenas o host, sem https://, barra ou espaços (ex.: github.com).";
  if (input.kind === "token") {
    if (input.username.trim().length > GIT_LIMITS.username) return `O usuário pode ter até ${GIT_LIMITS.username} caracteres.`;
    if (/[\r\n\0]/.test(input.username)) return "O usuário não pode ter quebras de linha.";
    return validateGitToken(input.secret);
  }
  return validateGitSshKey(input.secret);
}

/** Rótulo legível de uma credencial no seletor do clone. */
export function credentialOptionLabel(cred: GitCredentialView): string {
  const kindLabel = cred.kind === "token" ? "Token" : "SSH";
  return `${cred.label} (${cred.host} · ${kindLabel})`;
}

/** Texto curto de status de um job de clone. */
export function cloneStatusText(job: GitCloneJob): string {
  if (job.status === "running") {
    return job.progress !== undefined ? `Clonando… ${job.progress}%` : "Clonando repositório…";
  }
  if (job.status === "done") {
    return job.result?.folderWarning ? "Repositório clonado com aviso" : "Pasta cadastrada";
  }
  return "Falha ao clonar";
}
