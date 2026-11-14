import {
  agentEngine,
  createRoutineBodySchema,
  DEFAULT_USD_BRL,
  isRoutinePaused,
  localDayStart,
  slotKeyNow,
  periodBounds,
  routineModeBodySchema,
  routineNextQuerySchema,
  routineScheduleParamsSchema,
  type RoutineFirstRun,
  type RoutineRun as RoutineRunT,
  type PlatformRoutinesToday,
  type RoutinesToday,
  routineParamsSchema,
  editTrackedItemBodySchema,
  stopTrackedItemBodySchema,
  trackedItemChangesQuerySchema,
  trackedItemParamsSchema,
  trackedItemsQuerySchema,
  type TrackedItem,
  type TrackedItemChange,
  type TrackedItemsResponse,
  updateRoutineBodySchema,
  engineBlockLabel,
  type ManagementSummary,
  type ManagementTaskBrief,
  type NextSlot,
  type Routine,
  type RoutineDetail,
  type RoutineRun,
  type RoutinesOverview,
  type Task,
  ACTIVITY_USER,
} from "@cyno/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { HttpError } from "../platform/http/errors";
import { activeActivity } from "../workspace/activity/log";
import { RoutineToolError } from "../workspace/routines/routine-service";
import { buildRoutinesToday, mergeRoutinesToday } from "../workspace/routines/today";
import type { WorkspaceManager } from "../platform/workspaces/manager";
import { buildOverview, goalVerdict, overviewItem, routineCosts } from "../workspace/routines/overview";
import { priceRecord, totalsOf } from "../engines/usage/usage-aggregate";
import type { WorkspaceRuntime } from "../workspace/runtime";

/** Workspace da requisição (`:ws`). */
export type RuntimeOf = (request: FastifyRequest) => WorkspaceRuntime;

const DAY_MS = 86_400_000;

const titleOf = (task: Pick<Task, "prompt">) => task.prompt.split("\n")[0]!.slice(0, 160);
const brief = (task: Task, reason?: string): ManagementTaskBrief => ({
  id: task.id,
  title: titleOf(task),
  ...(task.agentId ? { agentId: task.agentId } : {}),
  status: task.status,
  updatedAt: task.updatedAt,
  ...(reason ? { reason } : {}),
});

/**
 * Rotinas e a visão de gestão, dentro de /api/w/:ws:
 * - GET   /routines/overview     -> RoutinesOverview (tudo que a página precisa numa chamada);
 * - GET   /routines/:id          -> RoutineDetail (itens com link, execuções, decisões do vigia);
 * - GET   /routines/:id/runs     -> { runs } as últimas execuções dos horários (a mais nova primeiro: rodando, ok, falhou, pulada);
 * - GET   /routines/:id/next?count=5 | ?from=ISO&to=ISO&count=200 -> { next } os próximos horários (calculados; vazio se a rotina está pausada; com from/to só o período pedido);
 * - GET   /routines/today       -> RoutinesToday (o que rodou, roda e vai rodar hoje, metas e mudanças; o painel Hoje e a agenda leem daqui);
 * - POST  /routines/:id/retry   -> { routine } ("Tentar de novo": tira o bloqueio e zera as tentativas);
 * - POST  /routines/:id/schedules/:scheduleId/run -> { run } ("Rodar agora": execução avulsa de um horário, sem empilhar);
 * - DELETE /routines/:id        -> { removed } (só encerrada ou em proposta: apaga itens e histórico);
 * - POST  /routines              -> 201 Routine (você cria direto, já ativa; meta ou acompanhamento, com `schedules`);
 * - POST  /routines/:id/mode     -> { routine } (só você liga o Automático por tipo de ação com teto por dia, volta para Pede OK ou aceita/recusa a sugestão do Maestro);
 * - PATCH /routines/:id          -> Routine (só você: meta, "precisa de OK", instrução, horários, pausar/retomar/encerrar, pular a semana);
 * - GET   /routines/:id/items?state=&status=  -> TrackedItemsResponse (itens acompanhados, com histórico e resumo);
 * - POST  /routines/:id/items/:itemId/stop  -> { item } (você para o item; o agente nunca mais o vê);
 * - POST  /routines/:id/items/:itemId/reopen -> { item } (só você retoma; a vida conta de novo);
 * - PATCH /routines/:id/items/:itemId {values?, status?} -> { item } (corrige um campo ou o status);
 * - GET   /routines/:id/changes?hours=48 -> { changes } as mudanças recentes dos itens;
 * - GET   /management/summary    -> ManagementSummary (o topo da página Gestão).
 * A aprovação de uma proposta do Maestro é pelo Para você (POST /for-you/:id/decision com `routine`).
 */
/** Ação do dono sobre um item acompanhado: uma linha na Atividade (a rotina, o item e quem fez). */
function noteItemAction(runtime: WorkspaceRuntime, routineId: string, action: string, summary: string, itemId: string): void {
  const title = runtime.routines.find(routineId)?.title ?? routineId;
  activeActivity()?.record({ workspaceId: runtime.id, category: "rotina", action, actor: ACTIVITY_USER, summary: `${summary} de “${title}”`, refs: { routineId }, data: { itemId } });
}

export function registerRoutineRoutes(scope: FastifyInstance, runtimeOf: RuntimeOf): void {
  const usdBrl = (request: FastifyRequest) => request.server.spendSettings?.usdBrl() ?? DEFAULT_USD_BRL;

  /** Custo das tarefas das rotinas (só lê o histórico se houver tarefa de rotina). */
  async function costsFor(runtime: WorkspaceRuntime) {
    const tasks = runtime.store.snapshot().tasks;
    if (!tasks.some((task) => task.routineId)) return undefined;
    const from = Math.min(...runtime.routines.list().map((routine) => Date.parse(routine.createdAt)), Date.now()) - DAY_MS;
    return routineCosts(await runtime.usageHistory.read(from), tasks);
  }

  /** Erro de regra dos itens (item inexistente, rotina sem itens, valor inválido) vira 404/400. */
  const itemsGuard = <T>(run: () => T): T => {
    try {
      return run();
    } catch (error) {
      if (error instanceof RoutineToolError) throw new HttpError(/does not exist/.test(error.message) ? 404 : 400, error.message);
      throw error;
    }
  };

  /** O resumo dos itens entra no cartão do acompanhamento. */
  const withTracking = (runtime: WorkspaceRuntime, item: RoutinesOverview["routines"][number]): RoutinesOverview["routines"][number] => {
    const tracking = runtime.tracking.summary(item.routine);
    return tracking ? { ...item, tracking } : item;
  };

  scope.get("/routines/today", async (request): Promise<RoutinesToday> => {
    const runtime = runtimeOf(request);
    return buildRoutinesToday({ workspaceId: runtime.id, routines: runtime.routines, tracking: runtime.tracking, state: runtime.state, now: runtime.now(), forYou: runtime.forYou.list() });
  });

  scope.get("/routines/overview", async (request): Promise<RoutinesOverview> => {
    const runtime = runtimeOf(request);
    const overview = buildOverview({ routines: runtime.routines, state: runtime.state, now: runtime.now(), costs: await costsFor(runtime), usdBrl: usdBrl(request), forYou: runtime.forYou.list() });
    return { ...overview, routines: overview.routines.map((item) => withTracking(runtime, item)) };
  });

  scope.get("/routines/:id/items", async (request): Promise<TrackedItemsResponse> => {
    const { id } = routineParamsSchema.parse(request.params);
    const query = trackedItemsQuerySchema.parse(request.query);
    const runtime = runtimeOf(request);
    return itemsGuard(() => {
      const { routine, spec } = runtime.tracking.specOf(id);
      const { items, total } = runtime.tracking.list(id, { ...(query.state ? { state: query.state } : {}), ...(query.status ? { status: query.status } : {}), limit: query.limit, offset: query.offset });
      return { items, total, summary: runtime.tracking.summary(routine)!, fields: spec.fields, statuses: spec.statuses };
    });
  });

  scope.post("/routines/:id/items/:itemId/stop", async (request): Promise<{ item: TrackedItem }> => {
    const { id, itemId } = trackedItemParamsSchema.parse(request.params);
    const body = stopTrackedItemBodySchema.parse(request.body ?? {});
    const runtime = runtimeOf(request);
    return itemsGuard(() => {
      const item = runtime.tracking.stop(id, itemId, { by: "usuario", ...(body.reason ? { reason: body.reason } : {}) });
      noteItemAction(runtime, id, "item-parado", `Você parou de acompanhar o item ${itemId}`, itemId);
      return { item };
    });
  });

  scope.post("/routines/:id/items/:itemId/reopen", async (request): Promise<{ item: TrackedItem }> => {
    const { id, itemId } = trackedItemParamsSchema.parse(request.params);
    const runtime = runtimeOf(request);
    return itemsGuard(() => {
      const item = runtime.tracking.reopen(id, itemId);
      noteItemAction(runtime, id, "item-reaberto", `Você reabriu o item ${itemId}`, itemId);
      return { item };
    });
  });

  scope.patch("/routines/:id/items/:itemId", async (request): Promise<{ item: TrackedItem }> => {
    const { id, itemId } = trackedItemParamsSchema.parse(request.params);
    const body = editTrackedItemBodySchema.parse(request.body);
    return itemsGuard(() => ({ item: runtimeOf(request).tracking.edit(id, itemId, { ...(body.values ? { values: body.values } : {}), ...(body.status ? { status: body.status } : {}) }) }));
  });

  scope.get("/routines/:id/changes", async (request): Promise<{ changes: TrackedItemChange[] }> => {
    const { id } = routineParamsSchema.parse(request.params);
    const { hours } = trackedItemChangesQuerySchema.parse(request.query);
    const runtime = runtimeOf(request);
    return itemsGuard(() => ({ changes: runtime.tracking.recent(id, runtime.now().getTime() - hours * 3_600_000) }));
  });

  scope.get("/routines/:id", async (request): Promise<RoutineDetail> => {
    const { id } = routineParamsSchema.parse(request.params);
    const runtime = runtimeOf(request);
    const routine = runtime.routines.find(id);
    if (!routine) throw new HttpError(404, `Rotina "${id}" não encontrada`);
    return {
      item: overviewItem({ routines: runtime.routines, state: runtime.state, now: runtime.now(), costs: await costsFor(runtime), usdBrl: usdBrl(request), forYou: runtime.forYou.list() }, routine),
      entries: runtime.routines.entriesOf(id),
      executions: runtime.routines.executionsOf(id),
      decisions: runtime.routines.decisionsOf(id),
      runs: runtime.routines.runsOf(id),
    };
  });

  scope.get("/routines/:id/runs", async (request): Promise<{ runs: RoutineRun[] }> => {
    const { id } = routineParamsSchema.parse(request.params);
    const runtime = runtimeOf(request);
    if (!runtime.routines.find(id)) throw new HttpError(404, `Rotina "${id}" não encontrada`);
    return { runs: runtime.routines.runsOf(id) };
  });

  scope.get("/routines/:id/next", async (request): Promise<{ next: NextSlot[] }> => {
    const { id } = routineParamsSchema.parse(request.params);
    const { count, from, to } = routineNextQuerySchema.parse(request.query);
    const runtime = runtimeOf(request);
    if (!runtime.routines.find(id)) throw new HttpError(404, `Rotina "${id}" não encontrada`);
    if (from || to) {
      const now = runtime.now();
      const start = from ? new Date(Math.max(Date.parse(from), now.getTime())) : now;
      const end = to ? new Date(to) : new Date(start.getTime() + 30 * DAY_MS);
      return { next: runtime.routines.nextBetween(id, start, end, count, now) };
    }
    return { next: runtime.routines.nextOf(id, count, runtime.now()) };
  });

  /** A rotina com a primeira execução dos horários que ainda não rodaram ("primeira execução: amanhã às 9h"). */
  const withFirstRuns = (runtime: WorkspaceRuntime, routine: Routine): Routine & { firstRuns: RoutineFirstRun[] } => ({ ...routine, firstRuns: runtime.routines.firstRunsOf(routine, runtime.now()) });

  scope.post("/routines", async (request, reply) => {
    const runtime = runtimeOf(request);
    const created = runtime.routines.create(createRoutineBodySchema.parse(request.body));
    return reply.code(201).send(withFirstRuns(runtime, created));
  });

  scope.patch("/routines/:id", async (request) => {
    const { id } = routineParamsSchema.parse(request.params);
    const runtime = runtimeOf(request);
    return withFirstRuns(runtime, runtime.routines.update(id, updateRoutineBodySchema.parse(request.body)));
  });

  scope.delete("/routines/:id", async (request): Promise<{ removed: string }> => {
    const { id } = routineParamsSchema.parse(request.params);
    await runtimeOf(request).removeRoutine(id);
    return { removed: id };
  });

  scope.post("/routines/:id/retry", async (request): Promise<{ routine: Routine }> => {
    const { id } = routineParamsSchema.parse(request.params);
    return { routine: runtimeOf(request).routines.unblock(id) };
  });

  scope.post("/routines/:id/schedules/:scheduleId/run", async (request): Promise<{ run: RoutineRunT }> => {
    const { id, scheduleId } = routineScheduleParamsSchema.parse(request.params);
    const runtime = runtimeOf(request);
    const routine = runtime.routines.find(id);
    if (!routine) throw new HttpError(404, `Rotina "${id}" não encontrada`);
    const schedule = routine.schedules.find((candidate) => candidate.id === scheduleId);
    if (!schedule) throw new HttpError(404, `Horário "${scheduleId}" não encontrado nesta rotina`);
    if (routine.status !== "ativa") throw new HttpError(409, `A rotina está ${routine.status}: só uma rotina ativa roda`);
    if (isRoutinePaused(routine, runtime.now())) throw new HttpError(409, "A rotina está pausada");
    if (routine.blocked) throw new HttpError(409, `${routine.blocked.reason}. Use "Tentar de novo" antes`);
    if (!schedule.enabled) throw new HttpError(409, "Este horário está desligado");
    const now = runtime.now();
    // Execução avulsa: a chave é o instante (nunca coincide com um horário marcado), o relógio não a toma por perdida.
    const slotKey = slotKeyNow(now);
    const run = await runtime.routineRunner.start(routine, schedule, { slotKey, at: now.toISOString() });
    return { run };
  });

  // Modo da rotina: SÓ o usuário liga o Automático (esta rota; o Maestro só sugere e nenhuma ferramenta MCP chama aqui).
  // Corpo igual ao do projeto: { kind: "automatico", actions[], dailyCap, sites?, connectors? } | { kind: "pede-ok" } | { kind: "proposta", accept }.
  scope.post("/routines/:id/mode", async (request): Promise<{ routine: Routine }> => {
    const { id } = routineParamsSchema.parse(request.params);
    const body = routineModeBodySchema.parse(request.body);
    return { routine: runtimeOf(request).routines.setMode(id, body) };
  });

  scope.get("/management/summary", async (request): Promise<ManagementSummary> => {
    const runtime = runtimeOf(request);
    const now = runtime.now();
    const nowMs = now.getTime();
    const office = runtime.store.snapshot();

    // Esperando você: itens pendentes do Para você e há quanto tempo.
    const pending = runtime.store.forYouSnapshot().filter((item) => item.status === "pendente");
    const ages = pending.map((item) => Math.max(0, nowMs - Date.parse(item.createdAt)));
    const oldest = pending.reduce<{ at: string; age: number } | undefined>((best, item, index) => (!best || ages[index]! > best.age ? { at: item.createdAt, age: ages[index]! } : best), undefined);

    // Tarefas travadas ou que falharam hoje (dia local de São Paulo).
    const dayStart = localDayStart(now).getTime();
    const failedToday = office.tasks.filter((task) => task.status === "failed" && task.outcome !== "cancelled" && Date.parse(task.updatedAt) >= dayStart);
    const waitingApproval = office.tasks.filter((task) => task.status === "waiting_approval");
    const blockedByEngine: ManagementTaskBrief[] = [];
    for (const task of office.tasks) {
      if (task.status !== "queued") continue;
      const agent = office.agents.find((candidate) => candidate.id === task.agentId);
      const block = agent ? runtime.engineBlockOf(agent) : undefined;
      if (block) blockedByEngine.push(brief(task, engineBlockLabel(block, nowMs)));
    }

    // Cota atual das assinaturas e os motores parados.
    const quota = runtime.quotaSnapshot().map((usage) => ({
      provider: usage.provider,
      ...(usage.status ? { status: usage.status } : {}),
      updatedAt: usage.updatedAt,
      windows: usage.windows.map((window) => ({ id: window.id, ...(window.label ? { label: window.label } : {}), utilization: window.utilization, ...(window.resetsAt ? { resetsAt: window.resetsAt } : {}) })),
    }));
    const enginesBlocked: ManagementSummary["enginesBlocked"] = [];
    const seen = new Set<string>();
    for (const agent of office.agents) {
      const block = runtime.engineBlockOf(agent);
      const engine = agentEngine(agent);
      if (!block || seen.has(engine)) continue;
      seen.add(engine);
      enginesBlocked.push({ engine, reason: block.reason, label: engineBlockLabel(block, nowMs) });
    }

    // Gasto da semana (custo equivalente da API), da segunda 00:00 de São Paulo até agora.
    const bounds = periodBounds(now);
    const records = await runtime.usageHistory.read(bounds.start.getTime(), nowMs + 1);
    const week = totalsOf(records.map((record) => priceRecord(record)), usdBrl(request));

    const overview = buildOverview({ routines: runtime.routines, state: runtime.state, now, forYou: runtime.forYou.list() });
    return {
      at: now.toISOString(),
      goals: goalVerdict(overview.routines),
      waiting: {
        count: pending.length,
        oldestAt: oldest?.at ?? null,
        oldestAgeMs: oldest?.age ?? 0,
        avgAgeMs: ages.length > 0 ? Math.round(ages.reduce((sum, age) => sum + age, 0) / ages.length) : 0,
        olderThan24h: ages.filter((age) => age > DAY_MS).length,
      },
      tasks: { failedToday: failedToday.slice(-20).map((task) => brief(task, task.result?.slice(0, 200))), waitingApproval: waitingApproval.slice(0, 20).map((task) => brief(task)), blockedByEngine: blockedByEngine.slice(0, 20) },
      quota,
      enginesBlocked,
      weekSpend: { periodKey: bounds.key, costUsd: week.costUsd, costBrl: week.costBrl, turns: week.turns },
    };
  });
}

/** GET /api/routines/today: as rotinas de hoje somando todos os workspaces (o painel Hoje da plataforma e a agenda). */
export function registerPlatformRoutineRoutes(app: FastifyInstance, manager: WorkspaceManager): void {
  app.get("/api/routines/today", async (): Promise<PlatformRoutinesToday> => {
    const parts: RoutinesToday[] = [];
    let now = new Date();
    for (const workspace of manager.list()) {
      const runtime = manager.find(workspace.id);
      if (!runtime) continue;
      now = runtime.now();
      parts.push(buildRoutinesToday({ workspaceId: runtime.id, routines: runtime.routines, tracking: runtime.tracking, state: runtime.state, now, forYou: runtime.forYou.list() }));
    }
    return mergeRoutinesToday(parts, now);
  });
}
