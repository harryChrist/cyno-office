import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { ACTIVITY_CATEGORIES, type ActivityCategory, type ActivityEntry, type ActivityQuery, type ActivityResponse, type ActivitySummary } from "@cyno/shared";
import { addDays, dayKeyOf, startOfDay } from "../../engines/usage/usage-time";
import { DAY_FILE } from "./log";

/** Lê uma linha da Atividade (linha quebrada ou de outro formato = undefined). */
export function parseActivityLine(line: string): ActivityEntry | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  try {
    const data = JSON.parse(trimmed) as Partial<ActivityEntry>;
    if (typeof data !== "object" || data === null) return undefined;
    if (typeof data.id !== "string" || typeof data.at !== "string" || typeof data.summary !== "string" || typeof data.action !== "string") return undefined;
    if (!ACTIVITY_CATEGORIES.includes(data.category as ActivityCategory) || Number.isNaN(Date.parse(data.at))) return undefined;
    return data as ActivityEntry;
  } catch {
    return undefined;
  }
}

/** Dias (AAAA-MM-DD) com arquivo na pasta, do mais novo para o mais velho. */
export async function activityDays(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).map((name) => DAY_FILE.exec(name)?.[1]).filter((day): day is string => day !== undefined).sort().reverse();
  } catch {
    return [];
  }
}

async function readDay(dir: string, day: string): Promise<ActivityEntry[]> {
  try {
    const text = await readFile(path.join(dir, `${day}.jsonl`), "utf8");
    return text.split("\n").map(parseActivityLine).filter((entry): entry is ActivityEntry => entry !== undefined);
  } catch {
    return [];
  }
}

/** Limite de tempo: AAAA-MM-DD (dia de São Paulo; `to` vale até o fim do dia) ou data e hora ISO. */
export function boundMs(value: string | undefined, kind: "from" | "to"): number | undefined {
  if (!value) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return kind === "from" ? startOfDay(value) : startOfDay(addDays(value, 1)) - 1;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
}

const fold = (text: string) => text.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();

export type ActivityFilter = Pick<ActivityQuery, "category" | "actor" | "q">;

export function matchesFilter(entry: ActivityEntry, filter: ActivityFilter, needle: string | undefined): boolean {
  if (filter.category && !filter.category.includes(entry.category)) return false;
  if (filter.actor && entry.actor !== filter.actor) return false;
  if (needle) {
    const haystack = fold(`${entry.summary} ${entry.action} ${entry.refs?.taskId ?? ""} ${entry.refs?.url ?? ""}`);
    if (!haystack.includes(needle)) return false;
  }
  return true;
}

/** Mais novo primeiro; empate de horário desempata pelo id. */
const newestFirst = (a: ActivityEntry, b: ActivityEntry) => Date.parse(b.at) - Date.parse(a.at) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

function parseCursor(cursor: string | undefined): { ms: number; id: string } | undefined {
  if (!cursor) return undefined;
  const cut = cursor.indexOf("|");
  const ms = Number(cursor.slice(0, cut));
  return cut > 0 && Number.isFinite(ms) ? { ms, id: cursor.slice(cut + 1) } : undefined;
}

/** Entradas de uma pasta (mais novas primeiro), com filtro e paginação por cursor. */
export async function queryActivity(dir: string, query: ActivityQuery): Promise<ActivityResponse> {
  const fromMs = boundMs(query.from, "from") ?? -Infinity;
  const toMs = boundMs(query.to, "to") ?? Infinity;
  const needle = query.q ? fold(query.q.trim()) : undefined;
  const cursor = parseCursor(query.cursor);
  const fromDay = Number.isFinite(fromMs) ? dayKeyOf(fromMs) : "";
  const toDay = Number.isFinite(toMs) ? dayKeyOf(toMs) : "9999-99-99";
  const out: ActivityEntry[] = [];
  let more = false;
  for (const day of await activityDays(dir)) {
    if (day > toDay) continue;
    if (day < fromDay) break;
    const entries = (await readDay(dir, day)).sort(newestFirst);
    for (const entry of entries) {
      const at = Date.parse(entry.at);
      if (at < fromMs || at > toMs) continue;
      if (cursor && (at > cursor.ms || (at === cursor.ms && entry.id >= cursor.id))) continue;
      if (!matchesFilter(entry, query, needle)) continue;
      if (out.length >= query.limit) {
        more = true;
        break;
      }
      out.push(entry);
    }
    if (more) break;
  }
  const last = out.at(-1);
  return { entries: out, ...(more && last ? { nextCursor: `${Date.parse(last.at)}|${last.id}` } : {}) };
}

/** Todas as entradas entre dois dias (AAAA-MM-DD, inclusive), sem ordem garantida. */
export async function readActivityRange(dir: string, fromDay: string, toDay: string): Promise<ActivityEntry[]> {
  const out: ActivityEntry[] = [];
  for (const day of await activityDays(dir)) {
    if (day > toDay || day < fromDay) continue;
    out.push(...(await readDay(dir, day)));
  }
  return out;
}

/** Números do período para o topo da página. */
export function summarizeActivity(entries: readonly ActivityEntry[], range: { from: string; to: string }): ActivitySummary {
  const summary: ActivitySummary = {
    from: range.from,
    to: range.to,
    total: entries.length,
    byCategory: {},
    tasksDone: 0,
    tasksFailed: 0,
    approvals: { requested: 0, approved: 0, rejected: 0, answered: 0 },
    publications: 0,
    media: 0,
    costUsd: 0,
    tokens: 0,
  };
  for (const entry of entries) {
    summary.byCategory[entry.category] = (summary.byCategory[entry.category] ?? 0) + 1;
    const { category, action } = entry;
    if (category === "tarefa") {
      if (action === "concluida") {
        summary.tasksDone += 1;
        const cost = entry.data?.costUsd;
        const tokens = entry.data?.tokens;
        if (typeof cost === "number" && Number.isFinite(cost)) summary.costUsd += cost;
        if (typeof tokens === "number" && Number.isFinite(tokens)) summary.tokens += tokens;
      } else if (action === "falhou") summary.tasksFailed += 1;
    } else if (category === "aprovacao") {
      if (action === "pedida") summary.approvals.requested += 1;
      else if (action === "aprovada") summary.approvals.approved += 1;
      else if (action === "rejeitada") summary.approvals.rejected += 1;
      else if (action === "respondida") summary.approvals.answered += 1;
    } else if (category === "publicacao") summary.publications += 1;
    else if (category === "midia" && action === "criada") summary.media += 1;
  }
  summary.costUsd = Math.round(summary.costUsd * 10_000) / 10_000;
  return summary;
}
