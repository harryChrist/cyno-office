import { forYouKind, type ForYouItem, type RetroGroup, type RetroView } from "@cyno/shared";

/** Textos e contas da aba "O que aprendemos" (sem React, para testar). */

/** Os cartões de regra: os que esperam o dono primeiro (o mais antigo no topo), depois os decididos (o mais recente primeiro). Cancelados ficam de fora. */
export function ruleItems(items: readonly ForYouItem[] | null | undefined): ForYouItem[] {
  const rules = (items ?? []).filter((item) => forYouKind(item) === "regra" && item.status !== "cancelado" && item.rule !== undefined);
  const pending = rules.filter((item) => item.status === "pendente").sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const decided = rules.filter((item) => item.status !== "pendente").sort((a, b) => (b.decidedAt ?? b.createdAt).localeCompare(a.decidedAt ?? a.createdAt) || b.id.localeCompare(a.id));
  return [...pending, ...decided];
}

/** Quantas regras esperam o OK do dono (o selo da aba). */
export function waitingRules(items: readonly ForYouItem[] | null | undefined): number {
  return (items ?? []).filter((item) => forYouKind(item) === "regra" && item.status === "pendente").length;
}

/** "3 regras esperando" / "1 regra esperando"; vazio quando não há nada. */
export function badgeLabel(count: number): string {
  return count === 0 ? "" : `${count} ${count === 1 ? "regra esperando" : "regras esperando"} o seu OK`;
}

/** A linha de cima: o que a retrospectiva olhou. */
export function considerLine(view: Pick<RetroView, "considered">): string {
  const { decided, rejected, edited, failed } = view.considered;
  if (decided === 0 && failed === 0) return "Nenhuma decisão sua nos últimos 14 dias: ainda não há o que procurar.";
  const few = decided < 5 ? " Poucos dados: os padrões aparecem com 3 itens em 2 dias, ou 5 no total." : "";
  return `Olhei ${decided} ${decided === 1 ? "decisão sua" : "decisões suas"} dos últimos 14 dias: ${rejected} ${rejected === 1 ? "recusa" : "recusas"}, ${edited} ${edited === 1 ? "texto editado" : "textos editados"} e ${failed} ${failed === 1 ? "falha" : "falhas"}.${few}`;
}

/** O texto do botão do Maestro, com o custo à vista (nunca é automático). */
export function askButtonLabel(view: Pick<RetroView, "estimate" | "needsMaestro">): string {
  return `Escrever as regras com o Maestro (${view.estimate.label})`;
}

/** Por que o botão do Maestro está desligado (undefined = pode clicar). */
export function askDisabledReason(view: Pick<RetroView, "needsMaestro" | "maestro">): string | undefined {
  if (view.needsMaestro.length === 0) return "Nenhum padrão espera texto: as regras de emoji, hashtag, tamanho e exclamação já saem prontas.";
  if (!view.maestro.available) return view.maestro.reason ?? "O Maestro deste workspace não está disponível.";
  if (view.maestro.asking) return "O Maestro já está escrevendo as regras: os cartões aparecem aqui sozinhos.";
  return undefined;
}

/** O nome do tipo de padrão para a lista do que espera texto. */
export const GROUP_KIND_LABEL: Record<RetroGroup["kind"], string> = { rejection: "Recusas", edit_trait: "Edições", edit_words: "Palavras trocadas", failure: "Falhas" };

/** Uma linha do padrão: "Recusas · Comentário · Beto: recusou 5 de 13 comentários de Beto (tom)". */
export function groupLine(group: RetroGroup): string {
  return `${GROUP_KIND_LABEL[group.kind]} · ${group.typeName}: ${group.line} (${group.days} ${group.days === 1 ? "dia" : "dias"})`;
}

/** Há padrões com regra pronta (molde) ainda sem cartão: o painel abre os cartões na primeira visita (só código, não custa nada). */
export function hasReady(view: Pick<RetroView, "ready">): boolean {
  return view.ready.length > 0;
}
