import type { ActivityCategory, ActivityEntry, ActivityRefs } from "@cyno/shared";

/** Funções puras da página Atividade (período, agrupamento por dia, filtros, ícones, referências). */

export const ACTIVITY_TIME_ZONE = "America/Sao_Paulo";

export const RANGES = [
  { id: "hoje", label: "Hoje", days: 1 },
  { id: "7d", label: "7 dias", days: 7 },
  { id: "30d", label: "30 dias", days: 30 },
] as const;
export type RangeId = (typeof RANGES)[number]["id"];

export type ActivityFilters = {
  range: RangeId;
  /** Vazio = todas. */
  categories: ActivityCategory[];
  /** Vazio = todos. */
  actor: string;
  q: string;
};

export const DEFAULT_FILTERS: ActivityFilters = { range: "7d", categories: [], actor: "", q: "" };

/** AAAA-MM-DD de hoje em São Paulo. */
export function todayKey(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: ACTIVITY_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** Soma dias a um AAAA-MM-DD (puro calendário, sem fuso). */
export function addDaysKey(day: string, days: number): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Primeiro e último dia (inclusive) de um período, terminando hoje. */
export function rangeOf(range: RangeId, now: Date = new Date()): { from: string; to: string } {
  const to = todayKey(now);
  const days = RANGES.find((item) => item.id === range)?.days ?? 1;
  return { from: addDaysKey(to, -(days - 1)), to };
}

const WEEKDAYS = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];
const MONTHS = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];

/** "Hoje", "Ontem" ou "segunda, 3 de novembro" (com o ano se não for o de hoje). */
export function dayLabel(day: string, today: string): string {
  if (day === today) return "Hoje";
  if (day === addDaysKey(today, -1)) return "Ontem";
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const weekday = WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]!;
  return `${weekday.charAt(0).toUpperCase()}${weekday.slice(1)}, ${d} de ${MONTHS[m - 1]}${String(y) === today.slice(0, 4) ? "" : ` de ${y}`}`;
}

/** Dia da entrada: o `at` já vem no fuso de São Paulo. */
export const entryDay = (entry: Pick<ActivityEntry, "at">): string => entry.at.slice(0, 10);
/** "14:03". */
export const entryTime = (entry: Pick<ActivityEntry, "at">): string => entry.at.slice(11, 16);

export type DayGroup = { day: string; label: string; entries: ActivityEntry[] };

/** Agrupa (já em ordem, mais nova primeiro) por dia. */
export function groupByDay(entries: readonly ActivityEntry[], today: string): DayGroup[] {
  const groups: DayGroup[] = [];
  for (const entry of entries) {
    const day = entryDay(entry);
    const last = groups.at(-1);
    if (last && last.day === day) last.entries.push(entry);
    else groups.push({ day, label: dayLabel(day, today), entries: [entry] });
  }
  return groups;
}

const fold = (text: string) => text.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();

/** A entrada passa nos filtros (mesma regra do servidor: categoria, ator, busca sem acento e período)? */
export function matchesFilters(entry: ActivityEntry, filters: ActivityFilters, range: { from: string; to: string }): boolean {
  const day = entryDay(entry);
  if (day < range.from || day > range.to) return false;
  if (filters.categories.length > 0 && !filters.categories.includes(entry.category)) return false;
  if (filters.actor && entry.actor !== filters.actor) return false;
  const q = filters.q.trim();
  if (q && !fold(`${entry.summary} ${entry.action} ${entry.refs?.taskId ?? ""} ${entry.refs?.url ?? ""}`).includes(fold(q))) return false;
  return true;
}

/** Junta as entradas que chegaram ao vivo (as que passam nos filtros) no começo da lista, sem repetir, em ordem. */
export function mergeLive(list: readonly ActivityEntry[], live: readonly ActivityEntry[], accept: (entry: ActivityEntry) => boolean): ActivityEntry[] {
  const known = new Set(list.map((entry) => entry.id));
  const fresh = live.filter((entry) => !known.has(entry.id) && accept(entry));
  if (fresh.length === 0) return list as ActivityEntry[];
  return [...fresh, ...list].sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || (a.id < b.id ? 1 : -1));
}

/** Caminhos (viewBox 24) do ícone de cada categoria. */
export const CATEGORY_ICONS: Record<ActivityCategory, string[]> = {
  tarefa: ["M9 11l3 3 8-8", "M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h9"],
  aprovacao: ["M12 3l7 3v5c0 5-3 8-7 10-4-2-7-5-7-10V6l7-3z", "M9 12l2 2 4-4"],
  publicacao: ["M22 2L11 13", "M22 2l-7 20-4-9-9-4 20-7z"],
  rotina: ["M21 12a9 9 0 1 1-3-6.7", "M21 3v6h-6"],
  midia: ["M4 5h16v14H4z", "M4 16l4-4 4 4 3-3 5 5", "M9 9.5h.01"],
  plano: ["M9 6h11", "M9 12h11", "M9 18h11", "M4 6h.01", "M4 12h.01", "M4 18h.01"],
  agente: ["M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z", "M4 21a8 8 0 0 1 16 0"],
  agenda: ["M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z", "M3 10h18", "M8 2v4", "M16 2v4"],
  sistema: ["M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z", "M19 12a7 7 0 0 0-.1-1.2l2-1.5-2-3.4-2.4 1a7 7 0 0 0-2-1.2L14 3h-4l-.5 2.7a7 7 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.5A7 7 0 0 0 5 12c0 .4 0 .8.1 1.2l-2 1.5 2 3.4 2.4-1a7 7 0 0 0 2 1.2L10 21h4l.5-2.7a7 7 0 0 0 2-1.2l2.4 1 2-3.4-2-1.5c.1-.4.1-.8.1-1.2z"],
  gasto: ["M12 2v20", "M17 6H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"],
};

/** Tom (cor) da bolinha do ícone por categoria; as falhas e cancelamentos puxam para o vermelho. */
export type Tone = "ok" | "info" | "accent" | "warn" | "danger" | "neutral" | "alert";
/** Linha de alerta de rotina: a ação "alerta" ou uma mudança que levou um item a um status de alerta (Entrevista, Oferta…). */
export function isRoutineAlert(entry: Pick<ActivityEntry, "category" | "action" | "data">): boolean {
  return entry.category === "rotina" && (entry.action === "alerta" || entry.data?.alert === true);
}

export function toneOf(entry: Pick<ActivityEntry, "category" | "action"> & { data?: ActivityEntry["data"] }): Tone {
  const { category, action } = entry;
  if (isRoutineAlert({ category, action, data: entry.data })) return "alert";
  if (action === "falhou" || action === "erro_fatal" || action === "processo_morto_por_memoria" || action === "terminal_caiu" || action === "nao_iniciou") return "danger";
  if (action === "cancelada" || action === "cancelado" || action === "rejeitada" || action === "memoria_baixa" || action === "pressao_de_memoria" || action === "descartada" || action === "apagada" || action === "removido" || action === "recusado") return "warn";
  if (category === "tarefa") return action === "concluida" ? "ok" : "info";
  if (category === "aprovacao") return action === "pedida" ? "accent" : "ok";
  if (category === "publicacao") return "accent";
  if (category === "sistema" || category === "gasto") return "neutral";
  return "info";
}

export type RefLink = { kind: "task" | "foryou" | "media" | "routine" | "url"; id: string; label: string };

/** Links clicáveis de uma entrada (abrir a tarefa, o item do Para você, a mídia, a rotina, o post). */
export function refLinks(refs: ActivityRefs | undefined): RefLink[] {
  if (!refs) return [];
  const out: RefLink[] = [];
  if (refs.taskId) out.push({ kind: "task", id: refs.taskId, label: "Tarefa" });
  if (refs.forYouId) out.push({ kind: "foryou", id: refs.forYouId, label: "Aprovações" });
  if (refs.mediaId) out.push({ kind: "media", id: refs.mediaId, label: "Mídia" });
  if (refs.routineId) out.push({ kind: "routine", id: refs.routineId, label: "Rotina" });
  if (refs.url && /^https?:\/\//i.test(refs.url)) out.push({ kind: "url", id: refs.url, label: hostOf(refs.url) });
  return out;
}

/** "linkedin.com" de uma URL (sem www). */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "Abrir";
  }
}

const USD = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "USD", currencyDisplay: "code", minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** "US$ 1,23" (menos de 1 centavo vira "< US$ 0,01"). */
export function formatUsd(value: number): string {
  if (value > 0 && value < 0.01) return "< US$ 0,01";
  return USD.format(value).replace("USD", "US$").replace(/\s+/g, " ");
}

/** "3 min", "1 h 05 min", "42 s". */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")} min`;
}

/** "850 MB" ou "1,6 GB". */
export function formatMb(mb: number): string {
  if (!Number.isFinite(mb)) return "—";
  if (mb < 1024) return `${Math.round(mb)} MB`;
  return `${(mb / 1024).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} GB`;
}

/** Texto curto dos números de uma entrada (duração, custo): vai depois da frase. */
export function entryFacts(entry: ActivityEntry): string[] {
  const facts: string[] = [];
  const { durationMs, costUsd } = entry.data ?? {};
  if (isRoutineAlert(entry)) facts.push("Alerta");
  if (entry.category === "tarefa" && entry.action === "concluida") {
    if (typeof costUsd === "number") facts.push(formatUsd(costUsd));
  } else if (typeof durationMs === "number" && entry.category === "aprovacao") {
    facts.push(`esperou ${formatDuration(durationMs)}`);
  }
  if (entry.data?.backfill === true) facts.push("recuperado do histórico");
  return facts;
}

/** A manchete (e o resumo) da entrega de uma tarefa concluída, gravadas na entrada; vazio quando não há. */
export function entryDelivery(entry: Pick<ActivityEntry, "category" | "action" | "data">): { headline: string; summary?: string } | undefined {
  if (entry.category !== "tarefa" || entry.action !== "concluida") return undefined;
  const { headline, summary } = entry.data ?? {};
  if (typeof headline !== "string" || !headline.trim()) return undefined;
  return { headline, ...(typeof summary === "string" && summary.trim() ? { summary } : {}) };
}
