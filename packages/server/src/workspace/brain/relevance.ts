/**
 * Relevância lexical (sem modelo, sem custo): palavras da consulta sem acento, caixa e stopwords
 * pt-BR, comparadas com o título/nome do arquivo (peso maior), as tags e o corpo da nota.
 */

const STOPWORDS = new Set(
  (
    "a o as os um uma uns umas de da do das dos em na no nas nos por para pra pelo pela pelos pelas com sem sob sobre " +
    "e ou mas que se ao aos à às é ser são foi era como mais menos muito muita muitos muitas isso isto esse essa este esta " +
    "aquele aquela seu sua seus suas meu minha nosso nossa ele ela eles elas eu voce você voces vocês nós nao não sim já ja " +
    "tambem também quando onde qual quais quem cada todo toda todos todas outro outra outros outras entre ate até depois antes " +
    "faca faça fazer feito favor tarefa pedido nota notas the and for with"
  ).split(" "),
);

/** Minúsculas, sem acento. */
export function fold(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/** Palavras relevantes (3+ letras/dígitos, sem stopwords), sem repetir. */
export function terms(text: string): string[] {
  const words = fold(text).match(/[a-z0-9]{3,}/g) ?? [];
  return [...new Set(words.filter((word) => !STOPWORDS.has(fold(word))))];
}

/** Uma palavra casa com outra se forem iguais ou uma for prefixo da outra (com 4+ letras): "slogan" ~ "slogans". */
function matches(term: string, words: Set<string>): boolean {
  if (words.has(term)) return true;
  if (term.length < 4) return false;
  for (const word of words) {
    if (word.length >= 4 && (word.startsWith(term) || term.startsWith(word))) return true;
  }
  return false;
}

export type ScoredText = { title: string; file: string; tags?: string[]; body: string; mtimeMs?: number };

const DAY_MS = 86_400_000;

/**
 * Pontos de uma nota para a consulta: título/arquivo 3 por palavra, tags 2, corpo 1; mais um
 * empurrãozinho para edições recentes (até +0,5 nos últimos 30 dias). Sem consulta, só a recência.
 */
export function relevance(queryTerms: string[], note: ScoredText, nowMs: number): number {
  const recency = note.mtimeMs === undefined ? 0 : 0.5 * Math.max(0, 1 - (nowMs - note.mtimeMs) / (30 * DAY_MS));
  if (queryTerms.length === 0) return recency;
  const head = new Set(terms(`${note.title} ${note.file.replace(/\.md$/i, "").replace(/[-_/]+/g, " ")}`));
  const tags = new Set(terms((note.tags ?? []).join(" ")));
  const body = new Set(terms(note.body));
  let score = 0;
  for (const term of queryTerms) {
    if (matches(term, head)) score += 3;
    else if (matches(term, tags)) score += 2;
    else if (matches(term, body)) score += 1;
  }
  return score > 0 ? score + recency : recency;
}

/** Trecho em volta da primeira palavra da consulta que aparece no texto (ou o começo). */
export function snippet(text: string, queryTerms: string[], max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const folded = fold(flat);
  let at = -1;
  for (const term of queryTerms) {
    const index = folded.indexOf(term);
    if (index !== -1 && (at === -1 || index < at)) at = index;
  }
  const start = at <= max / 3 ? 0 : at - Math.floor(max / 3);
  const piece = flat.slice(start, start + max).trim();
  return `${start > 0 ? "…" : ""}${piece}${start + max < flat.length ? "…" : ""}`;
}
