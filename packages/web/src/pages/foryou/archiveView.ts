import type { ForYouItem } from "@cyno/shared";

/** Textos e contas do bloco "Mais antigos" das Aprovações (sem React, para testar). */

const MONTH_NAMES = [
  "janeiro",
  "fevereiro",
  "março",
  "abril",
  "maio",
  "junho",
  "julho",
  "agosto",
  "setembro",
  "outubro",
  "novembro",
  "dezembro",
] as const;

/** "2026-11" vira "novembro de 2026"; um mês fora do formato volta como veio (nunca "undefined"). */
export function monthLabel(month: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  const name = match ? MONTH_NAMES[Number(match[2]) - 1] : undefined;
  return match && name ? `${name} de ${match[1]}` : month;
}

/** "Aprovações decididas há mais de 7 dias ficam aqui."; vazio quando não há prazo (0 = nunca arquiva). */
export function archiveHint(liveDays: number): string {
  if (liveDays <= 0) return "";
  return `Aprovações decididas há mais de ${liveDays} ${liveDays === 1 ? "dia" : "dias"} ficam aqui.`;
}

/** Quantos itens o arquivo tem ao todo ("12 itens"). */
export function archiveTotal(months: readonly { count: number }[]): number {
  return months.reduce((sum, entry) => sum + entry.count, 0);
}

/** "1 item" / "12 itens". */
export function itemsLabel(count: number): string {
  return count === 1 ? "1 item" : `${count} itens`;
}

/** Os itens de um mês do arquivo, do decidido mais recentemente para o mais antigo. */
export function sortArchiveItems(items: readonly ForYouItem[]): ForYouItem[] {
  const at = (item: ForYouItem) => item.decidedAt ?? item.createdAt;
  return [...items].sort(
    (a, b) => at(b).localeCompare(at(a)) || b.id.localeCompare(a.id),
  );
}
