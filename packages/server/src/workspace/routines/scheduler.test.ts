import path from "node:path";
import { emptyRoutinesData, type MetaPlan, type Agent, type EngineBlock, type ForYouItem, type OfficeState, type Routine, type RoutineProposalPayload, type Task } from "@cyno/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WriteQueue } from "../../store/write-queue";
import { useTempDirs } from "../../dev/test-utils";
import { deliveryFailure, RoutineService } from "./routine-service";
import { MetaTracker } from "./meta-tracker";
import { overviewItem } from "./overview";
import { RoutineScheduler, ROUTINE_TICK_MS, linkChasePrompt, metaPrompt, type WakeInput } from "./scheduler";

const tempDir = useTempDirs();
const queues: WriteQueue[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(queues.splice(0).map((queue) => queue.idle()));
});

const CLARA = { id: "clara", name: "Clara", teamId: "time" } as Agent;
/** Segunda 2026-11-09 11:00 em São Paulo (W46), logo depois do fechamento das 08:00. */
const MONDAY = new Date("2026-11-09T14:00:00Z");

async function setup(start: Date = MONDAY) {
  const dir = await tempDir();
  const queue = new WriteQueue();
  queues.push(queue);
  let clock = start;
  const state = { tasks: [] as Task[] };
  const cards: RoutineProposalPayload[] = [];
  const service = new RoutineService(emptyRoutinesData(), {
    file: path.join(dir, "routines.json"),
    queue,
    publish: () => undefined,
    owners: { agent: (id) => (id === "clara" ? CLARA : undefined), team: (id) => (id === "time" ? { id, name: "Time" } : undefined) },
    openCard: (payload) => {
      cards.push(payload);
      return { id: `A-000${cards.length}` } as ForYouItem;
    },
    log: { warn: () => undefined, error: () => undefined },
    now: () => clock,
  });
  // O período anterior já foi fechado (o teste do fechamento limpa isto).
  const closed = { value: true };
  const created: { routine: Routine; prompt: string }[] = [];
  const wakes: WakeInput[] = [];
  let block: EngineBlock | undefined;
  let wakeResult = true;
  let nextId = 1;
  const forYouItems: ForYouItem[] = [];
  const dismissals: string[] = [];
  const meta = new MetaTracker({
    routines: service,
    state: { read: () => ({ rooms: [], teams: [], agents: [CLARA], tasks: state.tasks }) as OfficeState, readForYou: () => forYouItems },
    forYou: {
      cancel: async (id, input) => {
        const item = forYouItems.find((candidate) => candidate.id === id)!;
        Object.assign(item, { status: "cancelado", cancelledBy: input.by, cancelReason: input.reason });
        dismissals.push(id);
      },
    },
    now: () => clock,
    log: { warn: () => undefined },
  });
  const scheduler = new RoutineScheduler({
    routines: service,
    meta,
    state: { read: () => ({ rooms: [], teams: [], agents: [CLARA], tasks: state.tasks }) as OfficeState },
    pickAgent: () => CLARA,
    blocked: () => block,
    createTask: async (routine, agent, prompt) => {
      const task = { id: `task-${nextId++}`, roomId: "r", teamId: agent.teamId, agentId: agent.id, prompt, status: "queued", routineId: routine.id, createdAt: clock.toISOString(), updatedAt: clock.toISOString() } as Task;
      state.tasks.push(task);
      created.push({ routine, prompt });
      return task;
    },
    wake: (input) => {
      wakes.push(input);
      return wakeResult;
    },
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    now: () => clock,
  });
  const activate = (target: number, extra: Partial<Parameters<typeof service.create>[0]> = {}) =>
    service.create({ title: "Convites", unit: "convite", kind: "invite", site: "linkedin.com", target, period: "week", agentId: "clara", needsApproval: true, instruction: "Convide devs", ...extra });
  if (closed.value) service.closePeriod("2026-W45");
  return {
    service,
    scheduler,
    meta,
    forYouItems,
    dismissals,
    state,
    created,
    wakes,
    cards,
    activate,
    setClock: (date: Date) => (clock = date),
    setBlock: (value: EngineBlock | undefined) => (block = value),
    setWakeResult: (value: boolean) => (wakeResult = value),
    deliver: (task: Task, urls: string[]) => {
      for (const url of urls) service.record({ task, agentId: "clara", routineId: task.routineId!, url });
      task.status = "done";
      task.updatedAt = clock.toISOString();
      service.onTaskUpdate(task);
    },
  };
}

describe("RoutineScheduler: o que cobra", () => {
  it("atrasada: cria UMA tarefa com o lote (menor entre déficit, 5 e o teto diário) e marca a rotina", async () => {
    const { scheduler, created, activate, service } = await setup();
    activate(10);
    await scheduler.tick();
    expect(created).toHaveLength(1);
    // Segunda 11h: 11h/168h da semana -> esperado 1 (de 10), entregue 0.
    expect(created[0]!.prompt).toMatch(/^Rotina: Convites/);
    expect(created[0]!.prompt).toContain("Faça 5 agora");
    expect(created[0]!.prompt).toContain("routine_record");
    expect(created[0]!.prompt).toContain("submit_result");
    expect(created[0]!.prompt).toContain("Convide devs");
    expect(service.get("R-0001")).toMatchObject({ lastTaskId: "task-1" });
    expect(service.decisionsOf("R-0001")[0]).toMatchObject({ kind: "dispatched", taskId: "task-1" });
  });

  it("tarefa ainda aberta da rotina: não cria outra (um lote por vez)", async () => {
    const { scheduler, created, activate, service } = await setup();
    activate(10);
    await scheduler.tick();
    await scheduler.tick();
    await scheduler.tick();
    expect(created).toHaveLength(1);
    expect(service.decisionsOf("R-0001").filter((decision) => decision.kind === "skipped")).toHaveLength(1);
  });

  it("no ritmo ou meta batida: não faz nada", async () => {
    const { scheduler, created, activate, deliver, state } = await setup();
    activate(10);
    await scheduler.tick();
    deliver(state.tasks[0]!, ["https://linkedin.com/in/a"]);
    await scheduler.tick();
    expect(created).toHaveLength(1);
  });

  it("depois de entregar, o próximo lote sai quando o ritmo volta a atrasar", async () => {
    const { scheduler, created, activate, deliver, state, setClock } = await setup();
    activate(10);
    await scheduler.tick();
    deliver(state.tasks[0]!, ["https://linkedin.com/in/a", "https://linkedin.com/in/b"]);
    // Quarta 11h: esperado 4, entregue 2: déficit 2.
    setClock(new Date("2026-11-11T14:00:00Z"));
    await scheduler.tick();
    expect(created).toHaveLength(2);
    expect(created[1]!.prompt).toContain("Meta da semana (2026-W46): 2/10");
    expect(created[1]!.prompt).toContain("Faça 5 agora");
  });

  it("motor bloqueado: pula e anota o motivo", async () => {
    const { scheduler, created, activate, setBlock, service } = await setup();
    activate(10);
    setBlock({ reason: "quota" });
    await scheduler.tick();
    expect(created).toHaveLength(0);
    expect(service.decisionsOf("R-0001")[0]!.reason).toMatch(/indisponível \(quota\)/);
    setBlock(undefined);
    await scheduler.tick();
    expect(created).toHaveLength(1);
  });

  it("teto diário: o lote respeita o que resta e para quando acaba", async () => {
    const { scheduler, created, activate, setClock, service, state, deliver } = await setup();
    activate(60, { dailyCap: 2 } as never);
    // Quarta: esperado alto, mas o teto é 2 por dia.
    setClock(new Date("2026-11-11T14:00:00Z"));
    await scheduler.tick();
    expect(created[0]!.prompt).toContain("Faça 2 agora");
    deliver(state.tasks[0]!, ["https://linkedin.com/in/a", "https://linkedin.com/in/b"]);
    await scheduler.tick();
    expect(created).toHaveLength(1);
    expect(service.decisionsOf("R-0001")[0]!.reason).toMatch(/teto diário atingido/);
  });

  it("pausada, semana pulada e proposta: não cobra", async () => {
    const { scheduler, created, activate, service } = await setup();
    const paused = activate(10);
    service.update(paused.id, { pausedUntil: "2026-11-09T20:00:00.000Z" });
    const skipped = activate(10);
    service.update(skipped.id, { skipThisPeriod: true });
    service.propose({ title: "P", unit: "x", kind: "post", site: "linkedin.com", target: 3, agentId: "clara", instruction: "" });
    await scheduler.tick();
    expect(created).toHaveLength(0);
  });

  it("rotina fabricada pela semente do app de teste (seed): atrasada, mas o vigia não cobra", async () => {
    const { scheduler, created, activate, service } = await setup();
    const routine = activate(10);
    // A mesma rotina, sem a marca, seria cobrada (o primeiro teste deste arquivo); com a marca, nada sai.
    // A marca só nasce na semente, gravada direto em disco: aqui ela é posta no registro em memória do serviço.
    (service as unknown as { data: { routines: { id: string; seed?: true }[] } }).data.routines.find((candidate) => candidate.id === routine.id)!.seed = true;
    await scheduler.tick();
    expect(created).toHaveLength(0);
  });

  it("fechamento semanal (revisão M1): rotina seed não acorda o Maestro nem abre cartão de baixar a meta; sem a marca, acorda", async () => {
    const control = await setup(new Date("2026-11-09T14:00:00Z"));
    control.activate(10);
    control.setClock(new Date("2026-11-16T11:00:00Z"));
    await control.scheduler.tick();
    expect(control.wakes.filter((wake) => wake.kind === "weekly")).toHaveLength(1);

    const { scheduler, wakes, cards, activate, service, setClock } = await setup(new Date("2026-11-09T14:00:00Z"));
    const routine = activate(10);
    (service as unknown as { data: { routines: { id: string; seed?: true }[] } }).data.routines.find((candidate) => candidate.id === routine.id)!.seed = true;
    setClock(new Date("2026-11-16T11:00:00Z"));
    await scheduler.tick();
    expect(wakes).toHaveLength(0);
    expect(cards).toHaveLength(0);
    expect(service.closedPeriod()).toBe("2026-W46"); // o período fecha, só não há nada a fechar para a rotina inventada
    expect(service.results().some((result) => result.routineId === routine.id && result.periodKey === "2026-W46")).toBe(false);
  });

  it("tarefa anterior sem entrega: espera antes de tentar de novo", async () => {
    const { scheduler, created, activate, state, setClock } = await setup();
    activate(10);
    await scheduler.tick();
    state.tasks[0]!.status = "failed";
    state.tasks[0]!.updatedAt = MONDAY.toISOString();
    setClock(new Date(MONDAY.getTime() + 10 * 60_000));
    await scheduler.tick();
    expect(created).toHaveLength(1);
    setClock(new Date(MONDAY.getTime() + 61 * 60_000));
    await scheduler.tick();
    expect(created).toHaveLength(2);
  });

  it("reiniciar não repõe horários perdidos: um lote só, pelo déficit de agora", async () => {
    const { scheduler, created, activate, setClock } = await setup();
    activate(10);
    setClock(new Date("2026-11-12T14:00:00Z"));
    await scheduler.tick();
    expect(created).toHaveLength(1);
    expect(created[0]!.prompt).toContain("Faça 5 agora");
  });
});

describe("RoutineScheduler: teto de tentativas sem entrega", () => {
  /** Cada rodada: o vigia cria a tarefa e ela termina sem nenhum item entregue. */
  async function emptyRound(ctx: Awaited<ReturnType<typeof setup>>, status: "done" | "failed" = "done") {
    await ctx.scheduler.tick();
    const task = ctx.state.tasks.at(-1)!;
    task.status = status;
    task.updatedAt = new Date(MONDAY.getTime() + (ctx.created.length - 1) * 2 * 3_600_000).toISOString();
    ctx.service.onTaskUpdate(task);
    // Passa o tempo de espera depois de uma tarefa sem entrega.
    ctx.setClock(new Date(MONDAY.getTime() + ctx.created.length * 2 * 3_600_000));
  }

  it("3 tarefas seguidas sem entrega (done vazia ou failed): pausa, anota e abre o cartão revisar", async () => {
    const ctx = await setup();
    ctx.activate(10);
    await emptyRound(ctx, "done");
    await emptyRound(ctx, "failed");
    expect(ctx.service.get("R-0001")).toMatchObject({ status: "ativa", emptyStreak: 2 });
    await emptyRound(ctx, "done");
    expect(ctx.service.get("R-0001")).toMatchObject({ status: "pausada", pausedReason: "3 tentativas sem entrega" });
    expect(ctx.cards.at(-1)).toMatchObject({ mode: "revisar", routineId: "R-0001" });
    expect(ctx.service.decisionsOf("R-0001")[0]!.reason).toContain("3 tentativas sem entrega");
    // Pausada: o vigia não cria mais tarefa.
    ctx.setClock(new Date("2026-11-11T14:00:00Z"));
    await ctx.scheduler.tick();
    expect(ctx.created).toHaveLength(3);
  });

  it("uma entrega zera a contagem", async () => {
    const ctx = await setup();
    ctx.activate(10);
    await emptyRound(ctx, "done");
    await emptyRound(ctx, "failed");
    await ctx.scheduler.tick();
    ctx.deliver(ctx.state.tasks.at(-1)!, ["https://linkedin.com/in/a"]);
    expect(ctx.service.get("R-0001").emptyStreak).toBe(0);
    // Mais tarde na semana a meta volta a atrasar e sai outro lote.
    ctx.setClock(new Date("2026-11-12T14:00:00Z"));
    await emptyRound(ctx);
    expect(ctx.service.get("R-0001")).toMatchObject({ status: "ativa", emptyStreak: 1 });
  });

  it("aprovar o cartão retoma; recusar mantém pausada", async () => {
    const ctx = await setup();
    ctx.activate(10);
    // Motivos diferentes (terminou vazia / falhou): não bloqueia, pausa na terceira.
    for (const status of ["done", "failed", "done"] as const) await emptyRound(ctx, status);
    const item = { id: "A-0009", routine: ctx.cards.at(-1) } as ForYouItem;
    ctx.service.decide(item, { status: "rejeitado" });
    expect(ctx.service.get("R-0001").status).toBe("pausada");
    ctx.service.decide(item, { status: "aprovado" });
    expect(ctx.service.get("R-0001")).toMatchObject({ status: "ativa", emptyStreak: 0 });
    expect(ctx.service.get("R-0001").pausedReason).toBeUndefined();
  });
});

describe("RoutineScheduler: fechamento semanal e risco", () => {
  it("antes de segunda 08:00 não fecha; depois fecha uma vez e acorda o Maestro uma vez", async () => {
    const { scheduler, wakes, activate, service, setClock } = await setup(new Date("2026-11-09T14:00:00Z"));
    activate(10);
    // Cenário limpo: nenhum período fechado ainda.
    setClock(new Date("2026-11-16T10:59:00Z")); // segunda 07:59 em SP (W47 ainda não passou das 08:00)
    await scheduler.tick();
    expect(service.closedPeriod()).toBe("2026-W45");
    setClock(new Date("2026-11-16T11:00:00Z")); // segunda 08:00 em SP
    await scheduler.tick();
    expect(service.closedPeriod()).toBe("2026-W46");
    expect(wakes.filter((wake) => wake.kind === "weekly")).toHaveLength(1);
    expect(wakes[0]!.message).toContain("Convites (R-0001): 0/10 entregues, NÃO bateu a meta");
    expect(wakes[0]!.message).toContain("save_note");
    await scheduler.tick();
    await scheduler.tick();
    expect(wakes.filter((wake) => wake.kind === "weekly")).toHaveLength(1);
  });

  it("duas semanas ruins seguidas: abre o cartão de baixar a meta (uma vez)", async () => {
    const { scheduler, cards, activate, setClock } = await setup();
    activate(10);
    setClock(new Date("2026-11-16T11:00:00Z"));
    await scheduler.tick();
    expect(cards).toHaveLength(0);
    setClock(new Date("2026-11-23T11:00:00Z"));
    await scheduler.tick();
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ mode: "ajustar", routineId: "R-0001", target: 10, suggestedTarget: 7 });
    await scheduler.tick();
    expect(cards).toHaveLength(1);
  });

  it("meta em risco (atrasada com menos de 2 dias): acorda uma vez por meta por período", async () => {
    const { scheduler, wakes, activate, state, setClock, service } = await setup();
    activate(10);
    setClock(new Date("2026-11-14T14:00:00Z")); // sábado: faltam < 2 dias
    await scheduler.tick();
    state.tasks[0]!.status = "in_progress";
    await scheduler.tick();
    await scheduler.tick();
    const risk = wakes.filter((wake) => wake.kind === "risk");
    expect(risk).toHaveLength(1);
    expect(risk[0]!.message).toContain("Convites (R-0001): 0/10");
    expect(service.get("R-0001").riskWokenPeriod).toBe("2026-W46");
    // Na semana seguinte pode acordar de novo.
    setClock(new Date("2026-11-21T14:00:00Z"));
    await scheduler.tick();
    expect(wakes.filter((wake) => wake.kind === "risk")).toHaveLength(2);
  });

  it("sem Maestro de CLI: não acorda mas também não repete o aviso", async () => {
    const { scheduler, wakes, activate, setClock, setWakeResult } = await setup();
    activate(10);
    setWakeResult(false);
    setClock(new Date("2026-11-14T14:00:00Z"));
    await scheduler.tick();
    await scheduler.tick();
    expect(wakes.filter((wake) => wake.kind === "risk")).toHaveLength(1);
  });
});

describe("RoutineScheduler: Meta v2", () => {
  const goal = (extra: Record<string, unknown> = {}) => ({ goal: { target: 3, period: "week" as const, stopOnHit: true, prepareFactor: 2, ...extra } });
  const activateV2 = (ctx: Awaited<ReturnType<typeof setup>>, extra: Record<string, unknown> = {}, target = 3) => ctx.activate(target, { kind: "other", site: "example.com", ...goal({ target, ...extra }) } as never);
  const option = (id: string, taskId: string, status: ForYouItem["status"] = "pendente") => ({ id, taskId, status, kind: "aprovacao", agentId: "clara", roomId: "r" }) as unknown as ForYouItem;

  it("fator de preparo: cobra o que falta e pede o dobro de opções, num único lote", async () => {
    const ctx = await setup();
    activateV2(ctx);
    await ctx.scheduler.tick();
    expect(ctx.created).toHaveLength(1);
    expect(ctx.created[0]!.prompt).toContain("Faça 3 agora");
    expect(ctx.created[0]!.prompt).toContain("prepare 6 opções");
    expect(ctx.created[0]!.prompt).toContain("UMA chamada de request_approval com items[]");
    expect(ctx.service.decisionsOf("R-0001")[0]!.reason).toContain("lote de 3 (6 opção(ões)");
  });

  it("dias preferidos são só sugestão: segunda não cobra, terça cobra e quarta atrasada ainda cobra", async () => {
    const ctx = await setup();
    activateV2(ctx, { preferredDays: [2, 4] }, 2);
    await ctx.scheduler.tick();
    expect(ctx.created).toHaveLength(0);
    ctx.setClock(new Date("2026-11-10T14:00:00Z")); // terça
    await ctx.scheduler.tick();
    expect(ctx.created).toHaveLength(1);
    expect(ctx.created[0]!.prompt).toContain("Dias preferidos: terça, quinta");
    ctx.state.tasks[0]!.status = "failed";
    ctx.state.tasks[0]!.updatedAt = "2026-11-10T14:00:00.000Z";
    ctx.setClock(new Date("2026-11-11T20:00:00Z")); // quarta, passou a espera: atrasada, cobra mesmo sem ser dia preferido
    await ctx.scheduler.tick();
    expect(ctx.created).toHaveLength(2);
  });

  it("o que está em preparo ou aprovado cobre o que falta: o vigia não cobra de novo", async () => {
    const ctx = await setup();
    activateV2(ctx);
    await ctx.scheduler.tick();
    // A tarefa terminou sem fechar a meta, mas 6 opções ainda esperam OK em outra tarefa aberta da rotina.
    ctx.state.tasks.push({ ...ctx.state.tasks[0]!, id: "task-x" });
    ctx.state.tasks[0]!.status = "done";
    for (let n = 1; n <= 6; n += 1) ctx.forYouItems.push(option(`A-${n}`, "task-x"));
    ctx.setClock(new Date("2026-11-12T14:00:00Z"));
    await ctx.scheduler.tick();
    expect(ctx.created).toHaveLength(1);
    expect(ctx.service.decisionsOf("R-0001")[0]!.reason).toContain("já há uma tarefa aberta");
  });

  it("bateu: para até o próximo período e dispensa as opções que sobraram sem acordar a IA", async () => {
    const ctx = await setup();
    activateV2(ctx);
    await ctx.scheduler.tick();
    const task = ctx.state.tasks[0]!;
    // 3 aprovadas (meta fechada) e 3 sobras ainda pendentes, com a tarefa aberta esperando.
    task.status = "waiting_approval";
    for (let n = 1; n <= 3; n += 1) ctx.forYouItems.push(option(`A-${n}`, task.id, "aprovado"));
    for (let n = 4; n <= 6; n += 1) ctx.forYouItems.push(option(`A-${n}`, task.id));
    await ctx.scheduler.tick();
    expect(ctx.dismissals).toEqual(["A-4", "A-5", "A-6"]);
    expect(ctx.forYouItems.filter((item) => item.status === "cancelado")).toHaveLength(3);
    expect(ctx.service.statsFor("R-0001", "2026-W46").dismissed).toBe(3);
    expect(ctx.created).toHaveLength(1);
    // Terminou e entregou as 3: segue parada até a semana virar.
    ctx.deliver(task, ["https://example.com/1", "https://example.com/2", "https://example.com/3"]);
    ctx.setClock(new Date("2026-11-14T14:00:00Z"));
    await ctx.scheduler.tick();
    expect(ctx.created).toHaveLength(1);
    expect(ctx.service.decisionsOf("R-0001")[0]!.reason).toContain("meta batida (3/3)");
    // Um tick a mais não dispensa de novo.
    await ctx.scheduler.tick();
    expect(ctx.dismissals).toHaveLength(3);
  });

  it("virar o período não acumula: o que faltou na semana não vira dívida na seguinte", async () => {
    const ctx = await setup();
    activateV2(ctx, {}, 3);
    await ctx.scheduler.tick();
    ctx.deliver(ctx.state.tasks[0]!, ["https://example.com/1"]);
    // Semana seguinte (W47), segunda 11h: alvo cheio de novo, sem somar o que faltou.
    ctx.setClock(new Date("2026-11-16T14:00:00Z"));
    await ctx.scheduler.tick();
    expect(ctx.service.closedPeriod()).toBe("2026-W46");
    expect(ctx.service.results().find((result) => result.periodKey === "2026-W46")).toMatchObject({ target: 3, delivered: 1, outcome: "nao_bateu" });
    expect(ctx.created).toHaveLength(2);
    expect(ctx.created[1]!.prompt).toContain("(2026-W47): 0/3");
    expect(ctx.created[1]!.prompt).toContain("Faça 3 agora");
  });

  it("meta mensal: ritmo do mês, fecha no dia 1 às 08:00 e guarda preparadas, aprovadas e dispensadas no histórico", async () => {
    const ctx = await setup(new Date("2026-11-20T14:00:00Z"));
    activateV2(ctx, { period: "month" }, 4);
    await ctx.scheduler.tick();
    expect(ctx.created[0]!.prompt).toContain("Meta do mês (2026-M11)");
    ctx.service.bumpStats("R-0001", "2026-M11", { prepared: 8, approved: 4, dismissed: 4 });
    ctx.deliver(ctx.state.tasks[0]!, ["https://example.com/1", "https://example.com/2", "https://example.com/3", "https://example.com/4"]);
    await ctx.scheduler.tick();
    expect(ctx.created).toHaveLength(1);
    // Antes das 08:00 do dia 1 não fecha; depois fecha o mês (e não mexe nas semanas).
    ctx.setClock(new Date("2026-12-01T10:59:00Z"));
    await ctx.scheduler.tick();
    expect(ctx.service.closedMonth()).toBe("2026-M10");
    ctx.setClock(new Date("2026-12-01T11:00:00Z"));
    await ctx.scheduler.tick();
    expect(ctx.service.closedMonth()).toBe("2026-M11");
    expect(ctx.service.results().find((result) => result.periodKey === "2026-M11")).toMatchObject({ target: 4, delivered: 4, outcome: "bateu", prepared: 8, approved: 4, dismissed: 4 });
    expect(ctx.wakes.find((wake) => wake.kind === "weekly")!.message).toContain("Fechamento mensal das rotinas (2026-M11)");
    expect(ctx.wakes[0]!.message).toContain("8 opções preparadas, 4 aprovadas, 4 dispensadas");
    // O histórico por período aparece para a tela.
    expect(ctx.service.history(ctx.service.get("R-0001"), new Date("2026-12-02T14:00:00Z"), 2).at(-1)).toMatchObject({ periodKey: "2026-M11", outcome: "bateu", prepared: 8, approved: 4, dismissed: 4 });
  });

  it("meta v1 (sem goal, só target) continua valendo com os padrões: lote do que falta, sem preparo extra", async () => {
    const ctx = await setup();
    ctx.activate(4);
    expect(ctx.service.get("R-0001").goal).toMatchObject({ stopOnHit: true, prepareFactor: 1 });
    await ctx.scheduler.tick();
    expect(ctx.created[0]!.prompt).toContain("Faça 4 agora");
    expect(ctx.created[0]!.prompt).not.toContain("opções bem pensadas");
  });
});

describe("RoutineScheduler: o relógio", () => {
  it("encadeia setTimeout de 10 em 10 minutos e para no stop", async () => {
    vi.useFakeTimers();
    const { scheduler, created, activate } = await setup();
    activate(10);
    scheduler.start();
    await vi.advanceTimersByTimeAsync(ROUTINE_TICK_MS - 1);
    expect(created).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(created).toHaveLength(1);
    scheduler.stop();
    await vi.advanceTimersByTimeAsync(ROUTINE_TICK_MS * 3);
    expect(created).toHaveLength(1);
  });
});

describe("metaPrompt", () => {
  const routine = (extra: Partial<Routine> = {}) => ({ id: "R-0001", title: "Comentários", unit: "comentário", kind: "comment", site: "linkedin.com", target: 8, period: "week", instruction: "", needsApproval: true, mode: { kind: "pede-ok" }, ...extra }) as Routine;
  const plan = (extra: Partial<MetaPlan> = {}): MetaPlan => ({ periodKey: "2026-W46", periodStart: "2026-11-09T03:00:00.000Z", periodEnd: "2026-11-16T03:00:00.000Z", target: 8, delivered: 3, inFlight: 0, pending: 0, pendingCover: 0, committed: 3, missing: 5, expected: 4, pace: "atrasada", hit: false, action: "cobrar", reason: "", batch: 5, candidates: 5, ...extra });

  it("Pede OK: diz quanto falta e manda UM lote com items[]", () => {
    const prompt = metaPrompt(routine(), plan(), MONDAY);
    expect(prompt.startsWith("Rotina: Comentários")).toBe(true);
    expect(prompt).toContain("3/8 comentário entregues");
    expect(prompt).toContain("faltam 5 para fechar");
    expect(prompt).toContain("UMA chamada de request_approval com items[]");
    expect(prompt).toContain("routine_record");
  });

  it("com fator de preparo: pede mais opções para escolher as melhores e avisa que as sobras são dispensadas", () => {
    const prompt = metaPrompt(routine(), plan({ batch: 3, candidates: 6, missing: 3, target: 3, delivered: 0, committed: 0 }), MONDAY);
    expect(prompt).toContain("prepare 6 opções");
    expect(prompt).toContain("as 3 melhores");
    expect(prompt).toContain("dispensadas pelo servidor");
  });

  it("Automático: executa só até o que falta e o servidor bloqueia o resto", () => {
    const prompt = metaPrompt(routine({ mode: { kind: "automatico", grant: { actions: [], approvedAt: MONDAY.toISOString() } } }), plan({ batch: 2, candidates: 4, missing: 2 }), MONDAY);
    expect(prompt).toContain("modo Automático");
    expect(prompt).toContain("só até 2");
    expect(prompt).toContain("não deixa passar do alvo");
    expect(prompt).not.toContain("request_approval com items");
  });

  it("meta mensal e dias preferidos aparecem no pedido", () => {
    const prompt = metaPrompt(routine({ period: "month", goal: { target: 8, period: "month", stopOnHit: true, prepareFactor: 1, preferredDays: [2, 4] } }), plan({ periodKey: "2026-M11", periodEnd: "2026-12-01T03:00:00.000Z" }), MONDAY);
    expect(prompt).toContain("Meta do mês (2026-M11)");
    expect(prompt).toContain("Dias preferidos: terça, quinta");
    expect(prompt).toContain("só sugestão");
  });
});

describe("RoutineScheduler: acabamento (aprovadas sem link, bloqueio, espera)", () => {
  const overviewOf = (ctx: Awaited<ReturnType<typeof setup>>, now: Date) =>
    overviewItem({ routines: ctx.service, state: { read: () => ({ rooms: [], teams: [], agents: [CLARA], tasks: ctx.state.tasks }) as OfficeState }, now, forYou: ctx.forYouItems }, ctx.service.get("R-0001"));

  /** Uma tarefa de preparo que terminou com N cartões aprovados e nenhum link registrado. */
  async function approvedWithoutLinks(ctx: Awaited<ReturnType<typeof setup>>, count: number) {
    await ctx.scheduler.tick();
    const task = ctx.state.tasks.at(-1)!;
    for (let i = 0; i < count; i += 1) ctx.forYouItems.push({ id: `A-1${i}`, taskId: task.id, status: "aprovado", text: `Comentário ${i}`, createdAt: MONDAY.toISOString(), decidedAt: MONDAY.toISOString() } as ForYouItem);
    task.status = "done";
    task.result = "Fiz tudo.";
    task.updatedAt = MONDAY.toISOString();
    ctx.service.onTaskUpdate(task);
  }

  it("aprovadas sem link: a decisão e o cartão dizem o mesmo; o vigia cobra só o registro, uma vez por espera", async () => {
    const ctx = await setup();
    ctx.activate(3);
    await approvedWithoutLinks(ctx, 3);
    const now = new Date(MONDAY.getTime() + 3_700_000);
    ctx.setClock(now);
    const item = overviewOf(ctx, now);
    expect(item).toMatchObject({ delivered: 0, approvedNoLink: 3 });
    expect(item.nextDispatch.reason).toContain("3 aprovada(s), falta registrar o link");
    await ctx.scheduler.tick();
    expect(ctx.created).toHaveLength(2);
    expect(ctx.created[1]!.prompt).toContain("Registre os links das 3 aprovada(s)");
    expect(ctx.created[1]!.prompt).toContain("NÃO prepare opções novas");
    expect(ctx.created[1]!.prompt).not.toContain("Faça 3 agora");
    expect(ctx.created[1]!.prompt).toContain("A-10");
    // A cobrança do registro não repete na mesma espera (a tarefa acabou sem registrar: espera e não prepara nada novo).
    const chase = ctx.state.tasks.at(-1)!;
    chase.status = "done";
    chase.updatedAt = now.toISOString();
    ctx.service.onTaskUpdate(chase);
    ctx.setClock(new Date(now.getTime() + 600_000));
    await ctx.scheduler.tick();
    expect(ctx.created).toHaveLength(2);
    // Duas tarefas seguidas sem nenhum link (o preparo e a cobrança do registro): o vigia para e diz por quê.
    expect(overviewOf(ctx, new Date(now.getTime() + 600_000)).nextDispatch).toMatchObject({ state: "sem_cobranca", reason: expect.stringContaining("terminou sem registrar nenhum item") });
  });

  it("a cobrança do registro leva as Instruções da rotina e ensina o registro sem link para entrega ao dono", () => {
    const routine = { id: "R-0001", title: "Posts", unit: "post", kind: "post", site: "instagram.com", instruction: "Faça posts quadrados de café com a identidade da marca.", period: "week" } as Routine;
    const plan = { periodKey: "2026-W46", approvedNoLink: 2, delivered: 0, target: 2 } as MetaPlan;
    const prompt = linkChasePrompt(routine, plan, ["- A-1: post"]);
    expect(prompt).toContain("Instruções da rotina:\nFaça posts quadrados de café");
    expect(prompt).toContain('delivered_to "owner"');
    expect(linkChasePrompt({ ...routine, instruction: "" }, plan, [])).not.toContain("Instruções da rotina");
  });

  it("depois de 'Tentar de novo' a cobrança do registro sai na hora, sem esperar a hora de espera", async () => {
    const ctx = await setup();
    ctx.activate(3);
    await approvedWithoutLinks(ctx, 3);
    const now = new Date(MONDAY.getTime() + 3_700_000);
    ctx.setClock(now);
    await ctx.scheduler.tick();
    const chase = ctx.state.tasks.at(-1)!;
    chase.status = "done";
    chase.updatedAt = now.toISOString();
    ctx.service.onTaskUpdate(chase);
    ctx.setClock(new Date(now.getTime() + 600_000));
    await ctx.scheduler.tick();
    expect(ctx.created).toHaveLength(2);
    ctx.service.unblock("R-0001");
    await ctx.scheduler.tick();
    expect(ctx.created).toHaveLength(3);
    expect(ctx.created[2]!.prompt).toContain("Registre os links das 3 aprovada(s)");
  });

  it("depois que o agente registra os links as aprovadas viram entregues e nada mais é cobrado", async () => {
    const ctx = await setup();
    ctx.activate(2);
    await approvedWithoutLinks(ctx, 2);
    ctx.setClock(new Date(MONDAY.getTime() + 3_700_000));
    await ctx.scheduler.tick();
    ctx.deliver(ctx.state.tasks.at(-1)!, ["https://linkedin.com/feed/update/1", "https://linkedin.com/feed/update/2"]);
    expect(overviewOf(ctx, new Date(MONDAY.getTime() + 3_700_000))).toMatchObject({ delivered: 2, approvedNoLink: 0 });
    await ctx.scheduler.tick();
    expect(ctx.created).toHaveLength(2);
  });

  it("a Meta atrasada em espera (tarefa sem entrega) diz a hora em que tenta de novo, não 'cobra agora'", async () => {
    const ctx = await setup();
    ctx.activate(10);
    await ctx.scheduler.tick();
    const task = ctx.state.tasks.at(-1)!;
    task.status = "done";
    task.updatedAt = MONDAY.toISOString();
    ctx.service.onTaskUpdate(task);
    const now = new Date(MONDAY.getTime() + 20 * 60_000);
    ctx.setClock(now);
    const item = overviewOf(ctx, now);
    expect(item.nextDispatch.state).toBe("aguardando");
    expect(item.nextDispatch.reason).toMatch(/tenta de novo às \d\d:\d\d/);
    expect(item.nextDispatch.retryAt).toBe(new Date(MONDAY.getTime() + 3_600_000).toISOString());
  });

  it("2 tentativas seguidas sem navegador: bloqueia, avisa uma vez, o vigia para e 'Tentar de novo' zera", async () => {
    const ctx = await setup();
    ctx.activate(10);
    for (let round = 0; round < 2; round += 1) {
      await ctx.scheduler.tick();
      const task = ctx.state.tasks.at(-1)!;
      task.status = "done";
      task.result = "0 entregues: não consegui abrir o navegador neste ambiente.";
      task.updatedAt = ctx.service.get("R-0001").lastDispatchAt!;
      ctx.service.onTaskUpdate(task);
      ctx.setClock(new Date(MONDAY.getTime() + (round + 1) * 2 * 3_600_000));
    }
    const blocked = ctx.service.get("R-0001");
    expect(blocked.blocked).toMatchObject({ kind: "sem_navegador", reason: "O agente não conseguiu executar: sem navegador", attempts: 2 });
    expect(ctx.cards.filter((card) => card.mode === "revisar")).toHaveLength(1);
    expect(overviewOf(ctx, new Date(MONDAY.getTime() + 5 * 3_600_000)).nextDispatch).toMatchObject({ state: "sem_cobranca", reason: expect.stringContaining("sem navegador") });
    ctx.setClock(new Date(MONDAY.getTime() + 8 * 3_600_000));
    await ctx.scheduler.tick();
    await ctx.scheduler.tick();
    expect(ctx.created).toHaveLength(2);
    ctx.service.unblock("R-0001");
    expect(ctx.service.get("R-0001").blocked).toBeUndefined();
    await ctx.scheduler.tick();
    expect(ctx.created).toHaveLength(3);
  });
});

describe("RoutineService: resumo da execução", () => {
  it("guarda um resumo curto e limpo e o texto completo à parte", async () => {
    const ctx = await setup();
    ctx.activate(3);
    const result = "## Resumo\n\n- **Publiquei** 2 posts no [LinkedIn](https://linkedin.com/x). Links registrados.\n- Conferi o feed\n- Nada mais";
    ctx.service.addRun("R-0001", { scheduleId: "S1", slotKey: "2026-11-09T09:00", startedAt: MONDAY.toISOString(), taskId: "task-9", outcome: "rodando" });
    ctx.service.onTaskUpdate({ id: "task-9", routineId: "R-0001", status: "done", result } as Task);
    const run = ctx.service.runsOf("R-0001")[0]!;
    expect(run.outcome).toBe("ok");
    expect(run.summary).toBe("Publiquei 2 posts no LinkedIn.");
    expect(run.detail).toBe(result);
  });
});

describe("deliveryFailure: por que a tarefa não entregou", () => {
  const why = (result: string, status: "done" | "failed" = "done") => deliveryFailure({ result, status }).reason;
  it("só a negação do navegador/acesso vira 'sem navegador'", () => {
    expect(why("0 entregues: não consegui abrir o navegador neste ambiente.")).toBe("sem navegador");
    expect(why("Sem acesso ao navegador, nada foi feito.")).toBe("sem navegador");
    expect(why("O navegador está indisponível.")).toBe("sem navegador");
    expect(why("I cannot open a browser here, so nothing was delivered.")).toBe("sem navegador");
    expect(why("No browser tool available.")).toBe("sem navegador");
  });
  it("citar o navegador sem negar não é bloqueio", () => {
    expect(why("Executei os 2 comentários abrindo as páginas no navegador. Não chamei routine_record.")).toBe("terminou sem registrar nenhum item");
    expect(why("", "failed")).toBe("a tarefa falhou sem entregar nada");
    // Frase que termina e a seguinte começa com "Abrir": não atravessa o ponto final.
    expect(why("Só abri a página e não há comentário publicado.\n\nAbrir a página não é o mesmo que fazer o item, então não registrei nada.")).toBe("terminou sem registrar nenhum item");
  });
});
