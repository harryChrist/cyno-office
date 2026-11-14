import {
  DAY_STATES,
  DAY_STATE_LABELS,
  DAY_STATS_RETENTION_DAYS,
  addDays,
  daySentence,
  daysBetween,
  dayKeyOf,
  formatDayDuration,
  groupMs,
  HOUR_MS,
  isEmptyDay,
  parseDayKey,
  totalMs,
  type DayCompare,
  type DayComparison,
  type DayCoverage,
  type DayHour,
  type DayState,
  type DayStats,
  type DayTotals,
  type ForYouItem,
  type MetricDelta,
  type PlatformDayStats,
  type StateMs,
  type Task,
  WORK_TIME_ZONE,
} from "@cyno/shared";

/** Funções puras do "Meu dia": transformam a resposta do servidor (`DayStats`) no que a tela mostra. */

const MIN = 60_000;

// ---------- Dias e navegação ----------

const weekdayFormat = new Intl.DateTimeFormat("pt-BR", { timeZone: "UTC", weekday: "short" });
const timeFormat = new Intl.DateTimeFormat("pt-BR", { timeZone: WORK_TIME_ZONE, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

/** "11/11" a partir de "2026-11-11". */
export const shortDay = (day: string): string => `${day.slice(8, 10)}/${day.slice(5, 7)}`;

/** "Hoje", "Ontem" ou "qua., 11/11". */
export function dayLabel(day: string, today: string): string {
  if (day === today) return "Hoje";
  if (day === addDays(today, -1)) return "Ontem";
  const parsed = parseDayKey(day);
  if (!parsed) return day;
  return `${weekdayFormat.format(new Date(Date.UTC(parsed.y, parsed.m - 1, parsed.d)))}, ${shortDay(day)}`;
}

/** O primeiro dia que o servidor ainda guarda (90 dias para trás). */
export const oldestDay = (today: string): string => addDays(today, -DAY_STATS_RETENTION_DAYS);

export type DayNav = { prev: string | null; next: string | null; isToday: boolean };

/** Anterior e próximo: nunca no futuro e nunca além dos 90 dias que o servidor guarda. */
export function dayNav(day: string, today: string): DayNav {
  const prev = addDays(day, -1);
  const next = addDays(day, 1);
  return { prev: prev >= oldestDay(today) ? prev : null, next: next <= today ? next : null, isToday: day === today };
}

/** Leva um dia qualquer (de um endereço, de um seletor) para dentro do que existe: sem futuro, sem passado além dos 90 dias. */
export function clampDay(day: string, today: string): string {
  if (!parseDayKey(day)) return today;
  if (day > today) return today;
  const oldest = oldestDay(today);
  return day < oldest ? oldest : day;
}

export type DayOption = { day: string; label: string };

/** As opções do seletor: hoje (sempre) e os dias com dado, do mais novo para o mais velho, sem repetir e sem sair da janela. */
export function dayOptions(days: readonly string[], today: string, current?: string): DayOption[] {
  const set = new Set<string>([today]);
  for (const day of days) if (parseDayKey(day) && day <= today && daysBetween(day, today) <= DAY_STATS_RETENTION_DAYS) set.add(day);
  if (current && parseDayKey(current) && current <= today) set.add(current);
  return [...set].sort((a, b) => (a < b ? 1 : -1)).map((day) => ({ day, label: dayLabel(day, today) }));
}

// ---------- O herói ----------

export type CompareChip = { id: "yesterday" | "sameWeekday"; text: string; tone: "better" | "worse" | "same" };

export type HeroView = {
  /** O número grande: "1 h 10 min" (ou "Nada" quando ninguém esperou). */
  value: string;
  /** Ninguém esperou o dono neste dia. */
  none: boolean;
  sentence: string;
  chips: CompareChip[];
  /** "3 esperas · a maior 48 min · com alguém esperando 1 h 02 min". */
  details: string;
};

function compareText(delta: MetricDelta, since: string): string {
  const pct = delta.pct !== undefined ? ` (${delta.delta < 0 ? "▼" : "▲"} ${Math.abs(delta.pct)}%)` : "";
  if (delta.sense === "same") return `Igual a ${since}`;
  return `${formatDayDuration(Math.abs(delta.delta))} ${delta.delta < 0 ? "a menos" : "a mais"} que ${since}${pct}`;
}

function chipOf(id: CompareChip["id"], comparison: DayComparison | undefined, since: string): CompareChip | undefined {
  const delta = comparison?.metrics.waitingOwnerMs;
  if (!delta) return undefined;
  const tone = delta.sense === "better" ? "better" : delta.sense === "worse" ? "worse" : "same";
  return { id, text: compareText(delta, since), tone };
}

/** As comparações com o dia anterior e com o mesmo dia da semana passada (só as que o servidor mandou). */
export function compareChips(compare: DayCompare | undefined, isToday: boolean): CompareChip[] {
  const list = [chipOf("yesterday", compare?.yesterday, isToday ? "ontem" : "o dia anterior"), chipOf("sameWeekday", compare?.sameWeekday, "a semana passada")];
  return list.filter((chip): chip is CompareChip => chip !== undefined);
}

/** A frase pronta do servidor-lado-shared; fora de hoje o "ontem" dela vira "dia anterior". */
export function heroSentence(stats: DayStats, today: string): string {
  const label = dayLabel(stats.day, today);
  const sentence = daySentence(stats, { label: label === "Hoje" || label === "Ontem" ? label : `Em ${shortDay(stats.day)}` });
  return stats.day === today ? sentence : sentence.replace(" que ontem", " que no dia anterior");
}

export function heroView(stats: DayStats, today: string): HeroView {
  const waiting = stats.totals.ms.waiting_owner;
  const none = stats.totals.waits === 0;
  const parts: string[] = [];
  if (!none) {
    parts.push(`${stats.totals.waits} ${stats.totals.waits === 1 ? "espera" : "esperas"}`);
    parts.push(`a maior ${formatDayDuration(stats.totals.longestWaitMs)}`);
    if (stats.totals.waitWallMs > 0 && Math.abs(stats.totals.waitWallMs - waiting) > 30_000) parts.push(`com alguém esperando ${formatDayDuration(stats.totals.waitWallMs)}`);
  }
  return { value: none ? "Nada" : formatDayDuration(waiting), none, sentence: heroSentence(stats, today), chips: compareChips(stats.compare, stats.day === today), details: parts.join(" · ") };
}

// ---------- O que espera agora ----------

export type OpenWait = { id: string; title: string; agentId: string; since: string; ageMs: number };

/** As esperas abertas agora (os itens pendentes do "Para você"), a mais antiga primeiro. */
export function openWaitsNow(items: readonly ForYouItem[] | null, now: number, title: (item: ForYouItem) => string): OpenWait[] {
  return (items ?? [])
    .filter((item) => item.status === "pendente" && item.decidedBy !== "automatico")
    .map((item) => ({ id: item.id, title: title(item), agentId: item.agentId, since: item.createdAt, ageMs: Math.max(0, now - Date.parse(item.createdAt)) }))
    .filter((wait) => Number.isFinite(wait.ageMs))
    .sort((a, b) => b.ageMs - a.ageMs || a.id.localeCompare(b.id));
}

// ---------- As maiores esperas ----------

export type WaitRow = {
  key: string;
  /** Primeiro item do "Para você" da espera (o link do item). */
  forYouId: string | undefined;
  title: string;
  agentName: string;
  where: string;
  durationMs: number;
  duration: string;
  /** 0 a 1, em relação à maior da lista. */
  ratio: number;
  open: boolean;
  /** "das 14:02 às 14:50" (ou "desde 14:02" se segue aberta). */
  span: string;
  /** Quando a espera começou (ms): o "Ver esse momento" abre o replay aí. */
  start: number;
};

export const hhmm = (t: number): string => timeFormat.format(new Date(t));

/** "14:02" no mesmo dia; "11/11 14:02" quando a espera começou ou terminou em outro dia. */
const atTime = (t: number, day: string): string => (dayKeyOf(t) === day ? hhmm(t) : `${shortDay(dayKeyOf(t))} ${hhmm(t)}`);

export function waitRows(stats: Pick<DayStats, "waits" | "day">, title: (forYouId: string | undefined, type: string) => string): WaitRow[] {
  const max = Math.max(1, ...stats.waits.map((wait) => wait.ms));
  return stats.waits.slice(0, 10).map((wait) => {
    const forYouId = wait.forYouIds[0];
    const where = [wait.projectName, wait.sprintName].filter(Boolean).join(" · ");
    return {
      key: wait.forYouIds.join("+") || `${wait.agentId}-${wait.start}`,
      forYouId,
      title: title(forYouId, wait.type),
      agentName: wait.agentName,
      where,
      durationMs: wait.ms,
      duration: formatDayDuration(wait.ms),
      ratio: wait.ms / max,
      open: wait.open,
      start: wait.start,
      span: wait.open ? `desde ${atTime(wait.start, stats.day)}` : `das ${atTime(wait.start, stats.day)} às ${atTime(wait.end, stats.day)}`,
    };
  });
}

// ---------- O dia por hora ----------

/** A ordem de baixo para cima de cada barra. */
export const BAR_STATES: readonly DayState[] = ["working", "queued", "waiting_agent", "waiting_maestro", "engine_blocked", "waiting_owner"];

export const STATE_TONES: Record<DayState, string> = {
  waiting_owner: "owner",
  working: "work",
  queued: "queue",
  waiting_agent: "agent",
  waiting_maestro: "maestro",
  engine_blocked: "engine",
};

/** Os degraus do eixo (em minutos de agente por hora): a barra nunca passa de 60 min por agente. */
const AXIS_STEPS_MIN = [5, 10, 15, 30, 60, 120, 180, 240, 360, 480, 720, 960, 1440];

/** O teto "redondo" do eixo para o maior valor (ms). */
export function niceAxisMs(maxMs: number): number {
  const minutes = maxMs / MIN;
  const step = AXIS_STEPS_MIN.find((value) => value >= minutes);
  return (step ?? Math.ceil(minutes / 1440) * 1440) * MIN;
}

export type HourSegment = { state: DayState; ms: number; pct: number };
export type HourBar = {
  t: number;
  /** "08" (a hora local). */
  label: string;
  segments: HourSegment[];
  totalMs: number;
  /** A hora que está passando agora (só no dia de hoje). */
  current: boolean;
  /** Hora que ainda não chegou. */
  future: boolean;
};
export type HourChart = { bars: HourBar[]; axisMs: number; ticks: Array<{ ms: number; label: string; pct: number }>; hasData: boolean };

export const ALL_STATES: readonly DayState[] = DAY_STATES;

/**
 * As barras do dia: uma por hora (23, 24 ou 25), empilhadas pelos estados visíveis, na mesma escala.
 * `visible` é o que a legenda deixou ligado; `now` marca a hora atual (só quando cai dentro do dia).
 */
export function hourChart(hours: readonly DayHour[], now: number, visible: ReadonlySet<DayState> = new Set(DAY_STATES)): HourChart {
  const shown = (hour: DayHour) => BAR_STATES.filter((state) => visible.has(state)).reduce((sum, state) => sum + hour.ms[state], 0);
  const maxMs = Math.max(0, ...hours.map(shown));
  const axisMs = niceAxisMs(Math.max(maxMs, MIN));
  const bars = hours.map((hour): HourBar => {
    const segments = BAR_STATES.filter((state) => visible.has(state) && hour.ms[state] > 0).map((state) => ({ state, ms: hour.ms[state], pct: (hour.ms[state] / axisMs) * 100 }));
    return { t: hour.t, label: String(hour.hour).padStart(2, "0"), segments, totalMs: shown(hour), current: now >= hour.t && now < hour.t + HOUR_MS, future: hour.t > now };
  });
  const ticks = [0, 0.5, 1].map((fraction) => ({ ms: axisMs * fraction, label: fraction === 0 ? "0" : formatAxis(axisMs * fraction), pct: fraction * 100 }));
  return { bars, axisMs, ticks, hasData: maxMs > 0 };
}

function formatAxis(ms: number): string {
  const minutes = Math.round(ms / MIN);
  if (minutes < 60) return `${minutes} min`;
  return minutes % 60 === 0 ? `${minutes / 60} h` : `${(minutes / 60).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} h`;
}

/** A legenda liga e desliga estados, mas sempre sobra um ligado. */
export function toggleState(visible: ReadonlySet<DayState>, state: DayState): Set<DayState> {
  const next = new Set(visible);
  if (next.has(state)) {
    if (next.size > 1) next.delete(state);
  } else {
    next.add(state);
  }
  return next;
}

/** Só os estados que aparecem em alguma hora entram na legenda. */
export function legendStates(hours: readonly DayHour[]): DayState[] {
  return DAY_STATES.filter((state) => hours.some((hour) => hour.ms[state] > 0));
}

export type HourTableRow = { key: number; hour: string; cells: Array<{ state: DayState; text: string }>; total: string };

/** A tabela gêmea do gráfico (para leitor de tela): uma linha por hora que teve algo. */
export function hourTable(hours: readonly DayHour[], states: readonly DayState[]): HourTableRow[] {
  return hours
    .filter((hour) => totalMs(hour.ms) > 0)
    .map((hour) => ({
      key: hour.t,
      hour: `${String(hour.hour).padStart(2, "0")}h`,
      cells: states.map((state) => ({ state, text: hour.ms[state] > 0 ? formatDayDuration(hour.ms[state]) : "—" })),
      total: formatDayDuration(totalMs(hour.ms)),
    }));
}

// ---------- Cobertura ----------

/** O selo "sem registro de estados antes de ..."; `null` quando o dia inteiro tem registro. */
export function coverageNote(coverage: DayCoverage): string | null {
  if (coverage.states === "full") return null;
  if (!coverage.clockFrom) return "Sem registro de estados neste dia";
  const at = Date.parse(coverage.clockFrom);
  if (!Number.isFinite(at)) return "Sem registro de estados neste dia";
  const date = shortDay(dayKeyOf(at));
  return coverage.states === "none" ? `Sem registro de estados antes de ${date}` : `Sem registro de estados antes de ${date}, ${hhmm(at)}`;
}

// ---------- Por agente, por projeto e sprint ----------

export type TimeCells = { working: string; queued: string; waitingOwner: string; stalled: string };

function timeCells(ms: StateMs): TimeCells {
  const group = groupMs(ms);
  const text = (value: number) => (value > 0 ? formatDayDuration(value) : "—");
  return { working: text(group.working), queued: text(group.queued), waitingOwner: text(group.waiting_owner), stalled: text(group.stalled) };
}

export type AgentRow = { id: string; name: string; cells: TimeCells; waits: number; done: number };

/** Tarefas concluídas no dia por agente (o `updatedAt` da tarefa feita cai no dia; a mesma regra do total do servidor). */
export function doneByAgent(tasks: readonly Pick<Task, "agentId" | "role" | "status" | "updatedAt">[], range: { start: number; end: number }): Map<string, number> {
  const out = new Map<string, number>();
  for (const task of tasks) {
    if (task.role === "request" || task.status !== "done") continue;
    const at = Date.parse(task.updatedAt);
    if (task.agentId && at >= range.start && at < range.end) out.set(task.agentId, (out.get(task.agentId) ?? 0) + 1);
  }
  return out;
}

export function agentRows(stats: Pick<DayStats, "agents" | "start" | "end">, done: ReadonlyMap<string, number>): AgentRow[] {
  return stats.agents.map((agent) => ({ id: agent.id, name: agent.name, cells: timeCells(agent.ms), waits: agent.waits, done: done.get(agent.id) ?? 0 }));
}

export type ProjectRow = { id: string; name: string; cells: TimeCells; waits: number; sprints: Array<{ id: string; name: string; cells: TimeCells; waits: number }> };

export function projectRows(stats: Pick<DayStats, "projects">): ProjectRow[] {
  return stats.projects.map((project) => ({
    id: project.id,
    name: project.name,
    cells: timeCells(project.ms),
    waits: project.waits,
    sprints: project.sprints.map((sprint) => ({ id: sprint.id, name: sprint.name, cells: timeCells(sprint.ms), waits: sprint.waits })),
  }));
}

// ---------- O gasto do dia ----------

const BRL = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const USD = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "USD" });

export function compactTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} mi`;
  if (tokens >= 10_000) return `${Math.round(tokens / 1000).toLocaleString("pt-BR")} mil`;
  return tokens.toLocaleString("pt-BR");
}

export type UsageView = {
  hasUsage: boolean;
  tokens: string;
  turns: string;
  cost: string;
  costUsd: string;
  /** "3 turnos sem medição" (o motor não informou tokens). */
  unmeasured: string | null;
  providers: Array<{ id: string; label: string; turns: string; tokens: string; cost: string; unmeasured: string | null }>;
};

const turnsText = (turns: number) => `${turns} ${turns === 1 ? "turno" : "turnos"}`;

export function usageView(stats: Pick<DayStats, "totals" | "providers">): UsageView {
  const { totals } = stats;
  const tokens = totals.tokens.input + totals.tokens.output + totals.tokens.cacheRead + totals.tokens.cacheCreation;
  return {
    hasUsage: totals.turns > 0 || tokens > 0,
    tokens: compactTokens(tokens),
    turns: turnsText(totals.turns),
    cost: BRL.format(totals.costBrl),
    costUsd: USD.format(totals.costUsd),
    unmeasured: totals.unmeasuredTurns > 0 ? `${totals.unmeasuredTurns} ${totals.unmeasuredTurns === 1 ? "turno sem medição" : "turnos sem medição"}` : null,
    providers: stats.providers.map((provider) => ({
      id: provider.provider,
      label: provider.label,
      turns: turnsText(provider.turns),
      tokens: provider.totalTokens > 0 ? compactTokens(provider.totalTokens) : "—",
      cost: provider.costBrl > 0 ? BRL.format(provider.costBrl) : "—",
      unmeasured: provider.unmeasuredTurns > 0 ? `${provider.unmeasuredTurns} sem medição` : null,
    })),
  };
}

// ---------- Dia vazio ----------

export type EmptyView = { title: string; text: string };

/** O texto de um dia sem nada (ou `null` se o dia tem o que mostrar). `workspaceIsNew`: o workspace ainda não tem dado nenhum. */
export function emptyView(stats: DayStats, today: string, workspaceIsNew: boolean): EmptyView | null {
  if (!isEmptyDay(stats)) return null;
  if (workspaceIsNew) return { title: "Ainda não há dias para mostrar", text: "Quando os agentes começarem a trabalhar neste workspace, o seu dia aparece aqui: quanto tempo eles esperaram por você, trabalharam e gastaram." };
  if (stats.day === today) return { title: "Hoje ainda está quieto", text: "Nenhum agente trabalhou nem esperou por você até agora. Conforme o dia andar, os números aparecem aqui." };
  return { title: "Nada neste dia", text: "Nenhum agente trabalhou, esperou por você ou gastou nada em " + dayLabel(stats.day, today).toLowerCase() + "." };
}

// ---------- A linha do Hoje e do Cyno ----------

export type WaitedLine = { text: string; detail: string; quiet: boolean };

/** "Esperando você · 2 h 10 min hoje" e "maior 48 min"; sem espera, uma linha calma. Serve ao dia de um workspace e ao da plataforma. */
export function waitedLine(source: Pick<DayStats | PlatformDayStats, "totals"> | null): WaitedLine | null {
  if (!source) return null;
  const totals: DayTotals = source.totals;
  if (totals.waits === 0) return { text: "Esperando você · ninguém esperou hoje", detail: "", quiet: true };
  return {
    text: `Esperando você · ${formatDayDuration(totals.ms.waiting_owner)} hoje`,
    detail: `${totals.waits} ${totals.waits === 1 ? "espera" : "esperas"} · maior ${formatDayDuration(totals.longestWaitMs)}`,
    quiet: false,
  };
}

/** O estado e o rótulo de cada coluna da tabela do gráfico. */
export const stateLabel = (state: DayState): string => DAY_STATE_LABELS[state];
