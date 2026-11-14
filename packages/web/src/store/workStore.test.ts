import type { Plan, PlanTask } from "@cyno/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { useWorkStore } from "./workStore";

const AT = "2026-11-08T12:00:00.000Z";
const step = (agentId: string, status: "pendente" | "em_andamento" | "feita") => ({ agentId, what: "x", status });
const task = (current: number, steps: PlanTask["steps"]): PlanTask => ({ ref: "T1", title: "Texto", briefing: "b", ownerId: "ana", steps, current, dependsOn: [], priority: "normal", doneWhen: [], rework: { count: 0 }, status: "em_andamento", updatedAt: AT });
const plan = (tasks: PlanTask[]): Plan => ({ id: "r1", kind: "projeto", origin: "maestro", priority: "normal", mode: { kind: "pede-ok" }, worked: {}, forYouId: "A-0001", approvedAt: AT, title: "Campanha", status: "ativo", version: 1, tasks, createdAt: AT, updatedAt: AT });

describe("workStore", () => {
  beforeEach(() => useWorkStore.getState().reset());

  it("snapshot preenche; project:upserted troca e marca a passagem de etapa; project:deleted tira; reset esquece", () => {
    const store = useWorkStore.getState();
    store.apply({ type: "office:snapshot", office: { rooms: [], teams: [], agents: [], tasks: [] }, projects: [plan([task(0, [step("ana", "em_andamento"), step("beto", "pendente")])])] });
    expect(useWorkStore.getState().plans).toHaveLength(1);
    store.apply({ type: "project:upserted", project: plan([task(1, [step("ana", "feita"), step("beto", "pendente")])]) });
    expect(useWorkStore.getState().plans[0]!.tasks[0]!.current).toBe(1);
    expect(useWorkStore.getState().handoffs).toMatchObject([{ ref: "T1", fromAgentId: "ana", toAgentId: "beto" }]);
    store.open("r1");
    expect(useWorkStore.getState().openProjectId).toBe("r1");
    store.apply({ type: "project:deleted", id: "r1" });
    expect(useWorkStore.getState().plans).toEqual([]);
    store.reset();
    expect(useWorkStore.getState()).toMatchObject({ plans: [], handoffs: [], openProjectId: null });
  });

  it("o projeto fixo Avulsas volta como um projeto kind tarefa por pedido (id do pedido); o servidor segue guardando as folhas", () => {
    const leaf = (ref: string, requestId: string, extra: Partial<PlanTask> = {}): PlanTask => ({ ...task(0, [step("ana", "pendente")]), ref, title: `Pedido ${requestId}`, status: "a_fazer", meta: { requestId, origin: "usuario" }, ...extra });
    const avulsas: Plan = { ...plan([leaf("A1", "r-a"), leaf("A2", "r-b", { status: "concluida", finishedAt: AT })]), id: "avulsas", kind: "tarefa", system: "avulsas", approvedAt: undefined, forYouId: undefined, title: "Avulsas" };
    const store = useWorkStore.getState();
    store.apply({ type: "office:snapshot", office: { rooms: [], teams: [], agents: [], tasks: [] }, projects: [plan([task(0, [step("ana", "em_andamento")])]), avulsas] });
    const ids = () => useWorkStore.getState().projects.map((project) => project.id);
    expect(ids()).toEqual(["r1", "r-a", "r-b"]);
    expect(useWorkStore.getState().projects.find((project) => project.id === "r-b")).toMatchObject({ kind: "tarefa", status: "concluido", tasks: [{ ref: "A2" }] });
    expect(useWorkStore.getState().plans.map((candidate) => candidate.id)).toEqual(["r1"]);
    // uma folha nova chega pelo evento do Avulsas
    store.apply({ type: "project:upserted", project: { ...avulsas, tasks: [...avulsas.tasks, leaf("A3", "r-c")] } });
    expect(ids()).toEqual(["r1", "r-a", "r-b", "r-c"]);
    expect(useWorkStore.getState().rawProjects.map((project) => project.id)).toEqual(["r1", "avulsas"]);
    // o casca de projeto de um pedido que virou folha sai pelo project:deleted
    store.apply({ type: "project:deleted", id: "r1" });
    expect(ids()).toEqual(["r-a", "r-b", "r-c"]);
  });
});
