import { z } from "zod";
import { MAX_ID_LENGTH, SAFE_ID_PATTERN } from "./ids";
import type { AutoGrant, ModeProposal, ProjectMode } from "./projects";
import type { GoalProjection } from "./goal-projection";

/**
 * Rotinas e metas: "10 convites por semana". O servidor vigia o ritmo sozinho (sem gastar token),
 * manda uma tarefa ao agente do time quando a meta está atrasada e só conta como FEITO o que foi
 * entregue: tarefa da rotina concluída (done, com o resultado enviado) e itens registrados com o link
 * durante ela. Item de tarefa que falhou, foi cancelada ou não terminou nunca conta.
 */

/** Fuso das semanas das rotinas (as semanas começam na segunda). */
export const ROUTINE_TIMEZONE = "America/Sao_Paulo";

export const ROUTINE_KINDS = ["post", "comment", "invite", "like", "other"] as const;
export type RoutineKind = (typeof ROUTINE_KINDS)[number];
export const ROUTINE_KIND_LABELS: Record<RoutineKind, string> = { post: "Posts", comment: "Comentários", invite: "Convites", like: "Curtidas", other: "Outra" };

/** Período da meta: semana ISO ou mês civil (fuso de São Paulo). */
export const ROUTINE_PERIODS = ["week", "month"] as const;
export type RoutinePeriod = (typeof ROUTINE_PERIODS)[number];

/** proposta = esperando o seu OK no "Para você"; ativa = vigiada; pausada; encerrada (fora das telas; arquivos antigos dizem "arquivada" e são lidos como encerrada). */
export const ROUTINE_STATUSES = ["proposta", "ativa", "pausada", "encerrada"] as const;
export type RoutineStatus = (typeof ROUTINE_STATUSES)[number];

/** registrado = o agente anotou com o link; entregue = a tarefa terminou (done); descartado = a tarefa falhou ou foi cancelada. */
export const ENTRY_STAGES = ["registrado", "entregue", "descartado"] as const;
export type EntryStage = (typeof ENTRY_STAGES)[number];

export const ROUTINE_LIMITS = { title: 120, unit: 40, site: 120, instruction: 4000, url: 2000, note: 500, target: 1000, batch: 5 } as const;

/** Rotina. `needsApproval` só o usuário muda (aprovando a proposta ou pela API da tela), nunca um agente. */
export type Routine = {
  /** "R-0001", sequencial por workspace. */
  id: string;
  title: string;
  /** O que se conta ("convite", "post"). */
  unit: string;
  kind: RoutineKind;
  /** Host do site da rotina ("linkedin.com"). */
  site: string;
  /** Meta por período (já limitada pelo teto semanal do tipo). */
  target: number;
  period: RoutinePeriod;
  /** Dono: um agente ou um time (o servidor escolhe o agente do time). */
  agentId?: string;
  teamId?: string;
  instruction: string;
  status: RoutineStatus;
  /** true (padrão) = as ações sensíveis da rotina pedem o seu OK; false = o navegador libera só as da lista do tipo, no site e dentro do teto diário. */
  needsApproval: boolean;
  /** Teto diário definido por você (sem ele vale o da tabela do tipo). */
  dailyCap?: number;
  pausedUntil?: string;
  /** Períodos pulados ("2026-W46"): sem cobrança nem veredito. */
  skipPeriods: string[];
  createdBy: "maestro" | "usuario";
  /** Rotina fabricada pela semente do app de teste (`dev/history-seed.ts`): aparece nas telas e nas contas, mas o vigia nunca a cobra nem acorda o Maestro por ela. */
  seed?: true;
  createdAt: string;
  updatedAt: string;
  lastDispatchAt?: string;
  lastTaskId?: string;
  /** Um aviso de risco por período: o último período em que o Maestro foi acordado por esta meta. */
  riskWokenPeriod?: string;
  /** Período em que perguntamos se queria baixar a meta (uma pergunta por sequência ruim). */
  lowerGoalAskedPeriod?: string;
  /** Tarefas seguidas da rotina que terminaram sem entregar nada (zera ao entregar; 3 pausam a rotina). */
  emptyStreak?: number;
  /** Por que está pausada pelo servidor (ex.: "3 tentativas sem entrega"). */
  pausedReason?: string;
  // ---------- Rotinas v2 (todos com padrão: o arquivo v1 continua legível) ----------
  /** meta = alvo por período (o vigia cuida); acompanhamento = horários + itens acompanhados. Padrão "meta". */
  type: RoutineType;
  /** Dono pelo endereço "workspace/agente" ou por time. Derivado de agentId/teamId ao gravar (os dois continuam valendo). */
  owner?: RoutineOwner;
  /** Pede OK (padrão) ou Automático com permissão. Espelha `needsApproval` (false = automático). */
  mode: RoutineMode;
  /** Sugestão de Automático: só vale depois do OK do usuário. */
  modeProposal?: RoutineModeProposal;
  /** Os horários da rotina, cada um com a sua ação. */
  schedules: RoutineSchedule[];
  /** Só type "meta". */
  goal?: MetaGoal;
  /** Só type "acompanhamento". */
  tracking?: TrackingSpec;
  /** Últimas execuções dos horários (até ROUTINE_RUNS_KEPT), das mais antigas para as mais novas. */
  lastRuns: RoutineRun[];
  /** Meta v2: opções preparadas, aprovadas e dispensadas por período (as últimas ROUTINE_STATS_KEPT chaves). */
  periodStats: Record<string, PeriodStats>;
  /** Modo Automático (R5): quanto o Automático já liberou HOJE nesta rotina (soma das execuções do dia; dia de São Paulo). */
  autoUsage?: { day: string; count: number };
  /** Acabamento: o agente não conseguiu executar (ex.: sem navegador) 2 vezes seguidas; o vigia para até "Tentar de novo". */
  blocked?: RoutineBlock;
  /** Tarefas seguidas da Meta sem entrega pelo MESMO motivo (zera ao entregar ou quando o motivo muda). */
  noDelivery?: { reason: string; count: number };
  /** Última vez que o vigia cobrou só o registro dos links das aprovadas (no máximo uma vez por espera). */
  linkChaseAt?: string;
};

/** Por que o vigia parou de tentar uma Meta. `reason` é o texto que a tela mostra. */
export type RoutineBlock = { kind: "sem_navegador" | "sem_entrega"; reason: string; since: string; attempts: number };
/** Depois de quantas tentativas seguidas sem entrega pelo mesmo motivo a rotina fica bloqueada. */
export const ROUTINE_BLOCK_AFTER = 2;
/** Opções de uma Meta com preparo, contadas no período: preparadas (cartões abertos), aprovadas e dispensadas ("meta batida"). */
export type PeriodStats = { prepared: number; approved: number; dismissed: number };
export const ROUTINE_STATS_KEPT = 12;
export const ROUTINE_MAX_EMPTY_TASKS = 3;

export const ROUTINE_TYPES = ["meta", "acompanhamento"] as const;
export type RoutineType = (typeof ROUTINE_TYPES)[number];
export const ROUTINE_TYPE_LABELS: Record<RoutineType, string> = { meta: "Meta", acompanhamento: "Acompanhamento" };

export type RoutineOwner = { address: string } | { teamId: string };
export type RoutineMode = ProjectMode;
export type RoutineModeProposal = ModeProposal;

/** 1 = segunda … 7 = domingo. */
export type Weekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;
export type ScheduleDays = { kind: "todo_dia" } | { kind: "uteis" } | { kind: "semana"; weekdays: Weekday[] } | { kind: "mes"; monthDay: number };

/** Um horário da rotina: dias, horas e o que fazer. Dispara direto para o agente do horário. */
export type RoutineSchedule = {
  /** "S1", sequencial por rotina. */
  id: string;
  label: string;
  days: ScheduleDays;
  /** "HH:MM" no fuso de São Paulo. */
  times: string[];
  /** A instrução DESTE horário. */
  action: string;
  /** Endereço "workspace/agente"; ausente = o dono da rotina. */
  agent?: string;
  /** "itens_vencidos": só roda se houver item para conferir (R2). */
  scope?: "geral" | "itens_vencidos";
  /** RESERVADO: gatilho "chegou e-mail". Sem implementação nesta rodada (nunca dispara). */
  trigger?: { kind: "email_novo"; connector: string };
  enabled: boolean;
  /** Último horário já tratado ("2026-11-11T08:00"): rodado, pulado ou ignorado. */
  lastSlotKey?: string;
};

export const ROUTINE_RUN_OUTCOMES = ["rodando", "ok", "falhou", "pulada"] as const;
export type RoutineRunOutcome = (typeof ROUTINE_RUN_OUTCOMES)[number];
/** Resumo de uma execução de horário (as telas "Hoje" e Gestão leem daqui). */
export type RoutineRun = {
  id: string;
  scheduleId?: string;
  slotKey?: string;
  /** Projeto kind "tarefa" que a execução criou (ausente quando foi pulada). */
  projectId?: string;
  taskId?: string;
  startedAt: string;
  endedAt?: string;
  outcome: RoutineRunOutcome;
  /** Resumo curto e limpo (primeira frase útil, sem markdown, até ~200 caracteres): a lista usa este. */
  summary?: string;
  /** O texto completo que o agente devolveu (com as quebras de linha): a tela usa ao abrir a execução. */
  detail?: string;
  /** Montado pelo servidor a partir do histórico dos itens (R2); nunca do texto do agente. */
  changes: RoutineRunChange[];
  skipReason?: string;
};
export const ROUTINE_RUNS_KEPT = 50;

/** Uma mudança de item numa execução: item novo, status que mudou, item encerrado (status final ou parado). */
export type RoutineRunChange = { itemId: string; text: string; kind?: "novo" | "status" | "encerrado"; /** O status novo é de alerta (destaque no aviso). */ alert?: boolean };

/** Meta v2 (R3): alvo por semana ou mês; dias preferidos são só sugestão. */
export type MetaGoal = {
  target: number;
  period: RoutinePeriod;
  preferredDays?: Weekday[];
  /** Padrão true: bateu, para até o próximo período. */
  stopOnHit: boolean;
  /** 1 a 3: quantos candidatos preparar por item da meta (padrão 1). */
  prepareFactor: number;
};

export const FIELD_TYPES = ["texto", "link", "data", "numero", "opcao"] as const;
export type FieldType = (typeof FIELD_TYPES)[number];
export type FieldDef = { key: string; label: string; type: FieldType; options?: string[]; required?: boolean };
export type TrackingStatus = { name: string; terminal?: boolean; alert?: boolean };
export type TrackingSpec = {
  fields: FieldDef[];
  /** O primeiro é o status inicial. */
  statuses: TrackingStatus[];
  /** Vida do item: dias, até um status terminal, os dois ou nenhum (sem fim). */
  lifespan: { days?: number; untilTerminal: boolean };
  /** Status gravado ao expirar (ex.: "Sem resposta"). */
  expireStatus?: string;
  /** Com que frequência cada item deve ser conferido. */
  checkEveryHours?: number;
};

export type TrackedItemState = "ativo" | "encerrado" | "parado";
export type TrackedItemHistory = { at: string; by: "agente" | "servidor" | "usuario"; taskId?: string; field?: string; from?: string; to?: string; note?: string };
/** Item acompanhado: vive em routines/<routineId>/items.json (fora de routines.json). */
export type TrackedItem = {
  /** "I-0001", sequencial por rotina. */
  id: string;
  routineId: string;
  values: Record<string, string | number>;
  /** Chave de origem (id da mensagem, link da vaga): evita duplicar. */
  sourceKey?: string;
  status: string;
  state: TrackedItemState;
  createdAt: string;
  expiresAt?: string;
  endedAt?: string;
  endReason?: "expirou" | "terminal" | "usuario" | "rotina_encerrada";
  lastCheckedAt?: string;
  /** Até TRACKED_HISTORY_KEPT mudanças. */
  history: TrackedItemHistory[];
};
export const TRACKED_HISTORY_KEPT = 200;
export type RoutineItemsFile = { version: 1; items: TrackedItem[] };

export const ROUTINE_SCHEDULE_LIMITS = { schedules: 12, times: 24, label: 80, action: 4000 } as const;

/** Item do livro-razão: um link que o agente registrou durante uma tarefa da rotina. */
export type RoutineEntry = {
  id: string;
  routineId: string;
  periodKey: string;
  url: string;
  note?: string;
  taskId: string;
  agentId: string;
  stage: EntryStage;
  at: string;
  /** Quando virou entregue/descartado. */
  settledAt?: string;
  /** "owner" = entrega feita ao próprio dono (sem publicação e sem link: `url` vazio, e a `note` diz o que foi entregue). */
  deliveredTo?: "owner";
};

/** Chave de uma entrega para não contar duas vezes: o link normalizado; sem link (entrega ao dono), o próprio id. */
export function routineEntryKey(entry: Pick<RoutineEntry, "id" | "url">): string {
  return entry.url ? (normalizeRoutineUrl(entry.url) ?? entry.url) : entry.id;
}

/** Prova de execução: uma ação sensível do navegador que passou (aprovada ou liberada pela rotina). */
export type RoutineExecution = {
  id: string;
  /** Ausente = a tarefa não era de uma rotina (a aprovação passou pelo caminho normal). */
  routineId?: string;
  host: string;
  label: string;
  /** click | type | press */
  actionKind: string;
  taskId?: string;
  agentId: string;
  /** aprovacao = você aprovou o pedido; rotina = a rotina "sem OK" liberou; livre = o workspace não pede aprovação. */
  via: "aprovacao" | "rotina" | "livre";
  at: string;
};

/** Registro curto de uma decisão do vigia (despachou ou pulou, com o motivo). */
export type RoutineDecision = { at: string; kind: "dispatched" | "skipped" | "closed" | "wake" | "ask"; reason: string; taskId?: string };
export const ROUTINE_DECISIONS_KEPT = 200;
export const ROUTINE_EXECUTIONS_KEPT = 1000;

export type RoutinePeriodOutcome = "bateu" | "nao_bateu" | "pulada";
/** Resultado gravado no fechamento de um período. */
export type RoutineResult = {
  routineId: string;
  periodKey: string;
  target: number;
  delivered: number;
  outcome: RoutinePeriodOutcome;
  /** Meta v2 (R3): candidatos preparados, aprovados e dispensados no período. */
  prepared?: number;
  approved?: number;
  dismissed?: number;
};

/** Conteúdo de routines.json. */
export type RoutinesData = {
  /** Formato do arquivo: 2 = rotinas v2 (tipo, modo, horários). Arquivos sem versão são v1 e são lidos com padrões. */
  version: 2;
  routines: Routine[];
  entries: RoutineEntry[];
  executions: RoutineExecution[];
  decisions: Record<string, RoutineDecision[]>;
  results: RoutineResult[];
  /** Último período FECHADO (resumo semanal já enviado). */
  closedPeriod?: string;
  /** Último mês FECHADO (as metas mensais fecham no dia 1, 08:00). */
  closedMonth?: string;
};

export const emptyRoutinesData = (): RoutinesData => ({ version: 2, routines: [], entries: [], executions: [], decisions: {}, results: [] });

// ---------- Limites do site (v1: tabela do LinkedIn, fixa no código) ----------

export type RoutineLimit = { daily?: number; weekly?: number };
export const ROUTINE_LIMITS_TABLE: Record<RoutineKind, RoutineLimit> = {
  invite: { daily: 15, weekly: 60 },
  comment: { daily: 8 },
  post: { daily: 1 },
  like: { daily: 30, weekly: 100 },
  other: {},
};

/** Teto diário efetivo (o seu, nunca acima do da tabela). Sem teto = undefined. */
export function dailyCapOf(routine: Pick<Routine, "kind" | "dailyCap">): number | undefined {
  const table = ROUTINE_LIMITS_TABLE[routine.kind].daily;
  if (routine.dailyCap === undefined) return table;
  return table === undefined ? routine.dailyCap : Math.min(table, routine.dailyCap);
}

/** Meta limitada ao teto semanal do tipo (e, sem teto semanal, a 7x o diário). */
export function clampTarget(kind: RoutineKind, target: number, period: RoutinePeriod = "week"): number {
  const limit = ROUTINE_LIMITS_TABLE[kind];
  const week = limit.weekly ?? (limit.daily !== undefined ? limit.daily * 7 : ROUTINE_LIMITS.target);
  // Mês = até 5 semanas do teto semanal do tipo.
  const cap = Math.min(ROUTINE_LIMITS.target, period === "month" ? week * 5 : week);
  return Math.max(1, Math.min(Math.floor(target), cap));
}

// ---------- Períodos (semana ISO no fuso de São Paulo) ----------

export type ZonedParts = { year: number; month: number; day: number; hour: number; minute: number; second: number };
const formatters = new Map<string, Intl.DateTimeFormat>();

export function zoned(ms: number, timeZone: string): ZonedParts {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    formatters.set(timeZone, formatter);
  }
  const parts: Record<string, string> = {};
  for (const part of formatter.formatToParts(new Date(ms))) parts[part.type] = part.value;
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), hour: Number(parts.hour) % 24, minute: Number(parts.minute), second: Number(parts.second) };
}

/** Instante em que começa o dia local (y-m-d) no fuso. */
export function startOfLocalDay(year: number, month: number, day: number, timeZone: string): number {
  const guess = Date.UTC(year, month - 1, day);
  let ms = guess;
  for (let i = 0; i < 2; i += 1) {
    const p = zoned(ms, timeZone);
    ms = guess - (Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - ms);
  }
  return ms;
}

export const pad2 = (n: number) => String(n).padStart(2, "0");

/** Dia (UTC puro) do calendário somado de `days`. */
export function shiftDay(year: number, month: number, day: number, days: number): { year: number; month: number; day: number } {
  const at = new Date(Date.UTC(year, month - 1, day + days));
  return { year: at.getUTCFullYear(), month: at.getUTCMonth() + 1, day: at.getUTCDate() };
}

/** Dia da semana ISO: 1 = segunda … 7 = domingo. */
export function isoWeekday(year: number, month: number, day: number): number {
  return ((new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7) + 1;
}

/** Ano e número da semana ISO do dia (a semana é do ano da sua quinta-feira). */
function isoWeekOf(year: number, month: number, day: number): { isoYear: number; week: number } {
  const thursday = shiftDay(year, month, day, 4 - isoWeekday(year, month, day));
  const jan1 = Date.UTC(thursday.year, 0, 1);
  const week = Math.floor((Date.UTC(thursday.year, thursday.month - 1, thursday.day) - jan1) / 86_400_000 / 7) + 1;
  return { isoYear: thursday.year, week };
}

export type PeriodBounds = { key: string; start: Date; end: Date };

/** "2026-W46": semana ISO (começa na segunda) em que o instante cai, no fuso de São Paulo (não no do servidor). */
export function periodKey(date: Date, timeZone: string = ROUTINE_TIMEZONE): string {
  const p = zoned(date.getTime(), timeZone);
  const { isoYear, week } = isoWeekOf(p.year, p.month, p.day);
  return `${isoYear}-W${pad2(week)}`;
}

/** Início (segunda 00:00 local) e fim (a segunda seguinte, exclusivo) da semana do instante. */
export function periodBounds(date: Date, timeZone: string = ROUTINE_TIMEZONE): PeriodBounds {
  const p = zoned(date.getTime(), timeZone);
  const monday = shiftDay(p.year, p.month, p.day, 1 - isoWeekday(p.year, p.month, p.day));
  const next = shiftDay(monday.year, monday.month, monday.day, 7);
  return {
    key: periodKey(date, timeZone),
    start: new Date(startOfLocalDay(monday.year, monday.month, monday.day, timeZone)),
    end: new Date(startOfLocalDay(next.year, next.month, next.day, timeZone)),
  };
}

/** Limites da semana de uma chave "2026-W46" (undefined se a chave for inválida). */
export function periodBoundsOfKey(key: string, timeZone: string = ROUTINE_TIMEZONE): PeriodBounds | undefined {
  const monthly = /^(\d{4})-M(\d{2})$/.exec(key);
  if (monthly) {
    const year = Number(monthly[1]);
    const month = Number(monthly[2]);
    if (month < 1 || month > 12) return undefined;
    return monthBounds(year, month, timeZone);
  }
  const match = /^(\d{4})-W(\d{2})$/.exec(key);
  if (!match) return undefined;
  const year = Number(match[1]);
  const week = Number(match[2]);
  if (week < 1 || week > 53) return undefined;
  // 4 de janeiro está sempre na semana 1 ISO.
  const jan4 = shiftDay(year, 1, 4, 0);
  const monday1 = shiftDay(jan4.year, jan4.month, jan4.day, 1 - isoWeekday(jan4.year, jan4.month, jan4.day));
  const monday = shiftDay(monday1.year, monday1.month, monday1.day, (week - 1) * 7);
  const bounds = periodBounds(new Date(startOfLocalDay(monday.year, monday.month, monday.day, timeZone) + 3_600_000), timeZone);
  return bounds.key === key ? bounds : undefined;
}

/** Mês civil (dia 1 00:00 local até o dia 1 do mês seguinte, exclusivo); chave "2026-M11". */
function monthBounds(year: number, month: number, timeZone: string): PeriodBounds {
  const next = month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 };
  return {
    key: `${year}-M${pad2(month)}`,
    start: new Date(startOfLocalDay(year, month, 1, timeZone)),
    end: new Date(startOfLocalDay(next.year, next.month, 1, timeZone)),
  };
}

/** Período (semana ISO ou mês) em que o instante cai, no fuso de São Paulo. */
export function periodBoundsFor(date: Date, period: RoutinePeriod, timeZone: string = ROUTINE_TIMEZONE): PeriodBounds {
  if (period === "week") return periodBounds(date, timeZone);
  const p = zoned(date.getTime(), timeZone);
  return monthBounds(p.year, p.month, timeZone);
}

/** Chave do período do instante: "2026-W46" (semana) ou "2026-M11" (mês). */
export function periodKeyFor(date: Date, period: RoutinePeriod, timeZone: string = ROUTINE_TIMEZONE): string {
  return periodBoundsFor(date, period, timeZone).key;
}

/** Qual período a chave descreve ("2026-M11" = mês; o resto, semana). */
export function periodOfKey(key: string): RoutinePeriod {
  return /^\d{4}-M\d{2}$/.test(key) ? "month" : "week";
}

/** Os `count` períodos anteriores ao do instante (semana ou mês), do mais antigo ao mais novo. */
export function previousPeriodKeysFor(date: Date, period: RoutinePeriod, count: number, timeZone: string = ROUTINE_TIMEZONE): string[] {
  const keys: string[] = [];
  let cursor = periodBoundsFor(date, period, timeZone).start.getTime();
  for (let i = 0; i < count; i += 1) {
    cursor -= 3_600_000;
    const bounds = periodBoundsFor(new Date(cursor), period, timeZone);
    keys.unshift(bounds.key);
    cursor = bounds.start.getTime();
  }
  return keys;
}

/** A chave do período anterior ao do instante, na semana ou no mês. */
export function previousPeriodKeyFor(date: Date, period: RoutinePeriod, timeZone: string = ROUTINE_TIMEZONE): string {
  return previousPeriodKeysFor(date, period, 1, timeZone)[0]!;
}

/** Fechamento do período ANTERIOR: segunda (semana) ou dia 1 (mês), 08:00 local. */
export function closeAtFor(date: Date, period: RoutinePeriod, timeZone: string = ROUTINE_TIMEZONE): Date {
  return new Date(periodBoundsFor(date, period, timeZone).start.getTime() + 8 * 3_600_000);
}

/** A chave do período anterior ao do instante. */
export function previousPeriodKey(date: Date, timeZone: string = ROUTINE_TIMEZONE): string {
  return periodKey(new Date(periodBounds(date, timeZone).start.getTime() - 3_600_000), timeZone);
}

/** Os `count` períodos anteriores ao do instante, do mais antigo ao mais novo. */
export function previousPeriodKeys(date: Date, count: number, timeZone: string = ROUTINE_TIMEZONE): string[] {
  const keys: string[] = [];
  let cursor = periodBounds(date, timeZone).start.getTime();
  for (let i = 0; i < count; i += 1) {
    cursor -= 3_600_000;
    const bounds = periodBounds(new Date(cursor), timeZone);
    keys.unshift(bounds.key);
    cursor = bounds.start.getTime();
  }
  return keys;
}

/** Dia local do instante ("2026-11-10"). */
export function localDayKey(date: Date, timeZone: string = ROUTINE_TIMEZONE): string {
  const p = zoned(date.getTime(), timeZone);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}

/** Início do dia local do instante. */
export function localDayStart(date: Date, timeZone: string = ROUTINE_TIMEZONE): Date {
  const p = zoned(date.getTime(), timeZone);
  return new Date(startOfLocalDay(p.year, p.month, p.day, timeZone));
}

/** Segunda-feira 08:00 local da semana do instante: o fechamento semanal da semana ANTERIOR acontece a partir dele. */
export function weeklyCloseAt(date: Date, timeZone: string = ROUTINE_TIMEZONE): Date {
  return new Date(periodBounds(date, timeZone).start.getTime() + 8 * 3_600_000);
}

/** Quanto da meta já deveria estar entregue agora: espalhada pela semana (arredonda para cima; no começo da semana já pede o primeiro). */
export function expectedByNow(target: number, now: Date, bounds: Pick<PeriodBounds, "start" | "end">): number {
  const total = bounds.end.getTime() - bounds.start.getTime();
  if (total <= 0) return target;
  const fraction = Math.min(1, Math.max(0, (now.getTime() - bounds.start.getTime()) / total));
  return Math.min(target, Math.max(0, Math.ceil(target * fraction - 1e-9)));
}

export const PACE_STATUSES = ["no_ritmo", "adiantada", "atrasada", "pausada", "concluida"] as const;
export type PaceStatus = (typeof PACE_STATUSES)[number];
export const PACE_LABELS: Record<PaceStatus, string> = { no_ritmo: "No ritmo", adiantada: "Adiantada", atrasada: "Atrasada", pausada: "Pausada", concluida: "Batida" };

export function paceStatus(input: { delivered: number; target: number; expected: number; paused?: boolean }): PaceStatus {
  if (input.delivered >= input.target) return "concluida";
  if (input.paused) return "pausada";
  if (input.delivered < input.expected) return "atrasada";
  if (input.delivered > input.expected) return "adiantada";
  return "no_ritmo";
}

/** A rotina está em pausa agora? (status pausada ou `pausedUntil` no futuro) */
export function isRoutinePaused(routine: Pick<Routine, "status" | "pausedUntil">, now: Date): boolean {
  if (routine.status === "pausada") return true;
  return routine.pausedUntil !== undefined && Date.parse(routine.pausedUntil) > now.getTime();
}

// ---------- Rótulos permitidos sem OK (por tipo; lista conservadora) ----------

/** Rótulos que NUNCA passam sem OK, em nenhum tipo (vale antes da lista do tipo). */
export const ROUTINE_NEVER_LABELS = ["conectar", "connect", "enviar mensagem", "send message", "message", "mensagem", "seguir", "follow", "comprar", "buy", "pagar", "pay", "purchase", "excluir", "delete", "apagar", "compartilhar", "share", "repost"] as const;

/** Rótulos de clique liberados pelo tipo da rotina quando ela é "sem OK" (comparação exata, sem acento nem caixa). */
export const ROUTINE_ALLOWED_LABELS: Record<RoutineKind, readonly string[]> = {
  comment: ["comentar", "publicar", "publicar comentario", "comment", "post", "post comment", "enviar comentario"],
  post: ["publicar", "postar", "post"],
  invite: ["enviar convite", "enviar sem nota", "send invitation", "send invite", "send without a note"],
  like: ["curtir", "like", "gostei"],
  other: [],
};

/** Minúsculas, sem acento, sem pontuação nas pontas e com espaços simples. */
export function normalizeRoutineLabel(label: string): string {
  return label
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[\s….!:;,]+$/g, "")
    .replace(/^[\s.!:;,]+/g, "")
    .replace(/\s+/g, " ");
}

/** O rótulo do botão está na lista do tipo (e não na lista de proibidos)? */
export function routineLabelAllowed(kind: RoutineKind, label: string): boolean {
  const normalized = normalizeRoutineLabel(label);
  if (!normalized) return false;
  if ((ROUTINE_NEVER_LABELS as readonly string[]).includes(normalized)) return false;
  return ROUTINE_ALLOWED_LABELS[kind].includes(normalized);
}

/** O host do clique é o site da rotina (ou um subdomínio dele)? */
export function hostMatchesSite(host: string, site: string): boolean {
  const h = host.toLowerCase().replace(/^www\./, "");
  const s = site.toLowerCase().replace(/^www\./, "");
  return h === s || h.endsWith(`.${s}`);
}

/** Normaliza um link para comparar duplicados (sem #, sem barra final, host sem www). */
export function normalizeRoutineUrl(url: string): string | undefined {
  const match = /^https?:\/\/(?:[^@/?#]*@)?([^:/?#]+)(?::\d+)?([^?#]*)(\?[^#]*)?/i.exec(url.trim());
  if (!match) return undefined;
  const host = match[1]!.toLowerCase().replace(/^www\./, "");
  const path = (match[2] ?? "").replace(/\/+$/, "");
  return `${host}${path}${match[3] ?? ""}`;
}

// ---------- Contas de progresso (funções puras sobre o livro-razão) ----------

function distinctUrls(entries: readonly RoutineEntry[], routineId: string, key: string, stage: EntryStage): number {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (entry.routineId !== routineId || entry.periodKey !== key || entry.stage !== stage) continue;
    seen.add(routineEntryKey(entry));
  }
  return seen.size;
}

/** Entregues no período, sem repetir o link. */
export function deliveredCount(entries: readonly RoutineEntry[], routineId: string, key: string): number {
  return distinctUrls(entries, routineId, key, "entregue");
}

/** Registrados que ainda esperam a entrega da tarefa (não contam). */
export function registeredCount(entries: readonly RoutineEntry[], routineId: string, key: string): number {
  return distinctUrls(entries, routineId, key, "registrado");
}

// ---------- Esquemas da API ----------

const idPart = z.string().max(MAX_ID_LENGTH).regex(SAFE_ID_PATTERN, "id inválido");
export const ROUTINE_ID_PATTERN = /^R-(\d{4,})$/;
export const routineIdSchema = z.string().regex(ROUTINE_ID_PATTERN, "id de rotina inválido");
export const routineParamsSchema = z.object({ id: routineIdSchema });
export const routineScheduleParamsSchema = z.object({ id: routineIdSchema, scheduleId: z.string().regex(/^S\d+$/, "id de horário inválido") });

/** Próximo id ("R-0001"…). */
export function nextRoutineId(routines: readonly Pick<Routine, "id">[]): string {
  let max = 0;
  for (const routine of routines) {
    const match = ROUTINE_ID_PATTERN.exec(routine.id);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `R-${String(max + 1).padStart(4, "0")}`;
}

export const routineSiteSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(ROUTINE_LIMITS.site)
  .regex(/^(?:www\.)?(?:[a-z0-9-]+\.)+[a-z]{2,}$/, "use só o domínio, ex.: linkedin.com")
  .transform((site) => site.replace(/^www\./, ""));

const fields = {
  title: z.string().trim().min(1).max(ROUTINE_LIMITS.title),
  unit: z.string().trim().min(1).max(ROUTINE_LIMITS.unit),
  kind: z.enum(ROUTINE_KINDS),
  site: routineSiteSchema,
  target: z.number().int().min(1).max(ROUTINE_LIMITS.target),
  instruction: z.string().trim().max(ROUTINE_LIMITS.instruction),
};

// ---------- Horários, metas e acompanhamento (esquemas) ----------

const hhmmSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "use HH:MM (00:00 a 23:59)");
const weekdaySchema = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5), z.literal(6), z.literal(7)]);
export const scheduleDaysSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("todo_dia") }),
  z.object({ kind: z.literal("uteis") }),
  z.object({ kind: z.literal("semana"), weekdays: z.array(weekdaySchema).min(1).max(7) }),
  z.object({ kind: z.literal("mes"), monthDay: z.number().int().min(1).max(31) }),
]);
const addressSchema = z.string().trim().regex(/^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/, 'use o endereço "workspace/agente"');
const scheduleTriggerSchema = z.object({ kind: z.literal("email_novo"), connector: z.string().max(120) });
const scheduleIdSchema = z.string().regex(/^S\d{1,3}$/, "id de horário inválido");

/** Horas sem repetição, em ordem. */
const sortedTimes = (times: string[]) => [...new Set(times)].sort();

const autoGrantSchema = z.object({
  actions: z.array(z.string()),
  sites: z.array(z.string()).optional(),
  connectors: z.array(z.string()).optional(),
  dailyCap: z.number().int().min(0).optional(),
  approvedAt: z.iso.datetime(),
});
const modeSchema = z.discriminatedUnion("kind", [z.object({ kind: z.literal("pede-ok") }), z.object({ kind: z.literal("automatico"), grant: autoGrantSchema })]);

/** Horário como o usuário o escreve (sem a marca de execução). Com `id` mantém o horário que já existe. */
export const scheduleInputSchema = z
  .strictObject({
    id: scheduleIdSchema.optional(),
    label: z.string().trim().min(1).max(ROUTINE_SCHEDULE_LIMITS.label),
    days: scheduleDaysSchema,
    times: z.array(hhmmSchema).max(ROUTINE_SCHEDULE_LIMITS.times).default([]),
    action: z.string().trim().min(1).max(ROUTINE_SCHEDULE_LIMITS.action),
    agent: addressSchema.optional(),
    scope: z.enum(["geral", "itens_vencidos"]).optional(),
    trigger: scheduleTriggerSchema.optional(),
    enabled: z.boolean().default(true),
  })
  .refine((schedule) => schedule.trigger !== undefined || schedule.times.length > 0, { message: "Informe pelo menos uma hora", path: ["times"] })
  .transform((schedule) => ({ ...schedule, times: sortedTimes(schedule.times) }));
export type ScheduleInput = z.input<typeof scheduleInputSchema>;

const metaGoalInputSchema = z.strictObject({
  target: z.number().int().min(1).max(ROUTINE_LIMITS.target),
  period: z.enum(ROUTINE_PERIODS).default("week"),
  preferredDays: z.array(weekdaySchema).max(7).optional(),
  stopOnHit: z.boolean().default(true),
  prepareFactor: z.number().int().min(1).max(3).default(1),
});

export const fieldDefSchema = z.object({
  key: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/, "chave inválida"),
  label: z.string().min(1).max(80),
  type: z.enum(FIELD_TYPES),
  options: z.array(z.string().max(80)).max(30).optional(),
  required: z.boolean().optional(),
});
export const trackingSpecSchema = z.object({
  fields: z.array(fieldDefSchema).max(30).default([]),
  statuses: z.array(z.object({ name: z.string().min(1).max(60), terminal: z.boolean().optional(), alert: z.boolean().optional() })).min(1).max(20).default([{ name: "Ativo" }]),
  lifespan: z.object({ days: z.number().int().min(1).max(3650).optional(), untilTerminal: z.boolean() }).default({ untilTerminal: false }),
  expireStatus: z.string().max(60).optional(),
  checkEveryHours: z.number().int().min(1).max(24 * 90).optional(),
});

/** POST /routines: você cria direto (nasce ativa). Dono: agente, time OU endereço "workspace/agente". Meta pede site e alvo; Acompanhamento pede horários. */
export const createRoutineBodySchema = z
  .strictObject({
    type: z.enum(ROUTINE_TYPES).default("meta"),
    title: fields.title,
    unit: fields.unit.default("item"),
    kind: fields.kind.default("other"),
    site: routineSiteSchema.optional(),
    target: fields.target.optional(),
    instruction: fields.instruction.default(""),
    period: z.enum(ROUTINE_PERIODS).default("week"),
    agentId: idPart.optional(),
    teamId: idPart.optional(),
    address: addressSchema.optional(),
    needsApproval: z.boolean().default(true),
    dailyCap: z.number().int().min(1).max(1000).optional(),
    schedules: z.array(scheduleInputSchema).max(ROUTINE_SCHEDULE_LIMITS.schedules).default([]),
    goal: metaGoalInputSchema.optional(),
    tracking: trackingSpecSchema.optional(),
  })
  .superRefine((body, ctx) => {
    const owners = [body.agentId, body.teamId, body.address].filter((value) => value !== undefined).length;
    if (owners !== 1) ctx.addIssue({ code: "custom", message: "Informe o agente OU o time dono da rotina", path: ["agentId"] });
    if (body.type === "meta") {
      if (body.site === undefined) ctx.addIssue({ code: "custom", message: "A meta precisa do site (ex.: linkedin.com)", path: ["site"] });
      if (body.target === undefined && body.goal === undefined) ctx.addIssue({ code: "custom", message: "A meta precisa do alvo", path: ["target"] });
    } else if (body.schedules.length === 0) {
      ctx.addIssue({ code: "custom", message: "O acompanhamento precisa de pelo menos um horário", path: ["schedules"] });
    }
  });
export type CreateRoutineBody = z.input<typeof createRoutineBodySchema>;

/** PATCH /routines/:id (só você): campos, horários, pausar/retomar/encerrar e pular a semana. */
export const updateRoutineBodySchema = z.strictObject({
  /** Pula o PRÓXIMO período (semana ou mês) da meta, além do atual. */
  skipNextPeriod: z.boolean().optional(),
  title: fields.title.optional(),
  unit: fields.unit.optional(),
  /** Tipo do que se conta (muda os tetos do site: o alvo e o teto diário são reajustados). */
  kind: fields.kind.optional(),
  /** Site da rotina (só o domínio, ex.: instagram.com). */
  site: routineSiteSchema.optional(),
  target: fields.target.optional(),
  instruction: fields.instruction.optional(),
  needsApproval: z.boolean().optional(),
  dailyCap: z.number().int().min(1).max(1000).nullable().optional(),
  agentId: idPart.nullable().optional(),
  teamId: idPart.nullable().optional(),
  /** "arquivada" é o nome antigo de "encerrada". */
  status: z.enum(["ativa", "pausada", "encerrada", "arquivada"]).optional(),
  pausedUntil: z.iso.datetime().nullable().optional(),
  /** Pular (true) ou voltar a cobrar (false) a semana atual. */
  skipThisPeriod: z.boolean().optional(),
  /** Troca a lista inteira de horários (com `id` mantém o horário; sem `id` é novo). */
  schedules: z.array(scheduleInputSchema).max(ROUTINE_SCHEDULE_LIMITS.schedules).optional(),
  /** Meta: o que mudar do alvo (período, dias preferidos, parar ao bater, fator de preparo). `preferredDays: null` limpa. */
  /** Acompanhamento: ajusta o esquema. Campos e status só podem ser ACRESCENTADOS (os que existem ficam, os itens dependem deles). `null` limpa expireStatus e checkEveryHours. */
  tracking: z
    .strictObject({
      fields: z.array(fieldDefSchema).max(30).optional(),
      statuses: z.array(z.object({ name: z.string().min(1).max(60), terminal: z.boolean().optional(), alert: z.boolean().optional() })).min(1).max(20).optional(),
      lifespan: z.object({ days: z.number().int().min(1).max(3650).optional(), untilTerminal: z.boolean() }).optional(),
      expireStatus: z.string().max(60).nullable().optional(),
      checkEveryHours: z.number().int().min(1).max(24 * 90).nullable().optional(),
    })
    .optional(),
  goal: z
    .strictObject({
      period: z.enum(ROUTINE_PERIODS).optional(),
      preferredDays: z.array(weekdaySchema).max(7).nullable().optional(),
      stopOnHit: z.boolean().optional(),
      prepareFactor: z.number().int().min(1).max(3).optional(),
    })
    .optional(),
});
export type UpdateRoutineBody = z.input<typeof updateRoutineBodySchema>;

/** GET /routines/:id/next?count=5 */
export const routineNextQuerySchema = z
  .object({
    count: z.coerce.number().int().min(1).max(500).default(5),
    /** Período pedido (ISO): só os horários dentro dele (`count` vira o teto). Sem `to`, vale só o `count` a partir de agora. */
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
  })
  .refine((q) => !q.from || !q.to || Date.parse(q.from) <= Date.parse(q.to), { message: "from deve vir antes de to" })
  .refine((q) => !q.from || !q.to || Date.parse(q.to) - Date.parse(q.from) <= 100 * 86_400_000, { message: "o período pode ter no máximo 100 dias" });

/** Ajustes que você faz ao aprovar a proposta (cartão "rotina" do Para você). */
export const routineApprovalOverridesSchema = z.strictObject({
  needsApproval: z.boolean().optional(),
  /** R5: o modo escolhido no cartão. "automatico" só vale se o Maestro sugeriu um escopo (o cartão guarda); sem escolha, Pede OK. */
  mode: z.enum(["pede-ok", "automatico"]).optional(),
  target: z.number().int().min(1).max(ROUTINE_LIMITS.target).optional(),
  dailyCap: z.number().int().min(1).max(1000).optional(),
});
export type RoutineApprovalOverrides = z.infer<typeof routineApprovalOverridesSchema>;

/**
 * Conteúdo do cartão "rotina" do Para você (campo `routine` do item): o que o card mostra e o que
 * você pode ajustar. `mode` "criar" = proposta nova; "ajustar" = pergunta de baixar a meta de uma
 * rotina que já existe (depois de 2 semanas ruins); "revisar" = a rotina foi pausada por 3 tentativas
 * sem entrega (aprovar = retomar, recusar = continua pausada).
 */
export type RoutineProposalPayload = {
  routineId: string;
  /** criar = rotina nova; alterar = mudança numa rotina que já existe (traz `before`, `view` e `patch`); ajustar = baixar a meta; revisar = retomar rotina pausada. */
  mode: "criar" | "ajustar" | "revisar" | "alterar";
  title: string;
  unit: string;
  kind: RoutineKind;
  site: string;
  target: number;
  period: RoutinePeriod;
  /** Nome de quem executa (agente ou time). */
  owner: string;
  instruction: string;
  needsApproval: boolean;
  /** O que o Maestro sugeriu para "precisa do meu OK" (só uma sugestão: vale o que você escolher ao aprovar; sem escolha fica true). */
  suggestedNeedsApproval?: boolean;
  dailyCap?: number;
  /** Limites do tipo (para o card avisar). */
  limits: RoutineLimit;
  /** "ajustar": a meta sugerida (menor). */
  suggestedTarget?: number;
  reason?: string;
  // ---------- R5: rotina v2 no cartão ----------
  /** Tipo da rotina proposta (ausente = meta, como nos cartões antigos). */
  type?: RoutineType;
  /** A rotina como ela ficará (horários, meta ou esquema de itens). */
  view?: RoutineProposalView;
  /** "alterar": a rotina como é hoje (o cartão mostra o antes e o depois). */
  before?: RoutineProposalView;
  /** "alterar": o que será aplicado ao aprovar (o servidor guarda; o corpo da decisão nunca o muda). */
  patch?: UpdateRoutineBody;
  /** O Automático sugerido pelo Maestro (só vale se você escolher ligar no cartão). */
  suggestedMode?: RoutineSuggestedMode;
};

/** O escopo do Automático que o Maestro sugere (sem `approvedAt`: só o usuário aprova). */
export type RoutineSuggestedMode = { actions: string[]; sites?: string[]; connectors?: string[]; dailyCap?: number };

/** Um horário como o cartão o mostra. */
export type RoutineProposalSchedule = { id?: string; label: string; days: ScheduleDays; times: string[]; action: string; agent?: string; agentName?: string; scope?: "geral" | "itens_vencidos"; enabled: boolean };
/** Retrato legível de uma rotina para o cartão de proposta (criar e alterar). */
export type RoutineProposalView = {
  title: string;
  type: RoutineType;
  owner: string;
  instruction?: string;
  site?: string;
  schedules: RoutineProposalSchedule[];
  goal?: MetaGoal;
  tracking?: TrackingSpec;
};

const suggestedModeSchema = z.object({
  actions: z.array(z.string()),
  sites: z.array(z.string()).optional(),
  connectors: z.array(z.string()).optional(),
  dailyCap: z.number().int().min(0).optional(),
});
const proposalScheduleSchema = z.object({
  id: z.string().optional(),
  label: z.string(),
  days: scheduleDaysSchema,
  times: z.array(hhmmSchema),
  action: z.string(),
  agent: z.string().optional(),
  agentName: z.string().optional(),
  scope: z.enum(["geral", "itens_vencidos"]).optional(),
  enabled: z.boolean(),
});
const proposalMetaGoalSchema = z.object({
  target: z.number().int(),
  period: z.enum(ROUTINE_PERIODS),
  preferredDays: z.array(weekdaySchema).optional(),
  stopOnHit: z.boolean(),
  prepareFactor: z.number().int(),
});
const proposalViewSchema = z.object({
  title: z.string(),
  type: z.enum(ROUTINE_TYPES),
  owner: z.string(),
  instruction: z.string().optional(),
  site: z.string().optional(),
  schedules: z.array(proposalScheduleSchema),
  goal: proposalMetaGoalSchema.optional(),
  tracking: trackingSpecSchema.optional(),
}) as unknown as z.ZodType<RoutineProposalView>;

export const routineProposalSchema = z.object({
  routineId: routineIdSchema,
  mode: z.enum(["criar", "ajustar", "revisar", "alterar"]),
  title: z.string().max(ROUTINE_LIMITS.title),
  unit: z.string().max(ROUTINE_LIMITS.unit),
  kind: z.enum(ROUTINE_KINDS),
  site: z.string().max(ROUTINE_LIMITS.site),
  target: z.number().int(),
  period: z.enum(ROUTINE_PERIODS),
  owner: z.string().max(200),
  instruction: z.string().max(ROUTINE_LIMITS.instruction),
  needsApproval: z.boolean(),
  suggestedNeedsApproval: z.boolean().optional(),
  dailyCap: z.number().int().optional(),
  limits: z.object({ daily: z.number().optional(), weekly: z.number().optional() }),
  suggestedTarget: z.number().int().optional(),
  reason: z.string().max(1000).optional(),
  type: z.enum(ROUTINE_TYPES).optional(),
  view: proposalViewSchema.optional(),
  before: proposalViewSchema.optional(),
  patch: updateRoutineBodySchema.optional(),
  suggestedMode: suggestedModeSchema.optional(),
}) as unknown as z.ZodType<RoutineProposalPayload>;

const isoSchema = z.iso.datetime();

const scheduleSchema = z.object({
  id: z.string(),
  label: z.string(),
  days: scheduleDaysSchema,
  times: z.array(hhmmSchema),
  action: z.string(),
  agent: z.string().optional(),
  scope: z.enum(["geral", "itens_vencidos"]).optional(),
  trigger: scheduleTriggerSchema.optional(),
  enabled: z.boolean().default(true),
  lastSlotKey: z.string().optional(),
}) satisfies z.ZodType<RoutineSchedule>;

const routineBlockSchema = z.object({ kind: z.enum(["sem_navegador", "sem_entrega"]), reason: z.string(), since: isoSchema, attempts: z.number().int() });

const routineRunSchema = z.object({
  id: z.string(),
  scheduleId: z.string().optional(),
  slotKey: z.string().optional(),
  projectId: z.string().optional(),
  taskId: z.string().optional(),
  startedAt: isoSchema,
  endedAt: isoSchema.optional(),
  outcome: z.enum(ROUTINE_RUN_OUTCOMES),
  summary: z.string().optional(),
  detail: z.string().optional(),
  changes: z.array(z.object({ itemId: z.string(), text: z.string(), kind: z.enum(["novo", "status", "encerrado"]).optional(), alert: z.boolean().optional() })).default([]),
  skipReason: z.string().optional(),
}) satisfies z.ZodType<RoutineRun>;

const metaGoalSchema = z.object({
  target: z.number().int(),
  period: z.enum(ROUTINE_PERIODS),
  preferredDays: z.array(weekdaySchema).optional(),
  stopOnHit: z.boolean().default(true),
  prepareFactor: z.number().int().default(1),
}) satisfies z.ZodType<MetaGoal>;

/** O grant que corresponde ao antigo "sem OK": os rótulos liberados do tipo, no site da rotina, dentro do teto diário. */
export function legacyGrant(routine: Pick<Routine, "kind" | "site" | "dailyCap">, approvedAt: string): AutoGrant {
  return {
    actions: [...ROUTINE_ALLOWED_LABELS[routine.kind]],
    ...(routine.site ? { sites: [routine.site] } : {}),
    ...(routine.dailyCap !== undefined ? { dailyCap: routine.dailyCap } : {}),
    approvedAt,
  };
}

/**
 * Leitura tolerante das rotinas v1 (sem type/mode/schedules/goal): "arquivada" vira "encerrada";
 * `needsApproval:false` vira modo automático com o grant do tipo e do site (quem já tinha dado "sem OK"
 * não perde nada); `needsApproval:true` vira "pede-ok"; a meta solta (target/period) vira `goal`.
 * Com `mode` já presente, `needsApproval` é só o espelho dele.
 */
export function upgradeRoutine(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;
  const r: Record<string, unknown> = { ...raw };
  if (r.status === "arquivada") r.status = "encerrada";
  r.type ??= "meta";
  if (r.mode === undefined) {
    const kind = (ROUTINE_KINDS as readonly unknown[]).includes(r.kind) ? (r.kind as RoutineKind) : "other";
    if (r.needsApproval === false) {
      r.mode = { kind: "automatico", grant: legacyGrant({ kind, site: typeof r.site === "string" ? r.site : "", ...(typeof r.dailyCap === "number" ? { dailyCap: r.dailyCap } : {}) }, typeof r.updatedAt === "string" ? r.updatedAt : new Date(0).toISOString()) };
    } else {
      r.mode = { kind: "pede-ok" };
    }
  }
  const mode = r.mode as { kind?: string };
  r.needsApproval = mode.kind !== "automatico";
  if (r.type === "meta" && r.goal === undefined && typeof r.target === "number") {
    r.goal = { target: r.target, period: r.period ?? "week", stopOnHit: true, prepareFactor: 1 };
  }
  return r;
}

const routineSchema = z.preprocess(
  upgradeRoutine,
  z.object({
    id: routineIdSchema,
    title: z.string(),
    unit: z.string(),
    kind: z.enum(ROUTINE_KINDS),
    site: z.string(),
    target: z.number().int(),
    period: z.enum(ROUTINE_PERIODS),
    agentId: z.string().optional(),
    teamId: z.string().optional(),
    instruction: z.string(),
    status: z.enum(ROUTINE_STATUSES),
    needsApproval: z.boolean(),
    dailyCap: z.number().int().optional(),
    pausedUntil: isoSchema.optional(),
    skipPeriods: z.array(z.string()),
    createdBy: z.enum(["maestro", "usuario"]),
    seed: z.literal(true).optional(),
    createdAt: isoSchema,
    updatedAt: isoSchema,
    lastDispatchAt: isoSchema.optional(),
    lastTaskId: z.string().optional(),
    riskWokenPeriod: z.string().optional(),
    lowerGoalAskedPeriod: z.string().optional(),
    emptyStreak: z.number().int().optional(),
    pausedReason: z.string().optional(),
    type: z.enum(ROUTINE_TYPES),
    owner: z.union([z.object({ address: z.string() }), z.object({ teamId: z.string() })]).optional(),
    mode: modeSchema,
    modeProposal: z.object({ grant: autoGrantSchema, by: z.enum(["maestro", "cyno"]), at: isoSchema }).optional(),
    schedules: z.array(scheduleSchema).default([]),
    goal: metaGoalSchema.optional(),
    tracking: trackingSpecSchema.optional(),
    lastRuns: z.array(routineRunSchema).default([]),
    periodStats: z.record(z.string(), z.object({ prepared: z.number().int(), approved: z.number().int(), dismissed: z.number().int() })).default({}),
    autoUsage: z.object({ day: z.string(), count: z.number().int().min(0) }).optional(),
    blocked: routineBlockSchema.optional(),
    noDelivery: z.object({ reason: z.string(), count: z.number().int() }).optional(),
    linkChaseAt: isoSchema.optional(),
  }),
) as unknown as z.ZodType<Routine>;

/** routines.json (valida ao ler; o servidor só grava o que ele mesmo produziu). Sem `version` = v1. */
export const routinesDataSchema = z.object({
  version: z.literal(2).default(2),
  routines: z.array(routineSchema),
  entries: z.array(
    z.object({
      id: z.string(),
      routineId: routineIdSchema,
      periodKey: z.string(),
      url: z.string(),
      note: z.string().optional(),
      taskId: z.string(),
      agentId: z.string(),
      stage: z.enum(ENTRY_STAGES),
      at: isoSchema,
      settledAt: isoSchema.optional(),
      deliveredTo: z.literal("owner").optional(),
    }) satisfies z.ZodType<RoutineEntry>,
  ),
  executions: z.array(
    z.object({
      id: z.string(),
      routineId: routineIdSchema.optional(),
      host: z.string(),
      label: z.string(),
      actionKind: z.string(),
      taskId: z.string().optional(),
      agentId: z.string(),
      via: z.enum(["aprovacao", "rotina", "livre"]),
      at: isoSchema,
    }) satisfies z.ZodType<RoutineExecution>,
  ),
  decisions: z.record(
    z.string(),
    z.array(z.object({ at: isoSchema, kind: z.enum(["dispatched", "skipped", "closed", "wake", "ask"]), reason: z.string(), taskId: z.string().optional() })),
  ),
  results: z.array(
    z.object({ routineId: routineIdSchema, periodKey: z.string(), target: z.number().int(), delivered: z.number().int(), outcome: z.enum(["bateu", "nao_bateu", "pulada"]), prepared: z.number().int().optional(), approved: z.number().int().optional(), dismissed: z.number().int().optional() }),
  ),
  closedPeriod: z.string().optional(),
  closedMonth: z.string().optional(),
}) satisfies z.ZodType<RoutinesData>;

export const trackedItemSchema = z.object({
  id: z.string(),
  routineId: routineIdSchema,
  values: z.record(z.string(), z.union([z.string(), z.number()])),
  sourceKey: z.string().optional(),
  status: z.string(),
  state: z.enum(["ativo", "encerrado", "parado"]),
  createdAt: isoSchema,
  expiresAt: isoSchema.optional(),
  endedAt: isoSchema.optional(),
  endReason: z.enum(["expirou", "terminal", "usuario", "rotina_encerrada"]).optional(),
  lastCheckedAt: isoSchema.optional(),
  history: z.array(z.object({ at: isoSchema, by: z.enum(["agente", "servidor", "usuario"]), taskId: z.string().optional(), field: z.string().optional(), from: z.string().optional(), to: z.string().optional(), note: z.string().optional() })).default([]),
}) satisfies z.ZodType<TrackedItem>;

/** routines/<routineId>/items.json */
export const routineItemsFileSchema = z.object({ version: z.literal(1).default(1), items: z.array(trackedItemSchema) }) satisfies z.ZodType<RoutineItemsFile>;

/** Próximo horário calculado (não gravado): o painel "Hoje", o cartão da Gestão e o Calendário leem isto. */
export type NextSlot = { scheduleId: string; label: string; slotKey: string; at: string; action: string };

// ---------- Respostas da API ----------

export type RoutineOwnerInfo = { kind: "agent" | "team"; id: string; name: string };
export type RoutineHistoryPoint = {
  periodKey: string;
  outcome: RoutinePeriodOutcome;
  delivered: number;
  target: number;
  /** Meta v2: opções preparadas, aprovadas e dispensadas no período, e o custo (USD) do período. */
  prepared?: number;
  approved?: number;
  dismissed?: number;
  costUsd?: number;
};
export type RoutineCost = { periodUsd: number; periodBrl: number; perUnitUsd: number | null; perUnitBrl: number | null; totalUsd: number; totalBrl: number };
export type RoutineOpenTask = { id: string; status: string; agentId?: string };
export type RoutineNextDispatch = { state: "agora" | "aguardando" | "sem_cobranca"; reason: string; /** Quando o vigia volta a tentar (espera depois de uma tarefa sem entrega). */ retryAt?: string };
/** Primeira execução de um horário que ainda não rodou ("primeira execução: amanhã às 9h"). */
export type RoutineFirstRun = { scheduleId: string; label: string; at: string; text: string };

/** Uma rotina com tudo o que o cartão da tela precisa. */
export type RoutineOverviewItem = {
  routine: Routine;
  owner?: RoutineOwnerInfo;
  periodKey: string;
  periodStart: string;
  periodEnd: string;
  daysLeft: number;
  /** Entregues no período (tarefa concluída + link). */
  delivered: number;
  /** Registrados com link, esperando a tarefa terminar. */
  registered: number;
  /** Período da meta: semana ou mês (`periodKey` é "2026-W46" ou "2026-M11"). */
  period: RoutinePeriod;
  /** Meta v2: aprovadas esperando entrega, opções esperando OK, o que falta (`alvo - entregues - aprovadas`) e o fator de preparo. */
  inFlight: number;
  pending: number;
  missing: number;
  prepareFactor: number;
  preferredDays: Weekday[];
  stopOnHit: boolean;
  /** Opções preparadas, aprovadas e dispensadas no período atual. */
  stats: PeriodStats;
  expected: number;
  pace: PaceStatus;
  /** Meta: para onde vai no ritmo dos últimos 7 dias ("no ritmo atual fecha em 7 de 10"). */
  projection?: GoalProjection;
  dailyCap: number | null;
  /** Itens contados hoje (registrados ou entregues). */
  todayCount: number;
  /** Até 6 períodos anteriores, do mais antigo ao mais novo. */
  history: RoutineHistoryPoint[];
  nextDispatch: RoutineNextDispatch;
  cost: RoutineCost;
  openTask: RoutineOpenTask | null;
  /** Próximos horários da rotina (até 3). */
  next: NextSlot[];
  /** Só acompanhamento: os números dos itens (R2). */
  tracking?: TrackingSummary;
  /** Meta: itens aprovados (cartão do Para você) que ainda não têm link registrado; não contam como entregues. */
  approvedNoLink?: number;
  /** Horários que nunca rodaram, com quando será a primeira execução (a hora de hoje já passou = amanhã). */
  firstRuns?: RoutineFirstRun[];
  /** O vigia parou de tentar (ver `routine.blocked`). */
  blocked?: RoutineBlock;
};

/** Resumo dos itens de um acompanhamento (o cartão da Gestão). */
export type TrackingSummary = { active: number; ended: number; stopped: number; /** Itens com mudança hoje (novo, status, encerrado). */ changedToday: number; /** Ativos que já passaram da hora de conferir. */ due: number };

export type GoalVerdict = { total: number; onTrack: number; ahead: number; behind: number; paused: number; done: number };

export type RoutinesOverview = {
  at: string;
  periodKey: string;
  daysLeft: number;
  verdict: GoalVerdict;
  /** Ativas, pausadas e propostas (arquivadas ficam de fora). */
  routines: RoutineOverviewItem[];
  /** As rotinas encerradas mais recentes (até 20): a tela abre o detalhe delas e oferece "Apagar". */
  ended?: RoutineOverviewItem[];
};

export type RoutineDetail = {
  item: RoutineOverviewItem;
  entries: RoutineEntry[];
  executions: RoutineExecution[];
  decisions: RoutineDecision[];
  /** Execuções dos horários, da mais nova para a mais antiga. */
  runs: RoutineRun[];
};

export type ManagementTaskBrief = { id: string; title: string; agentId?: string; status: string; updatedAt: string; reason?: string };

/** Topo da futura página "Gestão" (GET /management/summary). */
export type ManagementSummary = {
  at: string;
  goals: GoalVerdict;
  waiting: { count: number; oldestAt: string | null; oldestAgeMs: number; avgAgeMs: number; olderThan24h: number };
  tasks: {
    failedToday: ManagementTaskBrief[];
    waitingApproval: ManagementTaskBrief[];
    /** Na fila parada porque o motor do agente está sem cota/CLI. */
    blockedByEngine: ManagementTaskBrief[];
  };
  quota: { provider: string; status?: string; updatedAt: string; windows: { id: string; label?: string; utilization: number; resetsAt?: string }[] }[];
  enginesBlocked: { engine: string; reason: string; label: string }[];
  weekSpend: { periodKey: string; costUsd: number; costBrl: number; turns: number };
};
