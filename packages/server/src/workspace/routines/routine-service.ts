import { randomUUID } from "node:crypto";
import {
  ACTIVITY_MAESTRO,
  ACTIVITY_USER,
  autoUsedToday,
  autoVerdict,
  cleanSummary,
  describeSlotWhen,
  fullDetail,
  ROUTINE_BLOCK_AFTER,
  type RoutineBlock,
  type RoutineFirstRun,
  describeDays,
  describeTimes,
  fieldDefSchema,
  ROUTINE_ALLOWED_LABELS,
  type AutoGrant,
  type MetaGoal,
  type RoutineModeBody,
  type RoutineProposalSchedule,
  type RoutineProposalView,
  type RoutineSuggestedMode,
  type RoutineType,
  workClock,
  clampTarget,
  dailyCapOf,
  deliveredCount,
  hostMatchesSite,
  isRoutinePaused,
  legacyGrant,
  localDayKey,
  nextRoutineId,
  nextSlots,
  parseAddress,
  agentAddress,
  slotKeyNow,
  slotsBetween,
  normalizeRoutineUrl,
  periodBounds,
  periodBoundsFor,
  periodBoundsOfKey,
  periodKeyFor,
  periodOfKey,
  previousPeriodKeysFor,
  ROUTINE_STATS_KEPT,
  type PeriodStats,
  ROUTINE_DECISIONS_KEPT,
  ROUTINE_MAX_EMPTY_TASKS,
  ROUTINE_RUNS_KEPT,
  ROUTINE_EXECUTIONS_KEPT,
  ROUTINE_LIMITS,
  ROUTINE_LIMITS_TABLE,
  routineLabelAllowed,
  type ForYouItem,
  type NextSlot,
  type Routine,
  type RoutineDecision,
  type RoutineEntry,
  type RoutineExecution,
  type RoutineHistoryPoint,
  type RoutineOwnerInfo,
  type RoutineProposalPayload,
  type RoutineResult,
  type RoutineRun,
  type RoutineSchedule,
  type ScheduleInput,
  type TrackingSpec,
  type RoutinesData,
  type ServerEvent,
  type Task,
  type UpdateRoutineBody,
  type createRoutineBodySchema,
  type forYouDecisionBodySchema,
  scheduleInputSchema,
} from "@cyno/shared";
import type { FastifyBaseLogger } from "fastify";
import { z } from "zod";
import { HttpError } from "../../platform/http/errors";
import { shorten } from "../../util/text";
import { writeJsonAtomic } from "../../store/atomic-write";
import { activeActivity } from "../activity/log";
import type { WriteQueue } from "../../store/write-queue";

/** Erro de uma ferramenta MCP (mensagem em inglês, o modelo lê). */
export class RoutineToolError extends Error {}

/** Frases com que o agente diz que não conseguiu navegar/acessar (só a negação conta: "abri no navegador" não é bloqueio). */
const NO_BROWSER = [
  /\b(?:sem|without)\s+(?:acesso\s+(?:a|ao|à|ao seu)\s+)?(?:o\s+|um\s+|nenhum\s+)?(?:navegador|browser)/,
  /\bn[ãa]o\s+(?:consegui|conseguiu|tenho|tinha|posso|pude|foi\s+poss[ií]vel|h[áa]|existe)\s+(?:[^\s.!?;:]+\s+){0,4}?(?:navegador|browser|acessar|abrir|navegar)\b/,
  /\b(?:navegador|browser)\s+(?:est[áa]\s+)?(?:indispon[ií]vel|n[ãa]o\s+(?:est[áa]\s+)?(?:dispon[ií]vel|funciona|abre|respondeu)|bloqueado|fora do ar)/,
  /\b(?:can(?:no|')t|could\s?n(?:o|')t|unable\s+to|failed\s+to)\s+(?:\w+\s+){0,3}?(?:open|access|browse|use|reach)\b/,
  /\bno\s+(?:web\s+)?(?:browser|browsing)\b/,
  /\bn[ãa]o\s+h[áa]\s+ferramenta/,
];

/** Por que a tarefa da Meta terminou sem entregar nada (lido do que o agente devolveu). */
export function deliveryFailure(task: Pick<Task, "result" | "status">): { kind: RoutineBlock["kind"]; reason: string } {
  const text = (task.result ?? "").toLowerCase();
  if (NO_BROWSER.some((pattern) => pattern.test(text))) return { kind: "sem_navegador", reason: "sem navegador" };
  return { kind: "sem_entrega", reason: task.status === "failed" ? "a tarefa falhou sem entregar nada" : "terminou sem registrar nenhum item" };
}

export type RoutineOwners = {
  agent(id: string): { id: string; name: string; teamId: string } | undefined;
  team(id: string): { id: string; name: string } | undefined;
};

export type RoutineServiceDeps = {
  /** Id do workspace: dá o endereço "workspace/agente" do dono e valida o dos horários (ausente = sem checagem de endereço). */
  workspaceId?: string;
  /** data/workspaces/<id>/routines.json */
  file: string;
  /** A mesma fila de escrita do workspace. */
  queue: WriteQueue;
  publish: (event: ServerEvent) => void;
  owners: RoutineOwners;
  /** Abre o cartão "rotina" no Para você (undefined = sem Maestro para abrir). */
  openCard: (payload: RoutineProposalPayload) => ForYouItem | undefined;
  log: Pick<FastifyBaseLogger, "warn" | "error">;
  now: () => Date;
  /** "Tentar de novo" (botão ou aprovar o cartão de bloqueio): o vigia confere já, sem esperar a próxima passada (nem a espera de 1 h da cobrança). */
  afterRetry?: () => void;
};

type Decision = z.output<typeof forYouDecisionBodySchema>;
type CreateInput = z.input<typeof createRoutineBodySchema>;

/** Tudo que `build` precisa para montar uma rotina nova. */
type BuildSpec = {
  type: Routine["type"];
  title: string;
  unit: string;
  kind: Routine["kind"];
  site: string;
  target: number;
  period: Routine["period"];
  agentId?: string;
  teamId?: string;
  instruction: string;
  needsApproval: boolean;
  dailyCap?: number;
  createdBy: Routine["createdBy"];
  status: Routine["status"];
  schedules?: ScheduleInput[];
  goal?: Routine["goal"];
  tracking?: Partial<TrackingSpec>;
};

export type ProposeInput = {
  /** Padrão "meta". */
  type?: RoutineType;
  title: string;
  unit: string;
  kind: Routine["kind"];
  site: string;
  target: number;
  agentId?: string;
  teamId?: string;
  instruction: string;
  suggestedNeedsApproval?: boolean;
  // ---------- R5 ----------
  period?: Routine["period"];
  schedules?: ScheduleInput[];
  goal?: Partial<Pick<MetaGoal, "preferredDays" | "stopOnHit" | "prepareFactor">>;
  tracking?: Partial<TrackingSpec>;
  /** O Automático que o Maestro sugere (só vale depois do OK do usuário). */
  suggestedMode?: RoutineSuggestedMode;
};

/** Mudança proposta numa rotina que já existe (o cartão "alterar"). */
export type ProposeChangeInput = {
  routineId: string;
  patch: UpdateRoutineBody;
  suggestedMode?: RoutineSuggestedMode;
  reason?: string;
};

/** A proposta em texto (para o Maestro reler ao receber um pedido de ajuste). */
export function proposalText(view: RoutineProposalView): string {
  const lines = [`${view.title} (${view.type === "meta" ? "Meta" : "Acompanhamento"}, dono: ${view.owner})`];
  if (view.goal) lines.push(`Meta: ${view.goal.target} por ${view.goal.period === "month" ? "mês" : "semana"}${view.goal.preferredDays?.length ? `, dias preferidos ${view.goal.preferredDays.join(",")}` : ""}`);
  for (const schedule of view.schedules) lines.push(`- ${schedule.label}: ${describeDays(schedule.days)} ${describeTimes(schedule.times)}${schedule.agent ? ` -> ${schedule.agent}` : ""}${schedule.enabled ? "" : " (desligado)"}: ${shorten(schedule.action, 160)}`);
  if (view.tracking) lines.push(`Campos: ${view.tracking.fields.map((field) => field.key).join(", ") || "-"}; status: ${view.tracking.statuses.map((status) => status.name).join(" > ")}; vida: ${view.tracking.lifespan.days ?? "sem prazo"} dias${view.tracking.lifespan.untilTerminal ? " ou status final" : ""}`);
  return lines.join("\n");
}

/** Resultado de um período gravado no fechamento, ou calculado na hora para os períodos sem registro. */
type PeriodOutcome = RoutineHistoryPoint["outcome"];

const LIMIT_REASON = "limite do site";

/**
 * Rotinas do workspace (routines.json): rotinas, livro-razão (links registrados), provas de execução
 * e decisões do vigia. Regra de ouro: só conta como feito (`entregue`) o item cuja tarefa terminou
 * `done`; tarefa que falhou ou foi cancelada descarta os itens dela.
 */
export class RoutineService {
  /** Metas já comemoradas nesta vida do servidor ("rotina:período"): a festa é uma por meta e período. */
  private readonly goalHits = new Set<string>();

  constructor(
    private data: RoutinesData,
    private readonly deps: RoutineServiceDeps,
  ) {}

  // ---------- Leitura ----------

  list(): Routine[] {
    return structuredClone(this.data.routines);
  }

  get(id: string): Routine {
    return structuredClone(this.require(id));
  }

  find(id: string): Routine | undefined {
    const found = this.data.routines.find((routine) => routine.id === id);
    return found ? structuredClone(found) : undefined;
  }

  /** O livro-razão todo (somente leitura: não mexa nos itens). */
  get entries(): readonly RoutineEntry[] {
    return this.data.entries;
  }

  results(): readonly RoutineResult[] {
    return this.data.results;
  }

  closedMonth(): string | undefined {
    return this.data.closedMonth;
  }

  closedPeriod(): string | undefined {
    return this.data.closedPeriod;
  }

  entriesOf(routineId: string): RoutineEntry[] {
    return structuredClone(this.data.entries.filter((entry) => entry.routineId === routineId)).sort((a, b) => b.at.localeCompare(a.at));
  }

  executionsOf(routineId: string, limit = 50): RoutineExecution[] {
    return structuredClone(this.data.executions.filter((execution) => execution.routineId === routineId).slice(-limit)).reverse();
  }

  decisionsOf(routineId: string, limit = 50): RoutineDecision[] {
    return structuredClone((this.data.decisions[routineId] ?? []).slice(-limit)).reverse();
  }

  /** Últimas execuções dos horários, da mais nova para a mais antiga. */
  runsOf(routineId: string, limit = ROUTINE_RUNS_KEPT): RoutineRun[] {
    const routine = this.data.routines.find((candidate) => candidate.id === routineId);
    return structuredClone((routine?.lastRuns ?? []).slice(-limit)).reverse();
  }

  /** Próximos horários calculados (nunca gravados). Rotina inativa ou pausada não tem próximo. */
  nextOf(routineId: string, count: number, now: Date = this.deps.now()): NextSlot[] {
    const routine = this.data.routines.find((candidate) => candidate.id === routineId);
    if (!routine || routine.status !== "ativa" || isRoutinePaused(routine, now)) return [];
    return nextSlots(routine, now, count);
  }

  /** Horários dentro de [from, to) (calculados; só anda os dias do período). Rotina inativa ou pausada não tem. */
  nextBetween(routineId: string, from: Date, to: Date, limit: number, now: Date = this.deps.now()): NextSlot[] {
    const routine = this.data.routines.find((candidate) => candidate.id === routineId);
    if (!routine || routine.status !== "ativa" || isRoutinePaused(routine, now)) return [];
    return slotsBetween(routine, from, to, limit);
  }

  /** Itens contados no dia local de `now` (registrados ou entregues). */
  todayCount(routineId: string, now: Date = this.deps.now()): number {
    const day = localDayKey(now);
    return this.data.entries.filter((entry) => entry.routineId === routineId && entry.stage !== "descartado" && localDayKey(new Date(entry.at)) === day).length;
  }

  /** Ações sensíveis que passaram hoje pela rotina (aprovadas ou liberadas). */
  executionsToday(routineId: string, now: Date = this.deps.now()): number {
    const day = localDayKey(now);
    return this.data.executions.filter((execution) => execution.routineId === routineId && localDayKey(new Date(execution.at)) === day).length;
  }

  ownerOf(routine: Pick<Routine, "agentId" | "teamId">): RoutineOwnerInfo | undefined {
    if (routine.agentId) {
      const agent = this.deps.owners.agent(routine.agentId);
      return agent ? { kind: "agent", id: agent.id, name: agent.name } : undefined;
    }
    if (routine.teamId) {
      const team = this.deps.owners.team(routine.teamId);
      return team ? { kind: "team", id: team.id, name: team.name } : undefined;
    }
    return undefined;
  }

  /** Resultado de cada um dos `count` períodos anteriores (gravado no fechamento; senão calculado com a meta de hoje). */
  history(routine: Routine, now: Date, count = 6): RoutineHistoryPoint[] {
    const points: RoutineHistoryPoint[] = [];
    for (const key of previousPeriodKeysFor(now, routine.period, count)) {
      const stored = this.data.results.find((result) => result.routineId === routine.id && result.periodKey === key);
      if (stored) {
        points.push({ periodKey: key, outcome: stored.outcome, delivered: stored.delivered, target: stored.target, ...this.statsOf(routine, key, stored) });
        continue;
      }
      const bounds = periodBoundsOfKey(key);
      if (!bounds || Date.parse(routine.createdAt) >= bounds.end.getTime()) continue;
      points.push({ periodKey: key, ...this.outcomeOf(routine, key), ...this.statsOf(routine, key) });
    }
    return points;
  }

  /** Opções preparadas, aprovadas e dispensadas do período (só aparecem se a rotina preparou alguma). */
  private statsOf(routine: Routine, key: string, stored?: RoutineResult): Pick<RoutineHistoryPoint, "prepared" | "approved" | "dismissed"> {
    const stats = routine.periodStats[key];
    const prepared = stored?.prepared ?? stats?.prepared;
    if (!prepared) return {};
    return { prepared, approved: stored?.approved ?? stats?.approved ?? 0, dismissed: stored?.dismissed ?? stats?.dismissed ?? 0 };
  }

  /** Contadores do período atual (ou do informado) da Meta com preparo. */
  statsFor(routineId: string, key: string): PeriodStats {
    const routine = this.data.routines.find((candidate) => candidate.id === routineId);
    return { prepared: 0, approved: 0, dismissed: 0, ...routine?.periodStats[key] };
  }

  /** Soma opções preparadas/aprovadas/dispensadas no período (guarda só as últimas ROUTINE_STATS_KEPT chaves). */
  bumpStats(routineId: string, key: string, delta: Partial<PeriodStats>): void {
    const routine = this.data.routines.find((candidate) => candidate.id === routineId);
    if (!routine) return;
    const current = routine.periodStats[key] ?? { prepared: 0, approved: 0, dismissed: 0 };
    routine.periodStats[key] = { prepared: current.prepared + (delta.prepared ?? 0), approved: current.approved + (delta.approved ?? 0), dismissed: current.dismissed + (delta.dismissed ?? 0) };
    const keys = Object.keys(routine.periodStats).sort();
    for (const old of keys.slice(0, Math.max(0, keys.length - ROUTINE_STATS_KEPT))) delete routine.periodStats[old];
    this.commitRoutine(routineId);
  }

  /** Chave do período atual da rotina (semana ou mês). */
  currentKey(routine: Pick<Routine, "period">, now: Date = this.deps.now()): string {
    return periodKeyFor(now, routine.period);
  }

  private outcomeOf(routine: Routine, key: string): { outcome: PeriodOutcome; delivered: number; target: number } {
    const delivered = deliveredCount(this.data.entries, routine.id, key);
    const outcome: PeriodOutcome = routine.skipPeriods.includes(key) ? "pulada" : delivered >= routine.target ? "bateu" : "nao_bateu";
    return { outcome, delivered, target: routine.target };
  }

  // ---------- Criação e edição ----------

  /**
   * O Maestro propõe: a rotina nasce `proposta` (nada é vigiado, nenhum horário dispara) e o cartão vai
   * para o Para você com o tipo, os horários, a meta ou o esquema dos itens e o modo sugerido. Erros de
   * regra viram `RoutineToolError` (mensagem para o modelo corrigir e propor de novo).
   */
  propose(input: ProposeInput): { routine: Routine; item: ForYouItem | undefined; targetClamped: boolean } {
    const type = input.type ?? "meta";
    const owner = { ...(input.agentId !== undefined ? { agentId: input.agentId } : {}), ...(input.teamId !== undefined ? { teamId: input.teamId } : {}) };
    const period = input.period ?? "week";
    const target = type === "meta" ? clampTarget(input.kind, input.target, period) : 1;
    const schedules = this.parseSchedules(input.schedules ?? []);
    if (type === "acompanhamento") {
      if (schedules.length === 0) throw new RoutineToolError("A tracking routine needs at least one schedule (days, times and the action of each).");
      this.checkTracking({ fields: input.tracking?.fields ?? [], statuses: input.tracking?.statuses ?? [{ name: "Ativo" }], lifespan: input.tracking?.lifespan ?? { untilTerminal: false }, ...(input.tracking?.expireStatus ? { expireStatus: input.tracking.expireStatus } : {}) });
    } else if (!input.site) {
      throw new RoutineToolError("A goal routine needs the site (e.g. linkedin.com).");
    }
    let routine: Routine;
    try {
      this.requireOwner(owner);
      routine = this.build({
        type,
        title: input.title,
        unit: input.unit,
        kind: type === "meta" ? input.kind : "other",
        site: type === "meta" ? input.site : "",
        target,
        period,
        ...owner,
        instruction: input.instruction,
        needsApproval: true,
        createdBy: "maestro",
        status: "proposta",
        schedules,
        ...(type === "meta" ? { goal: { stopOnHit: input.goal?.stopOnHit ?? true, prepareFactor: input.goal?.prepareFactor ?? 1, ...(input.goal?.preferredDays?.length ? { preferredDays: [...new Set(input.goal.preferredDays)].sort() } : {}), period, target } } : {}),
        ...(type === "acompanhamento" && input.tracking ? { tracking: input.tracking } : {}),
      });
    } catch (error) {
      throw error instanceof HttpError ? new RoutineToolError(error.message) : error;
    }
    if (input.suggestedMode) routine.modeProposal = this.modeProposal(input.suggestedMode, "maestro");
    this.data.routines.push(routine);
    this.commit({ type: "routine:upserted", routine: structuredClone(routine) });
    const item = this.deps.openCard(this.payload(routine, "criar", { suggestedNeedsApproval: input.suggestedNeedsApproval }));
    this.logActivity("proposta", routine, `O Maestro propôs a rotina “${routine.title}”: ${this.viewLine(routine)}`, ACTIVITY_MAESTRO);
    return { routine: structuredClone(routine), item, targetClamped: target !== input.target && type === "meta" };
  }

  /**
   * O Maestro propõe MUDAR uma rotina que já existe: nada muda até o OK. A mudança é conferida contra uma
   * cópia (as mesmas regras da edição do usuário) e o cartão traz o antes e o depois.
   */
  proposeChange(input: ProposeChangeInput): { routine: Routine; item: ForYouItem | undefined } {
    const routine = this.data.routines.find((candidate) => candidate.id === input.routineId);
    if (!routine) throw new RoutineToolError(`Routine ${input.routineId} does not exist (see routine_list).`);
    if (routine.status !== "ativa" && routine.status !== "pausada") throw new RoutineToolError(`Routine ${routine.id} is ${routine.status}: only active or paused routines can be changed.`);
    if (Object.keys(input.patch).length === 0 && !input.suggestedMode) throw new RoutineToolError("Nothing to change: pass at least one field.");
    const after = structuredClone(routine);
    try {
      if (input.patch.schedules) this.parseSchedules(input.patch.schedules);
      this.applyPatch(after, input.patch);
    } catch (error) {
      if (error instanceof HttpError) throw new RoutineToolError(error.message);
      throw error;
    }
    if (JSON.stringify(this.viewOf(after)) === JSON.stringify(this.viewOf(routine)) && !input.suggestedMode && input.patch.status === undefined) {
      throw new RoutineToolError("This change leaves the routine exactly as it is.");
    }
    if (input.suggestedMode) {
      routine.modeProposal = this.modeProposal(input.suggestedMode, "maestro");
      this.commitRoutine(routine.id);
    }
    const payload: RoutineProposalPayload = { ...this.payload(routine, "alterar"), view: this.viewOf(after), before: this.viewOf(routine), patch: input.patch, ...(input.reason ? { reason: input.reason } : {}) };
    const item = this.deps.openCard(payload);
    this.logActivity("mudanca-proposta", routine, `O Maestro propôs mudar a rotina “${routine.title}”${input.reason ? `: ${shorten(input.reason, 160)}` : ""}`, ACTIVITY_MAESTRO);
    return { routine: structuredClone(routine), item };
  }

  /** Você cria direto: nasce ativa. */
  create(body: CreateInput): Routine {
    const type = body.type ?? "meta";
    const owner = this.resolveOwner(body);
    this.requireOwner(owner);
    const kind = body.kind ?? "other";
    const target = type === "meta" ? clampTarget(kind, body.goal?.target ?? body.target ?? 1, body.goal?.period ?? body.period ?? "week") : (body.target ?? 1);
    const routine = this.build({
      type,
      title: body.title,
      unit: body.unit ?? "item",
      kind,
      site: body.site ?? "",
      target,
      period: body.goal?.period ?? body.period ?? "week",
      ...owner,
      instruction: body.instruction ?? "",
      needsApproval: body.needsApproval ?? true,
      ...(body.dailyCap !== undefined ? { dailyCap: body.dailyCap } : {}),
      createdBy: "usuario",
      status: "ativa",
      ...(body.schedules ? { schedules: body.schedules } : {}),
      ...(body.goal ? { goal: { stopOnHit: true, prepareFactor: 1, ...body.goal, period: body.goal.period ?? "week", target } } : {}),
      ...(body.tracking ? { tracking: body.tracking } : {}),
    });
    this.data.routines.push(routine);
    this.commit({ type: "routine:upserted", routine: structuredClone(routine) });
    return structuredClone(routine);
  }

  /** Só você muda (a rota é da tela; nenhum agente chega aqui). */
  update(id: string, patch: UpdateRoutineBody): Routine {
    const routine = this.require(id);
    if (routine.status === "proposta") throw new HttpError(409, "A proposta ainda espera a sua decisão no Para você");
    this.applyPatch(routine, patch);
    this.normalize(routine);
    routine.updatedAt = this.deps.now().toISOString();
    this.commit({ type: "routine:upserted", routine: structuredClone(routine) });
    return structuredClone(routine);
  }

  /** Aplica a edição num objeto de rotina (o vivo, ou uma cópia para conferir uma proposta). Pode lançar HttpError. */
  private applyPatch(routine: Routine, patch: UpdateRoutineBody): void {
    if (patch.title !== undefined) routine.title = patch.title;
    if (patch.unit !== undefined) routine.unit = patch.unit;
    if (patch.site !== undefined) routine.site = patch.site;
    if (patch.kind !== undefined && patch.kind !== routine.kind) {
      // Outro tipo, outros tetos do site: o alvo e o teto diário voltam a caber neles.
      routine.kind = patch.kind;
      routine.target = clampTarget(routine.kind, routine.target, routine.period);
      const table = ROUTINE_LIMITS_TABLE[routine.kind].daily;
      if (routine.dailyCap !== undefined && table !== undefined && routine.dailyCap > table) routine.dailyCap = table;
    }
    if (patch.instruction !== undefined) routine.instruction = patch.instruction;
    if (patch.target !== undefined) routine.target = clampTarget(routine.kind, patch.target, routine.period);
    if (patch.needsApproval !== undefined) routine.needsApproval = patch.needsApproval;
    if (patch.dailyCap !== undefined) {
      if (patch.dailyCap === null) delete routine.dailyCap;
      else routine.dailyCap = patch.dailyCap;
    }
    if (patch.agentId !== undefined || patch.teamId !== undefined) {
      const next = { agentId: patch.agentId === undefined ? routine.agentId : (patch.agentId ?? undefined), teamId: patch.teamId === undefined ? routine.teamId : (patch.teamId ?? undefined) };
      // Trocar de dono: o novo vale sozinho (agente OU time).
      if (patch.agentId) delete (next as { teamId?: string }).teamId;
      if (patch.teamId) delete (next as { agentId?: string }).agentId;
      this.requireOwner(next);
      delete routine.agentId;
      delete routine.teamId;
      Object.assign(routine, next.agentId ? { agentId: next.agentId } : { teamId: next.teamId });
    }
    if (patch.status !== undefined) {
      const was = routine.status;
      routine.status = patch.status === "arquivada" ? "encerrada" : patch.status;
      if (routine.status === "ativa") {
        delete routine.pausedUntil;
        delete routine.pausedReason;
        routine.emptyStreak = 0;
        // Retomar não recupera os horários que passaram durante a pausa.
        if (was !== "ativa") this.markAllSlots(routine);
      }
    }
    if (patch.schedules !== undefined) {
      const schedules = this.normalizeSchedules(patch.schedules, routine.schedules);
      if (routine.type === "acompanhamento" && schedules.length === 0) throw new HttpError(400, "O acompanhamento precisa de pelo menos um horário");
      routine.schedules = schedules;
    }
    if (patch.pausedUntil !== undefined) {
      if (patch.pausedUntil === null) delete routine.pausedUntil;
      else routine.pausedUntil = patch.pausedUntil;
    }
    if (patch.goal !== undefined && routine.type === "meta") {
      const goal = { stopOnHit: true, prepareFactor: 1, ...routine.goal, target: routine.target, period: routine.period };
      if (patch.goal.period !== undefined) routine.period = patch.goal.period;
      if (patch.goal.stopOnHit !== undefined) goal.stopOnHit = patch.goal.stopOnHit;
      if (patch.goal.prepareFactor !== undefined) goal.prepareFactor = patch.goal.prepareFactor;
      if (patch.goal.preferredDays !== undefined) {
        if (patch.goal.preferredDays === null || patch.goal.preferredDays.length === 0) delete (goal as { preferredDays?: unknown }).preferredDays;
        else (goal as { preferredDays?: unknown }).preferredDays = [...new Set(patch.goal.preferredDays)].sort();
      }
      routine.goal = goal;
    }
    if (patch.tracking !== undefined) {
      if (routine.type !== "acompanhamento" || !routine.tracking) throw new HttpError(409, "Só o acompanhamento tem esquema de itens");
      const spec = { ...routine.tracking };
      const keys = new Set(spec.fields.map((field) => field.key));
      if (patch.tracking.fields) {
        const next = new Set(patch.tracking.fields.map((field) => field.key));
        for (const key of keys) if (!next.has(key)) throw new HttpError(400, `O campo "${key}" não pode ser removido: os itens já usam`);
        spec.fields = patch.tracking.fields;
      }
      if (patch.tracking.statuses) {
        const next = new Set(patch.tracking.statuses.map((status) => status.name));
        for (const status of spec.statuses) if (!next.has(status.name)) throw new HttpError(400, `O status "${status.name}" não pode ser removido: os itens já usam`);
        if (patch.tracking.statuses[0]!.name !== spec.statuses[0]!.name) throw new HttpError(400, "O primeiro status é o inicial e não muda");
        spec.statuses = patch.tracking.statuses;
      }
      if (patch.tracking.lifespan) spec.lifespan = patch.tracking.lifespan;
      if (patch.tracking.expireStatus !== undefined) {
        if (patch.tracking.expireStatus === null) delete spec.expireStatus;
        else spec.expireStatus = patch.tracking.expireStatus;
      }
      if (patch.tracking.checkEveryHours !== undefined) {
        if (patch.tracking.checkEveryHours === null) delete spec.checkEveryHours;
        else spec.checkEveryHours = patch.tracking.checkEveryHours;
      }
      routine.tracking = spec;
    }
    if (patch.skipNextPeriod !== undefined) {
      const bounds = periodBoundsFor(this.deps.now(), routine.period);
      // Uma hora depois do fim do período atual já é o período seguinte.
      const key = periodKeyFor(new Date(bounds.end.getTime() + 3_600_000), routine.period);
      const skips = new Set(routine.skipPeriods);
      if (patch.skipNextPeriod) skips.add(key);
      else skips.delete(key);
      routine.skipPeriods = [...skips].sort();
    }
    if (patch.skipThisPeriod !== undefined) {
      const key = periodKeyFor(this.deps.now(), routine.period);
      const skips = new Set(routine.skipPeriods);
      if (patch.skipThisPeriod) skips.add(key);
      else skips.delete(key);
      routine.skipPeriods = [...skips].sort();
    }
  }

  /** O Maestro pode pausar (nunca retomar, aprovar ou mudar o "sem OK"). */
  pauseByMaestro(id: string): Routine {
    const routine = this.require(id);
    if (routine.status !== "ativa") throw new RoutineToolError(`Routine ${id} is ${routine.status}: only active routines can be paused.`);
    routine.status = "pausada";
    routine.updatedAt = this.deps.now().toISOString();
    this.commit({ type: "routine:upserted", routine: structuredClone(routine) });
    this.logDecision(id, { kind: "skipped", reason: "pausada pelo Maestro" });
    return structuredClone(routine);
  }

  /** O Maestro retoma uma rotina pausada a pedido do usuário (reversível: não precisa de cartão). Os horários que passaram na pausa não voltam. */
  resumeByMaestro(id: string): Routine {
    const routine = this.require(id);
    if (routine.status !== "pausada") throw new RoutineToolError(`Routine ${id} is ${routine.status}: only paused routines can be resumed.`);
    routine.status = "ativa";
    routine.emptyStreak = 0;
    delete routine.pausedUntil;
    delete routine.pausedReason;
    this.markAllSlots(routine);
    routine.updatedAt = this.deps.now().toISOString();
    this.commit({ type: "routine:upserted", routine: structuredClone(routine) });
    this.logDecision(id, { kind: "wake", reason: "retomada pelo Maestro a pedido do usuário" });
    return structuredClone(routine);
  }

  /** Decisão do usuário no cartão "rotina". Aprovar ativa (com os ajustes); rejeitar arquiva a proposta. */
  decide(item: ForYouItem, decision: { status: "aprovado" | "rejeitado" | "respondido"; response?: string; routine?: Decision["routine"] }): void {
    const payload = item.routine;
    if (!payload) throw new HttpError(409, "O cartão não traz a rotina");
    const routine = this.require(payload.routineId);
    const at = this.deps.now().toISOString();
    if (payload.mode === "criar") {
      if (routine.status !== "proposta") throw new HttpError(409, `A rotina ${routine.id} já foi decidida`);
      if (decision.status === "aprovado") {
        const overrides = decision.routine ?? {};
        // Pede OK é o padrão: só o seu "Automático" no cartão liga (e só se o Maestro sugeriu um escopo).
        if (overrides.mode === "automatico" && routine.modeProposal) this.applyGrant(routine, { ...routine.modeProposal.grant, approvedAt: at }, "cartão");
        else routine.needsApproval = overrides.mode === "pede-ok" ? true : (overrides.needsApproval ?? true);
        if (overrides.target !== undefined && routine.type === "meta") routine.target = clampTarget(routine.kind, overrides.target, routine.period);
        if (overrides.dailyCap !== undefined) routine.dailyCap = overrides.dailyCap;
        routine.status = "ativa";
        this.markAllSlots(routine);
      } else {
        routine.status = "encerrada";
        if (decision.status === "respondido") this.logActivity("ajustada", routine, `Você pediu ajustes na proposta “${routine.title}”: ${shorten(decision.response ?? "", 200)}`, ACTIVITY_USER);
        else this.logActivity("recusada", routine, `Você recusou a proposta de rotina “${routine.title}”`, ACTIVITY_USER);
      }
    } else if (payload.mode === "alterar") {
      if (routine.status !== "ativa" && routine.status !== "pausada") throw new HttpError(409, `A rotina ${routine.id} está ${routine.status}: a mudança não vale mais`);
      if (decision.status === "aprovado") {
        if (!payload.patch) throw new HttpError(409, "O cartão não traz a mudança");
        // A mudança já foi conferida ao propor; aqui vale de novo (a rotina pode ter mudado desde então).
        this.update(routine.id, payload.patch);
        const overrides = decision.routine ?? {};
        const current = this.require(routine.id);
        if (overrides.mode === "automatico" && current.modeProposal) this.applyGrant(current, { ...current.modeProposal.grant, approvedAt: at }, "cartão");
        this.logActivity("alterada", current, `Você aprovou a mudança na rotina “${current.title}”: ${shorten(this.changeLines(payload.before, payload.view).join("; "), 220)}`, ACTIVITY_USER);
        return;
      }
      if (decision.status === "respondido") this.logActivity("ajustada", routine, `Você pediu ajustes na mudança da rotina “${routine.title}”: ${shorten(decision.response ?? "", 200)}`, ACTIVITY_USER);
      else this.logActivity("recusada", routine, `Você recusou a mudança na rotina “${routine.title}”`, ACTIVITY_USER);
      return;
    } else if (payload.mode === "revisar") {
      // Aprovar retoma; recusar mantém pausada.
      if (decision.status === "aprovado" && routine.status === "pausada") {
        routine.status = "ativa";
        routine.emptyStreak = 0;
        delete routine.pausedReason;
        this.markAllSlots(routine);
      }
      if (decision.status === "aprovado" && routine.blocked) {
        this.clearBlock(routine);
        this.deps.afterRetry?.();
      }
    } else if (decision.status === "aprovado") {
      // "Baixar a meta": a sua meta, ou a sugerida.
      routine.target = clampTarget(routine.kind, decision.routine?.target ?? payload.suggestedTarget ?? routine.target, routine.period);
    }
    this.normalize(routine);
    routine.updatedAt = at;
    this.commit({ type: "routine:upserted", routine: structuredClone(routine) });
  }

  /** "Descartar" no cartão: a proposta nova é arquivada; a pergunta de baixar a meta só some. */
  itemCancelled(item: ForYouItem): void {
    const payload = item.routine;
    if (!payload || payload.mode !== "criar") return;
    const routine = this.data.routines.find((candidate) => candidate.id === payload.routineId);
    if (!routine || routine.status !== "proposta") return;
    routine.status = "encerrada";
    this.logActivity("recusada", routine, `A proposta de rotina “${routine.title}” foi descartada`, ACTIVITY_USER);
    routine.updatedAt = this.deps.now().toISOString();
    this.commit({ type: "routine:upserted", routine: structuredClone(routine) });
  }

  /** Cartão de "baixar a meta" depois de períodos ruins (uma pergunta por sequência). */
  askLowerGoal(routine: Routine, suggestedTarget: number, reason: string): ForYouItem | undefined {
    const current = this.require(routine.id);
    current.lowerGoalAskedPeriod = periodKeyFor(this.deps.now(), current.period);
    this.commit({ type: "routine:upserted", routine: structuredClone(current) });
    const item = this.deps.openCard({ ...this.payload(current, "ajustar"), suggestedTarget, reason });
    this.logDecision(routine.id, { kind: "ask", reason: `perguntou se quer baixar a meta para ${suggestedTarget}` });
    return item;
  }

  // ---------- Registro dos agentes ----------

  /**
   * `routine_record`: o agente anota um link feito na tarefa da rotina. Valida o dono, a tarefa, o
   * site, o link repetido no período e o teto diário. Entra como `registrado`: só vira `entregue`
   * quando a tarefa terminar.
   */
  record(input: { task: Task | undefined; agentId: string; routineId: string; url?: string; note?: string; deliveredTo?: "owner" }): { entry: RoutineEntry; todayCount: number; cap?: number } {
    const routine = this.data.routines.find((candidate) => candidate.id === input.routineId);
    if (!routine) throw new RoutineToolError(`Routine ${input.routineId} does not exist.`);
    const task = input.task;
    if (!task || task.agentId !== input.agentId) throw new RoutineToolError("You have no task in progress right now.");
    if (task.routineId !== routine.id) throw new RoutineToolError(`Your current task does not belong to routine ${routine.id}. Only record items for the routine of the task you are running.`);
    if (routine.status !== "ativa") throw new RoutineToolError(`Routine ${routine.id} is ${routine.status}: nothing can be recorded now.`);
    const url = input.url?.trim() ?? "";
    const note = input.note?.trim().slice(0, ROUTINE_LIMITS.note);
    // Sem link: só quando a rotina não publica em site nenhum ou a entrega é para o próprio dono (e então a nota diz o que foi entregue).
    const linkless = url === "";
    if (linkless && routine.site && input.deliveredTo !== "owner") throw new RoutineToolError(`This routine publishes on ${routine.site}: record the full link of the item you published there. Without a link, only a delivery to the owner counts (delivered_to: "owner" with a note); never invent a link.`);
    if (linkless && input.deliveredTo === "owner" && !note) throw new RoutineToolError('A delivery to the owner needs a note saying what was delivered (e.g. "Post de café coado entregue na aprovação, mídia M-0003").');
    if (!linkless && input.deliveredTo === "owner" && !routine.site) throw new RoutineToolError("Do not pass a link for a delivery to the owner.");
    const now = this.deps.now();
    const key = periodKeyFor(now, routine.period);
    if (!linkless) {
      const normalized = normalizeRoutineUrl(url);
      if (!normalized) throw new RoutineToolError("The url must be a full http(s) link to the item you did.");
      const host = normalized.split("/")[0]!;
      if (routine.site && !hostMatchesSite(host, routine.site)) throw new RoutineToolError(`The link must be on ${routine.site}.`);
      if (this.data.entries.some((entry) => entry.routineId === routine.id && entry.periodKey === key && entry.stage !== "descartado" && entry.url && (normalizeRoutineUrl(entry.url) ?? entry.url) === normalized)) {
        throw new RoutineToolError("This link is already recorded for this period (duplicates are not counted).");
      }
    }
    const cap = dailyCapOf(routine);
    const today = this.todayCount(routine.id, now);
    if (cap !== undefined && today >= cap) throw new RoutineToolError(`Daily cap reached (${today}/${cap} today, ${LIMIT_REASON}). Stop here and finish with submit_result.`);
    const weekly = ROUTINE_LIMITS_TABLE[routine.kind].weekly;
    if (weekly !== undefined) {
      // O teto semanal do site vale por semana, mesmo numa meta mensal: conta pelo horário do registro.
      const week = periodBounds(now);
      const inWeek = this.data.entries.filter((entry) => entry.routineId === routine.id && entry.stage !== "descartado" && Date.parse(entry.at) >= week.start.getTime() && Date.parse(entry.at) < week.end.getTime()).length;
      if (inWeek >= weekly) throw new RoutineToolError(`Weekly cap reached (${inWeek}/${weekly}, ${LIMIT_REASON}). Stop here and finish with submit_result.`);
    }
    const entry: RoutineEntry = { id: randomUUID(), routineId: routine.id, periodKey: key, url: url.slice(0, ROUTINE_LIMITS.url), ...(note ? { note } : {}), ...(linkless ? { deliveredTo: "owner" as const } : {}), taskId: task.id, agentId: input.agentId, stage: "registrado", at: now.toISOString() };
    this.data.entries.push(entry);
    this.commit({ type: "routine:entry", entry: structuredClone(entry) });
    return { entry: structuredClone(entry), todayCount: today + 1, ...(cap !== undefined ? { cap } : {}) };
  }

  /** A tarefa de uma rotina terminou: `done` entrega os itens dela; `failed` (inclui cancelada) os descarta. */
  onTaskUpdate(task: Task): void {
    if (!task.routineId || (task.status !== "done" && task.status !== "failed")) return;
    this.finishRun(task);
    const stage = task.status === "done" ? "entregue" : "descartado";
    const settledAt = this.deps.now().toISOString();
    const changed: RoutineEntry[] = [];
    const before = this.data.routines.find((candidate) => candidate.id === task.routineId);
    const deliveredBefore = new Map<string, number>();
    for (const entry of this.data.entries) {
      if (entry.taskId === task.id && entry.stage === "registrado" && !deliveredBefore.has(entry.periodKey)) deliveredBefore.set(entry.periodKey, deliveredCount(this.data.entries, task.routineId, entry.periodKey));
    }
    for (const entry of this.data.entries) {
      if (entry.taskId !== task.id || entry.stage !== "registrado") continue;
      entry.stage = stage;
      entry.settledAt = settledAt;
      changed.push(entry);
    }
    if (changed.length > 0) {
      this.commit(...changed.map((entry): ServerEvent => ({ type: "routine:entry", entry: structuredClone(entry) })));
      if (task.status === "done" && before?.type === "meta") this.announceGoalHit(before, deliveredBefore);
      this.logDecision(task.routineId, { kind: "closed", reason: task.status === "done" ? `tarefa entregue: ${changed.length} item(ns) contam` : `tarefa não concluída: ${changed.length} item(ns) descartado(s)`, taskId: task.id });
    }
    this.countOutcome(task, task.status === "done" && changed.length > 0);
  }

  /** Os períodos cuja meta foi batida AGORA (as entregas passaram do alvo nesta passada): um evento por período, nunca repetido. */
  private announceGoalHit(routine: Routine, deliveredBefore: ReadonlyMap<string, number>): void {
    for (const [periodKey, before] of deliveredBefore) {
      const delivered = deliveredCount(this.data.entries, routine.id, periodKey);
      if (before >= routine.target || delivered < routine.target) continue;
      const mark = `${routine.id}:${periodKey}`;
      if (this.goalHits.has(mark)) continue;
      this.goalHits.add(mark);
      this.deps.publish({ type: "routine:goal-hit", routineId: routine.id, periodKey, title: routine.title, delivered, target: routine.target, ...(routine.agentId ? { agentId: routine.agentId } : {}), ...(routine.teamId ? { teamId: routine.teamId } : {}) });
    }
  }

  /**
   * Entrega zera a sequência; tarefa sem entrega soma. Duas seguidas pelo MESMO motivo (ex.: sem
   * navegador) bloqueiam a rotina (o vigia para e o dono é avisado uma vez); na terceira seguida, por
   * motivos diferentes, ela é pausada e o usuário decide no Para você.
   */
  private countOutcome(task: Task, delivered: boolean): void {
    const routine = this.data.routines.find((candidate) => candidate.id === task.routineId);
    // "Tentativas sem entrega" é conta da Meta; o acompanhamento não entrega links.
    if (!routine || routine.status !== "ativa" || routine.type !== "meta") return;
    // Tarefa que já tinha entregue antes (item de outra passada) também conta como entrega.
    const gave = delivered || this.data.entries.some((entry) => entry.taskId === task.id && entry.stage === "entregue");
    routine.emptyStreak = gave ? 0 : (routine.emptyStreak ?? 0) + 1;
    if (gave) delete routine.noDelivery;
    else {
      const failure = deliveryFailure(task);
      routine.noDelivery = { reason: failure.reason, count: routine.noDelivery?.reason === failure.reason ? routine.noDelivery.count + 1 : 1 };
      if (routine.noDelivery.count >= ROUTINE_BLOCK_AFTER && !routine.blocked) return this.block(routine, failure);
    }
    if (routine.emptyStreak < ROUTINE_MAX_EMPTY_TASKS || routine.blocked) {
      this.commit({ type: "routine:upserted", routine: structuredClone(routine) });
      return;
    }
    const reason = `${ROUTINE_MAX_EMPTY_TASKS} tentativas sem entrega`;
    routine.status = "pausada";
    routine.pausedReason = reason;
    routine.updatedAt = this.deps.now().toISOString();
    this.commit({ type: "routine:upserted", routine: structuredClone(routine) });
    this.logDecision(routine.id, { kind: "skipped", reason: `pausada: ${reason}` });
    this.deps.openCard({ ...this.payload(routine, "revisar"), reason: `A rotina foi pausada: ${reason} (tarefas concluídas sem nenhum item registrado, ou que falharam). Aprovar retoma a rotina; recusar mantém pausada.` });
  }

  /** Bloqueia a Meta: o vigia para; o dono recebe UM aviso (cartão no Para você + Atividade). */
  private block(routine: Routine, failure: { kind: RoutineBlock["kind"]; reason: string }): void {
    const text = `O agente não conseguiu executar: ${failure.reason}`;
    routine.blocked = { kind: failure.kind, reason: text, since: this.deps.now().toISOString(), attempts: routine.noDelivery?.count ?? ROUTINE_BLOCK_AFTER };
    routine.updatedAt = routine.blocked.since;
    this.commit({ type: "routine:upserted", routine: structuredClone(routine) });
    this.logDecision(routine.id, { kind: "skipped", reason: `bloqueada: ${text} (${routine.blocked.attempts} tentativas seguidas sem entrega)` });
    this.logActivity("bloqueada", routine, `“${shorten(routine.title, 60)}” ficou bloqueada: ${text}`, ACTIVITY_MAESTRO, { reason: failure.reason, attempts: routine.blocked.attempts });
    this.deps.openCard({ ...this.payload(routine, "revisar"), reason: `${text} (${routine.blocked.attempts} tentativas seguidas sem entrega). O vigia parou de tentar. Aprovar tenta de novo; recusar mantém bloqueada.` });
  }

  /** "Tentar de novo": tira o bloqueio, zera as tentativas e a espera (a próxima passada do vigia já pode cobrar). */
  unblock(id: string): Routine {
    const routine = this.require(id);
    if (routine.status !== "ativa" && routine.status !== "pausada") throw new HttpError(409, "Só rotina ativa ou pausada pode tentar de novo");
    // Só confere já se havia algo para limpar (bloqueio, tentativas ou espera da cobrança).
    const hadWait = routine.blocked !== undefined || routine.noDelivery !== undefined || routine.linkChaseAt !== undefined || routine.lastTaskId !== undefined || (routine.emptyStreak ?? 0) > 0;
    this.clearBlock(routine);
    routine.updatedAt = this.deps.now().toISOString();
    this.logDecision(id, { kind: "wake", reason: "você mandou tentar de novo: bloqueio e tentativas zerados" });
    this.logActivity("desbloqueada", routine, `Você mandou “${shorten(routine.title, 60)}” tentar de novo`, ACTIVITY_USER);
    this.commit({ type: "routine:upserted", routine: structuredClone(routine) });
    if (hadWait) this.deps.afterRetry?.();
    return structuredClone(routine);
  }

  private clearBlock(routine: Routine): void {
    delete routine.blocked;
    delete routine.noDelivery;
    delete routine.linkChaseAt;
    delete routine.lastTaskId;
    delete routine.lastDispatchAt;
    routine.emptyStreak = 0;
  }

  /** O vigia cobrou só o registro dos links (no máximo uma vez por espera). */
  markLinkChase(routineId: string): void {
    const routine = this.require(routineId);
    routine.linkChaseAt = this.deps.now().toISOString();
    this.commit({ type: "routine:upserted", routine: structuredClone(routine) });
  }

  /** Primeira execução dos horários que ainda não rodaram ("primeira execução: amanhã às 9h"). */
  firstRunsOf(routine: Routine, now: Date = this.deps.now()): RoutineFirstRun[] {
    if (routine.status !== "ativa" && routine.status !== "pausada") return [];
    const out: RoutineFirstRun[] = [];
    for (const schedule of routine.schedules) {
      if (!schedule.enabled || routine.lastRuns.some((run) => run.scheduleId === schedule.id)) continue;
      const first = nextSlots({ schedules: [schedule] }, now, 1)[0];
      if (first) out.push({ scheduleId: schedule.id, label: schedule.label, at: first.at, text: `primeira execução: ${describeSlotWhen(new Date(first.at), now)}` });
    }
    return out;
  }

  /**
   * Apaga a rotina (só encerrada ou proposta): somem ela e o histórico (links, provas, decisões,
   * resultados). Os itens acompanhados (arquivo) são do chamador; os projetos e as tarefas já
   * executados ficam como estão.
   */
  remove(id: string): Routine {
    const routine = this.require(id);
    if (routine.status !== "encerrada" && routine.status !== "proposta") throw new HttpError(409, "Só dá para apagar uma rotina encerrada ou em proposta: encerre antes");
    this.data.routines = this.data.routines.filter((candidate) => candidate.id !== id);
    this.data.entries = this.data.entries.filter((entry) => entry.routineId !== id);
    this.data.executions = this.data.executions.filter((execution) => execution.routineId !== id);
    this.data.results = this.data.results.filter((result) => result.routineId !== id);
    delete this.data.decisions[id];
    this.logActivity("apagada", routine, `Você apagou a rotina “${shorten(routine.title, 60)}” (${routine.id}) e o histórico dela`, ACTIVITY_USER);
    this.commit({ type: "routine:removed", routineId: id });
    return structuredClone(routine);
  }

  // ---------- Navegador: aprovação dispensada e prova de execução ----------

  /**
   * A rotina "sem OK" libera este clique? Só se TODAS as condições valerem: rotina ativa e com
   * `needsApproval: false`, clique (não digitar/Enter), rótulo na lista do tipo, host do site da
   * rotina e teto diário não estourado.
   */
  grant(routineId: string | undefined, host: string, label: string, actionKind: string): { allowed: true; routineId: string } | null {
    if (!routineId) return null;
    const routine = this.data.routines.find((candidate) => candidate.id === routineId);
    if (!routine || routine.status !== "ativa" || routine.needsApproval) return null;
    // Automático novo (tipos de ação escolhidos pelo usuário) passa pelo `autoReserve`, não por esta lista de rótulos.
    if (!this.legacyShaped(routine)) return null;
    if (isRoutinePaused(routine, this.deps.now())) return null;
    if (actionKind !== "click") return null;
    if (!hostMatchesSite(host, routine.site)) return null;
    if (!routineLabelAllowed(routine.kind, label)) return null;
    const cap = dailyCapOf(routine);
    if (cap !== undefined && this.executionsToday(routine.id) >= cap) return null;
    return { allowed: true, routineId: routine.id };
  }

  // ---------- Modo Automático (R5) ----------

  /** A permissão é a do antigo "sem OK" (rótulos de clique do tipo)? Essa o navegador lê pela lista de rótulos; as novas, pelo `autoReserve`. */
  private legacyShaped(routine: Routine): boolean {
    if (routine.mode.kind !== "automatico") return false;
    const labels = ROUTINE_ALLOWED_LABELS[routine.kind];
    return routine.mode.grant.actions.length > 0 && routine.mode.grant.actions.every((action) => labels.includes(action));
  }

  /** Grava o Automático na rotina (o único lugar que escreve `grant.approvedAt`); o `needsApproval` espelha. */
  private applyGrant(routine: Routine, grant: AutoGrant, via: "rota" | "cartão"): void {
    routine.mode = { kind: "automatico", grant };
    routine.needsApproval = false;
    delete routine.modeProposal;
    const label = (list: string[]) => list.join(", ");
    this.logActivity(
      "automatico-ligado",
      routine,
      `Você ligou o Automático em “${shorten(routine.title, 60)}”${via === "cartão" ? " ao criar/alterar a rotina" : ""}: ${label(grant.actions)}${grant.dailyCap !== undefined ? `, até ${grant.dailyCap} por dia` : ""}${grant.sites?.length ? ` (sites: ${label(grant.sites)})` : ""}`,
      ACTIVITY_USER,
      { actions: grant.actions, ...(grant.dailyCap !== undefined ? { dailyCap: grant.dailyCap } : {}) },
    );
  }

  /**
   * `POST /routines/:id/mode` (só o usuário chama; nenhuma ferramenta MCP chega aqui): liga o Automático
   * com a permissão, volta para "Pede OK" ou aceita/recusa a sugestão do Maestro. Mesmas regras do projeto.
   */
  setMode(id: string, body: RoutineModeBody): Routine {
    const routine = this.require(id);
    if (routine.status !== "ativa" && routine.status !== "pausada") throw new HttpError(409, routine.status === "proposta" ? "A proposta ainda espera a sua decisão no Para você" : "A rotina já foi encerrada");
    const at = this.deps.now().toISOString();
    let grant: AutoGrant | undefined;
    if (body.kind === "automatico") {
      grant = { actions: [...new Set(body.actions)], dailyCap: body.dailyCap, ...(body.sites?.length ? { sites: [...new Set(body.sites)] } : {}), ...(body.connectors?.length ? { connectors: [...new Set(body.connectors)] } : {}), approvedAt: at };
    } else if (body.kind === "proposta") {
      if (!routine.modeProposal) throw new HttpError(409, "Não há sugestão de modo nesta rotina");
      if (body.accept) grant = { ...routine.modeProposal.grant, approvedAt: at };
    }
    if (grant) this.applyGrant(routine, grant, "rota");
    else if (body.kind === "pede-ok") {
      routine.mode = { kind: "pede-ok" };
      routine.needsApproval = true;
      this.logActivity("automatico-desligado", routine, `Você voltou “${shorten(routine.title, 60)}” para Pede OK`, ACTIVITY_USER);
    } else {
      delete routine.modeProposal;
      this.logActivity("automatico-recusado", routine, `Você recusou a sugestão de rodar “${shorten(routine.title, 60)}” no automático`, ACTIVITY_USER);
    }
    routine.updatedAt = at;
    this.commit({ type: "routine:upserted", routine: structuredClone(routine) });
    return structuredClone(routine);
  }

  /**
   * Pede ao Automático da ROTINA para liberar UMA ação (aprovação de um tipo ou clique sensível) de uma
   * tarefa dela. Libera só com a rotina ativa e em Automático, o tipo no `grant`, o site liberado e o
   * teto do dia ainda não atingido; o teto é DA rotina (soma de todas as execuções do dia). Liberando,
   * já conta. Ler nunca passa por aqui (não pede aprovação em nenhum modo).
   */
  autoReserve(routineId: string, input: { type?: string; host?: string }): { ok: true; label: string } | { ok: false; note?: string } {
    const routine = this.data.routines.find((candidate) => candidate.id === routineId);
    if (!routine || routine.mode.kind !== "automatico" || this.legacyShaped(routine)) return { ok: false };
    const now = this.deps.now();
    if (routine.status === "pausada" || isRoutinePaused(routine, now)) return { ok: false, note: "Rotina pausada: nada é aprovado sozinho" };
    if (routine.status !== "ativa") return { ok: false };
    const used = autoUsedToday(routine, now.getTime());
    const verdict = autoVerdict(routine.mode.grant, used, input);
    if (!verdict.ok) return verdict;
    routine.autoUsage = { day: workClock(now.getTime()).day, count: used + 1 };
    this.commitRoutine(routine.id);
    return verdict;
  }

  /** Prova de execução: uma ação sensível passou (aprovada, liberada pela rotina ou sem aprovação no workspace). */
  noteExecution(input: Omit<RoutineExecution, "id" | "at">): RoutineExecution {
    const execution: RoutineExecution = { id: randomUUID(), ...input, at: this.deps.now().toISOString() };
    this.data.executions.push(execution);
    if (this.data.executions.length > ROUTINE_EXECUTIONS_KEPT) this.data.executions.splice(0, this.data.executions.length - ROUTINE_EXECUTIONS_KEPT);
    this.commit({ type: "routine:execution", execution: structuredClone(execution) });
    return structuredClone(execution);
  }

  // ---------- Vigia ----------

  /** Anota uma decisão (despachou/pulou…). Pula a repetição seguida do mesmo motivo (o log é limitado e o vigia roda a cada 10 min). */
  logDecision(routineId: string, decision: Omit<RoutineDecision, "at">): boolean {
    const list = (this.data.decisions[routineId] ??= []);
    const last = list.at(-1);
    if (last && last.kind === decision.kind && last.reason === decision.reason && decision.kind === "skipped") return false;
    list.push({ at: this.deps.now().toISOString(), ...decision });
    if (list.length > ROUTINE_DECISIONS_KEPT) list.splice(0, list.length - ROUTINE_DECISIONS_KEPT);
    this.commit();
    return true;
  }

  markDispatched(routineId: string, taskId: string): void {
    const routine = this.require(routineId);
    routine.lastDispatchAt = this.deps.now().toISOString();
    routine.lastTaskId = taskId;
    this.commit({ type: "routine:upserted", routine: structuredClone(routine) });
  }

  markRiskWoken(routineId: string, key: string): void {
    const routine = this.require(routineId);
    routine.riskWokenPeriod = key;
    this.commit({ type: "routine:upserted", routine: structuredClone(routine) });
  }

  /**
   * Fecha o período: grava o resultado (bateu / não bateu / pulada) de cada rotina que existia nele.
   * Devolve os resultados gravados. Roda uma vez por período (`closedPeriod`).
   */
  closePeriod(key: string): RoutineResult[] {
    const bounds = periodBoundsOfKey(key);
    const kind = periodOfKey(key);
    const results: RoutineResult[] = [];
    for (const routine of this.data.routines) {
      if (routine.status === "proposta" || routine.status === "encerrada" || routine.type !== "meta" || routine.period !== kind) continue;
      // Rotina fabricada pela semente do app de teste: sem fechamento, sem resumo do Maestro e sem cartão de "baixar a meta".
      if (routine.seed) continue;
      if (bounds && Date.parse(routine.createdAt) >= bounds.end.getTime()) continue;
      const stats = routine.periodStats[key];
      const result: RoutineResult = { routineId: routine.id, periodKey: key, ...this.outcomeOf(routine, key), ...(stats && stats.prepared > 0 ? { prepared: stats.prepared, approved: stats.approved, dismissed: stats.dismissed } : {}) };
      this.data.results = this.data.results.filter((existing) => !(existing.routineId === routine.id && existing.periodKey === key));
      this.data.results.push(result);
      results.push(result);
      this.logDecision(routine.id, { kind: "closed", reason: `${key}: ${result.outcome} (${result.delivered}/${result.target})` });
    }
    if (kind === "month") this.data.closedMonth = key;
    else this.data.closedPeriod = key;
    this.commit({ type: "routine:closed", periodKey: key, routineIds: results.map((result) => result.routineId) });
    return results;
  }

  /** Quantos períodos fechados seguidos (os mais novos) ficaram sem bater a meta (pulados não contam nem quebram). */
  badStreak(routineId: string): number {
    const results = this.data.results.filter((result) => result.routineId === routineId && result.outcome !== "pulada").sort((a, b) => b.periodKey.localeCompare(a.periodKey));
    let streak = 0;
    for (const result of results) {
      if (result.outcome !== "nao_bateu") break;
      streak += 1;
    }
    return streak;
  }

  /** Metas vigiadas pelo vigia agora: ativas (a pausa por data é checada no vigia). Acompanhamento não tem ritmo para vigiar. */
  active(): Routine[] {
    return this.data.routines.filter((routine) => routine.status === "ativa" && routine.type === "meta").map((routine) => structuredClone(routine));
  }

  /** Todas as ativas, de qualquer tipo (o relógio dos horários). */
  activeAll(): Routine[] {
    return this.data.routines.filter((routine) => routine.status === "ativa").map((routine) => structuredClone(routine));
  }

  // ---------- Relógio de horários ----------

  /** O horário foi tratado (rodou, foi pulado ou ignorado): nunca mais vence. */
  markSlot(routineId: string, scheduleId: string, slotKey: string): void {
    const schedule = this.data.routines.find((routine) => routine.id === routineId)?.schedules.find((candidate) => candidate.id === scheduleId);
    if (!schedule || (schedule.lastSlotKey !== undefined && schedule.lastSlotKey >= slotKey)) return;
    schedule.lastSlotKey = slotKey;
    this.commitRoutine(routineId);
  }

  /** Rotina pausada (ou desligada): os horários de agora em diante valem, os que passaram não voltam. */
  syncSlotMarks(routineId: string): void {
    const routine = this.data.routines.find((candidate) => candidate.id === routineId);
    if (!routine) return;
    const key = slotKeyNow(this.deps.now());
    let changed = false;
    for (const schedule of routine.schedules) {
      if (schedule.lastSlotKey === undefined || schedule.lastSlotKey < key) {
        schedule.lastSlotKey = key;
        changed = true;
      }
    }
    if (changed) this.commitRoutine(routineId);
  }

  /** Guarda uma execução de horário (rodando, pulada ou falhou) nas últimas do roteiro; guarda no máximo ROUTINE_RUNS_KEPT. */
  addRun(routineId: string, input: Omit<RoutineRun, "id" | "changes"> & { changes?: RoutineRun["changes"] }): RoutineRun {
    const routine = this.require(routineId);
    const run: RoutineRun = { id: randomUUID(), changes: [], ...input };
    routine.lastRuns.push(run);
    if (routine.lastRuns.length > ROUTINE_RUNS_KEPT) routine.lastRuns.splice(0, routine.lastRuns.length - ROUTINE_RUNS_KEPT);
    this.commitRoutine(routineId);
    return structuredClone(run);
  }

  /** Uma tarefa avulsa virou projeto (ou o contrário): as execuções que apontam para as Tasks dela passam a apontar para o projeto novo. */
  remapRunProject(taskIds: ReadonlySet<string>, projectId: string): number {
    let count = 0;
    for (const routine of this.data.routines) {
      let changed = false;
      for (const run of routine.lastRuns) {
        if (run.taskId && taskIds.has(run.taskId) && run.projectId !== projectId) {
          run.projectId = projectId;
          changed = true;
          count += 1;
        }
      }
      if (changed) this.commitRoutine(routine.id);
    }
    return count;
  }

  /** A execução ainda aberta de um horário (rodando), se houver. */
  openRun(routineId: string, scheduleId: string): RoutineRun | undefined {
    const run = this.data.routines.find((routine) => routine.id === routineId)?.lastRuns.findLast((candidate) => candidate.scheduleId === scheduleId && candidate.outcome === "rodando");
    return run ? structuredClone(run) : undefined;
  }

  /** Dá a execução como encerrada sem tarefa terminada (o servidor perdeu a tarefa, ou ela sumiu). */
  closeRun(routineId: string, runId: string, outcome: "ok" | "falhou", summary: string): void {
    const run = this.data.routines.find((routine) => routine.id === routineId)?.lastRuns.find((candidate) => candidate.id === runId);
    if (!run || run.outcome !== "rodando") return;
    Object.assign(run, { outcome, endedAt: this.deps.now().toISOString(), summary });
    this.commitRoutine(routineId);
  }

  /** Quem monta as mudanças dos itens de uma execução (o RoutineTracking; ligado pelo runtime). */
  private changeSource: ((routineId: string, taskId: string) => RoutineRun["changes"]) | undefined;
  setChangeSource(source: (routineId: string, taskId: string) => RoutineRun["changes"]): void {
    this.changeSource = source;
  }

  /** A tarefa de um horário terminou: fecha a execução dela. */
  private finishRun(task: Task): void {
    const routine = this.data.routines.find((candidate) => candidate.id === task.routineId);
    const run = routine?.lastRuns.find((candidate) => candidate.taskId === task.id && candidate.outcome === "rodando");
    if (!routine || !run) return;
    run.outcome = task.status === "done" ? "ok" : "falhou";
    run.endedAt = this.deps.now().toISOString();
    if (task.result) {
      // Resumo curto e limpo para a lista; o texto completo (com as quebras) fica à parte, para quando abrir.
      const short = cleanSummary(task.result);
      if (short) run.summary = short;
      run.detail = fullDetail(task.result);
    }
    // O que mudou nos itens vem do histórico deles (o servidor), não do texto do agente.
    if (routine.type === "acompanhamento" && this.changeSource) run.changes = this.changeSource(routine.id, task.id);
    this.commitRoutine(routine.id);
  }

  private commitRoutine(routineId: string): void {
    const routine = this.data.routines.find((candidate) => candidate.id === routineId);
    if (routine) this.commit({ type: "routine:upserted", routine: structuredClone(routine) });
  }

  /** Espera as gravações pedidas. */
  flush(): Promise<void> {
    return this.deps.queue.idle();
  }

  // ---------- Internos ----------

  /** Linha da Atividade da rotina (a categoria "rotina"). Sem Atividade ligada (testes), não faz nada. */
  private logActivity(action: string, routine: Pick<Routine, "id">, summary: string, actor: string, data: Record<string, unknown> = {}): void {
    activeActivity()?.record({ workspaceId: this.deps.workspaceId ?? "", category: "rotina", action, actor, summary, refs: { routineId: routine.id }, data });
  }

  private modeProposal(scope: RoutineSuggestedMode, by: "maestro" | "cyno"): NonNullable<Routine["modeProposal"]> {
    const at = this.deps.now().toISOString();
    const actions = scope.actions.map((action) => action.trim()).filter(Boolean);
    if (actions.length === 0) throw new RoutineToolError('suggested_mode "auto" needs auto_scope.actions (approval type ids the user would let run without asking).');
    return { by, at, grant: { actions, ...(scope.sites?.length ? { sites: scope.sites } : {}), ...(scope.connectors?.length ? { connectors: scope.connectors } : {}), ...(scope.dailyCap !== undefined ? { dailyCap: scope.dailyCap } : {}), approvedAt: at } };
  }

  /** Horários como o usuário/Maestro os escreveu, validados um a um (a mensagem diz qual e por quê). */
  private parseSchedules(inputs: ScheduleInput[]): ScheduleInput[] {
    return inputs.map((raw, index) => {
      const parsed = scheduleInputSchema.safeParse(raw);
      if (!parsed.success) throw new RoutineToolError(`schedules[${index}]: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "value"}: ${issue.message}`).join("; ")}`);
      if (parsed.data.agent !== undefined) {
        try {
          this.agentOfAddress(parsed.data.agent);
        } catch (error) {
          throw new RoutineToolError(`schedules[${index}].agent: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      return raw;
    });
  }

  /** Esquema do acompanhamento coerente: chaves e status únicos, `expireStatus` existente, fim por status terminal só com status terminal. */
  private checkTracking(spec: TrackingSpec): void {
    const problems: string[] = [];
    const parsed = z.array(fieldDefSchema).safeParse(spec.fields);
    if (!parsed.success) problems.push(`fields: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
    const keys = spec.fields.map((field) => field.key);
    if (new Set(keys).size !== keys.length) problems.push("fields: duplicated key");
    for (const field of spec.fields) if (field.type === "opcao" && (field.options?.length ?? 0) === 0) problems.push(`field "${field.key}" has type "opcao" but no options`);
    const names = spec.statuses.map((status) => status.name);
    if (new Set(names).size !== names.length) problems.push("statuses: duplicated name");
    if (spec.expireStatus && !names.includes(spec.expireStatus)) problems.push(`expire_status "${spec.expireStatus}" must be one of the statuses (${names.join(", ")})`);
    if (spec.lifespan.untilTerminal && !spec.statuses.some((status) => status.terminal)) problems.push("lifespan until_terminal needs at least one status marked terminal");
    if (problems.length > 0) throw new RoutineToolError(`Invalid tracking: ${problems.join(" | ")}`);
  }

  /** A rotina como o cartão mostra (horários com o nome do agente, meta, esquema). */
  viewOf(routine: Routine): RoutineProposalView {
    const owner = this.ownerOf(routine)?.name ?? "?";
    const schedules: RoutineProposalSchedule[] = routine.schedules.map((schedule) => {
      const parsed = schedule.agent ? parseAddress(schedule.agent) : undefined;
      const agentName = parsed ? this.deps.owners.agent(parsed.agentId)?.name : undefined;
      return { id: schedule.id, label: schedule.label, days: schedule.days, times: schedule.times, action: schedule.action, ...(schedule.agent ? { agent: schedule.agent } : {}), ...(agentName ? { agentName } : {}), ...(schedule.scope ? { scope: schedule.scope } : {}), enabled: schedule.enabled };
    });
    return {
      title: routine.title,
      type: routine.type,
      owner,
      ...(routine.instruction ? { instruction: routine.instruction } : {}),
      ...(routine.type === "meta" ? { site: routine.site, goal: { stopOnHit: true, prepareFactor: 1, ...routine.goal, target: routine.target, period: routine.period } } : {}),
      schedules,
      ...(routine.type === "acompanhamento" && routine.tracking ? { tracking: structuredClone(routine.tracking) } : {}),
    };
  }

  /** Resumo de uma linha (Atividade): tipo, horários e meta. */
  private viewLine(routine: Routine): string {
    const when = routine.schedules.map((schedule) => `${describeDays(schedule.days)} ${describeTimes(schedule.times)}`).join("; ");
    if (routine.type === "meta") return `${routine.target} ${routine.unit}(s) por ${routine.period === "month" ? "mês" : "semana"} em ${routine.site}${when ? `; ${when}` : ""}`;
    return `acompanhamento${when ? `; ${when}` : ""}`;
  }

  /** O que muda entre duas visões, em frases curtas (a Atividade e o texto do cartão). */
  private changeLines(before: RoutineProposalView | undefined, after: RoutineProposalView | undefined): string[] {
    if (!before || !after) return [];
    const lines: string[] = [];
    if (before.title !== after.title) lines.push(`título: ${before.title} -> ${after.title}`);
    if (before.owner !== after.owner) lines.push(`dono: ${before.owner} -> ${after.owner}`);
    const text = (view: RoutineProposalView, id: string | undefined) => {
      const schedule = view.schedules.find((candidate) => candidate.id === id);
      return schedule ? `${describeDays(schedule.days)} ${describeTimes(schedule.times)}${schedule.enabled ? "" : " (desligado)"}` : undefined;
    };
    for (const schedule of after.schedules) {
      const was = text(before, schedule.id);
      const now = text(after, schedule.id);
      if (was === undefined) lines.push(`novo horário ${schedule.label}: ${now}`);
      else if (was !== now || before.schedules.find((candidate) => candidate.id === schedule.id)?.action !== schedule.action) lines.push(`${schedule.label}: ${was} -> ${now}`);
    }
    for (const schedule of before.schedules) if (!after.schedules.some((candidate) => candidate.id === schedule.id)) lines.push(`horário ${schedule.label} removido`);
    if (JSON.stringify(before.goal) !== JSON.stringify(after.goal) && after.goal) lines.push(`meta: ${after.goal.target} por ${after.goal.period === "month" ? "mês" : "semana"}`);
    if (JSON.stringify(before.tracking) !== JSON.stringify(after.tracking)) lines.push("esquema dos itens");
    return lines;
  }

  private require(id: string): Routine {
    const found = this.data.routines.find((routine) => routine.id === id);
    if (!found) throw new HttpError(404, `Rotina "${id}" não encontrada`);
    return found;
  }

  private requireOwner(owner: { agentId?: string; teamId?: string }): void {
    if (owner.agentId !== undefined && owner.teamId !== undefined) throw new HttpError(400, "Informe o agente OU o time dono da rotina");
    if (owner.agentId === undefined && owner.teamId === undefined) throw new HttpError(400, "Informe o agente ou o time dono da rotina");
    if (owner.agentId !== undefined && !this.deps.owners.agent(owner.agentId)) throw new HttpError(400, `O agente "${owner.agentId}" não existe`);
    if (owner.teamId !== undefined && !this.deps.owners.team(owner.teamId)) throw new HttpError(400, `O time "${owner.teamId}" não existe`);
  }

  /** Dono como veio no corpo: agente, time ou endereço "workspace/agente" (que vira o id do agente). */
  private resolveOwner(input: { agentId?: string; teamId?: string; address?: string }): { agentId?: string; teamId?: string } {
    if (input.address === undefined) return { ...(input.agentId !== undefined ? { agentId: input.agentId } : {}), ...(input.teamId !== undefined ? { teamId: input.teamId } : {}) };
    if (input.agentId !== undefined || input.teamId !== undefined) throw new HttpError(400, "Informe o agente OU o time dono da rotina");
    return { agentId: this.agentOfAddress(input.address) };
  }

  /** "workspace/agente" -> id do agente (o workspace tem de ser este e o agente tem de existir). */
  private agentOfAddress(address: string): string {
    const parsed = parseAddress(address);
    if (!parsed) throw new HttpError(400, `Endereço inválido: "${address}" (use workspace/agente)`);
    if (this.deps.workspaceId !== undefined && parsed.workspace !== this.deps.workspaceId) throw new HttpError(400, `O endereço "${address}" é de outro workspace`);
    if (!this.deps.owners.agent(parsed.agentId)) throw new HttpError(400, `O agente "${address}" não existe`);
    return parsed.agentId;
  }

  /**
   * Lista de horários que o usuário escreveu -> horários gravados. `id` mantém o horário que já existia
   * (e a marca de execução dele); horário novo, ligado de novo ou com dias/horas mudados começa a valer
   * de agora em diante (não recupera o que já passou hoje).
   */
  private normalizeSchedules(inputs: ScheduleInput[], existing: RoutineSchedule[] = []): RoutineSchedule[] {
    const key = slotKeyNow(this.deps.now());
    const used = new Set<string>();
    const maxOf = (ids: string[]) => ids.reduce((max, id) => Math.max(max, Number(/^S(\d+)$/.exec(id)?.[1] ?? 0)), 0);
    let counter = maxOf([...existing.map((schedule) => schedule.id), ...inputs.flatMap((input) => (input.id ? [input.id] : []))]);
    const out: RoutineSchedule[] = [];
    for (const raw of inputs) {
      const input = scheduleInputSchema.parse(raw);
      if (input.agent !== undefined) this.agentOfAddress(input.agent);
      let id = input.id;
      if (!id || used.has(id)) {
        counter += 1;
        id = `S${counter}`;
      }
      used.add(id);
      const before = existing.find((schedule) => schedule.id === id);
      const same = before !== undefined && before.enabled === input.enabled && JSON.stringify(before.days) === JSON.stringify(input.days) && JSON.stringify(before.times) === JSON.stringify(input.times);
      out.push({
        id,
        label: input.label,
        days: input.days,
        times: input.times,
        action: input.action,
        ...(input.agent !== undefined ? { agent: input.agent } : {}),
        ...(input.scope !== undefined ? { scope: input.scope } : {}),
        ...(input.trigger !== undefined ? { trigger: input.trigger } : {}),
        enabled: input.enabled,
        ...(same && before.lastSlotKey !== undefined ? { lastSlotKey: before.lastSlotKey } : { lastSlotKey: key }),
      });
    }
    return out;
  }

  private markAllSlots(routine: Routine): void {
    const key = slotKeyNow(this.deps.now());
    for (const schedule of routine.schedules) schedule.lastSlotKey = key;
  }

  /** Mantém os campos derivados em dia: `mode` x `needsApproval`, `owner` e `goal` da meta. */
  private normalize(routine: Routine): void {
    const automatic = routine.mode.kind === "automatico";
    if (routine.needsApproval && automatic) routine.mode = { kind: "pede-ok" };
    else if (!routine.needsApproval && !automatic) routine.mode = { kind: "automatico", grant: legacyGrant(routine, this.deps.now().toISOString()) };
    if (this.deps.workspaceId !== undefined && routine.agentId) routine.owner = { address: agentAddress(this.deps.workspaceId, routine.agentId) };
    else if (routine.teamId) routine.owner = { teamId: routine.teamId };
    else delete routine.owner;
    if (routine.type === "meta") routine.goal = { stopOnHit: true, prepareFactor: 1, ...routine.goal, target: routine.target, period: routine.period };
  }

  private build(input: BuildSpec): Routine {
    const at = this.deps.now().toISOString();
    const tracking: TrackingSpec | undefined =
      input.type === "acompanhamento"
        ? { fields: input.tracking?.fields ?? [], statuses: input.tracking?.statuses ?? [{ name: "Ativo" }], lifespan: input.tracking?.lifespan ?? { untilTerminal: false }, ...(input.tracking?.expireStatus ? { expireStatus: input.tracking.expireStatus } : {}), ...(input.tracking?.checkEveryHours ? { checkEveryHours: input.tracking.checkEveryHours } : {}) }
        : undefined;
    const routine: Routine = {
      id: nextRoutineId(this.data.routines),
      title: input.title.trim(),
      unit: input.unit.trim(),
      kind: input.kind,
      site: input.site,
      target: input.target,
      period: input.period,
      ...(input.agentId ? { agentId: input.agentId } : {}),
      ...(input.teamId ? { teamId: input.teamId } : {}),
      instruction: input.instruction.trim(),
      status: input.status,
      needsApproval: input.needsApproval,
      ...(input.dailyCap !== undefined ? { dailyCap: input.dailyCap } : {}),
      skipPeriods: [],
      createdBy: input.createdBy,
      createdAt: at,
      updatedAt: at,
      type: input.type,
      mode: { kind: "pede-ok" },
      schedules: [],
      lastRuns: [],
      periodStats: {},
      ...(input.goal && input.type === "meta" ? { goal: input.goal } : {}),
      ...(tracking ? { tracking } : {}),
    };
    routine.schedules = this.normalizeSchedules(input.schedules ?? []);
    this.normalize(routine);
    return routine;
  }

  private payload(routine: Routine, mode: RoutineProposalPayload["mode"], extra: { suggestedNeedsApproval?: boolean } = {}): RoutineProposalPayload {
    return {
      routineId: routine.id,
      mode,
      title: routine.title,
      unit: routine.unit,
      kind: routine.kind,
      site: routine.site,
      target: routine.target,
      period: routine.period,
      owner: this.ownerOf(routine)?.name ?? "?",
      instruction: routine.instruction,
      needsApproval: routine.needsApproval,
      ...(extra.suggestedNeedsApproval !== undefined ? { suggestedNeedsApproval: extra.suggestedNeedsApproval } : {}),
      ...(routine.dailyCap !== undefined ? { dailyCap: routine.dailyCap } : {}),
      limits: ROUTINE_LIMITS_TABLE[routine.kind],
      type: routine.type,
      view: this.viewOf(routine),
      ...(routine.modeProposal ? { suggestedMode: { actions: routine.modeProposal.grant.actions, ...(routine.modeProposal.grant.sites?.length ? { sites: routine.modeProposal.grant.sites } : {}), ...(routine.modeProposal.grant.connectors?.length ? { connectors: routine.modeProposal.grant.connectors } : {}), ...(routine.modeProposal.grant.dailyCap !== undefined ? { dailyCap: routine.modeProposal.grant.dailyCap } : {}) } } : {}),
    };
  }

  /** Grava e publica (síncrono na memória; o disco vai pela fila). */
  private commit(...events: ServerEvent[]): void {
    const snapshot = structuredClone(this.data);
    this.deps.queue.enqueue(() => writeJsonAtomic(this.deps.file, snapshot)).catch((error: unknown) => this.deps.log.error({ err: error }, "falha ao gravar routines.json"));
    for (const event of events) this.deps.publish(event);
  }
}
