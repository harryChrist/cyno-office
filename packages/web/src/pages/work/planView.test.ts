import type { ForYouItem, Plan, PlanTask } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { detectHandoffs, groupByRequest, waitingLabel, waitingOnUser } from "./planView";

const AT = "2026-11-08T12:00:00.000Z";

const task = (ref: string, extra: Partial<PlanTask> = {}): PlanTask => ({
  ref,
  title: `Tarefa ${ref}`,
  briefing: "b",
  ownerId: "ana",
  steps: [{ agentId: "ana", what: "x", status: "pendente" }],
  current: 0,
  dependsOn: [],
  priority: "normal",
  doneWhen: [],
  rework: { count: 0 },
  status: "a_fazer",
  updatedAt: AT,
  ...extra,
});

const plan = (tasks: PlanTask[], extra: Partial<Plan> = {}): Plan => ({ id: "r1", kind: "projeto", origin: "maestro", priority: "normal", mode: { kind: "pede-ok" }, worked: {}, forYouId: "A-0001", approvedAt: AT, title: "Campanha", status: "ativo", version: 1, tasks, createdAt: AT, updatedAt: AT, ...extra });

const item = (id: string, extra: Partial<ForYouItem> = {}): ForYouItem => ({
  id,
  agentId: "maestro",
  roomId: "sala",
  type: "outro",
  status: "pendente",
  meta: {},
  text: "t",
  originalText: "t",
  editedByUser: false,
  createdAt: AT,
  ...extra,
});

describe("planView", () => {
  it("agrupa o Para você por pedido (Outros no fim) com o que espera você", () => {
    const plans = [plan([task("T1", { status: "esperando_voce" }), task("T2", { status: "esperando_voce" }), task("T3")])];
    const items = [item("A-0001"), item("A-0002", { projectId: "r1", taskRef: "T1" }), item("A-0003", { projectId: "r1", kind: "questionario" }), item("A-0004", { projectId: "r2" })];
    const tasks = [
      { id: "r1", prompt: "Campanha de lançamento\n\nbriefing" },
      { id: "r2", prompt: "Outro pedido" },
    ];
    const groups = groupByRequest(items, tasks, plans);
    expect(groups.map((group) => [group.title, group.items.map((candidate) => candidate.id)])).toEqual([
      ["Campanha de lançamento", ["A-0002", "A-0003"]],
      ["Outro pedido", ["A-0004"]],
      ["Outros", ["A-0001"]],
    ]);
    expect(groups[0]!.waiting).toEqual({ tasks: 2, items: 1 });
    expect(waitingLabel(groups[0]!.waiting)).toBe("2 tarefas esperando você · 1 pendência do pedido");
    expect(waitingLabel(waitingOnUser("r9", plans, items))).toBe("");
  });

  it("passagem de etapa: a etapa k terminou e a atual é de outro agente", () => {
    const before = plan([
      task("T1", { status: "em_andamento", steps: [{ agentId: "ana", what: "a", status: "em_andamento" }, { agentId: "beto", what: "b", status: "pendente" }] }),
      task("T2", { status: "em_andamento", steps: [{ agentId: "ana", what: "a", status: "em_andamento" }, { agentId: "ana", what: "b", status: "pendente" }] }),
    ]);
    const after = plan([
      task("T1", { status: "em_andamento", current: 1, steps: [{ agentId: "ana", what: "a", status: "feita" }, { agentId: "beto", what: "b", status: "pendente" }] }),
      task("T2", { status: "em_andamento", current: 1, steps: [{ agentId: "ana", what: "a", status: "feita" }, { agentId: "ana", what: "b", status: "pendente" }] }),
    ]);
    expect(detectHandoffs(before, after)).toEqual([{ planId: "r1", ref: "T1", title: "Tarefa T1", fromAgentId: "ana", toAgentId: "beto" }]);
    expect(detectHandoffs(undefined, after)).toEqual([]);
    expect(detectHandoffs(after, after)).toEqual([]);
  });
});
