import type { OfficeState } from "@cyno/shared";
import { describe, expect, it, vi } from "vitest";
import { officeToolsFor, type OfficeToolsDeps } from "./office-tools";
import { handleMcpPayload } from "./protocol";

const STATE = {
  rooms: [
    { id: "gerencia", name: "Sala do Maestro", kind: "maestro" },
    { id: "conteudo", name: "Conteúdo", kind: "team" },
  ],
  teams: [
    { id: "t-ger", roomId: "gerencia", name: "Gerência", focus: "coordenar" },
    { id: "t-cont", roomId: "conteudo", name: "Conteúdo", focus: "textos" },
  ],
  agents: [
    { id: "maestro", teamId: "t-ger", name: "Maestro" },
    { id: "clara", teamId: "t-cont", name: "Clara" },
  ],
  tasks: [{ id: "task-1", agentId: "clara", status: "in_progress" }],
} as unknown as OfficeState;

function setup() {
  const project = { id: "req-1", tasks: [{ ref: "T1" }, { ref: "T2" }], sprints: [{ id: "S1", name: "Sprint 1", startAt: "2026-11-12T12:00:00.000Z", endAt: "2026-11-19T12:00:00.000Z", summary: { done: [{}], carried: [] } }] };
  const plans = {
    propose: vi.fn(async () => project),
    addTasks: vi.fn(() => project),
    decideTask: vi.fn(() => "decidido"),
    describe: vi.fn(() => "quadro"),
    workerView: vi.fn(() => "view"),
    help: vi.fn(() => "ajuda"),
    updateProject: vi.fn(async () => ({ id: "req-1" })),
    createSprint: vi.fn(async () => ({ project, sprintId: "S1" })),
    updateSprint: vi.fn(async () => project),
    moveTask: vi.fn(async () => project),
    assignTask: vi.fn(async () => project),
    reassignTask: vi.fn(async () => project),
    closeSprint: vi.fn(async () => project),
    sprintIdOf: vi.fn((_project: string, wanted: string) => (wanted.toLowerCase() === "sprint 1" ? "S1" : wanted)),
    recordChecklist: vi.fn((): string | undefined => undefined),
  };
  const maestro = {
    team: vi.fn(() => "equipe"),
    openRequest: vi.fn(),
    delegate: vi.fn(() => "Subtarefa criada."),
    viewTask: vi.fn(),
    conclude: vi.fn(),
    requestApproval: vi.fn(),
    askQuestions: vi.fn(() => "perguntas"),
    requestFor: vi.fn(() => ({ id: "req-1" })),
  };
  const runner = {
    deliver: vi.fn(() => "Entregue."),
    progress: vi.fn(),
    requestApproval: vi.fn(() => "Aprovação enviada."),
    requestInformation: vi.fn(),
    currentTaskId: vi.fn(() => "task-1"),
    hasActive: vi.fn(),
  };
  const forYouTypes = { list: () => [], define: vi.fn() };
  const deps = { state: { read: () => STATE }, maestro, runner, plans, forYouTypes } as unknown as OfficeToolsDeps;
  const find = (agentId: string, name: string) => officeToolsFor(agentId, deps).find((tool) => tool.name === name)!;
  const call = async (agentId: string, name: string, args: Record<string, unknown>) => {
    const tool = find(agentId, name);
    return tool.call(tool.input.parse(args));
  };
  return { plans, maestro, runner, deps, find, call };
}

const TASK = { title: "Post 1", briefing: "Escreva", owner: "clara" };

describe("ferramentas de projeto do Maestro", () => {
  it("create_project manda título, prazo, prioridade, ritmo, sugestão de modo e as tarefas com done_when", async () => {
    const { plans, call } = setup();
    const result = await call("maestro", "create_project", {
      title: "Posts da semana",
      priority: "high",
      due_at: "2026-11-16",
      pace: { hours_per_day: 1, window: { from: "09:00", to: "12:00" } },
      suggested_mode: "auto",
      auto_scope: { actions: ["post"] },
      tasks: [{ ...TASK, done_when: ["até 1200 caracteres"], start_at: "2026-11-12", due_at: "2026-11-13", steps: [{ agent: "linkedin/clara", does: "escrever" }] }],
    });
    expect(result.text).toContain("Project with 2 task(s)");
    expect(plans.propose).toHaveBeenCalledWith("req-1", expect.objectContaining({ title: "Posts da semana", priority: "high", due_at: "2026-11-16", pace: expect.objectContaining({ hours_per_day: 1 }), suggested_mode: "auto" }));
    const sent = (plans.propose.mock.calls[0] as unknown as [string, { tasks: { done_when: string[]; steps: { agent: string }[] }[] }])[1];
    expect(sent.tasks[0]).toMatchObject({ done_when: ["até 1200 caracteres"], steps: [{ agent: "linkedin/clara" }] });
  });

  it("os nomes novos aparecem no tools/list e os antigos (create_plan & cia) continuam chamáveis, sem aparecer", async () => {
    const { deps, plans } = setup();
    const tools = () => officeToolsFor("maestro", deps);
    const listed = (await handleMcpPayload({ jsonrpc: "2.0", id: 1, method: "tools/list" }, tools)) as { result: { tools: { name: string }[] } };
    const names = listed.result.tools.map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining(["create_project", "add_project_tasks", "resolve_task", "get_project", "update_project"]));
    for (const old of ["create_plan", "add_plan_tasks", "resolve_plan_task", "get_plan", "list_plans"]) expect(names).not.toContain(old);
    // Chamar pelo nome antigo funciona (uma sessão retomada ainda usa).
    const response = (await handleMcpPayload({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "create_plan", arguments: { tasks: [TASK] } } }, tools)) as { result: { isError: boolean; content: { text: string }[] } };
    expect(response.result.isError).toBe(false);
    expect(plans.propose).toHaveBeenCalledTimes(1);
    await handleMcpPayload({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_plan", arguments: {} } }, tools);
    expect(plans.describe).toHaveBeenCalledWith("req-1");
    const resolved = (await handleMcpPayload({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "resolve_plan_task", arguments: { ref: "T1", action: "cancel_plan" } } }, tools)) as { result: { isError: boolean } };
    expect(resolved.result.isError).toBe(false);
    expect(plans.decideTask).toHaveBeenCalledWith("req-1", "T1", "cancel_plan", undefined);
  });

  it("resolve_task aceita cancel_project e update_project converte datas, prioridade e limpa com null", async () => {
    const { plans, call } = setup();
    await call("maestro", "resolve_task", { ref: "T1", action: "cancel_project" });
    expect(plans.decideTask).toHaveBeenCalledWith("req-1", "T1", "cancel_project", undefined);
    const result = await call("maestro", "update_project", { project_id: "req-1", priority: "low", due_at: "2026-11-20", start_at: null, pace: { hours_per_day: 2 } });
    expect(result.text).toContain("updated");
    expect(plans.updateProject).toHaveBeenCalledWith("req-1", { priority: "baixa", dueAt: "2026-11-20T00:00:00.000Z", startAt: null, pace: { hoursPerDay: 2 } });
    await expect(call("maestro", "update_project", { project_id: "req-1" })).rejects.toThrow(/Nothing to change/);
    await expect(call("maestro", "update_project", { project_id: "req-1", due_at: "semana que vem" })).rejects.toThrow(/due_at/);
  });

  it("delegate_task passa due_at, priority e done_when ao Maestro", async () => {
    const { maestro, call } = setup();
    await call("maestro", "delegate_task", { request_id: "req-1", agent_id: "clara", task: "Responda", due_at: "2026-11-12", priority: "high", done_when: ["menos de 600 caracteres"] });
    expect(maestro.delegate).toHaveBeenCalledWith(expect.objectContaining({ dueAt: "2026-11-12T00:00:00.000Z", priority: "high", doneWhen: ["menos de 600 caracteres"] }));
    await expect(call("maestro", "delegate_task", { request_id: "req-1", agent_id: "clara", task: "Responda", due_at: "ontem" })).rejects.toThrow(/due_at/);
  });
});

describe("ferramentas novas de sprint e árvore (só o Maestro)", () => {
  it("create_project aceita a árvore e as sprints e repassa tudo ao serviço", async () => {
    const { plans, call } = setup();
    await call("maestro", "create_project", {
      sprints: [{ ref: "s1", name: "Sprint 1", goal: "Base", start_at: "2026-11-12", duration_days: 7 }],
      labels: [{ name: "front" }],
      tasks: [
        { ref: "D1", title: "Front-End", briefing: "Entregável", kind: "group" },
        { ref: "T1", title: "Tela", briefing: "Faça a tela", owner: "clara", parent: "D1", sprint: "s1", labels: ["front"] },
      ],
    });
    const sent = (plans.propose.mock.calls[0] as unknown as [string, { sprints: unknown[]; labels: unknown[]; tasks: Record<string, unknown>[] }])[1];
    expect(sent.sprints).toEqual([{ ref: "s1", name: "Sprint 1", goal: "Base", start_at: "2026-11-12", duration_days: 7 }]);
    expect(sent.tasks[0]).toMatchObject({ kind: "group" });
    expect(sent.tasks[1]).toMatchObject({ parent: "D1", sprint: "s1", labels: ["front"] });
    expect(sent.tasks[0]).not.toHaveProperty("owner");
  });

  it("add_project_tasks aceita parent, kind e sprint; get_project devolve o quadro do serviço", async () => {
    const { plans, call } = setup();
    await call("maestro", "add_project_tasks", { tasks: [{ title: "Extra", briefing: "Faça", owner: "clara", parent: "D1", sprint: "S1" }] });
    expect(plans.addTasks).toHaveBeenCalledWith("req-1", [expect.objectContaining({ parent: "D1", sprint: "S1" })]);
    expect((await call("maestro", "get_project", {})).text).toBe("quadro");
  });

  it("add_sprint, update_sprint, move_task, assign_task e close_sprint chamam o serviço como Maestro", async () => {
    const { plans, call } = setup();
    expect((await call("maestro", "add_sprint", { project_id: "req-1", name: "Sprint 2", start_at: "2026-11-19", duration_days: 5 })).text).toContain("Sprint S1");
    expect(plans.createSprint).toHaveBeenCalledWith("req-1", { name: "Sprint 2", startAt: "2026-11-19T00:00:00.000Z", endAt: "2026-11-24T00:00:00.000Z" }, "maestro");
    await call("maestro", "update_sprint", { project_id: "req-1", sprint: "Sprint 1", goal: null, end_at: "2026-11-25" });
    expect(plans.updateSprint).toHaveBeenCalledWith("req-1", "S1", { goal: null, endAt: "2026-11-25T00:00:00.000Z" }, "maestro");
    await expect(call("maestro", "update_sprint", { project_id: "req-1", sprint: "S1" })).rejects.toThrow(/Nothing to change/);
    await call("maestro", "move_task", { project_id: "req-1", ref: "T1", sprint: null, parent: "D2" });
    expect(plans.moveTask).toHaveBeenCalledWith("req-1", "T1", { parent: "D2", sprintId: null }, "maestro");
    await call("maestro", "move_task", { project_id: "req-1", ref: "T1", sprint: "Sprint 1" });
    expect(plans.moveTask).toHaveBeenLastCalledWith("req-1", "T1", { sprintId: "S1" }, "maestro");
    await expect(call("maestro", "move_task", { project_id: "req-1", ref: "T1" })).rejects.toThrow(/Nothing to move/);
    await call("maestro", "assign_task", { project_id: "req-1", ref: "T1", assignees: ["clara", "maestro"], mode: "parallel" });
    expect(plans.assignTask).toHaveBeenCalledWith("req-1", "T1", ["clara", "maestro"], "parallel", "maestro");
    await expect(call("maestro", "assign_task", { project_id: "req-1", ref: "T1", assignees: Array.from({ length: 13 }, (_, index) => `a${index}`) })).rejects.toThrow();
    const closed = await call("maestro", "close_sprint", { project_id: "req-1", sprint: "S1" });
    expect(plans.closeSprint).toHaveBeenCalledWith("req-1", "S1", "maestro");
    expect(closed.text).toContain("waits for the user's OK");
  });

  it("reassign_task passa a tarefa travada a outro agente como Maestro (e só o Maestro a recebe)", async () => {
    const { plans, deps, call } = setup();
    const result = await call("maestro", "reassign_task", { project_id: "req-1", ref: "T2", agent: "clara", step: 1 });
    expect(plans.reassignTask).toHaveBeenCalledWith("req-1", "T2", { agentId: "clara", step: 1 }, "maestro");
    expect(result.text).toContain("reassigned to clara");
    await call("maestro", "reassign_task", { project_id: "req-1", ref: "T2", agent: "clara" });
    expect(plans.reassignTask).toHaveBeenLastCalledWith("req-1", "T2", { agentId: "clara" }, "maestro");
    await expect(call("maestro", "reassign_task", { project_id: "req-1", ref: "T2", agent: "clara", step: -1 })).rejects.toThrow();
    expect(officeToolsFor("clara", deps).map((tool) => tool.name)).not.toContain("reassign_task");
  });

  it("os agentes comuns não recebem as ferramentas de sprint e árvore", () => {
    const { deps } = setup();
    const names = officeToolsFor("clara", deps).map((tool) => tool.name);
    for (const name of ["add_sprint", "update_sprint", "move_task", "assign_task", "close_sprint", "create_project", "get_project"]) expect(names).not.toContain(name);
    expect(officeToolsFor("maestro", deps).map((tool) => tool.name)).toEqual(expect.arrayContaining(["add_sprint", "update_sprint", "move_task", "assign_task", "close_sprint"]));
  });
});

describe("checklist do critério de pronto (agentes)", () => {
  it("submit_result grava o checklist (e avisa de índice que não existe), sem bloquear a entrega", async () => {
    const { plans, runner, call } = setup();
    plans.recordChecklist.mockReturnValueOnce("checklist index 4 does not exist");
    const result = await call("clara", "submit_result", { result: "Pronto", checklist: [{ index: 1, met: true, note: "ok" }, { index: 4, met: false }] });
    expect(plans.recordChecklist).toHaveBeenCalledWith(expect.objectContaining({ id: "task-1" }), [{ index: 1, met: true, note: "ok" }, { index: 4, met: false }]);
    expect(runner.deliver).toHaveBeenCalledWith("clara", "Pronto");
    expect(result.text).toContain("Entregue.");
    expect(result.text).toContain("index 4 does not exist");
  });

  it("request_approval (um item e lote) também aceita o checklist", async () => {
    const { plans, runner, call } = setup();
    await call("clara", "request_approval", { question: "Posso postar?", text: "Oi", where: "Comentário", checklist: [{ index: 1, met: true }] });
    await call("clara", "request_approval", { items: [{ question: "a", text: "A", where: "x" }], checklist: [{ index: 2, met: false, note: "curto" }] });
    expect(plans.recordChecklist).toHaveBeenCalledTimes(2);
    expect(runner.requestApproval).toHaveBeenCalledTimes(2);
  });

  it("sem checklist, nada é gravado", async () => {
    const { plans, call } = setup();
    await call("clara", "submit_result", { result: "Pronto" });
    expect(plans.recordChecklist).not.toHaveBeenCalled();
  });
});
