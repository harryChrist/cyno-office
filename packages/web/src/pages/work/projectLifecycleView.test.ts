import { emptyAvulsas, projectDefaults, PROJECT_STATUSES, type Project } from "@cyno/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { useWorkStore } from "../../store/workStore";
import { canCompleteProject, canReopenProject, COMPLETE_PROJECT_MESSAGE, COMPLETE_PROJECT_TITLE, isProjectEditable } from "./projectLifecycleView";
import { syncProjectResponse } from "./useTaskActions";

const AT = "2026-11-21T12:00:00.000Z";
const project = (status: Project["status"] = "ativo", extra: Partial<Project> = {}): Project => ({
  ...projectDefaults(),
  id: "p1",
  title: "Livro",
  status,
  version: 1,
  tasks: [],
  createdAt: AT,
  updatedAt: AT,
  ...extra,
});

describe("editable do projeto", () => {
  it("aceita edição em projetos abertos (menos ajustando) e também em concluido", () => {
    expect(isProjectEditable(project("ativo"))).toBe(true);
    expect(isProjectEditable(project("pausado"))).toBe(true);
    expect(isProjectEditable(project("proposto"))).toBe(true);
    expect(isProjectEditable(project("concluido"))).toBe(true);
  });

  it("continua só leitura quando ajustando ou cancelado", () => {
    expect(isProjectEditable(project("ajustando"))).toBe(false);
    expect(isProjectEditable(project("cancelado"))).toBe(false);
  });
});

describe("botões Concluir projeto e Reabrir projeto", () => {
  it("mostra Concluir só para projeto ativo ou pausado (nunca para o Avulsas)", () => {
    expect(canCompleteProject(project("ativo"))).toBe(true);
    expect(canCompleteProject(project("pausado"))).toBe(true);
    expect(canCompleteProject(project("proposto"))).toBe(false);
    expect(canCompleteProject(project("ajustando"))).toBe(false);
    expect(canCompleteProject(project("concluido"))).toBe(false);
    expect(canCompleteProject(project("cancelado"))).toBe(false);
    expect(canCompleteProject(emptyAvulsas(AT))).toBe(false);
    for (const status of PROJECT_STATUSES) {
      expect(canCompleteProject({ ...emptyAvulsas(AT), status })).toBe(false);
    }
  });

  it("mostra Reabrir só para projeto concluído ou cancelado (nunca para o Avulsas)", () => {
    expect(canReopenProject(project("concluido"))).toBe(true);
    expect(canReopenProject(project("cancelado"))).toBe(true);
    expect(canReopenProject(project("ativo"))).toBe(false);
    expect(canReopenProject(project("pausado"))).toBe(false);
    expect(canReopenProject(project("proposto"))).toBe(false);
    expect(canReopenProject(project("ajustando"))).toBe(false);
    expect(canReopenProject(emptyAvulsas(AT))).toBe(false);
    for (const status of PROJECT_STATUSES) {
      expect(canReopenProject({ ...emptyAvulsas(AT), status })).toBe(false);
    }
  });

  it("mantém a confirmação curta de concluir", () => {
    expect(COMPLETE_PROJECT_TITLE).toBe("Concluir projeto?");
    expect(COMPLETE_PROJECT_MESSAGE).toBe("Marcar como concluído? Você pode reabrir depois.");
  });
});

describe("syncProjectResponse atualiza o store sem recarregar", () => {
  beforeEach(() => {
    useWorkStore.getState().reset();
  });

  it("reflete conclusão e reabertura no store local na hora", () => {
    const initial = project("ativo");
    useWorkStore.getState().apply({ type: "project:upserted", project: initial });
    expect(useWorkStore.getState().rawProjects[0]?.status).toBe("ativo");

    syncProjectResponse({ project: { ...initial, status: "concluido" } });
    expect(useWorkStore.getState().rawProjects[0]?.status).toBe("concluido");

    syncProjectResponse({ project: { ...initial, status: "ativo" } });
    expect(useWorkStore.getState().rawProjects[0]?.status).toBe("ativo");
  });
});
