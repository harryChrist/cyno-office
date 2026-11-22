import { isAvulsas, subtreeRefs, type Project, type ProjectTask, type ProjectTaskStatus } from "@cyno/shared";
import { canDeleteAvulsaTask } from "./avulsasCleanupView";
import { isProjectEditable } from "./projectLifecycleView";

/**
 * Lógica pura de "Apagar projeto" e "Apagar item" (tarefa, subtarefa ou módulo): quem pode apagar,
 * contagem da subárvore (`subtreeRefs`), mensagens do diálogo e bloqueio quando há algo em andamento
 * ou esperando você. O servidor valida o mesmo (409 em pt-BR).
 */

/** O botão "Apagar projeto" existe em todo projeto comum (aberto ou terminado), nunca no Avulsas. */
export function canDeleteProject(project: Pick<Project, "system">): boolean {
  return !isAvulsas(project);
}

/** Quantas tarefas o projeto tem, no texto do diálogo ("3 tarefas", "1 tarefa", "nenhuma tarefa"). */
export function projectTasksText(project: Pick<Project, "tasks">): string {
  const count = project.tasks.length;
  if (count === 0) return "nenhuma tarefa";
  return count === 1 ? "1 tarefa" : `${count} tarefas`;
}

/** Quantas tarefas estão rodando agora (o servidor não apaga assim). */
export function runningCount(project: Pick<Project, "tasks">): number {
  return project.tasks.filter((task) => task.status === "em_andamento").length;
}

/** O aviso extra quando há tarefa rodando; null quando não há. */
export function runningNote(project: Pick<Project, "tasks">): string | null {
  const running = runningCount(project);
  if (running === 0) return null;
  return running === 1 ? "Uma tarefa está rodando agora. Cancele ou espere ela terminar antes de apagar." : `${running} tarefas estão rodando agora. Cancele ou espere elas terminarem antes de apagar.`;
}

// ---------- Apagar item (tarefa, subtarefa ou módulo) ----------

export const DELETE_NODE_ACTIVE_NOTE = "Pare ou espere os itens em andamento antes de apagar.";

/** O item está ativo (rodando ou esperando você) e impede apagar a subárvore. */
export function isActiveTaskStatus(status: ProjectTaskStatus): boolean {
  return status === "em_andamento" || status === "esperando_voce";
}

/**
 * Quando o item mostra "Apagar" no menu da linha e no painel:
 * - no Avulsas, só folha terminada (regra de `canDeleteAvulsaTask`);
 * - nos outros projetos, qualquer tarefa, subtarefa ou módulo não arquivado enquanto o projeto é editável.
 */
export function canDeleteTaskNode(project: Pick<Project, "status" | "system">, task: Pick<ProjectTask, "status" | "archived" | "group">): boolean {
  if (isAvulsas(project)) return canDeleteAvulsaTask(project, task);
  return !task.archived && isProjectEditable(project);
}

/** Título do diálogo de apagar item ("Apagar «nome»?"). */
export function deleteTaskNodeTitle(title: string): string {
  return `Apagar “${title}”?`;
}

/** Texto principal do diálogo com a contagem de itens da subárvore. */
export function deleteTaskNodeSummary(count: number): string {
  if (count <= 1) return "Apaga este item (1 item). Isso não pode ser desfeito.";
  return `Apaga este item e tudo que está dentro dele (${count} itens). Isso não pode ser desfeito.`;
}

export type DeleteTaskNodeInfo = {
  /** Refs do próprio item e de todos os descendentes que vão junto. */
  refs: string[];
  /** Total de itens na subárvore (incluindo o próprio). */
  count: number;
  /** Quantos itens da subárvore estão em andamento ou esperando você. */
  activeCount: number;
  /** Desabilita o botão de confirmar quando há item ativo na subárvore. */
  blocked: boolean;
  title: string;
  summary: string;
  note: string | null;
};

/** Dados prontos para o diálogo de confirmação ao apagar uma tarefa, subtarefa ou módulo. */
export function deleteTaskNodeInfo(project: Pick<Project, "tasks">, ref: string): DeleteTaskNodeInfo {
  const byRef = new Map(project.tasks.map((task) => [task.ref, task]));
  const refs = subtreeRefs(project, ref).filter((candidate) => byRef.has(candidate));
  const nodes = refs.map((candidate) => byRef.get(candidate)!);
  const activeCount = nodes.filter((node) => isActiveTaskStatus(node.status)).length;
  const blocked = activeCount > 0;
  const root = byRef.get(ref);
  return {
    refs,
    count: nodes.length,
    activeCount,
    blocked,
    title: deleteTaskNodeTitle(root?.title ?? ref),
    summary: deleteTaskNodeSummary(nodes.length),
    note: blocked ? DELETE_NODE_ACTIVE_NOTE : null,
  };
}
