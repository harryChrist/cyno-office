import { emptyAvulsas, projectDefaults, type Project, type ProjectTask, type Sprint } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { parseWorkRoute, projectTabsFor, resolveProjectTab, routeForProjectId, routeForTaskId, showSprintsTab, workSub } from "./workRoute";

const AT = "2026-11-10T12:00:00.000Z";
const leaf = (ref: string, requestId: string, taskId: string): ProjectTask => ({
  ref,
  title: ref,
  briefing: "",
  ownerId: "ana",
  steps: [{ agentId: "ana", what: "x", status: "pendente", taskId }],
  current: 0,
  dependsOn: [],
  priority: "normal",
  doneWhen: [],
  rework: { count: 0 },
  status: "a_fazer",
  updatedAt: AT,
  meta: { requestId, origin: "usuario" },
});
const project = (id: string, tasks: ProjectTask[] = []): Project => ({ ...projectDefaults(), id, title: id, status: "ativo", version: 1, tasks, createdAt: AT, updatedAt: AT });

describe("endereços de Projetos e tarefas", () => {
  it("lê a entrada, o projeto, a aba e a tarefa aberta (e volta ao mesmo texto)", () => {
    expect(parseWorkRoute("")).toEqual({ view: "home" });
    expect(parseWorkRoute("outra-coisa")).toEqual({ view: "home" });
    expect(parseWorkRoute("p/abc")).toEqual({ view: "project", projectId: "abc", tab: "tarefas" });
    expect(parseWorkRoute("p/abc/entregas")).toEqual({ view: "project", projectId: "abc", tab: "entregas" });
    expect(parseWorkRoute("p/abc/tarefas/T3")).toEqual({ view: "project", projectId: "abc", tab: "tarefas", ref: "T3" });
    expect(parseWorkRoute("p/abc/qualquer")).toEqual({ view: "project", projectId: "abc", tab: "tarefas" });
    for (const sub of ["", "p/abc", "p/abc/sprints", "p/abc/tarefas/T3", "p/abc/atividade/T1"]) expect(workSub(parseWorkRoute(sub))).toBe(sub);
  });

  it("o foco por id de projeto abre o projeto; por id de pedido simples, o Avulsas com a tarefa aberta", () => {
    const projects = [project("p1"), project("avulsas", [leaf("A1", "req-1", "t-1"), leaf("A2", "req-2", "t-2")])];
    expect(routeForProjectId("p1", projects)).toEqual({ view: "project", projectId: "p1", tab: "tarefas" });
    expect(routeForProjectId("req-2", projects)).toEqual({ view: "project", projectId: "avulsas", tab: "tarefas", ref: "A2" });
    expect(routeForProjectId("nao-existe", projects)).toBeNull();
    expect(routeForProjectId("avulsas", [emptyAvulsas(AT)])).toEqual({ view: "project", projectId: "avulsas", tab: "tarefas" });
  });

  it("o foco por Task acha a tarefa pela etapa", () => {
    const projects = [project("p1", [{ ...leaf("T1", "x", "w-9"), meta: undefined }]), project("avulsas", [leaf("A1", "req-1", "t-1")])];
    expect(routeForTaskId("w-9", projects)).toEqual({ view: "project", projectId: "p1", tab: "tarefas", ref: "T1" });
    expect(routeForTaskId("t-1", projects)).toEqual({ view: "project", projectId: "avulsas", tab: "tarefas", ref: "A1" });
    expect(routeForTaskId("req-1", projects)).toEqual({ view: "project", projectId: "avulsas", tab: "tarefas", ref: "A1" });
    expect(routeForTaskId("sumiu", projects)).toBeNull();
  });
});

describe("Todas as tarefas no endereço", () => {
  it("lê a aba, os filtros e o painel aberto", () => {
    expect(parseWorkRoute("tarefas")).toEqual({ view: "tasks", query: "" });
    expect(parseWorkRoute("tarefas?sprint=ativa&agente=eco")).toEqual({ view: "tasks", query: "sprint=ativa&agente=eco" });
    expect(parseWorkRoute("tarefas/p1/T3?estado=a_fazer")).toEqual({ view: "tasks", query: "estado=a_fazer", projectId: "p1", ref: "T3" });
  });

  it("escreve de volta o mesmo endereço", () => {
    for (const sub of ["tarefas", "tarefas?sprint=ativa", "tarefas/p1/T3", "tarefas/p1/T3?q=login"]) expect(workSub(parseWorkRoute(sub))).toBe(sub);
  });
});

describe("aba Sprints e rota tab=sprints", () => {
  const sprint: Sprint = { id: "S1", name: "Sprint 1", startAt: AT, endAt: AT, order: 1, status: "ativa" };
  const withoutSprints = project("p1");
  const withSprints = { ...project("p2"), sprints: [sprint] };

  it("só mostra a aba Sprints quando o projeto tem sprints", () => {
    expect(showSprintsTab(withoutSprints)).toBe(false);
    expect(showSprintsTab({ ...withoutSprints, sprints: [] })).toBe(false);
    expect(showSprintsTab(withSprints)).toBe(true);
    expect(projectTabsFor(withoutSprints)).toEqual(["tarefas", "entregas", "atividade"]);
    expect(projectTabsFor(withSprints)).toEqual(["tarefas", "sprints", "entregas", "atividade"]);
  });

  it("rota ?tab=sprints ou /sprints em projeto sem sprints cai em Tarefas", () => {
    expect(parseWorkRoute("p/p1?tab=sprints")).toEqual({ view: "project", projectId: "p1", tab: "sprints" });
    expect(parseWorkRoute("p/p1?tab=entregas")).toEqual({ view: "project", projectId: "p1", tab: "entregas" });
    expect(parseWorkRoute("p/p1?tab=desconhecida")).toEqual({ view: "project", projectId: "p1", tab: "tarefas" });
    const parsed = parseWorkRoute("p/p1?tab=sprints");
    expect(parsed.view).toBe("project");
    if (parsed.view === "project") {
      expect(resolveProjectTab(parsed.tab, withoutSprints)).toBe("tarefas");
      expect(resolveProjectTab(parsed.tab, withSprints)).toBe("sprints");
    }
    expect(resolveProjectTab("sprints", withoutSprints)).toBe("tarefas");
    expect(resolveProjectTab("entregas", withoutSprints)).toBe("entregas");
    expect(resolveProjectTab("atividade", withoutSprints)).toBe("atividade");
  });
});
