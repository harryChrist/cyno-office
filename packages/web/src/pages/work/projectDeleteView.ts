import { isAvulsas, type Project } from "@cyno/shared";

/**
 * Lógica pura de "Apagar projeto": quem pode (projeto comum, nunca o Avulsas) e o que o diálogo conta.
 * O servidor ainda recusa (409) o Avulsas e o projeto com tarefa rodando, com a mensagem dele em pt-BR.
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
