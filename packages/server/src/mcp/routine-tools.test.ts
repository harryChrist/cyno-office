import path from "node:path";
import { emptyRoutinesData, registeredCount, type Agent, type ForYouItem, type OfficeState, type Task } from "@cyno/shared";
import { afterEach, describe, expect, it } from "vitest";
import { RoutineService } from "../workspace/routines/routine-service";
import { WriteQueue } from "../store/write-queue";
import { useTempDirs } from "../dev/test-utils";
import type { McpTool } from "./protocol";
import { maestroRoutineTools, workerRoutineTools } from "./routine-tools";

const tempDir = useTempDirs();
const queues: WriteQueue[] = [];
afterEach(async () => {
  await Promise.all(queues.splice(0).map((queue) => queue.idle()));
});

const NOW = new Date("2026-11-09T14:00:00Z");
const CLARA = { id: "clara", name: "Clara", teamId: "time" } as Agent;

async function setup() {
  const dir = await tempDir();
  const queue = new WriteQueue();
  queues.push(queue);
  const task = { id: "t1", roomId: "r", teamId: "time", agentId: "clara", prompt: "Rotina: Convites", status: "in_progress", routineId: "R-0001", createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() } as Task;
  const state = { read: () => ({ rooms: [], teams: [{ id: "time", name: "Time" }], agents: [CLARA], tasks: [task] }) as unknown as OfficeState };
  const service = new RoutineService(emptyRoutinesData(), {
    file: path.join(dir, "routines.json"),
    queue,
    publish: () => undefined,
    owners: { agent: (id) => (id === "clara" ? CLARA : undefined), team: (id) => (id === "time" ? { id, name: "Time" } : undefined) },
    openCard: () => ({ id: "A-0007" }) as ForYouItem,
    log: { warn: () => undefined, error: () => undefined },
    now: () => NOW,
  });
  let active = true;
  const runner = { hasActive: () => active, currentTaskId: () => "t1" };
  const maestro = maestroRoutineTools({ state, routines: service, now: () => NOW });
  const worker = workerRoutineTools("clara", { state, routines: service, runner, now: () => NOW });
  const call = (tools: McpTool[], name: string, args: object) => tools.find((tool) => tool.name === name)!.call(args);
  return { service, maestro, worker, call, setActive: (value: boolean) => (active = value) };
}

const PROPOSAL = { type: "goal", title: "Convites", unit: "convite", kind: "invite", site: "linkedin.com", goal: { target: 100 }, owner: "Clara", instruction: "Convide devs" };

describe("ferramentas MCP de rotinas", () => {
  it("nomes em inglês; o Maestro não apaga, retoma nem aprova; o agente só vê e registra", async () => {
    const { maestro, worker } = await setup();
    expect(maestro.map((tool) => tool.name).sort()).toEqual(["routine_list", "routine_pause", "routine_propose", "routine_resume", "routine_status", "routine_update_propose"]);
    expect(worker.map((tool) => tool.name).sort()).toEqual(["routine_record", "routine_status"]);
    const propose = maestro.find((tool) => tool.name === "routine_propose")!;
    // Nada que mude o "precisa de OK" além da sugestão.
    expect(Object.keys(propose.input.shape)).toContain("suggested_mode");
    expect(Object.keys(propose.input.shape)).not.toContain("needs_approval");
  });

  it("routine_propose cria a proposta (meta limitada) e avisa que nada roda antes do OK", async () => {
    const { service, maestro, call } = await setup();
    const result = await call(maestro, "routine_propose", PROPOSAL);
    expect(result.isError).toBeUndefined();
    expect(result.text).toContain("R-0001");
    expect(result.text).toContain("A-0007");
    expect(result.text).toContain("lowered to 60");
    expect(result.text).toContain("does NOT run");
    expect(service.get("R-0001")).toMatchObject({ status: "proposta", needsApproval: true, agentId: "clara", target: 60 });
  });

  it("routine_propose aceita o time (por nome) e recusa dono inexistente", async () => {
    const { service, maestro, call } = await setup();
    await call(maestro, "routine_propose", { ...PROPOSAL, owner: "Time" });
    expect(service.get("R-0001").teamId).toBe("time");
    const bad = await call(maestro, "routine_propose", { ...PROPOSAL, owner: "Fantasma" });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain("not found");
  });

  it("routine_list, routine_status e routine_pause", async () => {
    const { service, maestro, call } = await setup();
    expect((await call(maestro, "routine_list", {})).text).toBe("No routines yet.");
    service.create({ title: "Convites", unit: "convite", kind: "invite", site: "linkedin.com", target: 10, period: "week", agentId: "clara", needsApproval: true, instruction: "" });
    const list = await call(maestro, "routine_list", {});
    expect(list.text).toContain("R-0001 “Convites” [ativa]");
    expect(list.text).toContain("0/10 convite delivered");
    expect(list.text).toContain("mode: asks the user's OK");
    const status = await call(maestro, "routine_status", { routine_id: "R-0001" });
    expect(status.text).toContain("recent server decisions");
    expect((await call(maestro, "routine_status", { routine_id: "R-0099" })).isError).toBe(true);
    expect((await call(maestro, "routine_pause", { routine_id: "R-0001" })).text).toContain("paused");
    expect((await call(maestro, "routine_pause", { routine_id: "R-0001" })).isError).toBe(true);
  });

  it("routine_record sem link: só para entrega ao dono (com nota) ou rotina sem site; com site, a exigência do domínio continua", async () => {
    const { service, worker, call } = await setup();
    service.create({ title: "Posts", unit: "post", kind: "other", site: "instagram.com", target: 4, period: "week", agentId: "clara", needsApproval: true, instruction: "" });
    const noLink = await call(worker, "routine_record", { routine_id: "R-0001" });
    expect(noLink.isError).toBe(true);
    expect(noLink.text).toContain("publishes on instagram.com");
    expect((await call(worker, "routine_record", { routine_id: "R-0001", delivered_to: "owner" })).text).toContain("needs a note");
    expect((await call(worker, "routine_record", { routine_id: "R-0001", url: "https://evil.com/x" })).text).toContain("must be on instagram.com");
    const owner = await call(worker, "routine_record", { routine_id: "R-0001", delivered_to: "owner", note: "Post de café coado, mídia M-0003" });
    expect(owner.isError).toBeUndefined();
    const second = await call(worker, "routine_record", { routine_id: "R-0001", delivered_to: "owner", note: "Segundo post, mídia M-0004" });
    expect(second.isError).toBeUndefined();
    expect(service.entries).toHaveLength(2);
    expect(service.entries[0]).toMatchObject({ url: "", deliveredTo: "owner", stage: "registrado" });
    // Duas entregas ao dono são duas entregas (nada de colidir na chave vazia).
    expect(registeredCount(service.entries, "R-0001", service.entries[0]!.periodKey)).toBe(2);
  });

  it("routine_record: registra, e valida tarefa, dono, duplicado e site", async () => {
    const { service, worker, call, setActive } = await setup();
    service.create({ title: "Convites", unit: "convite", kind: "invite", site: "linkedin.com", target: 10, period: "week", agentId: "clara", needsApproval: true, instruction: "" });
    const ok = await call(worker, "routine_record", { routine_id: "R-0001", url: "https://www.linkedin.com/in/ana/", note: "Ana" });
    expect(ok.isError).toBeUndefined();
    expect(ok.text).toContain("1/15 today");
    expect(service.entries[0]).toMatchObject({ stage: "registrado", taskId: "t1", agentId: "clara", note: "Ana" });
    expect((await call(worker, "routine_record", { routine_id: "R-0001", url: "https://linkedin.com/in/ana" })).text).toContain("already recorded");
    expect((await call(worker, "routine_record", { routine_id: "R-0001", url: "https://evil.com/x" })).text).toContain("must be on linkedin.com");
    expect((await call(worker, "routine_record", { routine_id: "R-0002", url: "https://linkedin.com/in/x" })).text).toContain("does not exist");
    setActive(false);
    expect((await call(worker, "routine_record", { routine_id: "R-0001", url: "https://linkedin.com/in/bia" })).text).toContain("no task in progress");
  });

  it("routine_record: a tarefa atual precisa ser da rotina informada", async () => {
    const { service, worker, call } = await setup();
    for (const title of ["A", "B"]) service.create({ title, unit: "convite", kind: "invite", site: "linkedin.com", target: 10, period: "week", agentId: "clara", needsApproval: true, instruction: "" });
    const wrong = await call(worker, "routine_record", { routine_id: "R-0002", url: "https://linkedin.com/in/x" });
    expect(wrong.isError).toBe(true);
    expect(wrong.text).toContain("does not belong to routine R-0002");
  });

  it("routine_status do agente mostra só as dele e marca a da tarefa atual", async () => {
    const { service, worker, call } = await setup();
    service.create({ title: "Convites", unit: "convite", kind: "invite", site: "linkedin.com", target: 10, period: "week", agentId: "clara", needsApproval: true, instruction: "" });
    service.create({ title: "De outro", unit: "post", kind: "post", site: "linkedin.com", target: 2, period: "week", agentId: "clara", needsApproval: true, instruction: "" });
    const status = await call(worker, "routine_status", {});
    expect(status.text).toContain("R-0001");
    expect(status.text).toContain("the routine of your current task");
  });
});
