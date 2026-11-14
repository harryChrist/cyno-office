// Tradução pura entre a seleção e a câmera da cena (motor do Habblaud) e a interface do Cyno (`viewStore`).
// Sem React, sem motor: só as regras, para ficarem testadas.
import { LOBBY_ID } from "@cyno/shared";
import type { Selection as SelecaoDaCena } from "@cyno/cena";
import { NO_INSETS, combinedInsets, type Focus, type Insets, type Selection as SelecaoDaView } from "../store/viewStore";

/** Onde a câmera enquadra o lobby do Cyno na cena: a copa, no meio do núcleo. */
export const NUCLEO_ENQUADRADO = "core:copa";

/** O id do pai de um subagente (`agente::thread`); um agente comum devolve ele mesmo. */
export function idDoPai(id: string): string {
  const i = id.indexOf("::");
  return i < 0 ? id : id.slice(0, i);
}

/**
 * O que a cena selecionou -> o que o Cyno seleciona.
 * - agente: o agente; subagente: o agente pai
 * - sala: a sala (só se `salaExiste` a reconhece); qualquer parte do núcleo (`core:*`): o lobby
 * - nada (clique no vazio): null
 * Devolve `undefined` quando a seleção não corresponde a nada do Cyno (sala desconhecida): quem chama a ignora.
 */
export function selecaoDaCena(sel: SelecaoDaCena, salaExiste: (id: string) => boolean = () => true): SelecaoDaView | undefined {
  if (!sel) return null;
  if (sel.type === "agent") return { kind: "agent", id: idDoPai(sel.id) };
  if (sel.id.startsWith("core:")) return { kind: "room", id: LOBBY_ID };
  return salaExiste(sel.id) ? { kind: "room", id: sel.id } : undefined;
}

/** O que o Cyno selecionou -> o que a cena seleciona (o lobby vira a copa). */
export function selecaoParaCena(sel: SelecaoDaView): SelecaoDaCena {
  if (!sel) return null;
  if (sel.kind === "agent") return { type: "agent", id: sel.id };
  return { type: "room", id: sel.id === LOBBY_ID ? NUCLEO_ENQUADRADO : sel.id };
}

export function mesmaSelecaoDaView(a: SelecaoDaView, b: SelecaoDaView): boolean {
  return a === b || (!!a && !!b && a.kind === b.kind && a.id === b.id);
}

/** O foco do Cyno -> o alvo da câmera: `null` = visão geral; senão o id da sala (o lobby vira a copa). */
export function alvoDoFoco(focus: Focus): string | null {
  if (focus.kind === "map") return null;
  return focus.id === LOBBY_ID ? NUCLEO_ENQUADRADO : focus.id;
}

/** Painéis que tiram espaço da câmera da cena: a barra de cima, o menu lateral, a caixa "Peça ao Maestro" e o painel lateral aberto. */
const PAINEIS_QUE_COBREM = new Set(["topbar", "sidebar", "task-box", "side-panel"]);

/** Um painel que cobre mais que isto da largura é uma folha (celular): esconde o mapa inteiro e não entra na conta. */
const LARGURA_DE_FOLHA = 0.55;

/**
 * Área da tela coberta por painéis (px), para a câmera da cena centrar o prédio e enquadrar um agente na parte
 * que sobra. No celular o painel do agente é uma folha por cima de tudo: ele não conta (o mapa fica como está).
 */
export function insetsDaCena(overlays: Record<string, Insets>, viewport: { w: number; h: number }): Insets {
  const contam: Record<string, Insets> = {};
  for (const [chave, insets] of Object.entries(overlays)) {
    if (!PAINEIS_QUE_COBREM.has(chave)) continue;
    if (chave === "side-panel" && insets.right >= viewport.w * LARGURA_DE_FOLHA) continue;
    contam[chave] = insets;
  }
  const soma = combinedInsets(contam);
  return { ...NO_INSETS, ...soma };
}
