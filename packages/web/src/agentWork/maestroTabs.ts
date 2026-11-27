import type { RequestItem } from "./timelineView";
import type { MaestroTab } from "./workPanelStore";

/** Como o Maestro conversa: Claude Code interativo (terminal), CLI sem terminal (chat) ou simulado. */
export type MaestroMode = "terminal" | "conversa" | "simulado";

/**
 * As abas do painel do Maestro e a que abre por padrão. A conversa é o chat (Maestro de CLI sem
 * terminal interativo) ou os próprios pedidos (simulado: cada mensagem vira um pedido); com o
 * Claude Code interativo, a conversa é o terminal.
 */
export function maestroTabs(mode: MaestroMode): { tabs: MaestroTab[]; fallback: MaestroTab } {
  if (mode === "terminal") return { tabs: ["terminal", "pedidos", "atividade"], fallback: "terminal" };
  if (mode === "conversa") return { tabs: ["conversa", "pedidos", "atividade", "terminal"], fallback: "conversa" };
  return { tabs: ["conversa", "atividade", "terminal"], fallback: "conversa" };
}

/** A aba à vista: a escolhida (lembrada), se existe neste modo; senão a padrão. */
export function currentMaestroTab(chosen: MaestroTab | null, mode: MaestroMode): MaestroTab {
  const { tabs, fallback } = maestroTabs(mode);
  return chosen && tabs.includes(chosen) ? chosen : fallback;
}

/** Pedidos ao Maestro ainda abertos (o resumo "Em andamento" do cabeçalho), mais novos primeiro. */
export function activeRequests(items: readonly RequestItem[]): RequestItem[] {
  return items.filter((item) => item.stage !== "done" && item.stage !== "failed").reverse();
}
