import type { ForYouItem, OfficeState, Project, ServerEvent, Task } from "@cyno/shared";
import { describe, expect, it, vi } from "vitest";
import { isPingPong } from "./handoff";
import { ProjectService, type ProjectHost, type ProjectServiceDeps } from "./project-service";

/** Fatia 6: `send_to_colleague` (handoff), seus limites contra laço e o `request_help` que espera o Maestro. */

const AT = "2026-11-11T12:00:00.000Z";
/** Relógio do teste: parado em AT, e o teste o adianta quando precisa de tempo passando. */
const clock = { at: Date.parse(AT) };
const avatar = { skin: "tone3", hair: "bun", hairColor: "ink", shirt: "mint", pants: "denim" } as const;

function office(): OfficeState {
  const worker = (id: string, name: string, role: string) => ({ id, teamId: "a-time", name, role, instructions: "", avatar, status: "idle" as const });
  return {
    rooms: [
      { id: "ger", kind: "maestro", name: "Gerência", theme: "mint", gridPosition: { x: 0, y: 0 }, readsGlobalBrain: true, readsBrainsOf: [] },
      { id: "a", kind: "team", name: "A", theme: "mint", gridPosition: { x: 1, y: 0 }, readsGlobalBrain: true, readsBrainsOf: [] },
    ],
    teams: [
      { id: "ger-time", roomId: "ger", name: "Gerência", focus: "gerir" },
      { id: "a-time", roomId: "a", name: "Time", focus: "testar" },
    ],
    agents: [{ id: "maestro", teamId: "ger-time", name: "Maestro", role: "Gerente", instructions: "", avatar, status: "idle" }, worker("ana", "Ana", "Redatora"), worker("beto", "Beto", "Revisor"), worker("cris", "Cris", "Pesquisadora"), worker("dan", "Dan", "Designer")],
    tasks: [{ id: "req1", roomId: "ger", teamId: "ger-time", agentId: "maestro", role: "request", prompt: "Posts da semana", status: "in_progress", createdAt: AT, updatedAt: AT }],
  };
}

type Harness = ReturnType<typeof harness>;

function harness() {
  clock.at = Date.parse(AT);
  const state = office();
  const wakes: { kind: string; build: () => string }[] = [];
  const host: ProjectHost = { awaitUser: vi.fn(), working: vi.fn(), wake: (_id, kind, build) => void wakes.push({ kind, build }), close: vi.fn() };
  const deps: ProjectServiceDeps = {
    workspaceId: "ws",
    state: {
      read: () => structuredClone(state),
      commit: ((change: { tasks?: Task[] }) => {
        if (change.tasks) state.tasks = structuredClone(change.tasks);
        return Promise.resolve();
      }) as never,
      publish: (_event: ServerEvent) => undefined,
    } as never,
    agentLog: { append: vi.fn() } as never,
    orchestrator: { enqueue: vi.fn(), cancelTask: vi.fn(), retryWaiting: vi.fn() },
    forYou: { openSpecial: vi.fn((input: Record<string, unknown>) => ({ id: "A-0001", status: "pendente", ...input }) as unknown as ForYouItem), close: vi.fn(async () => undefined) },
    host: () => host,
    settings: () => ({ maxRunning: 3, perAgent: 1 }),
    log: { info: vi.fn(), error: vi.fn() },
    now: () => new Date(clock.at),
    checkEveryMs: 0,
    persistDelaysMs: [0, 0],
  };
  const service = new ProjectService([], deps);
  const live = () => (service as unknown as { plans: Project[] }).plans[0]!;
  return { service, state, wakes, deps, live };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 5));
const sub = (h: Harness, ref: string) => h.state.tasks.find((candidate) => candidate.work?.ref === ref)!;
const finish = async (h: Harness, ref: string, result = "ok") => {
  h.service.handleEvent({ type: "task:upserted", task: { ...sub(h, ref), status: "done", result } });
  await flush();
};

/** Projeto aprovado com a T1 da Ana em andamento; devolve a Task da etapa dela. */
async function running(h: Harness, steps?: { agent: string; does: string }[]): Promise<Task> {
  await h.service.propose("req1", { tasks: [{ title: "Post 1", briefing: "Escreva", owner: "Ana", ...(steps ? { steps } : {}) }] });
  await h.service.approve("req1");
  return sub(h, "T1");
}

describe("isPingPong", () => {
  it("só 5 agentes alternando entre os mesmos 2", () => {
    expect(isPingPong(["a", "b", "a", "b", "a"])).toBe(true);
    expect(isPingPong(["x", "a", "b", "a", "b", "a"])).toBe(true);
    expect(isPingPong(["a", "b", "a", "b"])).toBe(false);
    expect(isPingPong(["a", "b", "c", "b", "a"])).toBe(false);
    expect(isPingPong(["a", "a", "a", "a", "a"])).toBe(false);
  });
});

describe("handoff (send_to_colleague)", () => {
  it("pass_on cria a tarefa H1 do colega no mesmo projeto, admitida pelo agendador, com origin e o briefing da mensagem", async () => {
    const h = harness();
    const ana = await running(h);
    const answer = h.service.handoff(ana, { to: "ws/beto", message: "Revise o post: está em anexo.", intent: "pass_on", doneWhen: ["sem erros de português"] });
    expect(answer).toContain("finish your own step with submit_result");
    const created = h.service.get("req1").tasks.find((candidate) => candidate.ref === "H1")!;
    expect(created).toMatchObject({ ownerId: "beto", origin: { fromAddress: "ws/ana", fromRef: "T1", intent: "pass_on", hops: 1 }, doneWhen: [{ id: "d1", text: "sem erros de português" }], dependsOn: [] });
    // O checklist do colega nasce em branco: nenhum item marcado (sem `met`), nem pela conferência da Ana.
    expect(created.doneWhen).toEqual([{ id: "d1", text: "sem erros de português" }]);
    h.service.recordChecklist(ana, [{ index: 1, met: true }]);
    expect(h.service.get("req1").tasks.find((candidate) => candidate.ref === "H1")!.doneWhen).toEqual([{ id: "d1", text: "sem erros de português" }]);
    expect(created.briefing).toContain("Ana terminou a parte e passou a vez para você");
    expect(created.briefing).toContain("Revise o post");
    // O agendador já admitiu: há uma Task do Beto, ligada a H1 (a Ana segue na dela).
    expect(created.status).toBe("em_andamento");
    expect(sub(h, "H1")).toMatchObject({ agentId: "beto", work: { projectId: "req1", ref: "H1", step: 0 } });
    expect(sub(h, "H1").prompt).toContain("Revise o post");
    expect(sub(h, "T1").status).not.toBe("done");
  });

  it("o resultado parcial do remetente (limitado) vai no briefing", async () => {
    const h = harness();
    await running(h, [
      { agent: "ana", does: "escrever" },
      { agent: "cris", does: "pesquisar" },
    ]);
    await finish(h, "T1", "R".repeat(5000));
    const second = h.state.tasks.find((candidate) => candidate.work?.ref === "T1" && candidate.work.step === 1)!;
    h.service.handoff(second, { to: "dan", message: "Faça a arte", intent: "pass_on" });
    const briefing = h.service.get("req1").tasks.find((candidate) => candidate.ref === "H1")!.briefing;
    expect(briefing).toContain("Resultado parcial de T1");
    expect(briefing.length).toBeLessThan(3000);
  });

  it("ask: quando o colega termina, a resposta volta como tarefa (reply) para quem perguntou", async () => {
    const h = harness();
    const ana = await running(h);
    h.service.handoff(ana, { to: "Beto", message: "Qual o tom da marca?", intent: "ask" });
    await finish(h, "H1", "Tom direto e bem-humorado.");
    const project = h.service.get("req1");
    const reply = project.tasks.find((candidate) => candidate.ref === "H2")!;
    expect(reply).toMatchObject({ ownerId: "ana", origin: { fromAddress: "ws/beto", fromRef: "H1", intent: "fyi", reply: true, hops: 2 } });
    expect(reply.briefing).toContain("Resposta de Beto");
    expect(reply.briefing).toContain("Tom direto e bem-humorado.");
    // A resposta não gera outra resposta quando termina.
    await finish(h, "H2");
    expect(h.service.get("req1").tasks.filter((candidate) => candidate.origin?.reply)).toHaveLength(1);
  });

  it("fyi não gera resposta", async () => {
    const h = harness();
    const ana = await running(h);
    h.service.handoff(ana, { to: "beto", message: "Só avisando", intent: "fyi" });
    await finish(h, "H1");
    expect(h.service.get("req1").tasks.map((candidate) => candidate.ref)).toEqual(["T1", "H1"]);
  });

  it("o projeto só conclui quando as tarefas de repasse também terminam", async () => {
    const h = harness();
    const ana = await running(h);
    h.service.handoff(ana, { to: "beto", message: "revise", intent: "pass_on" });
    await finish(h, "T1");
    expect(h.service.get("req1").status).toBe("ativo");
    await finish(h, "H1");
    expect(h.service.get("req1").status).toBe("concluido");
  });

  it("recusa: a si mesmo, o Maestro, colega inexistente, outro workspace e tarefa fora de projeto", async () => {
    const h = harness();
    const ana = await running(h);
    expect(() => h.service.handoff(ana, { to: "ana", message: "x", intent: "pass_on" })).toThrow(/yourself/);
    expect(() => h.service.handoff(ana, { to: "ws/maestro", message: "x", intent: "ask" })).toThrow(/request_help/);
    expect(() => h.service.handoff(ana, { to: "fantasma", message: "x", intent: "ask" })).toThrow(/Available: .*ws\/beto/);
    expect(() => h.service.handoff(ana, { to: "outro/beto", message: "x", intent: "ask" })).toThrow(/this workspace/);
    expect(() => h.service.handoff({ ...ana, work: undefined }, { to: "beto", message: "x", intent: "ask" })).toThrow(/not linked to one/);
    expect(h.service.get("req1").tasks).toHaveLength(1);
  });

  it("numa tarefa simples (folha do Avulsas) o repasse vira outra folha ligada à origem, com a Task na fila do colega", async () => {
    const h = harness();
    const subtask: Task = { id: "sub1", roomId: "a", teamId: "a-time", agentId: "ana", projectId: "req1", prompt: "Escreva uma frase e passe para o designer", status: "in_progress", createdAt: AT, updatedAt: AT };
    h.service.adopt(h.state.tasks[0]!, subtask, {});
    h.state.tasks.push(subtask);
    const answer = h.service.handoff(subtask, { to: "dan", message: "Faça a arte da frase", intent: "pass_on" });
    expect(answer).toContain("passed the baton to Dan");
    const avulsas = h.service.get("avulsas");
    const leaf = avulsas.tasks.find((candidate) => candidate.origin)!;
    expect(leaf).toMatchObject({ ref: "A2", ownerId: "dan", origin: { fromRef: "A1", fromAddress: "ws/ana", intent: "pass_on", hops: 1 } });
    const queued = h.state.tasks.find((candidate) => candidate.work?.ref === "A2")!;
    expect(queued).toMatchObject({ agentId: "dan", status: "queued", work: { projectId: "avulsas", ref: "A2", step: 0 } });
    expect(leaf.steps[0]!.taskId).toBe(queued.id);
    expect(h.deps.orchestrator.enqueue).toHaveBeenCalledWith("dan");
    // `ask` numa folha: terminada, a resposta volta como outra folha para quem perguntou.
    h.service.handoff(queued, { to: "ana", message: "Qual o tom?", intent: "ask" });
    const asked = h.state.tasks.find((candidate) => candidate.work?.ref === "A3")!;
    h.service.handleEvent({ type: "task:upserted", task: { ...asked, status: "done", result: "Informal" } });
    await flush();
    expect(h.service.get("avulsas").tasks.find((candidate) => candidate.ref === "A4")).toMatchObject({ ownerId: "dan", origin: { intent: "fyi", reply: true } });
  });

  it("tarefa direta (atalho para um time, sem projeto) vira folha do Avulsas na hora do repasse", async () => {
    const h = harness();
    const direct: Task = { id: "dir1", roomId: "a", teamId: "a-time", agentId: "ana", prompt: "Escreva uma frase e passe para o designer", status: "in_progress", createdAt: AT, updatedAt: AT };
    h.state.tasks.push(direct);
    expect(h.service.handoff(direct, { to: "dan", message: "Faça a arte", intent: "pass_on" })).toContain("passed the baton to Dan");
    const avulsas = h.service.get("avulsas");
    expect(avulsas.tasks.map((task) => task.ref)).toEqual(["A1", "A2"]);
    expect(avulsas.tasks[1]).toMatchObject({ ownerId: "dan", origin: { fromRef: "A1", fromAddress: "ws/ana" } });
    expect(h.state.tasks.find((task) => task.id === "dir1")?.work).toMatchObject({ projectId: "avulsas", ref: "A1" });
    expect(h.state.tasks.find((task) => task.work?.ref === "A2")).toMatchObject({ agentId: "dan", status: "queued" });
  });

  it("todo erro do repasse diz que NADA foi repassado e o que fazer", async () => {
    const h = harness();
    const ana = await running(h);
    for (const input of [{ to: "ana" }, { to: "fantasma" }, { to: "maestro" }]) {
      expect(() => h.service.handoff(ana, { ...input, message: "x", intent: "pass_on" })).toThrow(/Nothing was handed off\. Do the work yourself or call request_help\. Do not report a handoff\./);
    }
    expect(() => h.service.handoff({ ...ana, work: undefined }, { to: "beto", message: "x", intent: "ask" })).toThrow(/Nothing was handed off/);
  });

  it("limite de hops: a cadeia passa de 6", async () => {
    const h = harness();
    const ana = await running(h);
    h.live().tasks[0]!.origin = { fromAddress: "ws/cris", fromRef: "X", intent: "pass_on", hops: 6 };
    expect(() => h.service.handoff(ana, { to: "beto", message: "x", intent: "pass_on" })).toThrow(/6 hops/);
    h.live().tasks[0]!.origin = { fromAddress: "ws/cris", fromRef: "X", intent: "pass_on", hops: 5 };
    expect(() => h.service.handoff(ana, { to: "beto", message: "x", intent: "pass_on" })).not.toThrow();
  });

  it("no máximo 3 repasses abertos por tarefa de origem", async () => {
    const h = harness();
    const ana = await running(h);
    for (const to of ["beto", "cris", "dan"]) h.service.handoff(ana, { to, message: `para ${to}`, intent: "fyi" });
    expect(() => h.service.handoff(ana, { to: "beto", message: "mais um", intent: "fyi" })).toThrow(/3 open handoffs/);
    await finish(h, "H1");
    expect(() => h.service.handoff(ana, { to: "beto", message: "agora sim", intent: "fyi" })).not.toThrow();
  });

  it("ida e volta: o 4º repasse alternando entre os mesmos 2 agentes é recusado e o Maestro é acordado uma vez", async () => {
    const h = harness();
    const ana = await running(h);
    h.service.handoff(ana, { to: "beto", message: "1", intent: "pass_on" });
    await finish(h, "T1");
    h.service.handoff(sub(h, "H1"), { to: "ana", message: "2", intent: "pass_on" });
    await finish(h, "H1");
    h.service.handoff(sub(h, "H2"), { to: "beto", message: "3", intent: "pass_on" });
    await finish(h, "H2");
    expect(() => h.service.handoff(sub(h, "H3"), { to: "ana", message: "4", intent: "pass_on" })).toThrow(/Back-and-forth refused/);
    expect(() => h.service.handoff(sub(h, "H3"), { to: "ana", message: "5", intent: "pass_on" })).toThrow(/Back-and-forth refused/);
    expect(h.wakes.filter((wake) => wake.kind === "handoff")).toHaveLength(1);
    expect(h.wakes.find((wake) => wake.kind === "handoff")!.build()).toContain("Back-and-forth");
    // Com um terceiro agente no meio não é ida e volta.
    expect(() => h.service.handoff(sub(h, "H3"), { to: "cris", message: "6", intent: "pass_on" })).not.toThrow();
  });

  it("no máximo 30 tarefas de repasse por projeto e 20 por hora no workspace", async () => {
    const base = { title: "x", briefing: "x", ownerId: "beto", steps: [], current: 0, dependsOn: [], priority: "normal", doneWhen: [], rework: { count: 0 }, status: "concluida", updatedAt: AT } as const;
    const fill = (h: Harness, count: number, at: string) => {
      for (let index = 0; index < count; index += 1) h.live().tasks.push({ ...base, ref: `Z${index + 1}`, origin: { fromAddress: "ws/cris", fromRef: "Q", intent: "fyi", hops: 1, at } } as never);
    };
    const h = harness();
    const ana = await running(h);
    fill(h, 29, "2026-11-10T10:00:00.000Z");
    expect(() => h.service.handoff(ana, { to: "beto", message: "30º", intent: "fyi" })).not.toThrow();
    expect(() => h.service.handoff(ana, { to: "beto", message: "31º", intent: "fyi" })).toThrow(/30 handoff tasks/);

    const h2 = harness();
    const ana2 = await running(h2);
    fill(h2, 20, AT);
    expect(() => h2.service.handoff(ana2, { to: "beto", message: "21º", intent: "fyi" })).toThrow(/20 handoff tasks in the last hour/);
  });

  it("colega sem cota: a tarefa entra na fila com blocked cota (não falha)", async () => {
    const h = harness();
    const ana = await running(h);
    h.deps.availability = (agent) => (agent.id === "beto" ? ({ reason: "quota" } as never) : undefined);
    h.service.handoff(ana, { to: "beto", message: "revise", intent: "pass_on" });
    const created = h.service.get("req1").tasks.find((candidate) => candidate.ref === "H1")!;
    expect(created).toMatchObject({ status: "a_fazer", blocked: { type: "cota", by: "ws/beto" } });
    expect(h.state.tasks.some((candidate) => candidate.work?.ref === "H1")).toBe(false);
  });

  it("projeto pausado: recusa com instrução", async () => {
    const h = harness();
    const ana = await running(h);
    await h.service.updateProject("req1", { status: "pausado" });
    expect(() => h.service.handoff(ana, { to: "beto", message: "x", intent: "pass_on" })).toThrow(/paused/);
  });
});

describe("request_help: a tarefa espera o Maestro", () => {
  it("skill: bloqueia como 'agente' com a nota Esperando o Maestro, acorda o Maestro uma vez e a espera sai em helpReleased", async () => {
    const h = harness();
    const ana = await running(h);
    expect(h.service.help(ana, "Preciso de um designer", "dan")).toContain("WAITS");
    expect(h.service.get("req1").tasks[0]).toMatchObject({ note: "Esperando o Maestro", blocked: { type: "agente", note: "Esperando o Maestro" }, help: [{ kind: "skill", suggestedAgentId: "dan" }] });
    const wake = h.wakes.filter((candidate) => candidate.kind === "help");
    expect(wake).toHaveLength(1);
    expect(wake[0]!.build()).toContain('message_agent(agent: "ana"');
    clock.at += 30 * 60_000;
    h.service.helpReleased(ana);
    expect(h.service.get("req1").tasks[0]!.blocked).toBeUndefined();
    expect(h.service.get("req1").tasks[0]!.note).toBeUndefined();
    expect(h.service.get("req1").tasks[0]!.blockedSpans).toEqual([expect.objectContaining({ type: "agente", since: AT, until: new Date(clock.at).toISOString() })]);
  });

  it("access: grava blocked acesso", async () => {
    const h = harness();
    const ana = await running(h);
    h.service.help(ana, "Sem login no LinkedIn", undefined, "access");
    expect(h.service.get("req1").tasks[0]).toMatchObject({ note: "Esperando o Maestro (acesso)", blocked: { type: "acesso" }, help: [{ kind: "access" }] });
    expect(h.wakes.find((candidate) => candidate.kind === "help")!.build()).toContain("ACESSO");
    h.service.helpReleased(ana);
    expect(h.service.get("req1").tasks[0]!.blocked).toBeUndefined();
  });
});
