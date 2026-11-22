import { emptyAvulsas, projectDefaults, type Project, type ProjectTask } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import {
  canDeleteProject,
  canDeleteTaskNode,
  DELETE_NODE_ACTIVE_NOTE,
  deleteTaskNodeInfo,
  deleteTaskNodeSummary,
  deleteTaskNodeTitle,
  isActiveTaskStatus,
  projectTasksText,
  runningCount,
  runningNote,
} from "./projectDeleteView";

const AT = "2026-11-10T12:00:00.000Z";
const task = (ref: string, status: ProjectTask["status"] = "concluida", extra: Partial<ProjectTask> = {}): ProjectTask => ({
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
  ...extra,
});
const mod = (ref: string, title = `Módulo ${ref}`, extra: Partial<ProjectTask> = {}): ProjectTask => ({
  ...task(ref, "backlog", { title, group: true, ownerId: "", steps: [], ...extra }),
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

describe("apagar item (tarefa, subtarefa ou módulo)", () => {
  it("aparece para tarefa, subtarefa e módulo em projetos comuns editáveis (inclusive concluído)", () => {
    const active = project([]);
    expect(canDeleteTaskNode(active, task("T1", "a_fazer"))).toBe(true);
    expect(canDeleteTaskNode(active, task("T1", "em_andamento"))).toBe(true);
    expect(canDeleteTaskNode(active, task("T2", "backlog", { parent: "T1" }))).toBe(true);
    expect(canDeleteTaskNode(active, mod("M1"))).toBe(true);
    expect(canDeleteTaskNode(project([], "concluido"), task("T1", "concluida"))).toBe(true);
    expect(canDeleteTaskNode(project([], "pausado"), mod("M1"))).toBe(true);
    expect(canDeleteTaskNode(project([], "proposto"), task("T1", "backlog"))).toBe(true);
    // Não aparece para arquivado, ajustando ou cancelado.
    expect(canDeleteTaskNode(active, task("T1", "concluida", { archived: true }))).toBe(false);
    expect(canDeleteTaskNode(project([], "ajustando"), task("T1", "a_fazer"))).toBe(false);
    expect(canDeleteTaskNode(project([], "cancelado"), task("T1", "cancelada"))).toBe(false);
  });

  it("no Avulsas continua valendo só para folha terminada", () => {
    const avulsas = emptyAvulsas(AT);
    expect(canDeleteTaskNode(avulsas, task("A1", "concluida"))).toBe(true);
    expect(canDeleteTaskNode(avulsas, task("A1", "cancelada"))).toBe(true);
    expect(canDeleteTaskNode(avulsas, task("A1", "falhou"))).toBe(true);
    expect(canDeleteTaskNode(avulsas, task("A1", "a_fazer"))).toBe(false);
    expect(canDeleteTaskNode(avulsas, mod("M1"))).toBe(false);
  });

  it("identifica estados ativos que impedem apagar", () => {
    expect(isActiveTaskStatus("em_andamento")).toBe(true);
    expect(isActiveTaskStatus("esperando_voce")).toBe(true);
    expect(isActiveTaskStatus("backlog")).toBe(false);
    expect(isActiveTaskStatus("a_fazer")).toBe(false);
    expect(isActiveTaskStatus("concluida")).toBe(false);
    expect(isActiveTaskStatus("cancelada")).toBe(false);
    expect(isActiveTaskStatus("falhou")).toBe(false);
  });

  it("formata título e mensagem com singular e plural", () => {
    expect(deleteTaskNodeTitle("Capítulo 1")).toBe("Apagar “Capítulo 1”?");
    expect(deleteTaskNodeSummary(1)).toBe("Apaga este item (1 item). Isso não pode ser desfeito.");
    expect(deleteTaskNodeSummary(4)).toBe("Apaga este item e tudo que está dentro dele (4 itens). Isso não pode ser desfeito.");
  });

  it("conta toda a subárvore (módulo, submódulo, tarefa e subtarefa) sem bloquear quando nada está ativo", () => {
    const p = project([
      mod("M1", "Parte 1"),
      mod("M2", "Capítulos", { parent: "M1" }),
      task("T1", "concluida", { parent: "M2" }),
      task("T2", "a_fazer", { parent: "M2" }),
      task("T3", "backlog", { parent: "T2" }),
      task("OUT", "em_andamento"),
    ]);
    const info = deleteTaskNodeInfo(p, "M1");
    expect(info.refs).toEqual(["M1", "M2", "T1", "T2", "T3"]);
    expect(info.count).toBe(5);
    expect(info.activeCount).toBe(0);
    expect(info.blocked).toBe(false);
    expect(info.title).toBe("Apagar “Parte 1”?");
    expect(info.summary).toBe("Apaga este item e tudo que está dentro dele (5 itens). Isso não pode ser desfeito.");
    expect(info.note).toBeNull();
  });

  it("desabilita a confirmação quando o próprio item ou algum descendente está em andamento ou esperando você", () => {
    const runningTree = project([
      mod("M1", "Backend"),
      task("T1", "concluida", { parent: "M1" }),
      task("T2", "em_andamento", { parent: "M1" }),
    ]);
    const runningInfo = deleteTaskNodeInfo(runningTree, "M1");
    expect(runningInfo.count).toBe(3);
    expect(runningInfo.activeCount).toBe(1);
    expect(runningInfo.blocked).toBe(true);
    expect(runningInfo.note).toBe(DELETE_NODE_ACTIVE_NOTE);
    expect(runningInfo.note).toBe("Pare ou espere os itens em andamento antes de apagar.");

    const waitingTree = project([
      mod("M1", "Design"),
      mod("M2", "Telas", { parent: "M1" }),
      task("T1", "esperando_voce", { parent: "M2" }),
    ]);
    const waitingInfo = deleteTaskNodeInfo(waitingTree, "M1");
    expect(waitingInfo.count).toBe(3);
    expect(waitingInfo.activeCount).toBe(1);
    expect(waitingInfo.blocked).toBe(true);
    expect(waitingInfo.note).toBe("Pare ou espere os itens em andamento antes de apagar.");

    const leafRunning = deleteTaskNodeInfo(project([task("T1", "em_andamento", { title: "Revisão" })]), "T1");
    expect(leafRunning.count).toBe(1);
    expect(leafRunning.blocked).toBe(true);
    expect(leafRunning.title).toBe("Apagar “Revisão”?");
    expect(leafRunning.summary).toBe("Apaga este item (1 item). Isso não pode ser desfeito.");
    expect(leafRunning.note).toBe("Pare ou espere os itens em andamento antes de apagar.");
  });
});
