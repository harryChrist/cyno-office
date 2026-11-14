/**
 * Texto que o agente devolve numa execução de rotina: guardamos o completo (`detail`) e um resumo
 * limpo e curto (`summary`) para a lista. Sem relógio nem disco.
 */

/** Tamanho do resumo curto de uma execução. */
export const ROUTINE_SUMMARY_MAX = 200;
/** Tamanho máximo do texto completo guardado. */
export const ROUTINE_DETAIL_MAX = 4000;

/** Tira o markdown de uma linha: títulos, negrito, itálico, código, links, marcadores de lista e citações. */
function stripMarkdown(line: string): string {
  return line
    .replace(/^\s{0,3}#{1,6}\s+/, "")
    .replace(/^\s*>+\s?/, "")
    .replace(/^\s*(?:[-*+•]|\d{1,3}[.)])\s+/, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)]*)\)/g, "$1")
    .replace(/`{1,3}([^`]*)`{1,3}/g, "$1")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(^|[\s(])[*_]([^*_\n]+)[*_](?=[\s).,;:!?]|$)/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Resumo curto e limpo: a primeira frase útil, sem markdown, com até `max` caracteres. Ignora cercas
 * de código, linhas só de enfeite ("---") e títulos genéricos ("Resumo:"). Texto vazio devolve "".
 */
export function cleanSummary(text: string, max: number = ROUTINE_SUMMARY_MAX): string {
  const lines: string[] = [];
  let fenced = false;
  for (const raw of text.split(/\r?\n/)) {
    if (/^\s*```/.test(raw)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    if (/^\s*([-*_=]\s*){3,}$/.test(raw)) continue;
    const line = stripMarkdown(raw);
    if (!line || /^(resumo|summary|resultado|result)\s*:?$/i.test(line)) continue;
    lines.push(line);
  }
  const all = lines.join(" ").trim();
  if (!all) return "";
  // Primeira frase: até o primeiro ponto final, interrogação ou exclamação seguido de espaço (não corta "3.5" nem "linkedin.com").
  const sentence = /^(.+?[.!?])(?=\s|$)/.exec(all)?.[1] ?? all;
  const base = sentence.length >= 12 ? sentence : all;
  return base.length <= max ? base : `${base.slice(0, max - 1).trimEnd()}…`;
}

/** O texto completo, só com os espaços de fim de linha aparados e o limite aplicado (mantém quebras de linha e markdown). */
export function fullDetail(text: string, max: number = ROUTINE_DETAIL_MAX): string {
  const clean = text.replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`;
}
