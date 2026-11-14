import { lastWorkspace, useNavStore } from "./navStore";

/** O workspace pedido, ou o atual, ou o último usado (as abas Mídia e Cérebro da Biblioteca são por workspace). */
function workspaceOr(workspaceId: string | null | undefined): string | null {
  return workspaceId ?? useNavStore.getState().workspaceId ?? lastWorkspace();
}

/** Aba Mídia da Biblioteca, já no workspace (`#/biblioteca/midia/<ws>`). */
export function openMedia(workspaceId?: string | null): void {
  const ws = workspaceOr(workspaceId);
  useNavStore.getState().go("biblioteca", ws ? `midia/${encodeURIComponent(ws)}` : "midia");
}

/** Aba Cérebro da Biblioteca, já no workspace (`#/biblioteca/cerebro/<ws>`). */
export function openBrain(workspaceId?: string | null): void {
  const ws = workspaceOr(workspaceId);
  useNavStore.getState().go("biblioteca", ws ? `cerebro/${encodeURIComponent(ws)}` : "cerebro");
}

/** Aba Gastos da Gestão (`#/<ws>/gestao/gastos`). */
export function openSpend(): void {
  useNavStore.getState().go("gestao", "gastos");
}

/** Aba Atividade da Gestão (`#/<ws>/gestao/atividade`; sem workspace, só a aba Sistema). */
export function openActivity(): void {
  useNavStore.getState().go("gestao", "atividade");
}

/** "Sua agenda" (`#/agenda`), ou já filtrada num workspace (`#/agenda/<ws>`). */
export function openAgenda(workspaceId?: string | null): void {
  useNavStore.getState().go("agenda", workspaceId ? encodeURIComponent(workspaceId) : "");
}
