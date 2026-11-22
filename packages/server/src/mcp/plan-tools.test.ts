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

function setup(options: { rule?: "maestro" | "always" | "never"; proposedStatus?: "proposto" | "ativo"; approvalBy?: "regra" | "maestro" } = {}) {
  const project = {
    id: "req-1",
    title: "Projeto Teste",
    status: options.proposedStatus ?? "proposto",
    ...(options.approvalBy ? { approval: { by: options.approvalBy, at: "2026-11-12T12:00:00.000Z" } } : {}),
    tasks: [
      { ref: "T1", released: true },
      { ref: "T2", released: false },
    ],
    sprints: [{ id: "S1", name: "Sprint 1", startAt: "2026-11-12T12:00:00.000Z", endAt: "2026-11-19T12:00:00.000Z", summary: { done: [{}], carried: [] } }],
  };
  let currentRule: "maestro" | "always" | "never" = options.rule ?? "maestro";
  const planApproval = {
    get: vi.fn(() => ({ rule: currentRule })),
    set: vi.fn(async (rule: "maestro" | "always" | "never", quote: string) => {
      currentRule = rule;
      return { rule, note: { quote, at: "2026-11-12T12:00:00.000Z", by: "maestro" as const } };
    }),
  };
  const plans = {
    propose: vi.fn(async () => project),
    addTasks: vi.fn(() => project),
    decideTask: vi.fn(() => "decidido"),
    describe: vi.fn(() => "quadro"),
    workerView: vi.fn(() => "view"),
    help: vi.fn(() => "ajuda"),
    updateProject: vi.fn(async () => ({ id: "req-1" })),
    updateTask: vi.fn(async () => project),
    deleteTask: vi.fn(async () => ({ project, deleted: ["T2"], cleanedDependsOn: [{ ref: "T3", removed: ["T2"] }] })),
    deleteProject: vi.fn(async () => ({ deleted: { tasks: 2, logs: 1 } })),
    list: vi.fn(() => [project]),
    releaseWork: vi.fn(async () => project),
    holdWork: vi.fn(async () => project),
    setReleasePace: vi.fn(async () => project),
    setProjectStatus: vi.fn(async () => project),
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
    requestFor: vi.fn((id?: string) => ({ id: id ?? "req-1" })),
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
  const deps = { state: { read: () => STATE }, maestro, runner, plans, planApproval, forYouTypes } as unknown as OfficeToolsDeps;
  const find = (agentId: string, name: string) => officeToolsFor(agentId, deps).find((tool) => tool.name === name)!;
  const call = async (agentId: string, name: string, args: Record<string, unknown>) => {
    const tool = find(agentId, name);
    return tool.call(tool.input.parse(args));
  };
  return { plans, planApproval, maestro, runner, deps, find, call };
}

const TASK = { title: "Post 1", briefing: "Escreva", owner: "clara" };

describe("ferramentas de projeto do Maestro", () => {
  it("create_project exige release e approval, não expõe sprints nem sprint por tarefa, e manda todos os campos ao serviço", async () => {
    const { plans, call, find } = setup();
    await expect(call("maestro", "create_project", { tasks: [TASK] })).rejects.toThrow();
    await expect(call("maestro", "create_project", { release: "now", tasks: [TASK] })).rejects.toThrow();
    await expect(call("maestro", "create_project", { approval: "ask", tasks: [TASK] })).rejects.toThrow();
    const shape = find("maestro", "create_project").input.shape as Record<string, unknown>;
    expect(shape).not.toHaveProperty("sprints");
    const taskShape = (find("maestro", "create_project").input.shape.tasks as { element: { shape: Record<string, unknown> } }).element.shape;
    expect(taskShape).not.toHaveProperty("sprint");

    const result = await call("maestro", "create_project", {
      release: "now",
      approval: "ask",
      new_project: true,
      title: "Posts da semana",
      priority: "high",
      due_at: "2026-11-16",
      pace: { hours_per_day: 1, window: { from: "09:00", to: "12:00" } },
      suggested_mode: "auto",
      auto_scope: { actions: ["post"] },
      tasks: [{ ...TASK, release: "later", done_when: ["até 1200 caracteres"], start_at: "2026-11-12", due_at: "2026-11-13", steps: [{ agent: "linkedin/clara", does: "escrever" }] }],
    });
    expect(result.text).toContain("Project with 2 task(s)");
    expect(result.text).toContain('project_id: "req-1"');
    expect(result.text).toContain('your choice "ask"');
    expect(plans.propose).toHaveBeenCalledWith(
      "req-1",
      expect.objectContaining({ release: "now", approval: "ask", new_project: true, title: "Posts da semana", priority: "high", due_at: "2026-11-16", pace: expect.objectContaining({ hours_per_day: 1 }), suggested_mode: "auto" }),
    );
    const sent = (plans.propose.mock.calls[0] as unknown as [string, { tasks: { release: string; done_when: string[]; steps: { agent: string }[] }[] }])[1];
    expect(sent.tasks[0]).toMatchObject({ release: "later", done_when: ["até 1200 caracteres"], steps: [{ agent: "linkedin/clara" }] });
  });

  it("create_project explica qual regra de aprovação valeu (always/never/maestro)", async () => {
    const always = setup({ rule: "always", proposedStatus: "proposto" });
    const forcedAsk = await always.call("maestro", "create_project", { release: "now", approval: "skip", tasks: [TASK] });
    expect(forcedAsk.text).toContain('workspace rule "always" overrode your "skip"');

    const never = setup({ rule: "never", proposedStatus: "ativo", approvalBy: "regra" });
    const forcedSkip = await never.call("maestro", "create_project", { release: "now", approval: "ask", tasks: [TASK] });
    expect(forcedSkip.text).toContain("started without asking for approval");
    expect(forcedSkip.text).toContain('workspace rule "never" overrode your "ask"');
    expect(forcedSkip.text).toContain("1 released, 1 planned");

    const maestroSkip = setup({ rule: "maestro", proposedStatus: "ativo", approvalBy: "maestro" });
    const skipped = await maestroSkip.call("maestro", "create_project", { release: "now", approval: "skip", tasks: [TASK] });
    expect(skipped.text).toContain('your choice "skip" (workspace rule is "maestro")');
  });

  it("set_plan_approval_rule mapeia regras, exige owner_quote (3..300) e grava via serviço", async () => {
    const { planApproval, call } = setup();
    await expect(call("maestro", "set_plan_approval_rule", { rule: "never_ask", owner_quote: "ok" })).rejects.toThrow();
    await expect(call("maestro", "set_plan_approval_rule", { rule: "never_ask", owner_quote: "   " })).rejects.toThrow();
    await expect(call("maestro", "set_plan_approval_rule", { rule: "never_ask", owner_quote: "x".repeat(301) })).rejects.toThrow();

    for (const [input, mapped] of [
      ["never_ask", "never"],
      ["always_ask", "always"],
      ["maestro_decides", "maestro"],
    ] as const) {
      const res = await call("maestro", "set_plan_approval_rule", { rule: input, owner_quote: "pode fazer sem pedir aprovação" });
      expect(planApproval.set).toHaveBeenLastCalledWith(mapped, "pode fazer sem pedir aprovação");
      expect(res.text).toContain(`"${mapped}"`);
    }
  });

  it("os nomes novos aparecem no tools/list (sem add_sprint) e os antigos seguem chamáveis", async () => {
    const { deps, plans } = setup();
    const tools = () => officeToolsFor("maestro", deps);
    const listed = (await handleMcpPayload({ jsonrpc: "2.0", id: 1, method: "tools/list" }, tools)) as { result: { tools: { name: string }[] } };
    const names = listed.result.tools.map((tool) => tool.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "create_project",
        "add_project_tasks",
        "resolve_task",
        "get_project",
        "update_project",
        "update_task",
        "delete_task",
        "delete_project",
        "release_work",
        "hold_work",
        "set_release_pace",
        "set_project_status",
        "set_plan_approval_rule",
      ]),
    );
    // add_sprint fica escondida (listed: false) para projetos novos.
    expect(names).not.toContain("add_sprint");
    for (const old of ["create_plan", "add_plan_tasks", "resolve_plan_task", "get_plan", "list_plans"]) expect(names).not.toContain(old);
    // Chamar pelo nome antigo funciona (uma sessão retomada ainda usa).
    const response = (await handleMcpPayload({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "create_plan", arguments: { release: "now", approval: "ask", tasks: [TASK] } } }, tools)) as { result: { isError: boolean; content: { text: string }[] } };
    expect(response.result.isError).toBe(false);
    expect(plans.propose).toHaveBeenCalledTimes(1);
    await handleMcpPayload({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_plan", arguments: { request_id: "req-1" } } }, tools);
    expect(plans.describe).toHaveBeenCalledWith({ requestId: "req-1" }, {});
    const resolved = (await handleMcpPayload({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "resolve_plan_task", arguments: { request_id: "req-1", ref: "T1", action: "cancel_plan" } } }, tools)) as { result: { isError: boolean } };
    expect(resolved.result.isError).toBe(false);
    expect(plans.decideTask).toHaveBeenCalledWith({ requestId: "req-1" }, "T1", "cancel_plan", undefined);
  });

  it("project_id XOR request_id em add_project_tasks, resolve_task e get_project (e release obrigatório em add_project_tasks)", async () => {
    const { plans, maestro, call } = setup();
    // Nenhum dos dois -> falha
    await expect(call("maestro", "add_project_tasks", { release: "now", tasks: [TASK] })).rejects.toThrow(/project_id or request_id/);
    await expect(call("maestro", "resolve_task", { ref: "T1", action: "skip" })).rejects.toThrow(/project_id or request_id/);
    await expect(call("maestro", "get_project", {})).rejects.toThrow(/project_id or request_id/);
    // Os dois juntos -> falha
    await expect(call("maestro", "add_project_tasks", { project_id: "p1", request_id: "req-1", release: "now", tasks: [TASK] })).rejects.toThrow(/project_id or request_id/);
    await expect(call("maestro", "resolve_task", { project_id: "p1", request_id: "req-1", ref: "T1", action: "skip" })).rejects.toThrow(/project_id or request_id/);
    await expect(call("maestro", "get_project", { project_id: "p1", request_id: "req-1" })).rejects.toThrow(/project_id or request_id/);
    // Sem release em add_project_tasks -> falha
    await expect(call("maestro", "add_project_tasks", { project_id: "p1", tasks: [TASK] })).rejects.toThrow();
    // Com project_id: não passa por maestro.requestFor
    maestro.requestFor.mockClear();
    await call("maestro", "add_project_tasks", { project_id: "manual-1", release: "later", tasks: [TASK] });
    expect(maestro.requestFor).not.toHaveBeenCalled();
    expect(plans.addTasks).toHaveBeenCalledWith({ projectId: "manual-1" }, [TASK], { release: "later" });
    await call("maestro", "resolve_task", { project_id: "manual-1", ref: "T1", action: "retry", instruction: "mude" });
    expect(plans.decideTask).toHaveBeenCalledWith({ projectId: "manual-1" }, "T1", "retry", "mude");
    await call("maestro", "get_project", { project_id: "manual-1", ref: "M1" });
    expect(plans.describe).toHaveBeenCalledWith({ projectId: "manual-1" }, { ref: "M1" });
  });

  it("resolve_task aceita cancel_project e update_project converte datas, prioridade e limpa com null", async () => {
    const { plans, call } = setup();
    await call("maestro", "resolve_task", { request_id: "req-1", ref: "T1", action: "cancel_project" });
    expect(plans.decideTask).toHaveBeenCalledWith({ requestId: "req-1" }, "T1", "cancel_project", undefined);
    const result = await call("maestro", "update_project", { project_id: "req-1", priority: "low", due_at: "2026-11-20", start_at: null, pace: { hours_per_day: 2 } });
    expect(result.text).toContain("updated");
    expect(plans.updateProject).toHaveBeenCalledWith("req-1", { priority: "baixa", dueAt: "2026-11-20T00:00:00.000Z", startAt: null, pace: { hoursPerDay: 2 } }, "maestro");
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

describe("ferramentas novas do Lote 3 (poderes do Maestro sobre módulos, tarefas, liberação e status)", () => {
  it("update_task converte campos, limpa com null e recusa chamada vazia ou data inválida", async () => {
    const { plans, call } = setup();
    const ok = await call("maestro", "update_task", {
      project_id: "p1",
      ref: "T2",
      title: "Novo título",
      briefing: "Novo briefing",
      priority: "high",
      owner: null,
      depends_on: ["T1", "M1"],
      start_at: "2026-11-15",
      due_at: null,
      done_when: ["curto"],
    });
    expect(ok.text).toContain("Item T2 updated");
    expect(plans.updateTask).toHaveBeenCalledWith(
      "p1",
      "T2",
      {
        title: "Novo título",
        briefing: "Novo briefing",
        priority: "alta",
        assignee: null,
        dependsOn: ["T1", "M1"],
        startAt: "2026-11-15T00:00:00.000Z",
        dueAt: null,
        doneWhen: ["curto"],
      },
      "maestro",
    );
    await expect(call("maestro", "update_task", { project_id: "p1", ref: "T2" })).rejects.toThrow(/Nothing to change/);
    await expect(call("maestro", "update_task", { project_id: "p1", ref: "T2", start_at: "amanha" })).rejects.toThrow(/start_at/);
  });

  it("delete_task repassa project_id, ref, reason, relata dependências limpas e aponta para delete_project", async () => {
    const { plans, call, find } = setup();
    const desc = find("maestro", "delete_task").description;
    expect(desc).not.toContain("only the owner can delete projects");
    expect(desc).toContain("delete_project");
    const res = await call("maestro", "delete_task", { project_id: "p1", ref: "T2", reason: "não precisa" });
    expect(plans.deleteTask).toHaveBeenCalledWith("p1", "T2", { by: "maestro", reason: "não precisa" });
    expect(res.text).toContain("Deleted 1 item(s) (T2)");
    expect(res.text).toContain("T3 (T2)");
  });

  it("delete_project exige owner_quote (3..300), chama deleteProject como Maestro e devolve título e contagens", async () => {
    const { plans, call } = setup();
    await expect(call("maestro", "delete_project", { project_id: "req-1" })).rejects.toThrow();
    await expect(call("maestro", "delete_project", { project_id: "req-1", owner_quote: "ok" })).rejects.toThrow();
    await expect(call("maestro", "delete_project", { project_id: "req-1", owner_quote: "   " })).rejects.toThrow();
    await expect(call("maestro", "delete_project", { project_id: "req-1", owner_quote: "x".repeat(301) })).rejects.toThrow();

    const res = await call("maestro", "delete_project", { project_id: "req-1", owner_quote: "apague esse projeto de teste" });
    expect(plans.deleteProject).toHaveBeenCalledWith("req-1", { by: "maestro", reason: "apague esse projeto de teste" });
    expect(res.text).toContain('"Projeto Teste"');
    expect(res.text).toContain("2 item(s)");
    expect(res.text).toContain("1 log(s)");
  });

  it("release_work, hold_work, set_release_pace e set_project_status validam e chamam o serviço como Maestro", async () => {
    const { plans, call } = setup();
    // release_work: refs XOR all
    await expect(call("maestro", "release_work", { project_id: "p1" })).rejects.toThrow(/refs or all/);
    await expect(call("maestro", "release_work", { project_id: "p1", refs: ["T1"], all: true })).rejects.toThrow(/refs or all/);
    await call("maestro", "release_work", { project_id: "p1", refs: ["M1"], with_prerequisites: true });
    expect(plans.releaseWork).toHaveBeenCalledWith("p1", { refs: ["M1"], withPrerequisites: true }, "maestro");
    await call("maestro", "release_work", { project_id: "p1", all: true });
    expect(plans.releaseWork).toHaveBeenLastCalledWith("p1", { all: true }, "maestro");

    await call("maestro", "hold_work", { project_id: "p1", refs: ["T1", "M2"] });
    expect(plans.holdWork).toHaveBeenCalledWith("p1", { refs: ["T1", "M2"] }, "maestro");
    await expect(call("maestro", "hold_work", { project_id: "p1", refs: [] })).rejects.toThrow();

    await call("maestro", "set_release_pace", { project_id: "p1", per_day: 2, unit: "modules", starts_on: "2026-11-25" });
    expect(plans.setReleasePace).toHaveBeenCalledWith("p1", { perDay: 2, unit: "modulos", startsOn: "2026-11-25" }, "maestro");
    await call("maestro", "set_release_pace", { project_id: "p1", per_day: 5 });
    expect(plans.setReleasePace).toHaveBeenLastCalledWith("p1", { perDay: 5, unit: "tarefas" }, "maestro");
    await call("maestro", "set_release_pace", { project_id: "p1", per_day: null });
    expect(plans.setReleasePace).toHaveBeenLastCalledWith("p1", null, "maestro");
    await expect(call("maestro", "set_release_pace", { project_id: "p1", per_day: 0 })).rejects.toThrow();

    for (const [input, mapped] of [
      ["active", "ativo"],
      ["paused", "pausado"],
      ["completed", "concluido"],
      ["canceled", "cancelado"],
    ] as const) {
      await call("maestro", "set_project_status", { project_id: "p1", status: input });
      expect(plans.setProjectStatus).toHaveBeenLastCalledWith("p1", mapped, "maestro");
    }
  });
});

describe("ferramentas de árvore e sprint (só o Maestro)", () => {
  it("create_project aceita kind module e group e labels (sem sprints), e repassa tudo ao serviço", async () => {
    const { plans, call } = setup();
    await call("maestro", "create_project", {
      release: "later",
      approval: "ask",
      labels: [{ name: "front" }],
      tasks: [
        { ref: "M1", title: "Front-End", briefing: "Módulo", kind: "module" },
        { ref: "M2", title: "Legado", briefing: "Módulo", kind: "group" },
        { ref: "T1", title: "Tela", briefing: "Faça a tela", owner: "clara", parent: "M1", labels: ["front"], release: "now" },
      ],
    });
    const sent = (plans.propose.mock.calls[0] as unknown as [string, { release: string; approval: string; sprints?: unknown[]; labels: unknown[]; tasks: Record<string, unknown>[] }])[1];
    expect(sent.release).toBe("later");
    expect(sent.approval).toBe("ask");
    expect(sent.sprints).toBeUndefined();
    expect(sent.tasks[0]).toMatchObject({ kind: "module" });
    expect(sent.tasks[1]).toMatchObject({ kind: "group" });
    expect(sent.tasks[2]).toMatchObject({ parent: "M1", labels: ["front"], release: "now" });
    expect(sent.tasks[0]).not.toHaveProperty("owner");
  });

  it("add_project_tasks aceita parent, kind module/group e sprint; get_project devolve o quadro", async () => {
    const { plans, call } = setup();
    await call("maestro", "add_project_tasks", { request_id: "req-1", release: "now", tasks: [{ title: "Extra", briefing: "Faça", owner: "clara", parent: "D1", sprint: "S1" }] });
    expect(plans.addTasks).toHaveBeenCalledWith({ requestId: "req-1" }, [expect.objectContaining({ parent: "D1", sprint: "S1" })], { release: "now" });
    expect((await call("maestro", "get_project", { request_id: "req-1" })).text).toBe("quadro");
  });

  it("sem limite de 60 tarefas: 150 itens (módulos aninhados, depends_on em módulo) passam; só a rede de segurança de 500 por chamada recusa", async () => {
    const { plans, call } = setup();
    const tasks = [
      { ref: "M1", title: "Módulo 1", briefing: "m", kind: "module" },
      { ref: "M2", title: "Módulo 2", briefing: "m", kind: "group", parent: "M1", depends_on: ["T0"] },
      { ref: "T0", title: "Antes", briefing: "t", owner: "clara" },
      ...Array.from({ length: 147 }, (_, index) => ({ ref: `C${index + 1}`, title: `Capítulo ${index + 1}`, briefing: "escreva", owner: "clara", parent: "M2" })),
    ];
    await call("maestro", "create_project", { release: "later", approval: "ask", tasks });
    const sent = (plans.propose.mock.calls.at(-1) as unknown as [string, { tasks: Record<string, unknown>[] }])[1];
    expect(sent.tasks).toHaveLength(150);
    expect(sent.tasks[1]).toMatchObject({ kind: "group", parent: "M1", depends_on: ["T0"] });
    await call("maestro", "add_project_tasks", { project_id: "req-1", release: "later", tasks });
    expect(plans.addTasks).toHaveBeenCalledWith({ projectId: "req-1" }, expect.arrayContaining([expect.objectContaining({ ref: "C147" })]), { release: "later" });
    const tooMany = Array.from({ length: 501 }, (_, index) => ({ title: `T${index}`, briefing: "x", owner: "clara" }));
    await expect(call("maestro", "create_project", { release: "later", approval: "ask", tasks: tooMany })).rejects.toThrow();
    await expect(call("maestro", "add_project_tasks", { project_id: "req-1", release: "later", tasks: tooMany })).rejects.toThrow();
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
    await expect(call("maestro", "assign_task", { project_id: "req-1", ref: "T1", assignees: Array.from({ length: 501 }, (_, index) => `a${index}`) })).rejects.toThrow();
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

  it("os agentes comuns não recebem nenhuma ferramenta de gestão de projeto (nem delete_project)", () => {
    const { deps } = setup();
    const names = officeToolsFor("clara", deps).map((tool) => tool.name);
    for (const name of ["add_sprint", "update_sprint", "move_task", "assign_task", "close_sprint", "create_project", "get_project", "update_task", "delete_task", "release_work", "hold_work", "set_release_pace", "set_project_status", "set_plan_approval_rule", "delete_project"]) {
      expect(names).not.toContain(name);
    }
    expect(officeToolsFor("maestro", deps).map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["add_sprint", "update_sprint", "move_task", "assign_task", "close_sprint", "update_task", "delete_task", "delete_project", "release_work", "hold_work", "set_release_pace", "set_project_status", "set_plan_approval_rule"]),
    );
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
