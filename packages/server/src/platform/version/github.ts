import type { UpdateCommit } from "@cyno/shared";

export type GithubCompare =
  | { ok: true; status: "ahead" | "behind" | "identical" | "diverged"; count: number; commits: UpdateCommit[] }
  | { ok: false; reason: "not-found" | "rate-limit" | "network" | "invalid" };

export const MAX_LISTED_COMMITS = 20;

/**
 * Compara dois commits pela API pública do GitHub, SEM credencial nenhuma (só repositório público: um privado devolve 404).
 * `compare/<base>...<head>`: `ahead` = o head tem commits que a base não tem. Qualquer falha vira `{ ok: false }`.
 */
export async function compareOnGithub(
  github: { owner: string; repo: string },
  base: string,
  head: string,
  options: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<GithubCompare> {
  const doFetch = options.fetch ?? fetch;
  const url = (page: number) => `https://api.github.com/repos/${github.owner}/${github.repo}/compare/${base}...${head}?per_page=${PAGE_SIZE}&page=${page}`;
  const first = await fetchPage(doFetch, url(1), options.timeoutMs ?? 8000);
  if (!first.ok) return first;
  const { status, count } = first.page;
  let { commits } = first.page;
  // A API lista do mais antigo ao mais novo, 100 por página: com mais de 100 novidades, o fim da lista está na última página.
  if (count > PAGE_SIZE) {
    const last = await fetchPage(doFetch, url(Math.ceil(count / PAGE_SIZE)), options.timeoutMs ?? 8000);
    if (last.ok) commits = last.page.commits;
  }
  return { ok: true, status, count, commits: [...commits].reverse().slice(0, MAX_LISTED_COMMITS) };
}

const PAGE_SIZE = 100;

type Page = { status: "ahead" | "behind" | "identical" | "diverged"; count: number; commits: UpdateCommit[] };

async function fetchPage(doFetch: typeof fetch, url: string, timeoutMs: number): Promise<{ ok: true; page: Page } | { ok: false; reason: "not-found" | "rate-limit" | "network" | "invalid" }> {
  let response: Response;
  try {
    response = await doFetch(url, {
      headers: { accept: "application/vnd.github+json", "user-agent": "cyno-update-check", "x-github-api-version": "2022-11-28" },
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return { ok: false, reason: "network" };
  }
  if (response.status === 404) return { ok: false, reason: "not-found" };
  if (response.status === 403 || response.status === 429) return { ok: false, reason: "rate-limit" };
  if (!response.ok) return { ok: false, reason: "network" };
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, reason: "invalid" };
  }
  const data = body as { status?: unknown; ahead_by?: unknown; total_commits?: unknown; commits?: unknown };
  const status = data.status;
  if (status !== "ahead" && status !== "behind" && status !== "identical" && status !== "diverged") return { ok: false, reason: "invalid" };
  const raw = Array.isArray(data.commits) ? (data.commits as unknown[]) : [];
  const commits: UpdateCommit[] = [];
  for (const entry of raw) {
    const item = entry as { sha?: unknown; commit?: { message?: unknown; committer?: { date?: unknown }; author?: { date?: unknown } } };
    if (typeof item.sha !== "string" || typeof item.commit?.message !== "string") continue;
    const date = item.commit.committer?.date ?? item.commit.author?.date;
    commits.push({ hash: item.sha, short: item.sha.slice(0, 7), date: typeof date === "string" ? date : "", subject: item.commit.message.split("\n")[0]!.trim() });
  }
  const count = typeof data.ahead_by === "number" ? data.ahead_by : typeof data.total_commits === "number" ? data.total_commits : commits.length;
  return { ok: true, page: { status, count, commits } };
}
