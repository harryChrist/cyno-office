import { emptyAvulsas, projectDefaults, type Project, type ProjectTask } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { canDeleteProject, projectTasksText, runningCount, runningNote } from "./projectDeleteView";

const AT = "2026-11-10T12:00:00.000Z";
const task = (ref: string, status: ProjectTask["status"] = "concluida"): ProjectTask => ({
  ref,
  title: `Tarefa ${ref}`,
  briefing: "b",
  ownerId: "ana",
  steps: [{ agentId: "ana", what: "fazer", status: "pendente" }],
  current: 0,
  dependsOn: [],
  priority: "normal",
  doneWhen: [],
  rework: { count: 0 },
  status,
  updatedAt: AT,
});
const project = (tasks: ProjectTask[], status: Project["status"] = "ativo"): Project => ({ ...projectDefaults(), id: "p1", title: "Campanha", status, version: 1, tasks, createdAt: AT, updatedAt: AT });

describe("apagar projeto", () => {
  it("existe para projeto comum (aberto ou terminado) e nunca para o Avulsas", () => {
    expect(canDeleteProject(project([]))).toBe(true);
    expect(canDeleteProject(project([], "concluido"))).toBe(true);
    expect(canDeleteProject(project([], "cancelado"))).toBe(true);
    expect(canDeleteProject(emptyAvulsas(AT))).toBe(false);
  });

  it("conta as tarefas no singular e no plural", () => {
    expect(projectTasksText(project([]))).toBe("nenhuma tarefa");
    expect(projectTasksText(project([task("T1")]))).toBe("1 tarefa");
    expect(projectTasksText(project([task("T1"), task("T2"), task("T3")]))).toBe("3 tarefas");
  });

  it("avisa de tarefa rodando; sem rodando, sem aviso", () => {
    expect(runningCount(project([task("T1"), task("T2", "em_andamento")]))).toBe(1);
    expect(runningNote(project([task("T1")]))).toBeNull();
    expect(runningNote(project([task("T1", "em_andamento")]))).toBe("Uma tarefa está rodando agora. Cancele ou espere ela terminar antes de apagar.");
    expect(runningNote(project([task("T1", "em_andamento"), task("T2", "em_andamento")]))).toBe("2 tarefas estão rodando agora. Cancele ou espere elas terminarem antes de apagar.");
  });
});
