// Adaptado de Habblaud (github.com/marmottajr/habblaud), MIT, Copyright (c) 2026 Márcio Junior.
// Origem: client/src/ui/termtools.ts (busca sem acento com mapa de posições, navegação com contador,
// filtro e "respostas finais"). Aqui trabalha sobre `TerminalLine` do Cyno e não toca no DOM: o destaque
// é feito em React, por `splitByRanges`. Sem `tr()` (o Cyno é só pt-BR).
import type { TerminalLine } from "./agentTerminal";

// ---------------------------------------------------------------- filtros

export type TerminalFilter = "all" | "talk" | "noTools";

export const TERMINAL_FILTERS: readonly { id: TerminalFilter; label: string; hint: string }[] = [
  { id: "all", label: "Tudo", hint: "Toda a conversa e o trabalho" },
  { id: "talk", label: "Só conversa", hint: "O que você e o agente disseram: suas mensagens, a resposta final de cada turno e o resultado" },
  { id: "noTools", label: "Sem ferramentas", hint: "Esconde as chamadas de ferramenta e as saídas delas" },
];

export function isTerminalFilter(value: unknown): value is TerminalFilter {
  return value === "all" || value === "talk" || value === "noTools";
}

/**
 * As respostas finais de cada turno: o texto do agente (`text`) sem nenhuma ferramenta depois dele até a
 * próxima fala do dono, a próxima seção (tarefa/conversa) ou o fim. Os textos do meio ("Vou ler o arquivo.")
 * ficam de fora. Subagente não conta: a conversa é com o agente principal.
 */
export function finalAnswerIds(lines: readonly TerminalLine[]): Set<string> {
  const finals = new Set<string>();
  let pending: string[] = [];
  const flush = () => {
    for (const id of pending) finals.add(id);
    pending = [];
  };
  for (const line of lines) {
    if (line.thread) continue;
    if (line.kind === "tool" || line.kind === "subagent") pending = [];
    else if (line.kind === "text") pending.push(line.id);
    else if (line.kind === "section" || (line.kind === "chat" && line.from === "user")) flush();
  }
  flush();
  return finals;
}

/** A linha aparece com o filtro? (`finals` = finalAnswerIds, usado só por "Só conversa".) */
export function lineVisible(line: TerminalLine, filter: TerminalFilter, finals: ReadonlySet<string>): boolean {
  if (line.kind === "section" || filter === "all") return true;
  if (filter === "noTools") return line.kind !== "tool" && line.kind !== "subagent" && !line.thread;
  if (line.thread) return false;
  return line.kind === "chat" || line.kind === "result" || (line.kind === "text" && finals.has(line.id));
}

/** Aplica o filtro; seção que ficou sem linha embaixo some. */
export function filterLines(lines: readonly TerminalLine[], filter: TerminalFilter): TerminalLine[] {
  if (filter === "all") return [...lines];
  const finals = filter === "talk" ? finalAnswerIds(lines) : new Set<string>();
  const out: TerminalLine[] = [];
  for (const line of lines) {
    if (!lineVisible(line, filter, finals)) continue;
    if (line.kind === "section" && out.at(-1)?.kind === "section") out.pop();
    out.push(line);
  }
  if (out.at(-1)?.kind === "section") out.pop();
  return out;
}

// ---------------------------------------------------------------- busca

/** Texto "dobrado" para a busca (minúsculas, sem acentos) e, para cada caractere dele, de onde veio no original. */
export type FoldedText = {
  text: string;
  /** Início e fim (no original) do caractere que gerou cada posição de `text`; ausentes = identidade (ASCII). */
  starts?: number[];
  ends?: number[];
};

// eslint-disable-next-line no-control-regex -- é a faixa ASCII de propósito (texto sem acento não precisa do mapa de posições)
const ASCII = /^[\x00-\x7f]*$/;
const COMBINING = /[̀-ͯ]/g;

/** Minúsculas e sem acentos ("Ação" -> "acao"), guardando as posições originais para o destaque. */
export function foldText(source: string): FoldedText {
  if (ASCII.test(source)) return { text: source.toLowerCase() };
  let text = "";
  const starts: number[] = [];
  const ends: number[] = [];
  let i = 0;
  for (const ch of source) {
    const folded = ch.normalize("NFD").replace(COMBINING, "").toLowerCase();
    // Acento solto (e + U+0301): some do texto dobrado, mas o destaque da letra anterior o inclui.
    if (!folded && ends.length) ends[ends.length - 1] = i + ch.length;
    for (let k = 0; k < folded.length; k++) {
      starts.push(i);
      ends.push(i + ch.length);
    }
    text += folded;
    i += ch.length;
  }
  return { text, starts, ends };
}

/** Termo da busca já dobrado; só espaços = sem busca (""). */
export function foldQuery(query: string): string {
  return query.trim() ? foldText(query.trim()).text : "";
}

/** Trechos [início, fim) do original que casam com o termo (já dobrado por foldQuery), sem sobreposição. */
export function findMatches(text: string, folded: string): [number, number][] {
  if (!folded || !text) return [];
  const f = foldText(text);
  const out: [number, number][] = [];
  for (let i = f.text.indexOf(folded); i !== -1; i = f.text.indexOf(folded, i + folded.length)) {
    const end = i + folded.length;
    out.push(f.starts ? [f.starts[i]!, f.ends![end - 1]!] : [i, end]);
  }
  return out;
}

/** Próximo (dir = 1) ou anterior (-1) resultado, dando a volta; sem resultado atual (-1), começa do primeiro ou do último. */
export function stepMatch(current: number, total: number, dir: 1 | -1): number {
  if (total <= 0) return -1;
  if (current < 0 || current >= total) return dir === 1 ? 0 : total - 1;
  return (current + dir + total) % total;
}

export type HitRef = { key: string; index: number };
export type HitCounts = readonly (readonly [string, number])[];

/** Posição do resultado atual numa lista de [chave da linha, nº de resultados] (na ordem da tela); -1 se não estiver lá. */
export function globalIndex(counts: HitCounts, ref: HitRef | null): number {
  if (!ref) return -1;
  let base = 0;
  for (const [key, n] of counts) {
    if (key === ref.key) return ref.index < n ? base + ref.index : -1;
    base += n;
  }
  return -1;
}

/** O resultado de número `index` (0 = primeiro) na mesma lista. */
export function refAt(counts: HitCounts, index: number): HitRef | null {
  if (index < 0) return null;
  let rest = index;
  for (const [key, n] of counts) {
    if (rest < n) return { key, index: rest };
    rest -= n;
  }
  return null;
}

/** Contador da busca ("3 de 17"); sem resultado atual, "0 de 17". */
export function searchCounter(index: number, total: number): string {
  return `${index >= 0 && index < total ? index + 1 : 0} de ${total}`;
}

/** Os dois textos de uma linha onde a busca olha: o principal e o detalhe (saída da ferramenta, objetivo). */
export function searchFields(line: TerminalLine): { text: string; detail: string } {
  return { text: line.text, detail: line.detail ?? "" };
}

/** Quantos resultados cada linha tem (só as linhas com resultado, na ordem da tela). Seções não entram. */
export function hitCounts(lines: readonly TerminalLine[], folded: string): [string, number][] {
  if (!folded) return [];
  const out: [string, number][] = [];
  for (const line of lines) {
    if (line.kind === "section") continue;
    const { text, detail } = searchFields(line);
    const n = findMatches(text, folded).length + findMatches(detail, folded).length;
    if (n > 0) out.push([line.id, n]);
  }
  return out;
}

/** Pedaço de texto, destacado ou não; `hit` é o número do resultado dentro do campo. */
export type Piece = { text: string; hit?: number };

/** Parte o texto nos trechos dados (ordenados, sem sobreposição): é o destaque, sem DOM nem innerHTML. */
export function splitByRanges(text: string, ranges: readonly [number, number][]): Piece[] {
  const out: Piece[] = [];
  let last = 0;
  ranges.forEach(([a, b], hit) => {
    if (a > last) out.push({ text: text.slice(last, a) });
    out.push({ text: text.slice(a, b), hit });
    last = b;
  });
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

// ---------------------------------------------------------------- recolhimento

/** Quantas linhas cada tipo de bloco mostra antes de recolher (os mesmos limites do Habblaud). */
export const PREVIEW_LINES = { prompt: 24, answer: 24, output: 6, goal: 3 } as const;
const MIN_HIDDEN_LINES = 3;
const CHARS_PER_LINE = 200;

export type Preview = {
  /** O que aparece com o bloco recolhido. */
  shown: string;
  /** Linhas escondidas (0 quando o corte foi no meio de uma linha comprida). */
  hiddenLines: number;
  /** Cortou no meio de uma linha: o rótulo é "mostrar tudo", sem contagem. */
  cutMidLine: boolean;
};

/**
 * Recolhe só se sobrarem pelo menos 3 linhas escondidas, ou se o texto passar de `maxLines * 200` caracteres.
 * Devolve null quando o texto cabe inteiro.
 */
export function collapsePreview(text: string, maxLines: number): Preview | null {
  const lines = text.split("\n");
  const maxChars = maxLines * CHARS_PER_LINE;
  if (lines.length > maxLines + MIN_HIDDEN_LINES - 1) {
    let shown = lines.slice(0, maxLines).join("\n");
    if (shown.length > maxChars) shown = shown.slice(0, maxChars);
    return { shown, hiddenLines: lines.length - maxLines, cutMidLine: false };
  }
  if (text.length > maxChars) return { shown: text.slice(0, maxChars), hiddenLines: 0, cutMidLine: true };
  return null;
}

/** O trecho que começa em `offset` fica escondido pelo recolhimento? (a busca abre o bloco nesse caso) */
export function hiddenAt(text: string, maxLines: number, offset: number): boolean {
  const preview = collapsePreview(text, maxLines);
  return preview !== null && offset >= preview.shown.length;
}

/** Rótulo do botão de um bloco recolhido. */
export function moreLabel(preview: Preview): string {
  if (preview.cutMidLine || preview.hiddenLines === 0) return "… mostrar tudo";
  return preview.hiddenLines === 1 ? "… +1 linha" : `… +${preview.hiddenLines} linhas`;
}

/** Quantas linhas mostra o bloco de texto principal de uma linha (o do detalhe é `output`/`goal`). */
export function previewLimit(line: TerminalLine, field: "text" | "detail"): number {
  if (field === "detail") return line.kind === "subagent" ? PREVIEW_LINES.goal : PREVIEW_LINES.output;
  return line.kind === "chat" && line.from === "user" ? PREVIEW_LINES.prompt : PREVIEW_LINES.answer;
}

// ---------------------------------------------------------------- cópia

/** Copiar a resposta ou o comando (o texto principal da linha, sem os espaços do fim). */
export function copyTextOf(line: TerminalLine): string {
  return line.text.replace(/\s+$/, "");
}

/** Copiar o bloco de baixo (a saída da ferramenta, o objetivo do subagente). */
export function copyDetailOf(line: TerminalLine): string {
  return (line.detail ?? "").replace(/\s+$/, "");
}
