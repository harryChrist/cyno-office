import path from "node:path";
import { emptyRoutinesData, type Agent, type Project, type ScheduleInput, type Task } from "@cyno/shared";
import { afterEach, describe, expect, it } from "vitest";
import { useTempDirs } from "../../dev/test-utils";
import { WriteQueue } from "../../store/write-queue";
import { MetaTracker } from "./meta-tracker";
import { RoutineRunner, SKIP_STILL_OPEN } from "./routine-runner";
import { RoutineService } from "./routine-service";
import { SlotClock } from "./slot-clock";

const tempDir = useTempDirs();
const queues: WriteQueue[] = [];
afterEach(async () => {
  await Promise.all(queues.splice(0).map((queue) => queue.idle()));
});

const CLARA = { id: "clara", name: "Clara", teamId: "time" } as Agent;
const BETO = { id: "beto", name: "Beto", teamId: "time" } as Agent;
const AGENTS: Record<string, Agent> = { clara: CLARA, beto: BETO };
/** Quarta 2026-11-11, 08:00 em São Paulo. */
const at = (local: string) => new Date(`${local}:00-03:00`);

type Started = { agentId: string; slotKey: string; scheduleId: string; title: string; prompt: string; mode: Project["mode"]; period: string; routineId: string };

async function setup(start: Date, extra: { failStart?: boolean } = {}) {
  const dir = await tempDir();
  const queue = new WriteQueue();
  queues.push(queue);
  let clock = start;
  const tasks: Task[] = [];
  const started: Started[] = [];
  const service = new RoutineService(emptyRoutinesData(), {
    workspaceId: "ws",
    file: path.join(dir, "routines.json"),
    queue,
    publish: () => undefined,
    owners: { agent: (id) => AGENTS[id], team: (id) => (id === "time" ? { id, name: "Time" } : undefined) },
    openCard: () => undefined,
    log: { warn: () => undefined, error: () => undefined },
    now: () => clock,
  });
  const meta = new MetaTracker({ routines: service, state: { read: () => ({ tasks, agents: Object.values(AGENTS) }) as never, readForYou: () => [] }, forYou: { cancel: async () => undefined }, now: () => clock, log: { warn: () => undefined } });
  const runner = new RoutineRunner({
    routines: service,
    meta,
    state: { read: () => ({ tasks, agents: Object.values(AGENTS) }) as never },
    workspaceId: "ws",
    pickAgent: (routine) => (routine.agentId ? AGENTS[routine.agentId] : undefined),
    startTask: async (input) => {
      if (extra.failStart) throw new Error("sem fila");
      started.push({ agentId: input.agentId, slotKey: input.slotKey!, scheduleId: input.scheduleId!, title: input.title, prompt: input.prompt, mode: input.mode, period: input.period, routineId: input.routineId });
      const task = { id: `task-${started.length}`, status: "queued", agentId: input.agentId, routineId: input.routineId } as Task;
      tasks.push(task);
      return { task, project: { id: task.id } as Project };
    },
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    now: () => clock,
  });
  const errors: unknown[] = [];
  const slotClock = new SlotClock({ routines: service, runner, log: { info: () => undefined, warn: () => undefined, error: (e: unknown) => errors.push(e) }, now: () => clock });
  const finish = (taskId: string, status: "done" | "failed", result = "feito") => {
    const task = tasks.find((candidate) => candidate.id === taskId)!;
    Object.assign(task, { status, result });
    service.onTaskUpdate({ ...task });
  };
  return { service, slotClock, started, tasks, finish, errors, setNow: (date: Date) => (clock = date), run: (id = "R-0001") => service.get(id) };
}

const watch = (extra: Partial<Parameters<RoutineService["create"]>[0]> = {}) => ({
  type: "acompanhamento" as const,
  title: "Inscrições",
  agentId: "clara",
  instruction: "",
  schedules: [
    { label: "E-mail", days: { kind: "uteis" as const }, times: ["09:00", "13:00", "18:00"], action: "Leia os e-mails novos" },
    { label: "Conferir", days: { kind: "todo_dia" as const }, times: ["10:00"], action: "Abra os sites", agent: "ws/beto" },
  ] satisfies ScheduleInput[],
  ...extra,
});

describe("relógio de horários", () => {
  it("o horário vencido vai direto para o agente dele (endereço do horário ou dono), uma vez só", async () => {
    const t = await setup(at("2026-11-11T08:00"));
    t.service.create(watch());
    // Criada às 08:00: nada vence ainda.
    await t.slotClock.tick();
    expect(t.started).toEqual([]);

    t.setNow(at("2026-11-11T09:00"));
    await t.slotClock.tick();
    expect(t.started).toHaveLength(1);
    expect(t.started[0]).toMatchObject({ agentId: "clara", slotKey: "2026-11-11T09:00", scheduleId: "S1", title: "E-mail 09:00", mode: { kind: "pede-ok" }, routineId: "R-0001", period: "2026-W46" });
    expect(t.started[0]!.prompt).toContain("Leia os e-mails novos");
    expect(t.started[0]!.prompt).toContain("É a primeira execução");
    // Mesmo minuto, outra passada: nada de repetir.
    await t.slotClock.tick();
    expect(t.started).toHaveLength(1);

    // O horário das 10h é do Beto (endereço ws/beto).
    t.setNow(at("2026-11-11T10:00"));
    await t.slotClock.tick();
    expect(t.started.map((s) => `${s.scheduleId}:${s.agentId}`)).toEqual(["S1:clara", "S2:beto"]);
    const runs = t.run().lastRuns;
    expect(runs.map((r) => [r.scheduleId, r.slotKey, r.outcome])).toEqual([
      ["S1", "2026-11-11T09:00", "rodando"],
      ["S2", "2026-11-11T10:00", "rodando"],
    ]);
    expect(runs[0]).toMatchObject({ projectId: "task-1", taskId: "task-1" });
  });

  it("rotina seed (revisão L3): o relógio de horários não dispara motor para ela", async () => {
    const t = await setup(at("2026-11-11T08:00"));
    const routine = t.service.create(watch());
    (t.service as unknown as { data: { routines: { id: string; seed?: true }[] } }).data.routines.find((candidate) => candidate.id === routine.id)!.seed = true;
    t.setNow(at("2026-11-11T09:00"));
    await t.slotClock.tick();
    expect(t.started).toEqual([]);
  });

  it("a execução termina com a tarefa: ok com resumo, ou falhou", async () => {
    const t = await setup(at("2026-11-11T08:00"));
    t.service.create(watch());
    t.setNow(at("2026-11-11T09:00"));
    await t.slotClock.tick();
    t.setNow(at("2026-11-11T09:04"));
    t.finish("task-1", "done", "2 novos itens");
    expect(t.run().lastRuns[0]).toMatchObject({ outcome: "ok", summary: "2 novos itens", endedAt: at("2026-11-11T09:04").toISOString() });
    t.setNow(at("2026-11-11T13:00"));
    await t.slotClock.tick();
    t.finish("task-2", "failed", "sem cota");
    expect(t.run().lastRuns.find((r) => r.taskId === "task-2")).toMatchObject({ outcome: "falhou", summary: "sem cota" });
    // Falha de acompanhamento não conta como "sem entrega" da Meta: a rotina continua ativa.
    expect(t.run().status).toBe("ativa");
  });

  it("não empilha: horário vencido com a execução anterior ainda aberta vira pulada; depois volta a rodar", async () => {
    const t = await setup(at("2026-11-11T08:00"));
    t.service.create(watch());
    t.setNow(at("2026-11-11T09:00"));
    await t.slotClock.tick();
    expect(t.started).toHaveLength(1);
    // 13:00: a das 09:00 ainda roda.
    t.setNow(at("2026-11-11T13:00"));
    await t.slotClock.tick();
    expect(t.started).toHaveLength(1);
    const skipped = t.run().lastRuns.at(-1)!;
    expect(skipped).toMatchObject({ scheduleId: "S1", slotKey: "2026-11-11T13:00", outcome: "pulada", skipReason: SKIP_STILL_OPEN });
    // Horário diferente da mesma rotina roda junto.
    t.setNow(at("2026-11-12T10:00"));
    await t.slotClock.tick();
    expect(t.started.at(-1)).toMatchObject({ scheduleId: "S2" });
    // A anterior termina: o próximo horário roda de novo.
    t.finish("task-1", "done");
    t.setNow(at("2026-11-12T13:00"));
    await t.slotClock.tick();
    expect(t.started.at(-1)).toMatchObject({ scheduleId: "S1", slotKey: "2026-11-12T13:00" });
  });

  it("pausada não dispara e não acumula: ao retomar só valem os próximos horários", async () => {
    const t = await setup(at("2026-11-11T08:00"));
    t.service.create(watch());
    t.service.update("R-0001", { status: "pausada" });
    t.setNow(at("2026-11-11T09:00"));
    await t.slotClock.tick();
    expect(t.started).toEqual([]);
    expect(t.service.nextOf("R-0001", 3, at("2026-11-11T09:00"))).toEqual([]);
    // Retoma às 09:30: o das 09:00 (passou há 30 min, dentro das 2 h) NÃO volta.
    t.setNow(at("2026-11-11T09:30"));
    t.service.update("R-0001", { status: "ativa" });
    await t.slotClock.tick();
    expect(t.started).toEqual([]);
    t.setNow(at("2026-11-11T13:00"));
    await t.slotClock.tick();
    expect(t.started.map((s) => s.slotKey)).toEqual(["2026-11-11T13:00"]);
  });

  it("pausa por data também não acumula", async () => {
    const t = await setup(at("2026-11-11T08:00"));
    t.service.create(watch());
    t.service.update("R-0001", { pausedUntil: "2026-11-11T12:30:00.000Z" });
    t.setNow(at("2026-11-11T09:00"));
    await t.slotClock.tick();
    expect(t.started).toEqual([]);
    t.setNow(at("2026-11-11T09:31"));
    await t.slotClock.tick();
    expect(t.started).toEqual([]);
  });

  it("recuperação no boot: roda só o último horário recente de cada schedule e marca os antigos como pulados", async () => {
    const t = await setup(at("2026-11-11T08:00"));
    t.service.create(watch());
    // Servidor desligado de 08:00 até 18:30: 09, 13 e 18 venceram (S1) e 10 (S2).
    t.setNow(at("2026-11-11T18:30"));
    await t.slotClock.tick();
    expect(t.started.map((s) => `${s.scheduleId}:${s.slotKey}`)).toEqual(["S1:2026-11-11T18:00"]);
    const runs = t.run().lastRuns;
    expect(runs.filter((r) => r.outcome === "pulada").map((r) => `${r.scheduleId}:${r.slotKey}:${r.skipReason}`)).toEqual([
      "S1:2026-11-11T09:00:servidor desligado",
      "S2:2026-11-11T10:00:servidor desligado",
      "S1:2026-11-11T13:00:servidor desligado",
    ]);
    // Já tratados: a próxima passada não repete nada.
    await t.slotClock.tick();
    expect(t.started).toHaveLength(1);
    expect(t.run().lastRuns).toHaveLength(4);
  });

  it("mais de 2 h depois: tudo vira pulada e nada roda", async () => {
    const t = await setup(at("2026-11-11T08:00"));
    t.service.create(watch({ schedules: [{ label: "E-mail", days: { kind: "todo_dia" }, times: ["09:00"], action: "x" }] }));
    t.setNow(at("2026-11-11T11:01"));
    await t.slotClock.tick();
    expect(t.started).toEqual([]);
    expect(t.run().lastRuns).toMatchObject([{ outcome: "pulada", slotKey: "2026-11-11T09:00", skipReason: "servidor desligado" }]);
  });

  it("falha ao criar o trabalho: execução 'falhou', o horário não repete a cada passada", async () => {
    const t = await setup(at("2026-11-11T08:00"), { failStart: true });
    t.service.create(watch());
    t.setNow(at("2026-11-11T09:00"));
    await t.slotClock.tick();
    await t.slotClock.tick();
    expect(t.run().lastRuns).toHaveLength(1);
    expect(t.run().lastRuns[0]).toMatchObject({ outcome: "falhou" });
    expect(t.run().lastRuns[0]!.summary).toContain("sem fila");
  });

  it("horário desligado, rotina encerrada e gatilho reservado não rodam; custo zero sem nada vencido", async () => {
    const t = await setup(at("2026-11-11T08:00"));
    t.service.create(
      watch({
        schedules: [
          { label: "Desligado", days: { kind: "todo_dia" }, times: ["09:00"], action: "x", enabled: false },
          { label: "Gatilho", days: { kind: "todo_dia" }, action: "x", trigger: { kind: "email_novo", connector: "gmail" } },
          { label: "Ligado", days: { kind: "todo_dia" }, times: ["09:00"], action: "x" },
        ],
      }),
    );
    t.setNow(at("2026-11-11T09:00"));
    await t.slotClock.tick();
    expect(t.started.map((s) => s.scheduleId)).toEqual(["S3"]);
    t.service.update("R-0001", { status: "encerrada" });
    t.setNow(at("2026-11-12T09:00"));
    await t.slotClock.tick();
    expect(t.started).toHaveLength(1);
  });

  it("meta com horário e meta batida: pula sem criar trabalho", async () => {
    const t = await setup(at("2026-11-11T08:00"));
    const meta = t.service.create({ type: "meta", title: "Posts", unit: "post", kind: "post", site: "linkedin.com", target: 1, agentId: "clara", schedules: [{ label: "Olhar", days: { kind: "todo_dia" }, times: ["09:00"], action: "olhe" }] });
    // Entrega 1 link no período.
    const task = { id: "t0", agentId: "clara", routineId: meta.id } as Task;
    t.service.record({ task, agentId: "clara", routineId: meta.id, url: "https://linkedin.com/posts/1" });
    t.service.onTaskUpdate({ ...task, status: "done" } as Task);
    t.setNow(at("2026-11-11T09:00"));
    await t.slotClock.tick();
    expect(t.started).toEqual([]);
    expect(t.run().lastRuns[0]).toMatchObject({ outcome: "pulada", skipReason: expect.stringContaining("meta batida") });
  });
});

describe("rotinas: criar, editar e migrar", () => {
  it("cria acompanhamento com ids de horário, marca inicial e dono por endereço", async () => {
    const t = await setup(at("2026-11-11T08:07"));
    const routine = t.service.create({ ...watch(), agentId: undefined, address: "ws/clara" });
    expect(routine).toMatchObject({ type: "acompanhamento", agentId: "clara", owner: { address: "ws/clara" }, status: "ativa", mode: { kind: "pede-ok" }, needsApproval: true, lastRuns: [] });
    expect(routine.schedules.map((s) => [s.id, s.lastSlotKey, s.enabled])).toEqual([
      ["S1", "2026-11-11T08:07", true],
      ["S2", "2026-11-11T08:07", true],
    ]);
    expect(routine.tracking).toEqual({ fields: [], statuses: [{ name: "Ativo" }], lifespan: { untilTerminal: false } });
    expect(() => t.service.create({ ...watch(), address: "ws/clara" })).toThrow();
    expect(() => t.service.create({ ...watch(), agentId: undefined, address: "outro/clara" })).toThrow(/outro workspace/);
    expect(() => t.service.create(watch({ schedules: [{ label: "x", days: { kind: "todo_dia" }, times: ["09:00"], action: "y", agent: "ws/ninguem" }] }))).toThrow(/não existe/);
  });

  it("editar horários mantém o id e a marca de quem não mudou; mudar hora recomeça de agora; needsApproval espelha o modo", async () => {
    const t = await setup(at("2026-11-11T08:00"));
    t.service.create(watch());
    t.setNow(at("2026-11-11T09:00"));
    await t.slotClock.tick();
    const before = t.run();
    const s1 = before.schedules[0]!;
    expect(s1.lastSlotKey).toBe("2026-11-11T09:00");
    const edited = t.service.update("R-0001", {
      schedules: [
        { id: "S1", label: "E-mail (novo nome)", days: { kind: "uteis" }, times: ["09:00", "13:00", "18:00"], action: "Leia" },
        { id: "S2", label: "Conferir", days: { kind: "todo_dia" }, times: ["10:30"], action: "Abra", agent: "ws/beto" },
        { label: "Novo", days: { kind: "mes", monthDay: 1 }, times: ["09:00"], action: "Relatório" },
      ],
    });
    expect(edited.schedules.map((s) => s.id)).toEqual(["S1", "S2", "S3"]);
    expect(edited.schedules[0]!.lastSlotKey).toBe("2026-11-11T09:00");
    expect(edited.schedules[1]!.lastSlotKey).toBe("2026-11-11T09:00");
    expect(() => t.service.update("R-0001", { schedules: [] })).toThrow(/pelo menos um horário/);
    const auto = t.service.update("R-0001", { needsApproval: false });
    expect(auto.mode.kind).toBe("automatico");
    expect(t.service.update("R-0001", { needsApproval: true }).mode).toEqual({ kind: "pede-ok" });
  });

  it("próximos horários só da rotina ativa", async () => {
    const t = await setup(at("2026-11-11T08:00"));
    t.service.create(watch());
    const next = t.service.nextOf("R-0001", 3, at("2026-11-11T08:00"));
    expect(next.map((n) => `${n.scheduleId}@${n.slotKey}`)).toEqual(["S1@2026-11-11T09:00", "S2@2026-11-11T10:00", "S1@2026-11-11T13:00"]);
    t.service.update("R-0001", { status: "pausada" });
    expect(t.service.nextOf("R-0001", 3, at("2026-11-11T08:00"))).toEqual([]);
  });

  it("guarda no máximo 50 execuções", async () => {
    const t = await setup(at("2026-11-11T08:00"));
    const routine = t.service.create(watch());
    for (let i = 0; i < 60; i += 1) t.service.addRun(routine.id, { scheduleId: "S1", startedAt: at("2026-11-11T08:00").toISOString(), outcome: "pulada", skipReason: String(i) });
    const runs = t.service.runsOf(routine.id);
    expect(runs).toHaveLength(50);
    expect(runs[0]!.skipReason).toBe("59");
  });
});
