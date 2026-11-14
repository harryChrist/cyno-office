import { projectDefaults, type Project, type ProjectTask } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { buildTreeRows, queuePositions, type TreeNodeRow, type TreeStepRow } from "./taskTreeView";

const AT = "2026-11-10T12:00:00.000Z";
const NOW = Date.parse("2026-11-10T15:00:00.000Z");
const NAMES: Record<string, string> = { sonia: "Sônia", davi: "Davi", hugo: "Hugo", ana: "Ana" };
const agentName = (id: string) => NAMES[id] ?? id;

const task = (ref: string, extra: Partial<ProjectTask> = {}): ProjectTask => {
  const owner = extra.ownerId ?? "sonia";
  return { ref, title: `Tarefa ${ref}`, briefing: "b", ownerId: owner, steps: [{ agentId: owner, what: "fazer", status: "pendente" }], current: 0, dependsOn: [], priority: "normal", doneWhen: [], rework: { count: 0 }, status: "a_fazer", updatedAt: AT, ...extra };
};
const mother = (ref: string, extra: Partial<ProjectTask> = {}) => task(ref, { steps: [], ownerId: "", status: "backlog", ...extra });
const project = (tasks: ProjectTask[]): Project => ({ ...projectDefaults(), id: "p", title: "Projeto", status: "ativo", version: 1, tasks, labels: [], sprints: [], createdAt: AT, updatedAt: AT });
const rowsOf = (p: Project, closed = new Set<string>()) => buildTreeRows(p, closed, { now: NOW, agentName });
const nodes = (p: Project) => rowsOf(p).filter((row): row is TreeNodeRow => row.kind === "node");

/** Postagem: pesquisa (Sônia) > texto (Davi) > revisão (Hugo); a conferência (Ana) espera a revisão. */
const postagem = (over: Record<string, Partial<ProjectTask>> = {}) =>
  project([
    mother("P", { title: "Criar a postagem" }),
    task("a", { parent: "P", title: "Pesquisar", ownerId: "sonia", ...over.a }),
    task("b", { parent: "P", title: "Criar os textos", ownerId: "davi", dependsOn: ["a"], status: "backlog", ...over.b }),
    task("c", { parent: "P", title: "Revisar", ownerId: "hugo", dependsOn: ["b"], status: "backlog", ...over.c }),
    task("d", { parent: "P", title: "Conferir", ownerId: "ana", dependsOn: ["c"], status: "backlog", ...over.d }),
  ]);

describe("árvore: quem faz, o quê e quem espera quem", () => {
  it("cada subtarefa mostra o responsável e, parada por dependência, de quem espera em palavras", () => {
    const rows = nodes(postagem());
    const flow = (ref: string) => rows.find((row) => row.ref === ref)!.flow!;
    expect(flow("a")).toMatchObject({ kind: "subtask", ownerId: "sonia", ownerName: "Sônia", text: "pronta para começar" });
    expect(flow("b")).toMatchObject({ ownerName: "Davi", text: "espera a Sônia terminar “Pesquisar”" });
    expect(flow("c").text).toBe("espera o Davi terminar “Criar os textos”");
  });

  it("rodando, entregue e fila do próprio agente", () => {
    const running = nodes(postagem({ a: { status: "em_andamento" } }));
    expect(running.find((row) => row.ref === "a")!.flow!.text).toBe("fazendo agora");
    const done = nodes(postagem({ a: { status: "concluida", result: "x" }, b: { status: "a_fazer" } }));
    expect(done.find((row) => row.ref === "a")!.flow!.text).toBe("entregou");
    expect(done.find((row) => row.ref === "b")!.flow!.text).toBe("pronta para começar");
    // Davi já faz outra coisa na mesma tarefa: a próxima dele entra na fila (1ª).
    const busy = project([mother("P"), task("a", { parent: "P", ownerId: "davi", status: "em_andamento" }), task("b", { parent: "P", ownerId: "davi", status: "a_fazer", waitingSince: AT }), task("c", { parent: "P", ownerId: "davi", status: "a_fazer", waitingSince: "2026-11-10T13:00:00.000Z" })]);
    expect([...queuePositions(busy)]).toEqual([["b", 1], ["c", 2]]);
    expect(nodes(busy).find((row) => row.ref === "c")!.flow!.text).toBe("na fila do Davi (2ª)");
  });

  it("a tarefa-mãe traz todos os responsáveis (sem corte) e o resumo", () => {
    const rows = nodes(postagem({ a: { status: "concluida", result: "x" }, b: { status: "em_andamento" } }));
    const p = rows.find((row) => row.ref === "P")!;
    expect(p.flow).toMatchObject({ kind: "mother", summary: "1 de 4 prontas · agora: Davi", everyone: ["sonia", "davi", "hugo", "ana"] });
    expect(p.progress).toEqual({ done: 1, total: 4 });
    const idle = nodes(postagem()).find((row) => row.ref === "P")!;
    expect(idle.flow!.summary).toBe("0 de 4 prontas");
  });

  it("várias dependências: espera os nomes; folha solta sem dependência não ganha linha de fluxo", () => {
    const p = project([mother("P"), task("a", { parent: "P", ownerId: "sonia" }), task("b", { parent: "P", ownerId: "davi" }), task("c", { parent: "P", ownerId: "hugo", dependsOn: ["a", "b"], status: "backlog" }), task("solta")]);
    const rows = nodes(p);
    expect(rows.find((row) => row.ref === "c")!.flow!.text).toBe("espera Sônia e Davi");
    expect(rows.find((row) => row.ref === "solta")!.flow).toBeUndefined();
  });
});

describe("árvore: tarefas antigas com steps", () => {
  const legacy = () =>
    project([
      task("L", {
        title: "Post antigo",
        ownerId: "sonia",
        status: "em_andamento",
        current: 1,
        steps: [
          { agentId: "sonia", what: "Escrever", status: "feita", result: "texto" },
          { agentId: "davi", what: "Revisar", status: "em_andamento" },
          { agentId: "hugo", what: "Postar", status: "pendente" },
        ],
      }),
    ]);

  it("cada passo vira uma linha filha de leitura, com o agente e o que espera", () => {
    const rows = rowsOf(legacy());
    expect(rows.map((row) => row.key)).toEqual(["L", "step:L:0", "step:L:1", "step:L:2"]);
    const steps = rows.filter((row): row is TreeStepRow => row.kind === "step");
    expect(steps.map((step) => [step.status, step.text, step.depth])).toEqual([
      ["concluida", "entregou", 2],
      ["em_andamento", "fazendo agora", 2],
      ["backlog", "espera o Davi terminar o passo 2", 2],
    ]);
    expect(nodes(legacy())[0]).toMatchObject({ stepCount: 3 });
  });

  it("fecha com a seta (closed) e uma tarefa de um passo só não ganha linhas de passo", () => {
    expect(rowsOf(legacy(), new Set(["L"])).map((row) => row.key)).toEqual(["L"]);
    expect(rowsOf(project([task("U")])).map((row) => row.key)).toEqual(["U"]);
  });
});
