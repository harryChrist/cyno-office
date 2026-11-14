import { describe, expect, it } from "vitest";
import type { ProjectTask } from "./projects";
import { blockedLeaves, blockedText, deadDependencies, deliveryLeaves, finalLeaves, flowStatusOf, isBlockedLeaf, joinNames, pendencySummary, receivedBy, receiversOf, waitingText } from "./task-flow";

const at = "2026-11-11T12:00:00.000Z";
const NAMES: Record<string, string> = { sonia: "Sônia", davi: "Davi", hugo: "Hugo", ana: "Ana" };
const agentName = (id: string) => NAMES[id] ?? id;

function task(ref: string, extra: Partial<ProjectTask> = {}): ProjectTask {
  const owner = extra.ownerId ?? "sonia";
  return {
    ref,
    title: `Tarefa ${ref}`,
    briefing: "faça",
    ownerId: owner,
    steps: extra.group ? [] : [{ agentId: owner, what: "faz", status: "pendente" }],
    current: 0,
    dependsOn: [],
    priority: "normal",
    doneWhen: [],
    status: "a_fazer",
    rework: { count: 0 },
    updatedAt: at,
    ...extra,
  };
}

/** Mãe P com a cadeia pesquisa > texto > revisão e, depois da revisão, imagem; a conferência espera as duas. */
const chain = (over: Record<string, Partial<ProjectTask>> = {}) => ({
  tasks: [
    task("P", { ownerId: "" }),
    task("a", { parent: "P", title: "Pesquisar", ownerId: "sonia", ...over.a }),
    task("b", { parent: "P", title: "Criar os textos", ownerId: "davi", dependsOn: ["a"], status: "backlog", ...over.b }),
    task("c", { parent: "P", title: "Revisar", ownerId: "hugo", dependsOn: ["b"], status: "backlog", ...over.c }),
    task("d", { parent: "P", title: "Criar a imagem", ownerId: "ana", dependsOn: ["c"], status: "backlog", ...over.d }),
    task("e", { parent: "P", title: "Conferir tudo", ownerId: "sonia", dependsOn: ["c", "d"], status: "backlog", ...over.e }),
  ],
});

describe("passagem de bastão entre subtarefas", () => {
  it("a folha final da mãe é a conferência; em paralelo, são todas as pontas", () => {
    expect(finalLeaves(chain(), "P").map((leaf) => leaf.ref)).toEqual(["e"]);
    const parallel = { tasks: [task("P"), task("x", { parent: "P" }), task("y", { parent: "P" })] };
    expect(finalLeaves(parallel, "P").map((leaf) => leaf.ref)).toEqual(["x", "y"]);
    expect(finalLeaves(parallel, "x").map((leaf) => leaf.ref)).toEqual(["x"]);
  });

  it("a entrega da mãe é a da última subtarefa (só se concluiu e entregou); em paralelo, o conjunto", () => {
    expect(deliveryLeaves(chain(), "P")).toEqual([]);
    const done = chain({ e: { status: "concluida", result: "Tudo conferido." } });
    expect(deliveryLeaves(done, "P").map((leaf) => leaf.result)).toEqual(["Tudo conferido."]);
    const parallel = { tasks: [task("P"), task("x", { parent: "P", status: "concluida", result: "X" }), task("y", { parent: "P", status: "concluida", result: "Y" })] };
    expect(deliveryLeaves(parallel, "P").map((leaf) => leaf.result)).toEqual(["X", "Y"]);
    expect(deliveryLeaves(parallel, "nao-existe")).toEqual([]);
  });

  it("o que a subtarefa recebe: a entrega de cada dependência, a de uma mãe é a das folhas finais; sem repetir", () => {
    const project = chain({ a: { status: "concluida", result: "Fontes" }, b: { status: "concluida", result: "Texto" }, c: { status: "concluida", result: "Revisado" }, d: { status: "concluida", result: "Imagem" } });
    expect(receivedBy(project, project.tasks.find((t) => t.ref === "e")!).map((leaf) => leaf.result)).toEqual(["Revisado", "Imagem"]);
    const after = { tasks: [...project.tasks.map((t) => (t.ref === "e" ? { ...t, status: "concluida" as const, result: "Ok" } : t)), task("N", { dependsOn: ["P", "e"], status: "backlog" })] };
    expect(receivedBy(after, after.tasks.at(-1)!).map((leaf) => leaf.ref)).toEqual(["e"]);
  });

  it("quem recebe a entrega: as que dependem dela, ou da mãe de que ela é a final; mãe que depende recebe nas subtarefas de entrada", () => {
    const project = chain();
    expect(receiversOf(project, "a").map((leaf) => leaf.ref)).toEqual(["b"]);
    expect(receiversOf(project, "c").map((leaf) => leaf.ref)).toEqual(["d", "e"]);
    expect(receiversOf(project, "e")).toEqual([]);
    const next = { tasks: [...project.tasks, task("Q", { ownerId: "" }), task("q1", { parent: "Q", dependsOn: ["P"], ownerId: "hugo" }), task("q2", { parent: "Q", dependsOn: ["q1"], ownerId: "ana" })] };
    expect(receiversOf(next, "e").map((leaf) => leaf.ref)).toEqual(["q1"]);
    expect(receiversOf(next, "d").map((leaf) => leaf.ref)).toEqual(["e"]);
  });
});

describe("waitingText: o que a subtarefa espera, em palavras", () => {
  const text = (project: ReturnType<typeof chain>, ref: string, queuePosition?: number) => waitingText({ task: project.tasks.find((t) => t.ref === ref)!, project, agentName, ...(queuePosition ? { queuePosition } : {}) });

  it("uma dependência: espera quem e o quê", () => {
    expect(text(chain(), "b")).toBe("espera a Sônia terminar “Pesquisar”");
  });

  it("várias dependências: espera os nomes (sem repetir)", () => {
    expect(text(chain(), "e")).toBe("espera Hugo e Ana");
    const same = chain({ d: { ownerId: "hugo" } });
    expect(text(same, "e")).toBe("espera Hugo");
  });

  it("dependência já concluída não entra", () => {
    const project = chain({ a: { status: "concluida", result: "x" }, b: { status: "concluida", result: "y" }, c: { status: "concluida", result: "z" }, d: { status: "em_andamento" } });
    expect(text(project, "e")).toBe("espera a Ana terminar “Criar a imagem”");
    const free = chain({ a: { status: "concluida", result: "x" }, b: { status: "a_fazer" } });
    expect(text(free, "b")).toBe("pronta para começar");
  });

  it("na fila do próprio agente (com a posição) e rodando", () => {
    const project = chain({ a: { status: "concluida", result: "x" }, b: { status: "a_fazer" } });
    expect(text(project, "b", 2)).toBe("na fila do Davi (2ª)");
    expect(text(chain({ a: { ownerId: "ana", status: "a_fazer" } }), "a", 1)).toBe("na fila da Ana (1ª)");
    expect(text(chain({ a: { status: "em_andamento" } }), "a")).toBe("fazendo agora");
    expect(text(chain({ a: { status: "esperando_voce" } }), "a")).toBe("esperando você");
  });

  it("concluída, cancelada e falhou não esperam nada; dependência numa mãe espera as folhas que faltam", () => {
    expect(text(chain({ a: { status: "concluida" } }), "a")).toBeNull();
    expect(text(chain({ a: { status: "cancelada" } }), "a")).toBeNull();
    expect(text(chain({ a: { status: "falhou" } }), "a")).toBeNull();
    const project = { tasks: [...chain().tasks, task("Z", { ownerId: "davi", dependsOn: ["P"], status: "backlog" })] };
    expect(waitingText({ task: project.tasks.at(-1)!, project, agentName })).toBe("espera Sônia, Davi, Hugo e Ana");
  });

  it("joinNames", () => {
    expect([joinNames([]), joinNames(["A"]), joinNames(["A", "B"]), joinNames(["A", "B", "C"])]).toEqual(["", "A", "A e B", "A, B e C"]);
  });
});

describe("dependência cancelada ou que falhou: a dependente fica travada (revisão 2, M5)", () => {
  const dead = (status: "cancelada" | "falhou") => chain({ a: { status: "concluida" }, b: { status } });
  const wait = (project: ReturnType<typeof chain>, ref: string) => waitingText({ task: project.tasks.find((candidate) => candidate.ref === ref)!, project, agentName });

  it("o texto diz quem foi cancelada ou falhou, em vez de 'espera X terminar'", () => {
    expect(wait(dead("cancelada"), "c")).toBe("travada: “Criar os textos” foi cancelada");
    expect(wait(dead("falhou"), "c")).toBe("travada: “Criar os textos” falhou");
    // Sem dependência morta o texto de sempre.
    expect(wait(chain({ a: { status: "concluida" }, b: { status: "em_andamento" } }), "c")).toBe("espera o Davi terminar “Criar os textos”");
  });

  it("a folha travada conta como esperando você na tela; o estado gravado não muda, e a mãe sobe junto", () => {
    const project = dead("cancelada");
    const c = project.tasks.find((candidate) => candidate.ref === "c")!;
    expect(isBlockedLeaf(project, c)).toBe(true);
    expect(c.status).toBe("backlog");
    expect(flowStatusOf(project, c)).toBe("esperando_voce");
    expect(flowStatusOf(project, project.tasks[0]!)).toBe("esperando_voce");
    expect(blockedLeaves(project).map((leaf) => leaf.ref)).toEqual(["c"]);
    expect(blockedText(project, c)).toBe("travada: “Criar os textos” foi cancelada");
    // Quem espera só a travada (d e e) também fica travada? Não: a dependência dela (c) não está cancelada, só parada.
    expect(isBlockedLeaf(project, project.tasks.find((candidate) => candidate.ref === "d")!)).toBe(false);
  });

  it("tirar a dependência ou refazer a que falhou destrava", () => {
    const project = dead("falhou");
    const c = project.tasks.find((candidate) => candidate.ref === "c")!;
    c.dependsOn = [];
    expect(isBlockedLeaf(project, c)).toBe(false);
    const redone = dead("falhou");
    redone.tasks.find((candidate) => candidate.ref === "b")!.status = "a_fazer";
    expect(deadDependencies(redone, redone.tasks.find((candidate) => candidate.ref === "c")!)).toEqual([]);
  });

  it("dependência numa mãe cancelada trava a folha de entrada de quem espera a mãe", () => {
    const project = {
      tasks: [task("M", { ownerId: "" }), task("m1", { parent: "M", status: "cancelada" }), task("m2", { parent: "M", status: "cancelada" }), task("z", { dependsOn: ["M"], status: "backlog" })],
    };
    expect(deadDependencies(project, project.tasks[3]!).map((leaf) => leaf.ref)).toEqual(["m1", "m2"]);
    expect(wait(project as never, "z")).toBe("travada: “Tarefa m1” foi cancelada (e mais 1)");
  });

  it("o resumo da mãe com pendência conta prontas, canceladas, falhas e travadas", () => {
    const project = chain({ a: { status: "concluida" }, b: { status: "cancelada" }, c: { status: "backlog" }, d: { status: "falhou" } });
    const summary = pendencySummary(project, project.tasks[0]!);
    expect(summary).toMatchObject({ done: 1, total: 5, cancelled: 1, failed: 1, blocked: 2 });
    expect(summary?.text).toBe("1 de 5 pronta · 1 cancelada · 1 falhou · 2 travadas");
    expect(pendencySummary(chain({ a: { status: "concluida" } }), chain().tasks[0]!)).toBeUndefined();
    const three = chain({ a: { status: "concluida" }, b: { status: "concluida" }, c: { status: "concluida" }, d: { status: "cancelada" } });
    expect(pendencySummary(three, three.tasks[0]!)?.text).toBe("3 de 5 prontas · 1 cancelada · 1 travada");
  });

  it("a mãe com uma subtarefa cancelada não conclui sozinha: fica com pendência", () => {
    const project = chain({ a: { status: "concluida" }, b: { status: "concluida" }, c: { status: "concluida" }, d: { status: "concluida" }, e: { status: "cancelada" } });
    expect(flowStatusOf(project, project.tasks[0]!)).toBe("esperando_voce");
    const clean = chain({ a: { status: "concluida" }, b: { status: "concluida" }, c: { status: "concluida" }, d: { status: "concluida" }, e: { status: "concluida" } });
    expect(flowStatusOf(clean, clean.tasks[0]!)).toBe("concluida");
  });
});
