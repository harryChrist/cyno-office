import path from "node:path";
import { emptyRoutinesData, type Agent, type Project, type ScheduleInput, type ServerEvent, type Task } from "@cyno/shared";
import { afterEach, describe, expect, it } from "vitest";
import { useTempDirs } from "../../dev/test-utils";
import { routineItemsTools } from "../../mcp/routine-items-tools";
import type { McpTool } from "../../mcp/protocol";
import { WriteQueue } from "../../store/write-queue";
import { MetaTracker } from "./meta-tracker";
import { RoutineItemsStore } from "./routine-items";
import { RoutineRunner, SKIP_NO_DUE_ITEMS } from "./routine-runner";
import { RoutineService } from "./routine-service";
import { SlotClock } from "./slot-clock";
import { RoutineTracking } from "./tracking";

const tempDir = useTempDirs();
const queues: WriteQueue[] = [];
afterEach(async () => {
  await Promise.all(queues.splice(0).map((queue) => queue.idle()));
});

const CLARA = { id: "clara", name: "Clara", teamId: "time" } as Agent;
const at = (local: string) => new Date(`${local}:00-03:00`);

const SCHEDULES = [
  { label: "E-mail", days: { kind: "todo_dia" as const }, times: ["08:00", "18:00"], action: "Leia os e-mails e registre as inscrições", scope: "geral" as const },
  { label: "Site", days: { kind: "todo_dia" as const }, times: ["10:00", "14:00"], action: "Abra o site de cada inscrição", scope: "itens_vencidos" as const },
] satisfies ScheduleInput[];

const TRACKING = {
  fields: [
    { key: "empresa", label: "Empresa", type: "texto" as const, required: true },
    { key: "vaga", label: "Vaga", type: "texto" as const },
    { key: "link", label: "Link", type: "link" as const },
    { key: "inscritoEm", label: "Inscrito em", type: "data" as const },
  ],
  statuses: [{ name: "Inscrito" }, { name: "Em análise" }, { name: "Entrevista", alert: true }, { name: "Recusado", terminal: true }, { name: "Sem resposta" }],
  lifespan: { days: 15, untilTerminal: true },
  expireStatus: "Sem resposta",
  checkEveryHours: 24,
};

async function setup(start: Date) {
  const dir = await tempDir();
  const queue = new WriteQueue();
  queues.push(queue);
  let clock = start;
  const tasks: Task[] = [];
  const started: { prompt: string; scheduleId: string }[] = [];
  const events: ServerEvent[] = [];
  const publish = (event: ServerEvent) => events.push(event);
  const service = new RoutineService(emptyRoutinesData(), {
    workspaceId: "ws",
    file: path.join(dir, "routines.json"),
    queue,
    publish,
    owners: { agent: (id) => (id === "clara" ? CLARA : undefined), team: () => undefined },
    openCard: () => undefined,
    log: { warn: () => undefined, error: () => undefined },
    now: () => clock,
  });
  const store = new RoutineItemsStore({ fileOf: (id) => path.join(dir, "routines", id, "items.json"), queue, log: { error: () => undefined } });
  const tracking = new RoutineTracking({ routines: service, store, publish, log: { error: () => undefined, info: () => undefined }, now: () => clock });
  service.setChangeSource((routineId, taskId) => tracking.changesOf(routineId, taskId));
  const meta = new MetaTracker({ routines: service, state: { read: () => ({ tasks, agents: [CLARA] }) as never, readForYou: () => [] }, forYou: { cancel: async () => undefined }, now: () => clock, log: { warn: () => undefined } });
  const runner = new RoutineRunner({
    routines: service,
    meta,
    tracking,
    state: { read: () => ({ tasks, agents: [CLARA] }) as never },
    workspaceId: "ws",
    pickAgent: () => CLARA,
    startTask: async (input) => {
      started.push({ prompt: input.prompt, scheduleId: input.scheduleId! });
      const task = { id: `task-${started.length}`, status: "in_progress", agentId: input.agentId, routineId: input.routineId } as Task;
      tasks.push(task);
      return { task, project: { id: task.id } as Project };
    },
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    now: () => clock,
  });
  const slotClock = new SlotClock({ routines: service, tracking, runner, log: { info: () => undefined, warn: () => undefined, error: () => undefined }, now: () => clock });
  const routine = service.create({ type: "acompanhamento", title: "Inscrições", agentId: "clara", instruction: "", schedules: SCHEDULES, tracking: TRACKING });
  let current: string | undefined;
  const tools = routineItemsTools("clara", {
    state: { read: () => ({ tasks }) as never },
    runner: { hasActive: () => current !== undefined, currentTaskId: () => current! },
    tracking,
    now: () => clock,
  });
  const call = async (name: string, args: object) => (tools.find((tool: McpTool) => tool.name === name)!.call(args) as Promise<{ text: string; isError?: boolean }> | { text: string; isError?: boolean });
  const finish = (taskId: string, status: "done" | "failed" = "done") => {
    const task = tasks.find((candidate) => candidate.id === taskId)!;
    Object.assign(task, { status, result: "ok" });
    service.onTaskUpdate({ ...task });
    current = undefined;
  };
  return { service, tracking, slotClock, started, tasks, events, call, finish, id: routine.id, setNow: (date: Date) => (clock = date), work: (taskId: string | undefined) => (current = taskId), run: () => service.get(routine.id) };
}

describe("PATCH do esquema do acompanhamento", () => {
  it("ajusta checkEveryHours, vida e expireStatus; só acrescenta campos e status", async () => {
    const t = await setup(at("2026-11-11T07:00"));
    const base = t.service.get(t.id).tracking!;
    const next = t.service.update(t.id, { tracking: { checkEveryHours: 12, lifespan: { days: 30, untilTerminal: false }, expireStatus: null, fields: [...base.fields, { key: "salario", label: "Salário", type: "numero" }], statuses: [...base.statuses, { name: "Oferta", terminal: true, alert: true }] } }).tracking!;
    expect(next).toMatchObject({ checkEveryHours: 12, lifespan: { days: 30, untilTerminal: false } });
    expect(next.expireStatus).toBeUndefined();
    expect(next.fields.map((field) => field.key)).toContain("salario");
    expect(next.statuses.at(-1)!.name).toBe("Oferta");
    expect(() => t.service.update(t.id, { tracking: { fields: base.fields.slice(1) } })).toThrow(/não pode ser removido/);
    expect(() => t.service.update(t.id, { tracking: { statuses: next.statuses.slice(1) } })).toThrow(/não pode ser removido/);
  });
});

describe("itens acompanhados: ferramentas do agente", () => {
  it("add é idempotente por source_key: o mesmo e-mail não vira dois itens", async () => {
    const t = await setup(at("2026-11-11T07:00"));
    t.tasks.push({ id: "t0", status: "in_progress", agentId: "clara", routineId: t.id } as Task);
    t.work("t0");
    const first = await t.call("routine_item_add", { values: { empresa: "Acme", vaga: "Dev", link: "https://acme.test/vaga/1" }, source_key: "msg-1" });
    expect(first.text).toContain("Created I-0001");
    const again = await t.call("routine_item_add", { values: { empresa: "Acme", vaga: "Dev" }, source_key: "msg-1" });
    expect(again.text).toContain("Already exists");
    expect(t.tracking.list(t.id).total).toBe(1);
    const other = await t.call("routine_item_add", { values: { empresa: "Beta" }, source_key: "msg-2" });
    expect(other.text).toContain("Created I-0002");
  });

  it("valida campos e status contra o esquema da rotina", async () => {
    const t = await setup(at("2026-11-11T07:00"));
    t.tasks.push({ id: "t0", status: "in_progress", agentId: "clara", routineId: t.id } as Task);
    t.work("t0");
    expect((await t.call("routine_item_add", { values: { vaga: "Dev" } })).text).toContain('Required field "empresa"');
    expect((await t.call("routine_item_add", { values: { empresa: "A", salario: 5 } })).text).toContain('Unknown field "salario"');
    expect((await t.call("routine_item_add", { values: { empresa: "A", link: "javascript:alert(1)" } })).text).toContain("http(s) link");
    expect((await t.call("routine_item_add", { values: { empresa: "A", inscritoEm: "ontem" } })).text).toContain("YYYY-MM-DD");
    const bad = await t.call("routine_item_add", { values: { empresa: "A" }, status: "Contratado" });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain("Valid: Inscrito, Em análise");
    expect(t.tracking.list(t.id).total).toBe(0);
    await t.call("routine_item_add", { values: { empresa: "A" }, source_key: "a" });
    const update = await t.call("routine_item_update", { item_id: "I-0001", status: "Contratado" });
    expect(update.isError).toBe(true);
    // Status é aceito sem diferenciar maiúsculas e vira o nome do esquema.
    await t.call("routine_item_update", { item_id: "I-0001", status: "em análise" });
    expect(t.tracking.get(t.id, "I-0001")?.status).toBe("Em análise");
  });

  it("update grava o histórico (data, de → para, nota, tarefa) e o status final encerra o item", async () => {
    const t = await setup(at("2026-11-11T07:00"));
    t.tasks.push({ id: "t0", status: "in_progress", agentId: "clara", routineId: t.id } as Task);
    t.work("t0");
    await t.call("routine_item_add", { values: { empresa: "Acme" }, source_key: "m1", note: "e-mail de confirmação" });
    t.setNow(at("2026-11-11T10:00"));
    await t.call("routine_item_update", { item_id: "I-0001", status: "Em análise", note: "site diz em análise" });
    t.setNow(at("2026-11-12T10:00"));
    await t.call("routine_item_update", { item_id: "I-0001", status: "Recusado", note: "e-mail de recusa", values: { vaga: "Dev Sr" } });
    const item = t.tracking.get(t.id, "I-0001")!;
    expect(item).toMatchObject({ status: "Recusado", state: "encerrado", endReason: "terminal", values: { empresa: "Acme", vaga: "Dev Sr" }, lastCheckedAt: at("2026-11-12T10:00").toISOString() });
    expect(item.history.map((h) => [h.field, h.from, h.to, h.taskId, h.by])).toEqual([
      ["criado", undefined, "Inscrito", "t0", "agente"],
      ["status", "Inscrito", "Em análise", "t0", "agente"],
      ["vaga", undefined, "Dev Sr", "t0", "agente"],
      ["status", "Em análise", "Recusado", "t0", "agente"],
    ]);
    expect(item.history[1]!.note).toBe("site diz em análise");
    // Item encerrado: o agente não mexe mais.
    expect((await t.call("routine_item_update", { item_id: "I-0001", status: "Entrevista" })).isError).toBe(true);
  });

  it("parar item: o agente para, some da lista padrão, e só o usuário reabre", async () => {
    const t = await setup(at("2026-11-11T07:00"));
    t.tasks.push({ id: "t0", status: "in_progress", agentId: "clara", routineId: t.id } as Task);
    t.work("t0");
    await t.call("routine_item_add", { values: { empresa: "Acme" }, source_key: "m1" });
    await t.call("routine_item_add", { values: { empresa: "Beta" }, source_key: "m2" });
    expect((await t.call("routine_item_stop", { item_id: "I-0001", reason: "vaga cancelada" })).text).toContain("Stopped");
    expect((await t.call("routine_items_list", {})).text).not.toContain("Acme");
    expect((await t.call("routine_items_list", { state: "stopped" })).text).toContain("Acme");
    expect((await t.call("routine_item_stop", { item_id: "I-0001", reason: "de novo" })).isError).toBe(true);
    const reopened = t.tracking.reopen(t.id, "I-0001");
    expect(reopened).toMatchObject({ state: "ativo" });
    expect(reopened.endReason).toBeUndefined();
    // O usuário também para pela rota (by usuario).
    const stopped = t.tracking.stop(t.id, "I-0002", { by: "usuario" });
    expect(stopped.history.at(-1)).toMatchObject({ by: "usuario", to: "parado" });
  });

  it("as ferramentas só valem dentro de uma tarefa da rotina", async () => {
    const t = await setup(at("2026-11-11T07:00"));
    expect((await t.call("routine_items_list", {})).text).toContain("only work inside a task");
    t.tasks.push({ id: "avulsa", status: "in_progress", agentId: "clara" } as Task);
    t.work("avulsa");
    const result = await t.call("routine_item_add", { values: { empresa: "A" } });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("tracking routine");
  });

  it("lista com filtros: due_only, status e página compacta", async () => {
    const t = await setup(at("2026-11-11T07:00"));
    t.tasks.push({ id: "t0", status: "in_progress", agentId: "clara", routineId: t.id } as Task);
    t.work("t0");
    for (const name of ["A", "B", "C"]) await t.call("routine_item_add", { values: { empresa: name }, source_key: name });
    await t.call("routine_item_update", { item_id: "I-0001", status: "Em análise" });
    expect((await t.call("routine_items_list", { due_only: true })).text).toContain("2 item(s) match");
    expect((await t.call("routine_items_list", { status: "Em análise" })).text).toContain("1 item(s) match");
    const page = (await t.call("routine_items_list", { limit: 1, offset: 1 })).text;
    expect(page).toContain("3 item(s) match; showing 2-2. Next page: offset=2.");
  });
});

describe("itens acompanhados: vida, horários e avisos (servidor, sem token)", () => {
  it("expira por dias como Sem resposta antes do agente, avisa uma vez e o status final não expira", async () => {
    const t = await setup(at("2026-11-11T07:00"));
    t.tasks.push({ id: "t0", status: "in_progress", agentId: "clara", routineId: t.id } as Task);
    t.work("t0");
    await t.call("routine_item_add", { values: { empresa: "Acme" }, source_key: "m1" });
    await t.call("routine_item_add", { values: { empresa: "Beta" }, source_key: "m2" });
    await t.call("routine_item_update", { item_id: "I-0002", status: "Recusado" });
    expect(t.tracking.get(t.id, "I-0001")!.expiresAt).toBe(at("2026-11-26T07:00").toISOString());
    t.events.length = 0;

    t.setNow(at("2026-11-26T07:30"));
    await t.slotClock.tick();
    const acme = t.tracking.get(t.id, "I-0001")!;
    expect(acme).toMatchObject({ status: "Sem resposta", state: "encerrado", endReason: "expirou" });
    expect(acme.history.at(-1)).toMatchObject({ by: "servidor", from: "Inscrito", to: "Sem resposta" });
    // O recusado já tinha encerrado: não muda.
    expect(t.tracking.get(t.id, "I-0002")).toMatchObject({ status: "Recusado", endReason: "terminal" });
    const expired = t.events.filter((event) => event.type === "routine:items" && event.expired?.length);
    expect(expired).toHaveLength(1);
    // Outra passada: nada de avisar de novo; nenhum agente foi chamado por isso.
    t.events.length = 0;
    await t.slotClock.tick();
    expect(t.events.filter((event) => event.type === "routine:items")).toHaveLength(0);
    expect(t.started).toEqual([]);
  });

  it("vida só por status final (sem dias) nunca expira", async () => {
    const t = await setup(at("2026-11-11T07:00"));
    const other = t.service.create({ type: "acompanhamento", title: "Sem prazo", agentId: "clara", instruction: "", schedules: SCHEDULES, tracking: { ...TRACKING, lifespan: { untilTerminal: true } } });
    t.tasks.push({ id: "t0", status: "in_progress", agentId: "clara", routineId: other.id } as Task);
    t.work("t0");
    await t.call("routine_item_add", { values: { empresa: "Acme" }, source_key: "m1" });
    expect(t.tracking.get(other.id, "I-0001")!.expiresAt).toBeUndefined();
    t.setNow(at("2027-02-01T07:30"));
    await t.slotClock.tick();
    expect(t.tracking.get(other.id, "I-0001")!.state).toBe("ativo");
  });

  it("itens_vencidos: sem item para conferir não cria tarefa; com item vencido cria e o briefing lista só os vencidos", async () => {
    const t = await setup(at("2026-11-11T07:00"));
    // 08:00 (geral): roda. 10:00 (itens_vencidos) sem nenhum item: pulada, sem tarefa.
    t.setNow(at("2026-11-11T08:00"));
    await t.slotClock.tick();
    expect(t.started.map((s) => s.scheduleId)).toEqual(["S1"]);
    expect(t.started[0]!.prompt).toContain("Itens abertos hoje (0)");
    t.tasks.push({ id: "t0", status: "in_progress", agentId: "clara", routineId: t.id } as Task);
    t.work("task-1");
    await t.call("routine_item_add", { values: { empresa: "Acme" }, source_key: "m1" });
    await t.call("routine_item_add", { values: { empresa: "Beta" }, source_key: "m2" });
    t.finish("task-1");
    t.setNow(at("2026-11-11T10:00"));
    await t.slotClock.tick();
    // Itens recém-criados e nunca conferidos contam como vencidos: roda uma vez.
    expect(t.started.map((s) => s.scheduleId)).toEqual(["S1", "S2"]);
    expect(t.started[1]!.prompt).toContain("Itens a conferir agora (2)");
    expect(t.started[1]!.prompt).toContain("source_key=m1");
    expect(t.started[1]!.prompt).toContain("routine_item_update");
    expect(t.started[1]!.prompt).toContain("Ler nunca pede aprovação");
    t.work("task-2");
    await t.call("routine_item_update", { item_id: "I-0001", status: "Em análise", checked: true });
    await t.call("routine_item_update", { item_id: "I-0002", checked: true });
    t.finish("task-2");
    // 14:00: conferidos há 4 h (< 24 h): nada vencido, o horário é pulado sem gastar tarefa.
    t.setNow(at("2026-11-11T14:00"));
    await t.slotClock.tick();
    expect(t.started).toHaveLength(2);
    expect(t.run().lastRuns.at(-1)).toMatchObject({ scheduleId: "S2", slotKey: "2026-11-11T14:00", outcome: "pulada", skipReason: SKIP_NO_DUE_ITEMS });
    // No dia seguinte (mais de 24 h) volta a conferir.
    t.setNow(at("2026-11-12T10:00"));
    await t.slotClock.tick();
    expect(t.started.at(-1)).toMatchObject({ scheduleId: "S2" });
    expect(t.started.at(-1)!.prompt).toContain("Itens a conferir agora (2)");
  });

  it("as mudanças da execução vêm do histórico (não do texto do agente) e viram uma linha só", async () => {
    const t = await setup(at("2026-11-11T07:00"));
    t.setNow(at("2026-11-11T08:00"));
    await t.slotClock.tick();
    t.work("task-1");
    await t.call("routine_item_add", { values: { empresa: "Acme" }, source_key: "m1" });
    await t.call("routine_item_add", { values: { empresa: "Beta" }, source_key: "m2" });
    t.finish("task-1");
    expect(t.run().lastRuns[0]!.changes.map((c) => [c.kind, c.text])).toEqual([
      ["novo", "Novo: Acme (Inscrito)"],
      ["novo", "Novo: Beta (Inscrito)"],
    ]);
    // Segunda execução: um status vira Entrevista (alerta) e outro Recusado (final).
    t.setNow(at("2026-11-11T10:00"));
    await t.slotClock.tick();
    t.work("task-2");
    await t.call("routine_item_update", { item_id: "I-0001", status: "Entrevista" });
    await t.call("routine_item_update", { item_id: "I-0002", status: "Recusado" });
    await t.call("routine_item_update", { item_id: "I-0001", values: { vaga: "Dev" } });
    t.finish("task-2");
    const run = t.run().lastRuns.find((candidate) => candidate.taskId === "task-2")!;
    expect(run.changes).toEqual([
      { itemId: "I-0001", text: "Acme → Entrevista", kind: "status", alert: true },
      { itemId: "I-0002", text: "Beta → Recusado", kind: "encerrado" },
    ]);
  });

  it("encerrar a rotina encerra os itens ativos", async () => {
    const t = await setup(at("2026-11-11T07:00"));
    t.tasks.push({ id: "t0", status: "in_progress", agentId: "clara", routineId: t.id } as Task);
    t.work("t0");
    await t.call("routine_item_add", { values: { empresa: "Acme" }, source_key: "m1" });
    t.service.update(t.id, { status: "encerrada" });
    t.tracking.sweep();
    expect(t.tracking.get(t.id, "I-0001")).toMatchObject({ state: "encerrado", endReason: "rotina_encerrada" });
  });

  it("o usuário corrige um campo e reabre (a vida conta de novo)", async () => {
    const t = await setup(at("2026-11-11T07:00"));
    t.tasks.push({ id: "t0", status: "in_progress", agentId: "clara", routineId: t.id } as Task);
    t.work("t0");
    await t.call("routine_item_add", { values: { empresa: "Acme" }, source_key: "m1" });
    const edited = t.tracking.edit(t.id, "I-0001", { values: { empresa: "Acme Ltda" } });
    expect(edited.values.empresa).toBe("Acme Ltda");
    expect(edited.history.at(-1)).toMatchObject({ by: "usuario", field: "empresa", from: "Acme", to: "Acme Ltda" });
    expect(() => t.tracking.edit(t.id, "I-0001", { values: { link: "nao-e-link" } })).toThrow(/http\(s\) link/);
    t.setNow(at("2026-11-27T08:00"));
    t.tracking.sweep();
    expect(t.tracking.get(t.id, "I-0001")!.endReason).toBe("expirou");
    const reopened = t.tracking.reopen(t.id, "I-0001");
    expect(reopened).toMatchObject({ state: "ativo", status: "Inscrito", expiresAt: at("2026-12-12T08:00").toISOString() });
    const summary = t.tracking.summary(t.run())!;
    expect(summary).toMatchObject({ active: 1, ended: 0, stopped: 0 });
  });
});
