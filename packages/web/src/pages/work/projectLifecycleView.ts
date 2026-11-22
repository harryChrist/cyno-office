import { isAvulsas, type Project } from "@cyno/shared";

/**
 * Lógica pura do ciclo de vida do projeto na tela Trabalho: quando a árvore aceita edição e criação
 * (inclusive projeto concluído, que reabre sozinho ao ganhar um item) e quando mostrar Concluir e Reabrir.
 */

export const COMPLETE_PROJECT_TITLE = "Concluir projeto?";
export const COMPLETE_PROJECT_MESSAGE = "Marcar como concluído? Você pode reabrir depois.";

/**
 * O projeto aceita edição e criação de itens na árvore: abertos (exceto "ajustando", enquanto o Maestro
 * refaz o plano) e também "concluido" (criar um item o reabre sozinho). Cancelado continua só leitura.
 */
export function isProjectEditable(project: Pick<Project, "status">): boolean {
  return project.status !== "ajustando" && project.status !== "cancelado";
}

/** "Concluir projeto" aparece para projeto ativo ou pausado (nunca para o Avulsas). */
export function canCompleteProject(project: Pick<Project, "status" | "system">): boolean {
  return !isAvulsas(project) && (project.status === "ativo" || project.status === "pausado");
}

/** "Reabrir projeto" aparece para projeto concluído ou cancelado (nunca para o Avulsas). */
export function canReopenProject(project: Pick<Project, "status" | "system">): boolean {
  return !isAvulsas(project) && (project.status === "concluido" || project.status === "cancelado");
}
