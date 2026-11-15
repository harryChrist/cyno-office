/** O que se sabe do endereço do `origin`, sem nunca guardar credencial. */
export type ParsedOrigin = {
  /** O endereço sem usuário e senha (https), ou o original em ssh. */
  clean: string;
  /** Só quando é do GitHub. */
  github: { owner: string; repo: string; webUrl: string; httpsUrl: string } | null;
};

const GITHUB_PATH = /^\/?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/;

function github(owner: string, repo: string): NonNullable<ParsedOrigin["github"]> {
  const webUrl = `https://github.com/${owner}/${repo}`;
  return { owner, repo, webUrl, httpsUrl: `${webUrl}.git` };
}

/** Entende `git@github.com:dono/repo.git`, `ssh://git@github.com/dono/repo.git` e `https://[usuario[:senha]@]github.com/dono/repo(.git)`. */
export function parseOrigin(raw: string | null | undefined): ParsedOrigin | null {
  const text = (raw ?? "").trim();
  if (!text) return null;
  // Repositório em pasta local (usado em testes e em espelhos): vale como endereço, mas não é do GitHub.
  if (text.startsWith("/") || text.startsWith("./") || text.startsWith("../")) return { clean: text, github: null };
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)(.+)$/.exec(text);
  if (scp && !/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    const host = scp[1]!.toLowerCase();
    const match = host === "github.com" ? GITHUB_PATH.exec(scp[2]!) : null;
    return { clean: text.replace(/^[^@/\s]+@/, (user) => (user === "git@" ? user : "")), github: match ? github(match[1]!, match[2]!) : null };
  }
  try {
    const url = new URL(text);
    const host = url.hostname.toLowerCase();
    const isGithub = host === "github.com" || host === "www.github.com";
    const match = isGithub && ["https:", "http:", "ssh:", "git:"].includes(url.protocol) ? GITHUB_PATH.exec(url.pathname) : null;
    url.username = "";
    url.password = "";
    return { clean: url.toString(), github: match ? github(match[1]!, match[2]!) : null };
  } catch {
    return null;
  }
}
