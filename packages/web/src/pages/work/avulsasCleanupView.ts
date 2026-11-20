import { isAvulsas, type AvulsasCleanupPreview, type AvulsasCleanupResult, type Project, type ProjectTask } from "@cyno/shared";
import { brasiliaDateTime } from "./workTime";

/**
 * Lógica pura de "apagar avulsas": as idades do diálogo "Limpar avulsas", os textos de contagem e de resultado,
 * a decisão de habilitar o botão final e a regra de "esta folha pode ser apagada". O servidor é quem decide de
 * verdade (409 com mensagem em pt-BR); aqui só se evita oferecer o que ele recusaria.
 */

export type CleanupAge = { days: number; label: string };

/** As idades do seletor; 0 = qualquer idade. */
export const CLEANUP_AGES: readonly CleanupAge[] = [
  { days: 0, label: "Todas as terminadas" },
  { days: 7, label: "Mais de 7 dias" },
  { days: 30, label: "Mais de 30 dias" },
  { days: 90, label: "Mais de 90 dias" },
];

export const DEFAULT_CLEANUP_DAYS = 30;

const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;

/** O que a pré-visualização diz: carregando, erro ou a contagem. */
export type CleanupPreviewState = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; preview: AvulsasCleanupPreview };

/** Quantas tarefas o botão final apagaria com a opção escolhida (0 = nada). */
export function cleanupTotal(preview: AvulsasCleanupPreview, includeArchive: boolean): number {
  return preview.count + (includeArchive ? preview.archivedCount : 0);
}

/** A linha de contagem do diálogo ("58 tarefas terminadas serão apagadas", "Nada para apagar"). */
export function cleanupCountText(state: CleanupPreviewState, includeArchive: boolean): string {
  if (state.status === "loading") return "Contando…";
  if (state.status === "error") return state.message;
  const { count } = state.preview;
  const archived = includeArchive ? state.preview.archivedCount : 0;
  if (count + archived === 0) return "Nada para apagar";
  if (count === 0) return archived === 1 ? "1 tarefa do arquivo será apagada" : `${archived} tarefas do arquivo serão apagadas`;
  if (archived > 0) return `${plural(count, "tarefa terminada", "tarefas terminadas")} e ${archived} do arquivo serão apagadas`;
  return count === 1 ? "1 tarefa terminada será apagada" : `${count} tarefas terminadas serão apagadas`;
}

/** O rótulo da opção do arquivo; só existe quando há tarefas arquivadas (senão, null). */
export function archiveOptionLabel(preview: AvulsasCleanupPreview | null): string | null {
  return preview && preview.archivedCount > 0 ? `Apagar também as do arquivo (${preview.archivedCount})` : null;
}

/** "A mais antiga é de 12/10/2026 14:00." (Brasília), ou null sem data ou sem nada para apagar. */
export function oldestText(preview: AvulsasCleanupPreview | null): string | null {
  if (!preview?.oldestAt || preview.count + preview.archivedCount === 0) return null;
  return `A mais antiga é de ${brasiliaDateTime(preview.oldestAt)}.`;
}

/** O botão final só vale com a contagem pronta e algo para apagar (e sem um pedido já em curso). */
export function canConfirmCleanup(state: CleanupPreviewState, includeArchive: boolean, pending: boolean): boolean {
  return !pending && state.status === "ready" && cleanupTotal(state.preview, includeArchive) > 0;
}

/** O rótulo do botão final, com o total ("Apagar 58 tarefas"). */
export function cleanupConfirmLabel(state: CleanupPreviewState, includeArchive: boolean): string {
  if (state.status !== "ready") return "Apagar tarefas";
  const total = cleanupTotal(state.preview, includeArchive);
  return total > 0 ? `Apagar ${plural(total, "tarefa", "tarefas")}` : "Apagar tarefas";
}

/** O resultado depois de apagar ("58 tarefas apagadas", "62 tarefas apagadas (4 do arquivo)"). */
export function cleanupResultText(result: AvulsasCleanupResult): string {
  const total = result.deleted + result.archivedDeleted;
  if (total === 0) return "Nada foi apagado";
  const base = total === 1 ? "1 tarefa apagada" : `${total} tarefas apagadas`;
  return result.archivedDeleted > 0 ? `${base} (${result.archivedDeleted} do arquivo)` : base;
}

// ---------- Apagar uma folha ----------

/** A folha acabou de vez (concluída, cancelada ou falhou)? Só essas dá para apagar. */
export function isTerminated(task: Pick<ProjectTask, "status">): boolean {
  return task.status === "concluida" || task.status === "cancelada" || task.status === "falhou";
}

/** "Apagar" aparece para a folha terminada do Avulsas (nunca em projeto comum, nunca em folha aberta). */
export function canDeleteAvulsaTask(project: Pick<Project, "system">, task: Pick<ProjectTask, "status" | "archived" | "group">): boolean {
  return isAvulsas(project) && !task.archived && !task.group && isTerminated(task);
}

/** O aviso curto do diálogo de apagar uma tarefa. */
export const DELETE_TASK_NOTE = "Não dá para desfazer. O histórico da Atividade continua.";
