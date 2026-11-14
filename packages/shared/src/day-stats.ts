// Adaptado de Habblaud (github.com/marmottajr/habblaud), MIT, Copyright (c) 2026 Márcio Junior.
// Veja THIRD_PARTY/habblaud-LICENSE.txt. Do original vêm as fórmulas e o código puro: `forEachHour`,
// `mergeIntervals`, as contas de dia com fuso (`dayStart`, `addDays`), as constantes de proteção
// (`MIN_WAIT_MS`, `WAIT_JOIN_MS`, `MAX_GAP_MS`, `TOP_WAITS`) e o desenho da leitura defensiva do arquivo do dia.
// O resto é do Cyno: o Cyno sabe o estado exato de cada tarefa, então nada aqui lê transcrição.

import type { ForYouItem, ForYouKind } from "./for-you";
import { WORK_TIME_ZONE, type Project, type ProjectTask } from "./projects";
import type { TerminalStatus } from "./terminal";
import type { Agent, Task } from "./types";

/**
 * "Meu dia": quanto tempo cada agente passou em cada estado ao longo do dia, com o número principal
 * "Esperando você". Código puro (sem Node nem DOM): o servidor grava o relógio de estados e monta o dia;
 * a tela e as ferramentas MCP leem o mesmo `DayStats`. Fuso fixo: America/Sao_Paulo (o do dono).
 *
 * Uma fonte por número: "Esperando você" sai dos itens do "Para você" (exato e retroativo); os outros
 * estados saem do relógio de estados (trechos gravados em baldes de 1 hora); tokens e custo saem do
 * histórico de gastos (o mesmo de Gastos), nunca recontados.
 */

export const DAY_STATS_PATH = "/api/day-stats";
export const WORKSPACE_DAY_STATS_PATH = "/day-stats";

export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;

/** O relógio fecha a parcial dos trechos abertos a cada tanto (também é o "batimento" que detecta lacuna). */
export const STATE_TICK_MS = 15_000;
/** E grava o arquivo a cada tanto (quando mudou). */
export const STATE_FLUSH_MS = 30_000;
/** Servidor parado ou dormindo: um buraco maior que isso entre dois batimentos não é integrado. */
export const MAX_GAP_MS = 120_000;
/** Esperas menores que isso não contam (aprovado em segundos). */
export const MIN_WAIT_MS = 3_000;
/** Dois itens da mesma tarefa colados (menos que isso entre um e outro) viram uma espera só. */
export const WAIT_JOIN_MS = 1_500;
export const TOP_WAITS = 10;
export const DAY_STATS_RETENTION_DAYS = 90;
/** Base mínima (5 min) para dar percentual na comparação de tempos. */
export const COMPARE_MIN_BASE_MS = 300_000;
/** Dias de comparação com a média (os 7 anteriores). */
export const COMPARE_AVG_DAYS = 7;
/** Intervalo máximo de `GET …/day-stats/range` (dias). */
export const DAY_STATS_RANGE_MAX_DAYS = 31;

// ---------- Estados ----------

export const DAY_STATES = ["waiting_owner", "working", "queued", "waiting_agent", "waiting_maestro", "engine_blocked"] as const;
export type DayState = (typeof DAY_STATES)[number];
/** Os estados que vêm do relógio (`waiting_owner` vem dos itens do "Para você"). */
export const CLOCK_STATES = ["working", "queued", "waiting_agent", "waiting_maestro", "engine_blocked"] as const;
export type ClockState = (typeof CLOCK_STATES)[number];

export type StateMs = Record<DayState, number>;
export type ClockMs = Record<ClockState, number>;

export const DAY_STATE_LABELS: Record<DayState, string> = {
  waiting_owner: "Esperando você",
  working: "Trabalhando",
  queued: "Na fila",
  waiting_agent: "Esperando outro agente",
  waiting_maestro: "Esperando o Maestro",
  engine_blocked: "Sem cota ou CLI fora",
};

/** Os quatro grupos do gráfico por hora (a tabela abre os seis estados). */
export const DAY_STATE_GROUPS = ["waiting_owner", "working", "stalled", "queued"] as const;
export type DayStateGroup = (typeof DAY_STATE_GROUPS)[number];
export const DAY_STATE_GROUP_LABELS: Record<DayStateGroup, string> = { waiting_owner: "Esperando você", working: "Trabalhando", stalled: "Parado por outro", queued: "Na fila" };
export const DAY_STATE_GROUP_OF: Record<DayState, DayStateGroup> = {
  waiting_owner: "waiting_owner",
  working: "working",
  queued: "queued",
  waiting_agent: "stalled",
  waiting_maestro: "stalled",
  engine_blocked: "stalled",
};

export const zeroClockMs = (): ClockMs => ({ working: 0, queued: 0, waiting_agent: 0, waiting_maestro: 0, engine_blocked: 0 });
export const zeroStateMs = (): StateMs => ({ waiting_owner: 0, ...zeroClockMs() });
export const totalMs = (ms: Partial<Record<DayState, number>>): number => DAY_STATES.reduce((sum, state) => sum + (ms[state] ?? 0), 0);

/** Soma o tempo dos estados em quatro grupos (o gráfico por hora). */
export function groupMs(ms: StateMs): Record<DayStateGroup, number> {
  const out: Record<DayStateGroup, number> = { waiting_owner: 0, working: 0, stalled: 0, queued: 0 };
  for (const state of DAY_STATES) out[DAY_STATE_GROUP_OF[state]] += ms[state];
  return out;
}

/**
 * O estado de uma tarefa agora (`null` = não conta). Unidade: a tarefa, porque uma tarefa parada esperando o dono
 * não ocupa mais o agente. Nunca devolve `waiting_owner` (esse vem dos itens do "Para você").
 * - `done`, `failed`, `waiting_approval` e o registro do pedido do Maestro: não contam;
 * - projeto que não está `ativo` (proposto, ajustando, pausado, concluído, cancelado): não conta;
 * - etapa concluída, falhada, cancelada ou esperando você: não conta;
 * - pedido de ajuda aberto: esperando o Maestro; bloqueio de agente: esperando outro agente; cota ou acesso: sem cota;
 * - senão, `queued` = na fila e `in_progress` = trabalhando (se o terminal do agente é conhecido, só com ele ocupado ou subindo).
 */
export function taskState(input: {
  task: Pick<Task, "role" | "status">;
  project?: Pick<Project, "status">;
  planTask?: Pick<ProjectTask, "status" | "blocked" | "help">;
  terminal?: TerminalStatus;
}): ClockState | null {
  const { task, project, planTask, terminal } = input;
  if (task.role === "request") return null;
  if (task.status !== "queued" && task.status !== "in_progress") return null;
  if (project && project.status !== "ativo") return null;
  if (planTask) {
    if (planTask.status === "concluida" || planTask.status === "falhou" || planTask.status === "cancelada" || planTask.status === "esperando_voce") return null;
    if (planTask.help && planTask.help.length > 0) return "waiting_maestro";
    const blocked = planTask.blocked?.type;
    if (blocked === "agente") return "waiting_agent";
    if (blocked === "cota" || blocked === "acesso") return "engine_blocked";
    if (blocked === "voce") return null;
  }
  if (task.status === "queued") return "queued";
  if (terminal !== undefined && terminal !== "busy" && terminal !== "starting") return null;
  return "working";
}

// ---------- Tempo (fuso fixo de São Paulo) ----------

export function hourStart(t: number): number {
  return Math.floor(t / HOUR_MS) * HOUR_MS;
}

/** Chama `cb` para cada pedaço de [from, to) dentro de uma hora (alinhada em UTC; o fuso de São Paulo tem horas inteiras). */
export function forEachHour(from: number, to: number, cb: (hour: number, ms: number) => void): void {
  let start = from;
  while (start < to) {
    const hour = hourStart(start);
    const end = Math.min(to, hour + HOUR_MS);
    cb(hour, end - start);
    start = end;
  }
}

/** Une intervalos sobrepostos (o tempo de relógio com alguém esperando). */
export function mergeIntervals(list: ReadonlyArray<readonly [number, number]>): Array<[number, number]> {
  const sorted = list.filter(([start, end]) => end > start).sort((a, b) => a[0] - b[0]);
  const out: Array<[number, number]> = [];
  for (const [start, end] of sorted) {
    const last = out[out.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else out.push([start, end]);
  }
  return out;
}

const partsFormat = new Intl.DateTimeFormat("en-CA", { timeZone: WORK_TIME_ZONE, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
const pad2 = (n: number) => String(n).padStart(2, "0");

function localParts(t: number): { y: number; mo: number; d: number; h: number; mi: number; s: number } {
  const parts: Record<string, string> = {};
  for (const part of partsFormat.formatToParts(new Date(t))) parts[part.type] = part.value;
  return { y: Number(parts.year), mo: Number(parts.month), d: Number(parts.day), h: Number(parts.hour), mi: Number(parts.minute), s: Number(parts.second) };
}

/** "AAAA-MM-DD" do instante `t` em São Paulo. */
export function dayKeyOf(t: number): string {
  const p = localParts(t);
  return `${p.y}-${pad2(p.mo)}-${pad2(p.d)}`;
}

/** Hora local (0 a 23) do instante `t` em São Paulo. */
export function localHourOf(t: number): number {
  return localParts(t).h;
}

const DAY_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Valida "AAAA-MM-DD" com rigor (formato exato e data que existe no calendário). */
export function parseDayKey(key: string): { y: number; m: number; d: number } | null {
  const match = DAY_KEY_RE.exec(key);
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  if (y < 1970 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const check = new Date(Date.UTC(y, m - 1, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) return null;
  return { y, m, d };
}

/** Soma `n` dias de calendário a "AAAA-MM-DD". */
export function addDays(key: string, n: number): string {
  const parsed = parseDayKey(key);
  if (!parsed) return key;
  const date = new Date(Date.UTC(parsed.y, parsed.m - 1, parsed.d + n));
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

/** Quantos dias de calendário vão de `from` a `to` (negativo se `to` é antes). */
export function daysBetween(from: string, to: string): number {
  const a = parseDayKey(from);
  const b = parseDayKey(to);
  if (!a || !b) return 0;
  return Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / DAY_MS);
}

function offsetMs(t: number): number {
  const p = localParts(t);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(t / 1000) * 1000;
}

/** Primeiro instante do dia `key` em São Paulo (a meia-noite, ou o começo real em dia com horário de verão). */
export function dayStart(key: string): number {
  const parsed = parseDayKey(key);
  if (!parsed) throw new RangeError(`dia inválido: ${key}`);
  const guess = Date.UTC(parsed.y, parsed.m - 1, parsed.d);
  let t = guess - offsetMs(guess);
  t = guess - offsetMs(t);
  // Meia-noite que não existe (horário de verão começando à 0h): anda até o primeiro instante do dia.
  const step = 15 * 60_000;
  for (let i = 0; i < 16 && dayKeyOf(t) < key; i += 1) t += step;
  for (let i = 0; i < 16 && dayKeyOf(t - step) === key; i += 1) t -= step;
  return t;
}

/** [início, fim) do dia: dura 24 h, ou 23 h e 25 h nos dias de mudança de horário de verão. */
export function dayRange(key: string): { start: number; end: number } {
  return { start: dayStart(key), end: dayStart(addDays(key, 1)) };
}

// ---------- Esperas pelo dono (do "Para você") ----------

export type WaitRecord = {
  /** Os itens do "Para você" que formam esta espera. */
  forYouIds: string[];
  taskId?: string;
  projectId?: string;
  sprintId?: string;
  agentId: string;
  /** Tipo e espécie do primeiro item (aprovação, plano, sprint, rotina, questionário). */
  type: string;
  kind: ForYouKind;
  start: number;
  end: number;
  /** Ainda esperando (o `end` é o agora). */
  open: boolean;
};

export type OwnerWaits = {
  /** Todas as esperas (as que tocam a janela, se houver), da mais antiga para a mais nova. */
  waits: WaitRecord[];
  /** As `TOP_WAITS` maiores (duração inteira). */
  top: WaitRecord[];
  /** Tempo de relógio com alguém esperando: a união dos intervalos (cortada na janela, se houver). */
  wallMs: number;
  /** A maior espera (duração inteira). */
  longestMs: number;
};

type ProjectLookup = readonly Pick<Project, "id" | "tasks">[];
type TaskLookup = readonly Pick<Task, "id" | "work" | "agentId">[];

/**
 * As esperas pelo dono. Cada item do "Para você" espera de `createdAt` até `decidedAt` (o cancelamento também grava
 * `decidedAt`) ou, se segue pendente, até agora. Os itens são agrupados por `taskId ?? groupId ?? id` e os intervalos
 * do grupo que se sobrepõem ou ficam colados (`WAIT_JOIN_MS`) viram uma espera só (o agente só recebe a resposta
 * quando o último item do lote sai). Cartão de regra (`kind: "regra"`) não é espera de agente e fica de fora. Esperas menores que `MIN_WAIT_MS` somem. O que o Modo Automático decidiu não
 * conta: o dono não fez ninguém esperar. Com `range`, só entram as esperas que tocam a janela.
 */
export function ownerWaits(
  items: readonly ForYouItem[],
  tasks: TaskLookup,
  now: number,
  options: { projects?: ProjectLookup; range?: { start: number; end: number } } = {},
): OwnerWaits {
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  type Part = { item: ForYouItem; start: number; end: number; open: boolean };
  const groups = new Map<string, Part[]>();
  for (const item of items) {
    if (item.decidedBy === "automatico") continue;
    // A regra proposta pela retrospectiva é decisão do dono, mas não segura nenhum agente: não é tempo de espera.
    if (item.kind === "regra") continue;
    const start = Date.parse(item.createdAt);
    if (!Number.isFinite(start)) continue;
    let end: number;
    let open = false;
    if (item.status === "pendente") {
      end = now;
      open = true;
    } else {
      end = item.decidedAt ? Date.parse(item.decidedAt) : Number.NaN;
      if (!Number.isFinite(end)) continue;
    }
    if (end < start) continue;
    const key = item.taskId ?? item.groupId ?? item.id;
    const list = groups.get(key);
    if (list) list.push({ item, start, end, open });
    else groups.set(key, [{ item, start, end, open }]);
  }

  const all: WaitRecord[] = [];
  for (const parts of groups.values()) {
    parts.sort((a, b) => a.start - b.start || a.end - b.end);
    let current: { parts: Part[]; start: number; end: number; open: boolean } | undefined;
    const flush = () => {
      if (!current || current.end - current.start < MIN_WAIT_MS) return;
      const first = current.parts[0]!.item;
      const task = first.taskId ? taskById.get(first.taskId) : undefined;
      const projectId = first.projectId ?? task?.work?.projectId;
      const taskRef = first.taskRef ?? task?.work?.ref;
      const sprintId = first.sprintId ?? (projectId && taskRef ? options.projects?.find((project) => project.id === projectId)?.tasks.find((candidate) => candidate.ref === taskRef)?.sprintId : undefined);
      all.push({
        forYouIds: current.parts.map((part) => part.item.id),
        ...(first.taskId ? { taskId: first.taskId } : {}),
        ...(projectId ? { projectId } : {}),
        ...(sprintId ? { sprintId } : {}),
        agentId: first.agentId,
        type: first.type,
        kind: first.kind ?? "aprovacao",
        start: current.start,
        end: current.end,
        open: current.open,
      });
    };
    for (const part of parts) {
      if (current && part.start <= current.end + WAIT_JOIN_MS) {
        current.parts.push(part);
        current.end = Math.max(current.end, part.end);
        current.open = current.open || part.open;
      } else {
        flush();
        current = { parts: [part], start: part.start, end: part.end, open: part.open };
      }
    }
    flush();
  }

  const range = options.range;
  const waits = (range ? all.filter((wait) => wait.end > range.start && wait.start < range.end) : all).sort((a, b) => a.start - b.start || a.end - b.end);
  const union = mergeIntervals(waits.map((wait): [number, number] => (range ? [Math.max(wait.start, range.start), Math.min(wait.end, range.end)] : [wait.start, wait.end])));
  const top = [...waits].sort((a, b) => b.end - b.start - (a.end - a.start) || a.start - b.start).slice(0, TOP_WAITS);
  return {
    waits,
    top,
    wallMs: union.reduce((sum, [start, end]) => sum + (end - start), 0),
    longestMs: top[0] ? top[0].end - top[0].start : 0,
  };
}

// ---------- O arquivo do relógio de estados ----------

/** Um balde de 1 hora do relógio. `byAgent`/`byProject`/`bySprint` são listas de pares (não objetos com chave livre). */
export type ClockBucket = {
  /** Início da hora (ms, alinhado em UTC). */
  t: number;
  ms: ClockMs;
  byAgent: Array<[string, ClockMs]>;
  byProject: Array<[string, ClockMs]>;
  /** Chave `projectId:sprintId`. */
  bySprint: Array<[string, ClockMs]>;
};

/** O arquivo de um dia (`day-stats/AAAA-MM-DD.json`). */
export type StateDayFile = {
  v: 1;
  day: string;
  /** Últimos nomes vistos (o agente, o projeto e a sprint podem sumir depois). */
  names: { agents: Array<[string, string]>; projects: Array<[string, string]>; sprints: Array<[string, string]> };
  buckets: ClockBucket[];
  /** Até quando o relógio esteve no ar neste dia (último batimento gravado). */
  liveAt: number;
};

/** Limites da leitura defensiva de um arquivo (um arquivo editado à mão ou estragado nunca derruba o servidor). */
export const DAY_FILE_LIMITS = { buckets: 25, parts: 500, text: 120, ms: DAY_MS } as const;

export const emptyClockBucket = (t: number): ClockBucket => ({ t, ms: zeroClockMs(), byAgent: [], byProject: [], bySprint: [] });
export const emptyStateDayFile = (day: string): StateDayFile => ({ v: 1, day, names: { agents: [], projects: [], sprints: [] }, buckets: [], liveAt: 0 });

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const num = (value: unknown, max: number): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.min(Math.round(value), max) : 0);
const str = (value: unknown, max: number): string | undefined => (typeof value === "string" && value.length > 0 ? value.slice(0, max) : undefined);

function clockMsFrom(value: unknown, cap = DAY_FILE_LIMITS.ms): ClockMs {
  const out = zeroClockMs();
  if (!isObject(value)) return out;
  for (const state of CLOCK_STATES) out[state] = num(value[state], cap);
  return out;
}

function pairsFrom(value: unknown): Array<[string, ClockMs]> {
  if (!Array.isArray(value)) return [];
  const out: Array<[string, ClockMs]> = [];
  for (const entry of value.slice(0, DAY_FILE_LIMITS.parts)) {
    if (!Array.isArray(entry)) continue;
    const key = str(entry[0], DAY_FILE_LIMITS.text);
    if (key) out.push([key, clockMsFrom(entry[1], HOUR_MS)]);
  }
  return out;
}

function namesFrom(value: unknown): Array<[string, string]> {
  if (!Array.isArray(value)) return [];
  const out: Array<[string, string]> = [];
  for (const entry of value.slice(0, DAY_FILE_LIMITS.parts)) {
    if (!Array.isArray(entry)) continue;
    const key = str(entry[0], DAY_FILE_LIMITS.text);
    const name = str(entry[1], DAY_FILE_LIMITS.text);
    if (key && name) out.push([key, name]);
  }
  return out;
}

/**
 * Lê o conteúdo de um arquivo do dia sem confiar nele: devolve `null` se não é um arquivo do dia `day` (versão
 * diferente, outro dia, não é objeto); descarta baldes fora do dia, repetidos ou sem hora inteira, e corta
 * listas e números nos tetos. Nunca lança.
 */
export function parseStateDayFile(raw: unknown, day: string): StateDayFile | null {
  if (!isObject(raw) || raw.v !== 1 || raw.day !== day || !parseDayKey(day)) return null;
  const { start, end } = dayRange(day);
  const file = emptyStateDayFile(day);
  if (typeof raw.liveAt === "number" && Number.isFinite(raw.liveAt) && raw.liveAt > 0) file.liveAt = Math.round(raw.liveAt);
  if (isObject(raw.names)) file.names = { agents: namesFrom(raw.names.agents), projects: namesFrom(raw.names.projects), sprints: namesFrom(raw.names.sprints) };
  const seen = new Set<number>();
  if (Array.isArray(raw.buckets)) {
    for (const entry of raw.buckets.slice(0, DAY_FILE_LIMITS.buckets)) {
      if (!isObject(entry)) continue;
      const t = entry.t;
      if (typeof t !== "number" || !Number.isInteger(t) || t % HOUR_MS !== 0 || t < start - HOUR_MS || t >= end || hourStart(t) !== t || seen.has(t)) continue;
      // Uma hora pertence ao dia pelo início dela.
      if (dayKeyOf(t) !== day) continue;
      seen.add(t);
      file.buckets.push({ t, ms: clockMsFrom(entry.ms, HOUR_MS), byAgent: pairsFrom(entry.byAgent), byProject: pairsFrom(entry.byProject), bySprint: pairsFrom(entry.bySprint) });
    }
  }
  file.buckets.sort((a, b) => a.t - b.t);
  return file;
}

// ---------- O dia montado ----------

/** O que o histórico de gastos diz do dia (o servidor monta com o mesmo `aggregateHistory` de Gastos). */
export type DayUsage = {
  tokens: { input: number; output: number; cacheRead: number; cacheCreation: number };
  costUsd: number;
  costBrl: number;
  turns: number;
  unmeasuredTurns: number;
  /** "Por conta": o motor, os turnos, os sem medição, os tokens e o custo. */
  providers: Array<{ provider: string; label: string; turns: number; unmeasuredTurns: number; totalTokens: number; costUsd: number; costBrl: number }>;
};

export const emptyDayUsage = (): DayUsage => ({ tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, costUsd: 0, costBrl: 0, turns: 0, unmeasuredTurns: 0, providers: [] });

export type DayTotals = {
  ms: StateMs;
  /** Tempo de relógio com alguém esperando o dono (a união das esperas). */
  waitWallMs: number;
  waits: number;
  longestWaitMs: number;
  tasksDone: number;
  /** Etapas de projeto entregues (concluídas de verdade) no dia. */
  deliveries: number;
  tokens: DayUsage["tokens"];
  costUsd: number;
  costBrl: number;
  turns: number;
  unmeasuredTurns: number;
};

export type DayHour = { t: number; hour: number; ms: StateMs };
export type AgentDay = { id: string; name: string; ms: StateMs; waits: number; longestWaitMs: number };
export type SprintDay = { id: string; name: string; ms: StateMs; waits: number };
export type ProjectDay = { id: string; name: string; ms: StateMs; waits: number; sprints: SprintDay[] };
export type WaitView = WaitRecord & { agentName: string; projectName?: string; sprintName?: string; ms: number; msInDay: number };

export type DayCoverage = {
  /** A partir de quando há registro de estados (ISO); ausente = o relógio ainda não registrou nada. */
  clockFrom?: string;
  /** Neste dia há registro de estados: `none` (antes do relógio), `partial` (o relógio começou no meio do dia) ou `full`. */
  states: "none" | "partial" | "full";
};

export type DayStats = {
  day: string;
  start: number;
  end: number;
  totals: DayTotals;
  /** Uma entrada por hora do dia (23, 24 ou 25). */
  hours: DayHour[];
  /** Ordenados pelo tempo esperando você. */
  projects: ProjectDay[];
  agents: AgentDay[];
  providers: DayUsage["providers"];
  /** As `TOP_WAITS` maiores esperas que tocam o dia. */
  waits: WaitView[];
  /** O tempo de relógio com alguém esperando, em intervalos do dia (para somar os workspaces sem contar duas vezes). */
  waitWall: Array<[number, number]>;
  coverage: DayCoverage;
  compare?: DayCompare;
};

export type DayStatsInput = {
  day: string;
  now: number;
  /** O arquivo do relógio do dia (ausente = sem registro). */
  clock?: StateDayFile | null;
  /** A partir de quando há registro de estados (ms). */
  clockFrom?: number;
  items: readonly ForYouItem[];
  tasks: readonly Task[];
  projects: readonly Project[];
  agents: readonly Pick<Agent, "id" | "name">[];
  usage?: DayUsage;
};

const WAIT_WALL_MAX = 200;

function addClock(target: StateMs, source: ClockMs): void {
  for (const state of CLOCK_STATES) target[state] += source[state];
}

const nameMap = (pairs: ReadonlyArray<readonly [string, string]> | undefined) => new Map(pairs ?? []);

/** O dia montado por hora, agente, estado, projeto e sprint. Pura: o servidor passa os dados já lidos. */
export function buildDayStats(input: DayStatsInput): DayStats {
  const { day, now } = input;
  const { start, end } = dayRange(day);
  const usage = input.usage ?? emptyDayUsage();
  const file = input.clock ?? undefined;

  const agentNames = nameMap(file?.names.agents);
  for (const agent of input.agents) agentNames.set(agent.id, agent.name);
  const projectNames = nameMap(file?.names.projects);
  const sprintNames = nameMap(file?.names.sprints);
  for (const project of input.projects) {
    projectNames.set(project.id, project.title);
    for (const sprint of project.sprints ?? []) sprintNames.set(`${project.id}:${sprint.id}`, sprint.name);
  }
  const agentName = (id: string) => agentNames.get(id) ?? id;
  const projectName = (id: string) => projectNames.get(id) ?? id;
  const sprintName = (key: string) => sprintNames.get(key) ?? key.slice(key.indexOf(":") + 1);

  // Esperando você (dos itens do "Para você").
  const owner = ownerWaits(input.items, input.tasks, now, { projects: input.projects, range: { start, end } });
  const totalStats = zeroStateMs();
  const hours = new Map<number, StateMs>();
  const hourTimes: number[] = [];
  for (let t = hourStart(start); t < end; t += HOUR_MS) {
    if (t < start - HOUR_MS / 2 || t >= end) continue;
    hourTimes.push(t);
    hours.set(t, zeroStateMs());
  }
  const agents = new Map<string, AgentDay>();
  const projects = new Map<string, ProjectDay>();
  const sprints = new Map<string, SprintDay & { projectId: string }>();
  const agentOf = (id: string): AgentDay => {
    let found = agents.get(id);
    if (!found) agents.set(id, (found = { id, name: agentName(id), ms: zeroStateMs(), waits: 0, longestWaitMs: 0 }));
    return found;
  };
  const projectOf = (id: string): ProjectDay => {
    let found = projects.get(id);
    if (!found) projects.set(id, (found = { id, name: projectName(id), ms: zeroStateMs(), waits: 0, sprints: [] }));
    return found;
  };
  const sprintOf = (key: string): SprintDay & { projectId: string } => {
    let found = sprints.get(key);
    if (!found) sprints.set(key, (found = { id: key.slice(key.indexOf(":") + 1), projectId: key.slice(0, key.indexOf(":")), name: sprintName(key), ms: zeroStateMs(), waits: 0 }));
    return found;
  };

  for (const wait of owner.waits) {
    const from = Math.max(wait.start, start);
    const to = Math.min(wait.end, end);
    const sprintKey = wait.projectId && wait.sprintId ? `${wait.projectId}:${wait.sprintId}` : undefined;
    const agent = agentOf(wait.agentId);
    agent.waits += 1;
    agent.longestWaitMs = Math.max(agent.longestWaitMs, wait.end - wait.start);
    const project = wait.projectId ? projectOf(wait.projectId) : undefined;
    if (project) project.waits += 1;
    const sprint = sprintKey ? sprintOf(sprintKey) : undefined;
    if (sprint) sprint.waits += 1;
    forEachHour(from, to, (hour, ms) => {
      const bucket = hours.get(hour);
      if (bucket) bucket.waiting_owner += ms;
      totalStats.waiting_owner += ms;
      agent.ms.waiting_owner += ms;
      if (project) project.ms.waiting_owner += ms;
      if (sprint) sprint.ms.waiting_owner += ms;
    });
  }

  // Os outros estados (do relógio).
  for (const bucket of file?.buckets ?? []) {
    const hourMs = hours.get(bucket.t);
    if (!hourMs) continue;
    addClock(hourMs, bucket.ms);
    addClock(totalStats, bucket.ms);
    for (const [id, ms] of bucket.byAgent) addClock(agentOf(id).ms, ms);
    for (const [id, ms] of bucket.byProject) addClock(projectOf(id).ms, ms);
    for (const [key, ms] of bucket.bySprint) {
      if (!key.includes(":")) continue;
      addClock(sprintOf(key).ms, ms);
    }
  }
  for (const sprint of sprints.values()) {
    const project = projectOf(sprint.projectId);
    const { projectId: _projectId, ...row } = sprint;
    project.sprints.push(row);
  }
  const byWaiting = <T extends { ms: StateMs; name: string }>(a: T, b: T) => b.ms.waiting_owner - a.ms.waiting_owner || totalMs(b.ms) - totalMs(a.ms) || a.name.localeCompare(b.name);
  for (const project of projects.values()) project.sprints.sort(byWaiting);

  // Entregas e tarefas concluídas do dia.
  let tasksDone = 0;
  for (const task of input.tasks) {
    if (task.role === "request" || task.status !== "done") continue;
    const at = Date.parse(task.updatedAt);
    if (at >= start && at < end) tasksDone += 1;
  }
  let deliveries = 0;
  for (const project of input.projects) {
    for (const planTask of project.tasks) {
      if (planTask.status !== "concluida" || planTask.skipped || planTask.group) continue;
      const at = Date.parse(planTask.finishedAt ?? "");
      if (at >= start && at < end) deliveries += 1;
    }
  }

  const clockFrom = input.clockFrom;
  const statesCoverage: DayCoverage["states"] = clockFrom === undefined || clockFrom >= end ? "none" : clockFrom <= start ? "full" : "partial";
  const wallInDay = mergeIntervals(owner.waits.map((wait): [number, number] => [Math.max(wait.start, start), Math.min(wait.end, end)]));

  return {
    day,
    start,
    end,
    totals: {
      ms: totalStats,
      waitWallMs: owner.wallMs,
      waits: owner.waits.length,
      longestWaitMs: owner.longestMs,
      tasksDone,
      deliveries,
      tokens: { ...usage.tokens },
      costUsd: usage.costUsd,
      costBrl: usage.costBrl,
      turns: usage.turns,
      unmeasuredTurns: usage.unmeasuredTurns,
    },
    hours: hourTimes.map((t) => ({ t, hour: localHourOf(t), ms: hours.get(t)! })),
    projects: [...projects.values()].sort(byWaiting),
    agents: [...agents.values()].sort(byWaiting),
    providers: usage.providers,
    waits: owner.top.map((wait) => ({
      ...wait,
      agentName: agentName(wait.agentId),
      ...(wait.projectId ? { projectName: projectName(wait.projectId) } : {}),
      ...(wait.projectId && wait.sprintId ? { sprintName: sprintName(`${wait.projectId}:${wait.sprintId}`) } : {}),
      ms: wait.end - wait.start,
      msInDay: Math.max(0, Math.min(wait.end, end) - Math.max(wait.start, start)),
    })),
    waitWall: wallInDay.slice(0, WAIT_WALL_MAX),
    coverage: { ...(clockFrom !== undefined ? { clockFrom: new Date(clockFrom).toISOString() } : {}), states: statesCoverage },
  };
}

/** O dia não tem nada: nem tempo, nem esperas, nem gasto, nem entregas. */
export function isEmptyDay(stats: Pick<DayStats, "totals">): boolean {
  const { totals } = stats;
  return totalMs(totals.ms) === 0 && totals.waits === 0 && totals.turns === 0 && totals.tasksDone === 0 && totals.deliveries === 0;
}

// ---------- Comparações ----------

export const COMPARE_METRICS = ["waitingOwnerMs", "workingMs", "waitWallMs", "tokens", "costUsd", "tasksDone"] as const;
export type CompareMetric = (typeof COMPARE_METRICS)[number];
export type DayMetrics = Record<CompareMetric, number>;

export function metricsOf(stats: Pick<DayStats, "totals">): DayMetrics {
  const { totals } = stats;
  return {
    waitingOwnerMs: totals.ms.waiting_owner,
    workingMs: totals.ms.working,
    waitWallMs: totals.waitWallMs,
    tokens: totals.tokens.input + totals.tokens.output + totals.tokens.cacheRead + totals.tokens.cacheCreation,
    costUsd: totals.costUsd,
    tasksDone: totals.tasksDone,
  };
}

/** Base mínima de cada métrica para dar percentual (abaixo disso o percentual só assusta). */
export const COMPARE_MIN_BASE: DayMetrics = { waitingOwnerMs: COMPARE_MIN_BASE_MS, workingMs: COMPARE_MIN_BASE_MS, waitWallMs: COMPARE_MIN_BASE_MS, tokens: 10_000, costUsd: 0.1, tasksDone: 5 };

/** Menos espera é bom (verde); as outras métricas não têm lado (neutro). */
const LOWER_IS_BETTER: Record<CompareMetric, boolean> = { waitingOwnerMs: true, workingMs: false, waitWallMs: true, tokens: false, costUsd: false, tasksDone: false };

export type MetricDelta = {
  current: number;
  base: number;
  delta: number;
  /** Variação em % (sinal: positivo = subiu); só quando a base passa do mínimo. */
  pct?: number;
  sense: "better" | "worse" | "same" | "neutral";
};

export type DayComparison = {
  /** "AAAA-MM-DD" do dia comparado (ausente na média). */
  day?: string;
  /** Quantos dias entraram na média. */
  days?: number;
  metrics: Record<CompareMetric, MetricDelta>;
};

export type DayCompare = { yesterday?: DayComparison; sameWeekday?: DayComparison; avg7?: DayComparison };

function deltaOf(metric: CompareMetric, current: number, base: number): MetricDelta {
  const delta = current - base;
  const out: MetricDelta = { current, base, delta, sense: "neutral" };
  if (base >= COMPARE_MIN_BASE[metric] && base > 0) out.pct = Math.round((delta / base) * 100);
  const same = Math.abs(delta) < 1e-9;
  out.sense = same ? "same" : LOWER_IS_BETTER[metric] ? (delta < 0 ? "better" : "worse") : "neutral";
  return out;
}

function comparison(current: DayMetrics, base: DayMetrics, extra: { day?: string; days?: number }): DayComparison {
  const metrics = {} as Record<CompareMetric, MetricDelta>;
  for (const metric of COMPARE_METRICS) metrics[metric] = deltaOf(metric, current[metric], base[metric]);
  return { ...extra, metrics };
}

/** A média das métricas dos dias (só dos que têm dado). */
export function averageMetrics(list: readonly DayMetrics[]): DayMetrics | undefined {
  if (list.length === 0) return undefined;
  const out = {} as DayMetrics;
  for (const metric of COMPARE_METRICS) out[metric] = list.reduce((sum, item) => sum + item[metric], 0) / list.length;
  return out;
}

/**
 * Compara o dia com ontem, com o mesmo dia da semana passada e com a média dos 7 dias anteriores. Dia sem dados
 * não entra (não existe "queda de 100%" em um dia que não foi registrado); a média só usa os dias com dados.
 */
export function compareDays(current: Pick<DayStats, "totals">, refs: { yesterday?: DayStats; sameWeekday?: DayStats; last7?: readonly DayStats[] }): DayCompare {
  const now = metricsOf(current);
  const out: DayCompare = {};
  if (refs.yesterday && !isEmptyDay(refs.yesterday)) out.yesterday = comparison(now, metricsOf(refs.yesterday), { day: refs.yesterday.day });
  if (refs.sameWeekday && !isEmptyDay(refs.sameWeekday)) out.sameWeekday = comparison(now, metricsOf(refs.sameWeekday), { day: refs.sameWeekday.day });
  const withData = (refs.last7 ?? []).filter((stats) => !isEmptyDay(stats));
  const avg = averageMetrics(withData.map(metricsOf));
  if (avg) out.avg7 = comparison(now, avg, { days: withData.length });
  return out;
}

/** "48 s", "12 min", "1 h 10 min". */
export function formatDayDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hoursPart = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hoursPart} h` : `${hoursPart} h ${String(rest).padStart(2, "0")} min`;
}

/**
 * A frase pronta (por código, sem IA): "Hoje você fez os agentes esperarem 1 h 10 min a menos que ontem (▼ 38%).
 * A maior espera foi de Eco, no Site novo, 48 min." `label` é como o dia se chama ("Hoje", "Ontem", "Em 10/11").
 */
export function daySentence(stats: DayStats, options: { label?: string } = {}): string {
  const label = options.label ?? `Em ${stats.day.slice(8, 10)}/${stats.day.slice(5, 7)}`;
  const waiting = stats.totals.ms.waiting_owner;
  const parts: string[] = [];
  if (stats.totals.waits === 0) {
    parts.push(`${label} nenhum agente esperou por você.`);
  } else {
    let sentence = `${label} você fez os agentes esperarem ${formatDayDuration(waiting)}`;
    const versus = stats.compare?.yesterday?.metrics.waitingOwnerMs;
    if (versus && versus.sense !== "same") {
      const arrow = versus.delta < 0 ? "▼" : "▲";
      const how = `${formatDayDuration(Math.abs(versus.delta))} ${versus.delta < 0 ? "a menos" : "a mais"} que ontem`;
      sentence += ` (${how}${versus.pct !== undefined ? `, ${arrow} ${Math.abs(versus.pct)}%` : ""})`;
    }
    parts.push(`${sentence}.`);
    const top = stats.waits[0];
    if (top) parts.push(`A maior espera foi de ${top.agentName}${top.projectName ? `, no ${top.projectName}` : ""}, ${formatDayDuration(top.ms)}.`);
  }
  return parts.join(" ");
}

// ---------- A plataforma (todos os workspaces) ----------

export type PlatformDayPart = { workspace: string; name: string; stats: DayStats };

export type PlatformDayStats = {
  day: string;
  start: number;
  end: number;
  /** Os totais somados dos workspaces; o tempo de relógio com alguém esperando é a união entre eles. */
  totals: DayTotals;
  hours: DayHour[];
  /** Um resumo por workspace, na ordem de quem fez mais gente esperar. */
  workspaces: Array<{ workspace: string; name: string; totals: DayTotals; coverage: DayCoverage }>;
  /** As maiores esperas de todos os workspaces. */
  waits: Array<WaitView & { workspace: string; workspaceName: string }>;
  coverage: DayCoverage;
};

/** Soma os dias dos workspaces (a mesma conta do dia de um, sem misturar agentes de workspaces diferentes). */
export function buildPlatformDayStats(day: string, parts: readonly PlatformDayPart[]): PlatformDayStats {
  const { start, end } = dayRange(day);
  const ms = zeroStateMs();
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
  const totals: DayTotals = { ms, waitWallMs: 0, waits: 0, longestWaitMs: 0, tasksDone: 0, deliveries: 0, tokens, costUsd: 0, costBrl: 0, turns: 0, unmeasuredTurns: 0 };
  const hours = new Map<number, StateMs>();
  const order: number[] = [];
  const intervals: Array<[number, number]> = [];
  let clockFrom: number | undefined;
  for (const { stats } of parts) {
    for (const state of DAY_STATES) ms[state] += stats.totals.ms[state];
    totals.waits += stats.totals.waits;
    totals.longestWaitMs = Math.max(totals.longestWaitMs, stats.totals.longestWaitMs);
    totals.tasksDone += stats.totals.tasksDone;
    totals.deliveries += stats.totals.deliveries;
    for (const key of ["input", "output", "cacheRead", "cacheCreation"] as const) tokens[key] += stats.totals.tokens[key];
    totals.costUsd += stats.totals.costUsd;
    totals.costBrl += stats.totals.costBrl;
    totals.turns += stats.totals.turns;
    totals.unmeasuredTurns += stats.totals.unmeasuredTurns;
    intervals.push(...stats.waitWall);
    for (const hour of stats.hours) {
      let bucket = hours.get(hour.t);
      if (!bucket) {
        hours.set(hour.t, (bucket = zeroStateMs()));
        order.push(hour.t);
      }
      for (const state of DAY_STATES) bucket[state] += hour.ms[state];
    }
    const from = stats.coverage.clockFrom ? Date.parse(stats.coverage.clockFrom) : undefined;
    if (from !== undefined && (clockFrom === undefined || from < clockFrom)) clockFrom = from;
  }
  totals.waitWallMs = mergeIntervals(intervals).reduce((sum, [from, to]) => sum + (to - from), 0);
  const waits = parts
    .flatMap(({ workspace, name, stats }) => stats.waits.map((wait) => ({ ...wait, workspace, workspaceName: name })))
    .sort((a, b) => b.ms - a.ms || a.start - b.start)
    .slice(0, TOP_WAITS);
  const states: DayCoverage["states"] = clockFrom === undefined || clockFrom >= end ? "none" : clockFrom <= start ? "full" : "partial";
  return {
    day,
    start,
    end,
    totals,
    hours: order.sort((a, b) => a - b).map((t) => ({ t, hour: localHourOf(t), ms: hours.get(t)! })),
    workspaces: parts
      .map(({ workspace, name, stats }) => ({ workspace, name, totals: stats.totals, coverage: stats.coverage }))
      .sort((a, b) => b.totals.ms.waiting_owner - a.totals.ms.waiting_owner || a.name.localeCompare(b.name)),
    waits,
    coverage: { ...(clockFrom !== undefined ? { clockFrom: new Date(clockFrom).toISOString() } : {}), states },
  };
}

// ---------- Rotas ----------

/** `GET /api/w/:ws/day-stats/range?from&to`: os dias do intervalo (até `DAY_STATS_RANGE_MAX_DAYS`), sem a comparação. */
export type DayStatsRangeResponse = { from: string; to: string; days: DayStats[] };

/** `GET /api/w/:ws/day-stats/days`: os dias (dos últimos 90) com algum dado e a partir de quando há registro de estados. */
export type DayStatsDaysResponse = { days: string[]; clockFrom?: string };

/**
 * Valida `?day=`: ausente = hoje; formato e data exatos (400), não pode ser no futuro (400) nem fora dos 90 dias (404).
 * Devolve o dia ou o erro com o código HTTP.
 */
export function parseDayQuery(day: unknown, now: number): { ok: true; day: string } | { ok: false; status: 400 | 404; error: string } {
  const today = dayKeyOf(now);
  if (day === undefined || day === "") return { ok: true, day: today };
  if (typeof day !== "string" || !parseDayKey(day)) return { ok: false, status: 400, error: "Dia inválido (use AAAA-MM-DD)" };
  if (day > today) return { ok: false, status: 400, error: "Esse dia ainda não chegou" };
  if (day < addDays(today, -DAY_STATS_RETENTION_DAYS)) return { ok: false, status: 404, error: `Só há registro dos últimos ${DAY_STATS_RETENTION_DAYS} dias` };
  return { ok: true, day };
}
