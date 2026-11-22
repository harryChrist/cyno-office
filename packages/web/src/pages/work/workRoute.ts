import { AVULSAS_ID, hasSprints, leafRequestId, type Project } from "@cyno/shared";

/**
 * Endereços de "Projetos e tarefas" (o que vem depois de `#/<ws>/trabalho`):
 *   ``                              a entrada (só os projetos)
 *   `p/<id>`                        a tela do projeto, aba Tarefas
 *   `p/<id>/<aba>`                  uma aba (tarefas, sprints, entregas, atividade)
 *   `p/<id>/<aba>/<ref>`            com o painel de uma tarefa aberto
 *   `tarefas[?filtros]`             "Todas as tarefas" (os filtros ficam no endereço)
 *   `tarefas/<id>/<ref>[?filtros]`  com o painel de uma tarefa aberto
 * O voltar do navegador fecha o painel, depois a aba, depois o projeto.
 */
export const PROJECT_TABS = ["tarefas", "sprints", "entregas", "atividade"] as const;
export type ProjectTab = (typeof PROJECT_TABS)[number];

export const PROJECT_TAB_LABELS: Record<ProjectTab, string> = { tarefas: "Tarefas", sprints: "Sprints", entregas: "Entregas", atividade: "Atividade" };

export type WorkRoute =
  | { view: "home" }
  | { view: "project"; projectId: string; tab: ProjectTab; ref?: string }
  /** "Todas as tarefas": `query` são os filtros (`sprint=ativa&agente=eco`); `projectId`+`ref` = o painel de uma tarefa aberto. */
  | { view: "tasks"; query: string; projectId?: string; ref?: string };

const decode = (part: string): string => {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
};

const isTab = (value: string): value is ProjectTab => (PROJECT_TABS as readonly string[]).includes(value);

/** A aba Sprints só aparece quando o projeto já tem sprints. */
export function showSprintsTab(project: Pick<Project, "sprints">): boolean {
  return hasSprints(project);
}

/** Abas visíveis de um projeto: sem sprints, a aba Sprints some. */
export function projectTabsFor(project: Pick<Project, "sprints">): ProjectTab[] {
  return showSprintsTab(project) ? [...PROJECT_TABS] : PROJECT_TABS.filter((id) => id !== "sprints");
}

/** Aba efetiva do projeto: um endereço pedindo `sprints` em projeto sem sprints cai em "Tarefas". */
export function resolveProjectTab(tab: ProjectTab, project: Pick<Project, "sprints">): ProjectTab {
  return tab === "sprints" && !showSprintsTab(project) ? "tarefas" : tab;
}

/** Lê o `sub` do navStore. Endereço que não é de projeto = a entrada. Aceita `p/<id>/<aba>` e `p/<id>?tab=<aba>`. */
export function parseWorkRoute(sub: string): WorkRoute {
  const cut = sub.indexOf("?");
  const query = cut >= 0 ? sub.slice(cut + 1) : "";
  const parts = (cut >= 0 ? sub.slice(0, cut) : sub).split("/").filter(Boolean).map(decode);
  if (parts[0] === "tarefas") return { view: "tasks", query, ...(parts[1] && parts[2] ? { projectId: parts[1], ref: parts[2] } : {}) };
  if (parts[0] !== "p" || !parts[1]) return { view: "home" };
  const queryTab = query ? new URLSearchParams(query).get("tab") : null;
  const rawTab = parts[2] ?? queryTab ?? "";
  const tab = isTab(rawTab) ? rawTab : "tarefas";
  const ref = parts[3];
  return { view: "project", projectId: parts[1], tab, ...(ref ? { ref } : {}) };
}

/** O `sub` do endereço para um destino. */
export function workSub(route: WorkRoute): string {
  if (route.view === "home") return "";
  if (route.view === "tasks") {
    const path = route.projectId && route.ref ? `tarefas/${encodeURIComponent(route.projectId)}/${encodeURIComponent(route.ref)}` : "tarefas";
    return route.query ? `${path}?${route.query}` : path;
  }
  const base = `p/${encodeURIComponent(route.projectId)}`;
  if (route.ref) return `${base}/${route.tab}/${encodeURIComponent(route.ref)}`;
  return route.tab === "tarefas" ? base : `${base}/${route.tab}`;
}

/**
 * Para onde leva o foco por `projectId` (Para você, Cyno, Hoje): o próprio projeto ou, se o id é o de um
 * pedido simples (que virou folha do Avulsas), o Avulsas com a tarefa aberta. Projeto que ainda não chegou = null.
 */
export function routeForProjectId(projectId: string, projects: readonly Project[]): WorkRoute | null {
  if (projects.some((project) => project.id === projectId)) return { view: "project", projectId, tab: "tarefas" };
  const avulsas = projects.find((project) => project.id === AVULSAS_ID);
  const leaf = avulsas?.tasks.find((task) => leafRequestId(task) === projectId);
  return leaf ? { view: "project", projectId: AVULSAS_ID, tab: "tarefas", ref: leaf.ref } : null;
}

/** Para onde leva o foco por Task do runner (a etapa de alguma tarefa, ou o próprio pedido do Maestro). Sem projeto = null. */
export function routeForTaskId(taskId: string, projects: readonly Project[]): WorkRoute | null {
  for (const project of projects) {
    const task = project.tasks.find((candidate) => candidate.steps.some((step) => step.taskId === taskId));
    if (task) return { view: "project", projectId: project.id, tab: "tarefas", ref: task.ref };
  }
  return routeForProjectId(taskId, projects);
}
