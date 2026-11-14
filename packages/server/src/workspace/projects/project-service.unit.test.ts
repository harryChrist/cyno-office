import { deliveryLeaves, statusOf, type ForYouItem, type OfficeState, type Project, type ServerEvent, type Task } from "@cyno/shared";
import { describe, expect, it, vi } from "vitest";
import { ProjectService, type ProjectHost, type ProjectServiceDeps } from "./project-service";

/** ProjectService com dependências falsas (sem disco nem runtime): o que importa aqui é a ordem das chamadas e o estado. */

const AT = "2026-11-11T12:00:00.000Z";
const avatar = { skin: "tone3", hair: "bun", hairColor: "ink", shirt: "mint", pants: "denim" } as const;

function office(): OfficeState {
  return {
    rooms: [
      { id: "ger", kind: "maestro", name: "Gerência", theme: "mint", gridPosition: { x: 0, y: 0 }, readsGlobalBrain: true, readsBrainsOf: [] },
      { id: "a", kind: "team", name: "A", theme: "mint", gridPosition: { x: 1, y: 0 }, readsGlobalBrain: true, readsBrainsOf: [] },
    ],
    teams: [
      { id: "ger-time", roomId: "ger", name: "Gerência", focus: "gerir" },
      { id: "a-time", roomId: "a", name: "Time", focus: "testar" },
    ],
    agents: [
      { id: "maestro", teamId: "ger-time", name: "Maestro", role: "Gerente", instructions: "", avatar, status: "idle" },
      { id: "ana", teamId: "a-time", name: "Ana", role: "Redatora", instructions: "", avatar, status: "idle" },
      { id: "beto", teamId: "a-time", name: "Beto", role: "Revisor", instructions: "", avatar, status: "idle" },
      { id: "caio", teamId: "a-time", name: "Caio", role: "Designer", instructions: "", avatar, status: "idle" },
      { id: "duda", teamId: "a-time", name: "Duda", role: "Analista", instructions: "", avatar, status: "idle" },
    ],
    tasks: [{ id: "req1", roomId: "ger", teamId: "ger-time", agentId: "maestro", role: "request", prompt: "Posts da semana", status: "in_progress", createdAt: AT, updatedAt: AT }],
  };
}

type Harness = ReturnType<typeof harness>;

function harness(options: { commit?: ProjectServiceDeps["state"]["commit"] } = {}) {
  const state = office();
  const events: ServerEvent[] = [];
  const calls: string[] = [];
  const items: ForYouItem[] = [];
  const commit = vi.fn(options.commit ?? (async () => undefined));
  const forYou = {
    openSpecial: vi.fn((input: Record<string, unknown>) => {
      calls.push("open");
      const item = { id: `A-000${items.length + 1}`, status: "pendente", ...input } as unknown as ForYouItem;
      items.push(item);
      return item;
    }),
    close: vi.fn(async (id: string) => {
      calls.push(`close:${id}`);
      return undefined;
    }),
  };
  const wakes: { kind: string; build: () => string; plan?: () => Project | undefined }[] = [];
  const host: ProjectHost = {
    awaitUser: vi.fn(),
    working: vi.fn(),
    wake: (_id, kind, build, plan) => void wakes.push({ kind, build, ...(plan ? { plan } : {}) }),
    close: vi.fn(),
  };
  const deps: ProjectServiceDeps = {
    workspaceId: "ws",
    state: {
      read: () => structuredClone(state),
      commit: ((change: Parameters<typeof commit>[0]) => {
        if (change.tasks) state.tasks = structuredClone(change.tasks);
        events.push(...change.events);
        return commit(change);
      }) as never,
      publish: (event: ServerEvent) => void events.push(event),
      readForYou: () => items,
    } as never,
    agentLog: { append: vi.fn() } as never,
    orchestrator: { enqueue: vi.fn(), cancelTask: vi.fn(), retryWaiting: vi.fn() },
    forYou,
    host: () => host,
    settings: () => ({ maxRunning: 3, perAgent: 1 }),
    log: { info: vi.fn(), error: vi.fn() },
    now: () => new Date(AT),
    checkEveryMs: 0,
    persistDelaysMs: [0, 0],
  };
  const service = new ProjectService([], deps);
  return { service, state, events, calls, items, commit, forYou, wakes, deps };
}

const task = (extra: Record<string, unknown> = {}) => ({ title: "Post 1", briefing: "Escreva", owner: "Ana", ...extra });

describe("propose: gravar antes de trocar o item do Para você", () => {
  it("grava, só então fecha o item antigo e abre o novo (e o evento sai com o item já pronto)", async () => {
    const h = harness();
    const v1 = await h.service.propose("req1", { tasks: [task()] });
    expect(v1.forYouId).toBe("A-0001");
    h.calls.length = 0;
    h.events.length = 0;
    const order: string[] = [];
    h.commit.mockImplementation(async () => void order.push("commit"));
    h.forYou.close.mockImplementation(async () => void order.push("close"));
    h.forYou.openSpecial.mockImplementation((input: Record<string, unknown>) => {
      order.push("open");
      return { id: "A-0002", ...input } as unknown as ForYouItem;
    });
    const v2 = await h.service.propose("req1", { tasks: [task({ title: "Post novo" })] });
    expect(order.slice(0, 3)).toEqual(["commit", "close", "open"]);
    expect(v2).toMatchObject({ version: 2, forYouId: "A-0002" });
    // O primeiro commit é silencioso: o project:upserted só sai depois de o item existir.
    expect(h.events.filter((event) => event.type === "project:upserted")).toHaveLength(1);
  });

  it("se a gravação falha, o item antigo continua aberto, a memória volta e o erro chega ao Maestro", async () => {
    let fail = false;
    const h = harness({ commit: async () => void (fail && (() => { throw new Error("disco cheio"); })()) });
    await h.service.propose("req1", { tasks: [task()] });
    h.calls.length = 0;
    fail = true;
    await expect(h.service.propose("req1", { tasks: [task({ title: "Outro" })] })).rejects.toThrow(/gravar o projeto/);
    expect(h.calls).toEqual([]); // nada foi fechado nem aberto
    expect(h.service.get("req1")).toMatchObject({ version: 1, tasks: [expect.objectContaining({ title: "Post 1" })], forYouId: "A-0001" });
  });

  it("preenche prazo, prioridade, ritmo, done_when e a sugestão do Automático (sem ligar o modo)", async () => {
    const h = harness();
    const project = await h.service.propose("req1", {
      title: "Posts da semana",
      priority: "high",
      start_at: "2026-11-12",
      due_at: "2026-11-16T18:00:00-03:00",
      pace: { hours_per_day: 1.5, window: { from: "09:00", to: "12:00" } },
      suggested_mode: "auto",
      auto_scope: { actions: ["post"], daily_cap: 2 },
      tasks: [task({ done_when: ["até 1200 caracteres", "abre com um gancho"], start_at: "2026-11-12", due_at: "2026-11-13", steps: [{ agent: "ws/ana", does: "escrever" }, { agent: "beto", does: "revisar" }] })],
    });
    expect(project).toMatchObject({ title: "Posts da semana", priority: "alta", pace: { hoursPerDay: 1.5, window: { from: "09:00", to: "12:00" } }, mode: { kind: "pede-ok" } });
    expect(project.dueAt).toBe("2026-11-16T21:00:00.000Z");
    expect(project.modeProposal).toMatchObject({ by: "maestro", grant: { actions: ["post"], dailyCap: 2 } });
    expect(project.tasks[0]).toMatchObject({ doneWhen: [{ id: "d1", text: "até 1200 caracteres" }, { id: "d2", text: "abre com um gancho" }], steps: [{ agentId: "ana" }, { agentId: "beto" }] });
    expect(project.tasks[0]!.startAt).toBe("2026-11-12T00:00:00.000Z");
  });

  it("recusa data inválida e suggested_mode sem auto_scope", async () => {
    const h = harness();
    await expect(h.service.propose("req1", { due_at: "amanhã cedo", tasks: [task()] })).rejects.toThrow(/due_at/);
    await expect(h.service.propose("req1", { suggested_mode: "auto", tasks: [task()] })).rejects.toThrow(/auto_scope/);
    await expect(h.service.propose("req1", { tasks: [task({ due_at: "x" })] })).rejects.toThrow(/due_at/);
  });
});

describe("wake: texto montado na hora do consumo", () => {
  it("a mensagem de falha reflete o estado de quando é consumida, não o de quando foi pedida", async () => {
    const h = harness();
    await h.service.propose("req1", { tasks: [task()] });
    await h.service.approve("req1");
    const sub = h.state.tasks.find((candidate) => candidate.work)!;
    const live = h.service.get("req1");
    expect(live.tasks[0]!.status).toBe("em_andamento");
    // A etapa falha: o Maestro é "acordado", mas o texto só sai quando alguém chama build().
    h.service.handleEvent({ type: "task:upserted", task: { ...sub, status: "failed", result: "API fora do ar" } });
    await Promise.resolve();
    await Promise.resolve();
    const failed = h.wakes.find((wake) => wake.kind === "failed")!;
    expect(failed).toBeDefined();
    // Antes do consumo, o Maestro (ou o usuário) já resolveu: a tarefa foi pulada.
    h.service.decideTask("req1", "T1", "skip", "não precisa");
    const text = failed.build();
    expect(text).toContain("API fora do ar");
    expect(text).toContain("Agora a tarefa está: pulada");
  });
});

describe("persist: novas tentativas e aviso visível", () => {
  it("tenta de novo e grava sem aviso quando a segunda tentativa funciona", async () => {
    let attempts = 0;
    const h = harness({ commit: async () => void (attempts++ === 0 && (() => { throw new Error("EAGAIN"); })()) });
    await h.service.propose("req1", { tasks: [task()] });
    expect(attempts).toBeGreaterThanOrEqual(2);
    expect(h.events.some((event) => event.type === "system:warning")).toBe(false);
  });

  it("depois das 3 tentativas publica system:warning (nos caminhos do servidor) e não lança", async () => {
    let fail = false;
    const h = harness({ commit: async () => void (fail && (() => { throw new Error("ENOSPC"); })()) });
    await h.service.propose("req1", { tasks: [task()] });
    await h.service.approve("req1");
    fail = true;
    const sub = h.state.tasks.find((candidate) => candidate.work)!;
    h.service.handleEvent({ type: "task:upserted", task: { ...sub, status: "waiting_approval" } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const warnings = h.events.filter((event) => event.type === "system:warning");
    expect(warnings).toHaveLength(1);
    expect((warnings[0] as { message: string }).message).toContain("ENOSPC");
  });

  it("nos caminhos do usuário (aprovar) o erro volta de verdade e o projeto continua proposto", async () => {
    let fail = false;
    const h = harness({ commit: async () => void (fail && (() => { throw new Error("EIO"); })()) });
    await h.service.propose("req1", { tasks: [task()] });
    fail = true;
    await expect(h.service.approve("req1")).rejects.toMatchObject({ statusCode: 500 });
    expect(h.service.get("req1").status).toBe("proposto");
  });
});

describe("tarefa pulada", () => {
  it("fica concluída para destravar as dependentes, mas o resumo conta à parte", async () => {
    const h = harness();
    await h.service.propose("req1", { tasks: [task({ ref: "T1" }), task({ ref: "T2", title: "Post 2", depends_on: ["T1"] }), task({ ref: "T3", title: "Post 3" })] });
    await h.service.approve("req1");
    const sub = h.state.tasks.filter((candidate) => candidate.work);
    // T1 e T3 começaram (perAgent 1 e mesmo agente: só um por vez; o que importa é T1).
    h.service.decideTask("req1", "T1", "skip");
    const after = h.service.get("req1");
    expect(after.tasks[0]).toMatchObject({ status: "concluida", skipped: true });
    expect(after.tasks[1]!.status).not.toBe("backlog");
    expect(h.service.describe("req1")).toContain("[pulada]");
    expect(h.service.describe("req1")).toMatch(/0 de 2 concluídas, 1 pulada/);
    expect(sub.length).toBeGreaterThan(0);
  });

  it("a Task cancelada pelo skip não reabre a tarefa como falha", async () => {
    const h = harness();
    await h.service.propose("req1", { tasks: [task()] });
    await h.service.approve("req1");
    const sub = h.state.tasks.find((candidate) => candidate.work)!;
    h.service.decideTask("req1", "T1", "skip");
    h.service.handleEvent({ type: "task:upserted", task: { ...sub, status: "failed", outcome: "cancelled", result: "Pulada pelo Maestro" } });
    await Promise.resolve();
    await Promise.resolve();
    expect(h.service.get("req1").tasks[0]).toMatchObject({ status: "concluida", skipped: true });
    expect(h.wakes.some((wake) => wake.kind === "failed")).toBe(false);
  });
});

describe("tarefa avulsa (kind tarefa): falha e cancelamento", () => {
  const adopt = (h: Harness) => {
    const sub: Task = { id: "sub1", roomId: "a", teamId: "a-time", agentId: "ana", projectId: "req1", prompt: "Responda o comentário", status: "queued", createdAt: AT, updatedAt: AT };
    h.service.adopt(h.state.tasks[0]!, sub, { dueAt: "2026-11-12T00:00:00.000Z", priority: "high", doneWhen: ["menos de 600 caracteres"], approvalType: "comentario" });
    h.state.tasks.push(sub);
    return sub;
  };
  const closeRequest = (h: Harness, status: "done" | "failed", extra: Partial<Task> = {}) => {
    const request = { ...h.state.tasks[0]!, status, result: "fim", ...extra };
    h.service.handleEvent({ type: "task:upserted", task: request });
  };
  const flush = () => new Promise((resolve) => setTimeout(resolve, 5));

  it("adopt cria uma folha do Avulsas (ref A1) com prazo, prioridade, done_when e a origem do pedido", () => {
    const h = harness();
    const sub = adopt(h);
    expect(sub.work).toEqual({ projectId: "avulsas", ref: "A1", step: 0 });
    const avulsas = h.service.get("avulsas");
    expect(avulsas).toMatchObject({ system: "avulsas", status: "ativo", nextRef: 2 });
    expect(avulsas.tasks).toHaveLength(1);
    expect(avulsas.tasks[0]).toMatchObject({ ref: "A1", priority: "alta", dueAt: "2026-11-12T00:00:00.000Z", doneWhen: [{ id: "d1", text: "menos de 600 caracteres" }], approvalType: "comentario", meta: { requestId: "req1", origin: "usuario" } });
    // A vista de projeto do pedido (o que o Maestro, o Cyno e a tela atual leem) continua igual.
    expect(h.service.get("req1")).toMatchObject({ kind: "tarefa", priority: "alta", dueAt: "2026-11-12T00:00:00.000Z" });
    expect(h.service.forRequest("req1")?.tasks[0]).toMatchObject({ ref: "A1" });
    expect(h.service.typeOf({ work: { projectId: "avulsas", ref: "A1", step: 0 } })).toBe("comentario");
    // dois pedidos: refs diferentes, o contador anda
    const second: Task = { id: "sub2", roomId: "a", teamId: "a-time", agentId: "ana", projectId: "req1", prompt: "Outra", status: "queued", createdAt: AT, updatedAt: AT };
    h.service.adopt(h.state.tasks[0]!, second);
    expect(second.work).toEqual({ projectId: "avulsas", ref: "A2", step: 0 });
    expect(h.service.get("avulsas").tasks.map((task) => task.meta!.requestId)).toEqual(["req1", "req1"]);
  });

  it("a única tarefa falha e o pedido fecha como done: o projeto fica cancelado com o motivo (não 'Concluído')", async () => {
    const h = harness();
    const sub = adopt(h);
    h.service.handleEvent({ type: "task:upserted", task: { ...sub, status: "failed", result: "API Error: 529 overloaded" } });
    await flush();
    expect(h.service.get("avulsas").tasks[0]!.status).toBe("falhou");
    closeRequest(h, "done");
    await flush();
    expect(h.service.get("req1")).toMatchObject({ status: "cancelado", summary: expect.stringContaining("API Error: 529 overloaded") });
  });

  it("com ao menos uma tarefa concluída o pedido done continua dando projeto concluído", async () => {
    const h = harness();
    const sub = adopt(h);
    h.service.handleEvent({ type: "task:upserted", task: { ...sub, status: "done", result: "ok" } });
    await flush();
    closeRequest(h, "done");
    await flush();
    expect(h.service.get("req1").status).toBe("concluido");
  });

  it("cancelar (outcome cancelled) vira tarefa cancelada, não falhou", async () => {
    const h = harness();
    const sub = adopt(h);
    h.service.handleEvent({ type: "task:upserted", task: { ...sub, status: "failed", outcome: "cancelled", result: "Cancelada: o pedido foi fechado pelo usuário" } });
    await flush();
    const after = h.service.get("req1").tasks[0]!;
    expect(after.status).toBe("cancelada");
    expect(after.failure).toBeUndefined();
    closeRequest(h, "failed", { outcome: "cancelled", result: "Cancelado pelo usuário" });
    await flush();
    expect(h.service.get("req1").status).toBe("cancelado");
  });
});

describe("Avulsas: fechamento do pedido, arquivo e boot", () => {
  const mkSub = (id: string, extra: Partial<Task> = {}): Task => ({ id, roomId: "a", teamId: "a-time", agentId: "ana", projectId: "req1", prompt: `Faça ${id}`, status: "queued", createdAt: AT, updatedAt: AT, ...extra });
  const flush = () => new Promise((resolve) => setTimeout(resolve, 5));
  const fakeArchive = () => {
    const stored: { ref: string }[] = [];
    return { stored, find: async (ref: string) => stored.find((task) => task.ref === ref) as never, append: async (leaves: readonly { ref: string }[]) => void stored.push(...leaves), ofRequest: async () => [] };
  };

  it("pedido que falhou cancela a folha aberta (com o motivo); pedido concluído deixa cada folha seguir a própria Task", async () => {
    const h = harness();
    const sub = mkSub("sub1");
    h.service.adopt(h.state.tasks[0]!, sub);
    h.state.tasks.push(sub);
    h.service.handleEvent({ type: "task:upserted", task: { ...h.state.tasks[0]!, status: "done", result: "ok" } });
    await flush();
    expect(h.service.get("avulsas").tasks[0]!.status).toBe("a_fazer");
    h.service.handleEvent({ type: "task:upserted", task: { ...h.state.tasks[0]!, status: "failed", result: "Cancelado: sem cota" } });
    await flush();
    expect(h.service.get("avulsas").tasks[0]).toMatchObject({ status: "cancelada", failure: "Cancelado: sem cota" });
    expect(h.service.get("req1")).toMatchObject({ status: "cancelado", summary: "Cancelado: sem cota" });
  });

  it("archiveDone leva ao arquivo só as finalizadas há mais de 14 dias; findTask acha no vivo e no arquivo", async () => {
    const h = harness();
    const archive = fakeArchive();
    h.deps.archive = archive;
    for (const id of ["old", "recent", "open", "running"]) {
      const sub = mkSub(id);
      h.service.adopt(h.state.tasks[0]!, sub);
      h.state.tasks.push({ ...sub, status: id === "running" ? "in_progress" : id === "open" ? "queued" : "done" });
    }
    const leaves = (h.service as unknown as { plans: Project[] }).plans.find((project) => project.id === "avulsas")!.tasks;
    Object.assign(leaves[0]!, { status: "concluida", finishedAt: "2026-10-01T10:00:00.000Z" });
    Object.assign(leaves[1]!, { status: "concluida", finishedAt: "2026-11-10T10:00:00.000Z" });
    Object.assign(leaves[3]!, { status: "concluida", finishedAt: "2026-10-01T10:00:00.000Z" }); // finalizada, mas a Task ainda roda: fica
    expect(await h.service.archiveDone()).toBe(1);
    expect(archive.stored.map((leaf) => leaf.ref)).toEqual(["A1"]);
    expect(h.service.get("avulsas").tasks.map((task) => task.ref)).toEqual(["A2", "A3", "A4"]);
    expect(await h.service.findTask("avulsas", "A2")).toMatchObject({ ref: "A2" });
    expect(await h.service.findTask("avulsas", "A1")).toMatchObject({ ref: "A1", status: "concluida" });
    expect(await h.service.findTask("avulsas", "A99")).toBeUndefined();
    expect(await h.service.archiveDone()).toBe(0);
  });

  it("resume concilia a folha com a Task que terminou enquanto o server estava fora", async () => {
    const h = harness();
    const sub = mkSub("sub1");
    h.service.adopt(h.state.tasks[0]!, sub);
    h.state.tasks.push({ ...sub, status: "done", result: "pronto" });
    h.service.resume();
    await flush();
    expect(h.service.get("avulsas").tasks[0]).toMatchObject({ status: "concluida", result: "pronto" });
  });

  it("workspace antigo sem o projeto fixo: o primeiro pedido simples cria o Avulsas", () => {
    const h = harness();
    expect(h.service.list()).toEqual([]);
    h.service.adopt(h.state.tasks[0]!, mkSub("sub1"));
    expect(h.service.list().map((project) => project.id)).toEqual(["avulsas"]);
  });
});

describe("agendador: só as folhas executam", () => {
  it("tarefa-mãe (com filha) não vira etapa; só a filha começa", async () => {
    const h = harness();
    await h.service.propose("req1", { tasks: [task({ title: "Mãe", ref: "T1" }), task({ title: "Filha", ref: "T2" })] });
    const plan = (h.service as unknown as { plans: Project[] }).plans.find((project) => project.id === "req1")!;
    plan.tasks[1]!.parent = "T1";
    plan.tasks[0]!.steps = [];
    await h.service.approve("req1");
    const started = h.state.tasks.filter((candidate) => candidate.work);
    expect(started.map((candidate) => candidate.work!.ref)).toEqual(["T2"]);
    expect(plan.tasks[0]!.status).toBe("a_fazer");
  });
});

describe("subtarefas por agente: passagem de bastão", () => {
  /** Mãe T1 com a cadeia T2 (Ana) > T3 (Beto) > T4 (Caio) e T5 (Duda, conferência) depois de T3 e T4. */
  async function chain() {
    const h = harness();
    await h.service.propose("req1", {
      tasks: [
        task({ ref: "T1", title: "Criar a postagem", owner: undefined }),
        task({ ref: "T2", parent: "T1", title: "Pesquisar", owner: "Ana", briefing: "pesquise o tema" }),
        task({ ref: "T3", parent: "T1", title: "Escrever o texto", owner: "Beto", depends_on: ["T2"], briefing: "escreva com a pesquisa" }),
        task({ ref: "T4", parent: "T1", title: "Criar a imagem", owner: "Caio", depends_on: ["T3"], briefing: "imagem do texto" }),
        task({ ref: "T5", parent: "T1", title: "Conferir tudo", owner: "Duda", depends_on: ["T3", "T4"], briefing: "confira" }),
      ],
    });
    await h.service.approve("req1");
    const finish = async (ref: string, result: string) => {
      const sub = h.state.tasks.find((candidate) => candidate.work?.ref === ref)!;
      sub.status = "done";
      sub.result = result;
      (h.service as unknown as { onStepTask(sub: Task): void }).onStepTask(sub);
      await new Promise((resolve) => setTimeout(resolve, 5));
    };
    const subOf = (ref: string) => h.state.tasks.find((candidate) => candidate.work?.ref === ref);
    return { h, finish, subOf };
  }

  it("só a primeira começa; a seguinte recebe a íntegra da anterior (prompt e get_task) e sabe quem recebe a dela", async () => {
    const { h, finish, subOf } = await chain();
    expect(h.state.tasks.filter((candidate) => candidate.work).map((candidate) => candidate.work!.ref)).toEqual(["T2"]);
    expect(subOf("T2")!.prompt).toContain("Fluxo da tarefa «Criar a postagem»: T2 Ana «Pesquisar» (você)");
    expect(subOf("T2")!.prompt).toContain("Depois de você: Beto (T3 «Escrever o texto») recebe o seu resultado na íntegra");
    const long = `Fontes: ${"x".repeat(5000)} FIM`;
    await finish("T2", long);
    const next = subOf("T3")!;
    expect(next.prompt).toContain("## O que as subtarefas de que esta depende entregaram");
    expect(next.prompt).toContain("T2 «Pesquisar» (Ana): Fontes:");
    expect(next.prompt).toContain("Depois de você: Caio (T4 «Criar a imagem»), Duda (T5 «Conferir tudo»)");
    const view = h.service.workerView(next);
    expect(view).toContain("### T2 — Pesquisar (Ana)\nFontes:");
    expect(view).toContain(long.slice(0, 4000));
    expect(h.service.workerView(subOf("T2")!)).not.toContain("O que as subtarefas de que esta depende entregaram");
  });

  it("a mãe só conclui quando todas concluem e a entrega dela é a da última subtarefa; o Maestro recebe uma mensagem só", async () => {
    const { h, finish, subOf } = await chain();
    await finish("T2", "R2");
    await finish("T3", "R3");
    expect(subOf("T5")).toBeUndefined();
    expect(statusOf(h.service.get("req1"), h.service.get("req1").tasks[0]!)).toBe("em_andamento");
    await finish("T4", "R4");
    expect(subOf("T5")!.prompt).toContain("Você é a última subtarefa: o seu resultado é a entrega da tarefa «Criar a postagem»");
    expect(h.service.workerView(subOf("T5")!)).toContain("### T4 — Criar a imagem (Caio)\nR4");
    expect(h.wakes.filter((wake) => wake.kind === "done")).toHaveLength(0);
    await finish("T5", "Entrega final");
    const plan = h.service.get("req1");
    expect(statusOf(plan, plan.tasks[0]!)).toBe("concluida");
    expect(deliveryLeaves(plan, "T1").map((leaf) => leaf.result)).toEqual(["Entrega final"]);
    const done = h.wakes.filter((wake) => wake.kind === "done");
    expect(done).toHaveLength(1);
    const message = done[0]!.build();
    expect(message).toContain("## T1 · Criar a postagem (tarefa com subtarefas) — a entrega é a de T5 (Duda)");
    expect(message).toContain("Entrega final");
  });
});

describe("done_when e checklist", () => {
  it("o done_when entra no briefing da etapa e no get_task; o checklist grava met/note sem bloquear", async () => {
    const h = harness();
    await h.service.propose("req1", { tasks: [task({ done_when: ["até 1200 caracteres", "abre com um gancho"], due_at: "2026-11-14" })] });
    await h.service.approve("req1");
    const sub = h.state.tasks.find((candidate) => candidate.work)!;
    expect(sub.prompt).toContain("Done when:\n1. até 1200 caracteres\n2. abre com um gancho");
    expect(sub.prompt).toContain("Prazo: 2026-11-14");
    expect(sub.prompt).toContain("checklist");
    expect(h.service.workerView(sub)).toContain("Done when:\n1. até 1200 caracteres");
    const warning = h.service.recordChecklist(sub, [
      { index: 1, met: true, note: "1100 caracteres" },
      { index: 2, met: false, note: "sem gancho" },
      { index: 5, met: true },
    ]);
    expect(warning).toContain("index 5 does not exist");
    expect(h.service.get("req1").tasks[0]!.doneWhen).toEqual([
      { id: "d1", text: "até 1200 caracteres", met: true, note: "1100 caracteres" },
      { id: "d2", text: "abre com um gancho", met: false, note: "sem gancho" },
    ]);
  });
});

describe("update_project", () => {
  it("só grava os campos e publica project:upserted", async () => {
    const h = harness();
    await h.service.propose("req1", { tasks: [task()] });
    h.events.length = 0;
    const updated = await h.service.updateProject("req1", { priority: "baixa", dueAt: "2026-12-01T00:00:00.000Z", title: "Novo título", pace: { hoursPerDay: 2 } });
    expect(updated).toMatchObject({ priority: "baixa", dueAt: "2026-12-01T00:00:00.000Z", title: "Novo título", pace: { hoursPerDay: 2 } });
    expect(h.events.map((event) => event.type)).toEqual(["project:upserted"]);
    const cleared = await h.service.updateProject("req1", { dueAt: null, pace: null });
    expect(cleared.dueAt).toBeUndefined();
    expect(cleared.pace).toBeUndefined();
  });
});

describe("pedido vindo do Cyno (Projeto-casca com origin cyno e brief)", () => {
  const openFromCyno = (h: Harness) => h.service.openFromCyno(h.state.tasks[0]!, { title: "Post sobre café", kind: "projeto", brief: "Briefing completo do Cyno", priority: "alta", dueAt: "2026-11-20T00:00:00.000Z", doneWhen: ["curto"] });

  it("nasce ativo, sem tarefas, com origem, briefing, prioridade, prazo e 'pronto quando'", () => {
    const h = harness();
    const project = openFromCyno(h);
    expect(project).toMatchObject({ id: "req1", origin: "cyno", kind: "projeto", status: "ativo", title: "Post sobre café", brief: "Briefing completo do Cyno", priority: "alta", dueAt: "2026-11-20T00:00:00.000Z", tasks: [] });
    expect(project.doneWhen).toEqual([{ id: "d1", text: "curto" }]);
    // Chamar de novo não duplica.
    expect(openFromCyno(h).id).toBe("req1");
    expect(h.service.list()).toHaveLength(1);
  });

  it("o create_project do Maestro adota a casca: o projeto novo herda origem, briefing, prioridade e prazo", async () => {
    const h = harness();
    openFromCyno(h);
    const plan = await h.service.propose("req1", { tasks: [task()] });
    expect(plan).toMatchObject({ origin: "cyno", brief: "Briefing completo do Cyno", priority: "alta", dueAt: "2026-11-20T00:00:00.000Z", status: "proposto" });
    expect(h.service.list()).toHaveLength(1);
  });

  it("o delegate_task do Maestro (adopt) absorve a casca de tarefa: a folha do Avulsas guarda origem, briefing, prioridade e prazo, e a casca some", () => {
    const h = harness();
    h.service.openFromCyno(h.state.tasks[0]!, { title: "Post", kind: "tarefa", brief: "Briefing", priority: "alta", dueAt: "2026-11-20T00:00:00.000Z", doneWhen: ["curto"] });
    const sub: Task = { id: "sub1", roomId: "a", teamId: "a-time", agentId: "ana", projectId: "req1", prompt: "Escreva", status: "queued", createdAt: AT, updatedAt: AT };
    h.service.adopt(h.state.tasks[0]!, sub);
    expect(h.service.list().map((project) => project.id)).toEqual(["avulsas"]);
    const leaf = h.service.get("avulsas").tasks[0]!;
    expect(leaf).toMatchObject({ title: "Post", priority: "alta", dueAt: "2026-11-20T00:00:00.000Z", doneWhen: [{ id: "d1", text: "curto" }], meta: { requestId: "req1", origin: "cyno", brief: "Briefing" } });
    // a vista do pedido mantém o que a casca tinha
    expect(h.service.get("req1")).toMatchObject({ origin: "cyno", brief: "Briefing", kind: "tarefa", priority: "alta" });
    expect(h.service.get("req1").tasks).toHaveLength(1);
  });

  it("o delegate_task numa casca de projeto (kind projeto) segue o caminho antigo: tarefa T1 na própria casca", () => {
    const h = harness();
    h.service.openFromCyno(h.state.tasks[0]!, { title: "Post", kind: "projeto", brief: "Briefing" });
    const sub: Task = { id: "sub1", roomId: "a", teamId: "a-time", agentId: "ana", projectId: "req1", prompt: "Escreva", status: "queued", createdAt: AT, updatedAt: AT };
    h.service.adopt(h.state.tasks[0]!, sub);
    expect(h.service.get("req1")).toMatchObject({ origin: "cyno", brief: "Briefing", kind: "projeto" });
    expect(h.service.get("req1").tasks.map((task) => task.ref)).toEqual(["T1"]);
    expect(sub.work).toEqual({ projectId: "req1", ref: "T1", step: 0 });
  });
});

describe("sprints: tarefa nova do Maestro herda a sprint ativa", () => {
  it("add_project_tasks entra na sprint ativa; sem sprint ativa fica sem sprint; sem sprints no projeto, nada muda", async () => {
    const h = harness();
    await h.service.propose("req1", { tasks: [task()] });
    await h.service.approve("req1");
    const plans = (h.service as unknown as { plans: Project[] }).plans;
    const plan = plans.find((candidate) => candidate.id === "req1")!;
    h.service.addTasks("req1", [task({ title: "Sem sprints" })]);
    expect(plan.tasks.at(-1)!.sprintId).toBeUndefined();
    plan.sprints = [{ id: "S1", name: "Sprint 1", startAt: AT, endAt: "2026-11-18T12:00:00.000Z", order: 1, status: "ativa" }];
    h.service.addTasks("req1", [task({ title: "Na ativa" })]);
    expect(plan.tasks.at(-1)).toMatchObject({ title: "Na ativa", sprintId: "S1" });
    plan.sprints[0]!.status = "fechada";
    h.service.addTasks("req1", [task({ title: "Depois" })]);
    expect(plan.tasks.at(-1)!.sprintId).toBeUndefined();
  });
});

describe("proposta com árvore e sprints (create_project) e as ferramentas de sprint do Maestro", () => {
  const tree = () => ({
    sprints: [
      { ref: "s1", name: "Sprint 1", goal: "Base", start_at: "2026-11-11T12:00:00.000Z" },
      { ref: "s2", name: "Sprint 2" },
    ],
    tasks: [
      { ref: "D1", title: "Front-End", briefing: "Entregável", kind: "group" as const },
      { ref: "T1", title: "Tela de login", briefing: "Tela", parent: "D1" },
      { ref: "T2", title: "Arte", briefing: "Arte da tela", owner: "Ana", parent: "T1", sprint: "s1" },
      { ref: "T3", title: "Revisão", briefing: "Revisar", owner: "Beto", parent: "T1", sprint: "s2", depends_on: ["T2"] },
    ],
  });

  it("monta tudo numa chamada e o cartão mostra sprints, entregável e responsáveis", async () => {
    const h = harness();
    const project = await h.service.propose("req1", tree());
    expect(project.status).toBe("proposto");
    expect(project.sprints!.map((sprint) => [sprint.id, sprint.status, sprint.endAt])).toEqual([
      ["S1", "planejada", "2026-11-18T12:00:00.000Z"],
      ["S2", "planejada", "2026-11-25T12:00:00.000Z"],
    ]);
    expect(project.tasks.find((task) => task.ref === "T2")).toMatchObject({ parent: "T1", sprintId: "S1", ownerId: "ana" });
    const card = h.items[0]!;
    expect(card.why).toBe("2 tarefa(s) em 2 sprint(s) para aprovar antes de começar");
    expect(card.text).toContain("**Sprint 1** (11/11 a 18/11): Base");
    expect(card.text).toContain("- **Front-End** (entregável)");
    expect(card.text).toContain("    - **T2 · Arte** — Ana · Sprint 1");
  });

  it("erro de validação volta inteiro ao Maestro e nada é gravado", async () => {
    const h = harness();
    const bad = tree() as unknown as { tasks: Record<string, unknown>[] };
    bad.tasks[3] = { ...bad.tasks[3]!, sprint: "s9" };
    await expect(h.service.propose("req1", bad as never)).rejects.toThrow(/Project rejected[\s\S]*Task T3: sprint "s9" does not exist/);
    expect(h.service.list().filter((plan) => plan.id === "req1")).toHaveLength(0);
    expect(h.items).toHaveLength(0);
  });

  it("aprovada, a primeira sprint abre na hora (data já chegou) e só a folha dela fica liberada", async () => {
    const h = harness();
    await h.service.propose("req1", tree());
    const approved = await h.service.approve("req1");
    expect(approved.sprints!.map((sprint) => sprint.status)).toEqual(["ativa", "planejada"]);
    expect(["a_fazer", "em_andamento"]).toContain(approved.tasks.find((task) => task.ref === "T2")!.status);
    expect(approved.tasks.find((task) => task.ref === "T3")!.status).toBe("backlog");
  });

  it("sprint 1 com datas que já passaram: as datas andam juntas e a primeira abre agora", async () => {
    const h = harness();
    const old = tree() as unknown as { sprints: Record<string, unknown>[] };
    old.sprints[0] = { ref: "s1", name: "Sprint 1", goal: "Base", start_at: "2026-10-01T12:00:00.000Z" };
    await h.service.propose("req1", old as never);
    const approved = await h.service.approve("req1");
    const [s1, s2] = approved.sprints!;
    expect(s1).toMatchObject({ status: "ativa", startAt: AT, endAt: "2026-11-18T12:00:00.000Z" });
    expect(s2!.status).toBe("planejada");
  });

  it("add_project_tasks com parent e sprint; folha que ainda não começou vira mãe; get_project em árvore", async () => {
    const h = harness();
    await h.service.propose("req1", tree());
    await h.service.approve("req1");
    const plan = h.service.get("req1");
    expect(plan.tasks.find((task) => task.ref === "T2")!.sprintId).toBe("S1");
    h.service.addTasks("req1", [{ ref: "T9", title: "Extra", briefing: "Extra", owner: "Beto", parent: "D1", sprint: "Sprint 2" }]);
    expect(h.service.get("req1").tasks.find((task) => task.ref === "T9")).toMatchObject({ parent: "D1", sprintId: "S2" });
    // T9 ainda não começou: ganhar uma filha a transforma em mãe (some o dono dela)
    h.service.addTasks("req1", [{ ref: "T10", title: "Detalhe", briefing: "Detalhe", owner: "Ana", parent: "T9" }]);
    expect(h.service.get("req1").tasks.find((task) => task.ref === "T9")).toMatchObject({ steps: [], ownerId: "" });
    expect(() => h.service.addTasks("req1", [{ title: "X", briefing: "x", owner: "Ana", parent: "D1", sprint: "S7" }])).toThrow(/Tasks rejected[\s\S]*sprint "S7" does not exist/);
    const text = h.service.describe("req1");
    expect(text).toContain("Sprints:");
    expect(text).toContain("S1 «Sprint 1» [ativa]");
    expect(text).toContain("- D1 «Front-End» [");
    expect(text).toContain("(deliverable)");
    expect(text).toContain("    - T3 «Revisão»");
  });

  it("get_project avisa quando há sprints mas nenhuma ativa e o que espera o dono", async () => {
    const h = harness();
    await h.service.propose("req1", tree());
    expect(h.service.describe("req1")).toContain("Waiting for the owner: approval of this project plan");
    await h.service.approve("req1");
    const plan = (h.service as unknown as { plans: Project[] }).plans[0]!;
    plan.sprints![0]!.status = "fechada";
    plan.sprints![1]!.status = "fechada";
    expect(h.service.describe("req1")).toContain("Warning: the project has sprints but none is active or planned");
  });

  it("assign_task: um agente troca o dono, vários em sequência viram etapas e em paralelo viram subtarefas", async () => {
    const h = harness();
    await h.service.propose("req1", { tasks: [task({ ref: "T1" }), task({ ref: "T2" }), task({ ref: "T3" })] });
    await h.service.assignTask("req1", "T1", ["Beto"]);
    expect(h.service.get("req1").tasks[0]).toMatchObject({ ownerId: "beto" });
    await h.service.assignTask("req1", "T2", ["Ana", "Beto"], "sequence", "maestro");
    expect(h.service.get("req1").tasks[1]!.steps.map((step) => step.agentId)).toEqual(["ana", "beto"]);
    await h.service.assignTask("req1", "T3", ["Ana", "Beto"], "parallel");
    const after = h.service.get("req1");
    expect(after.tasks.find((candidate) => candidate.ref === "T3")).toMatchObject({ steps: [], ownerId: "" });
    expect(after.tasks.filter((candidate) => candidate.parent === "T3").map((child) => [child.ownerId, child.status])).toEqual([["ana", "a_fazer"], ["beto", "a_fazer"]]);
    await expect(h.service.assignTask("req1", "T3", ["Ana"])).rejects.toThrow(/subtasks/);
    await expect(h.service.assignTask("req1", "T1", ["Ana", "Beto", "Maestro", "x"])).rejects.toThrow();
  });

  it("assign_task em cadeia (padrão): uma subtarefa por agente, sem limite de 3, cada uma depois da anterior", async () => {
    const h = harness();
    await h.service.propose("req1", { tasks: [task({ ref: "T1" })] });
    await h.service.assignTask("req1", "T1", ["Ana", "Beto", "Caio", "Duda", "Ana"]);
    const kids = h.service.get("req1").tasks.filter((candidate) => candidate.parent === "T1");
    expect(kids.map((child) => child.ownerId)).toEqual(["ana", "beto", "caio", "duda"]);
    expect(kids.map((child) => child.dependsOn)).toEqual([[], [kids[0]!.ref], [kids[1]!.ref], [kids[2]!.ref]]);
    expect(kids.map((child) => child.status)).toEqual(["a_fazer", "backlog", "backlog", "backlog"]);
  });

  it("move_task muda de sprint e de pai; close_sprint inicia o fechamento, cria o cartão e não decide", async () => {
    const h = harness();
    await h.service.propose("req1", tree());
    await h.service.approve("req1");
    await h.service.moveTask("req1", "T3", { sprintId: "S1" }, "maestro");
    expect(h.service.get("req1").tasks.find((task) => task.ref === "T3")!.sprintId).toBe("S1");
    await h.service.moveTask("req1", "T3", { parent: "D1" }, "maestro");
    expect(h.service.get("req1").tasks.find((task) => task.ref === "T3")!.parent).toBe("D1");
    expect(h.service.sprintIdOf("req1", "sprint 2")).toBe("S2");
    expect(() => h.service.sprintIdOf("req1", "S8")).toThrow(/does not exist/);
    const closed = await h.service.closeSprint("req1", "S1", "maestro");
    const sprint = closed.sprints!.find((candidate) => candidate.id === "S1")!;
    expect(sprint.status).toBe("fechando");
    expect(sprint.summary).toBeDefined();
    const card = h.items.find((item) => (item as { kind: string }).kind === "sprint")!;
    expect(card).toMatchObject({ status: "pendente", sprintId: "S1" });
    expect(sprint.forYouId).toBe(card.id);
    // não foi aprovada por ninguém: continua "fechando" e a seguinte ainda não abriu antes da data dela
    expect(sprint.summary!.decidedBy).toBeUndefined();
    await expect(h.service.closeSprint("req1", "S1", "maestro")).rejects.toThrow();
  });

  it("add_sprint e update_sprint do Maestro", async () => {
    const h = harness();
    await h.service.propose("req1", tree());
    const { sprintId } = await h.service.createSprint("req1", { name: "Sprint 3", goal: "Fim" }, "maestro");
    expect(sprintId).toBe("S3");
    expect(h.service.get("req1").sprints![2]).toMatchObject({ startAt: "2026-11-25T12:00:00.000Z", endAt: "2026-12-02T12:00:00.000Z" });
    const updated = await h.service.updateSprint("req1", "S3", { goal: null, endAt: "2026-12-05T12:00:00.000Z" }, "maestro");
    expect(updated.sprints![2]).toMatchObject({ endAt: "2026-12-05T12:00:00.000Z" });
    expect(updated.sprints![2]!.goal).toBeUndefined();
  });
});
