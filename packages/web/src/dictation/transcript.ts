/** Texto do campo e onde o ditado entra (posição do cursor quando o ditado começou). */
export type DictationBase = { text: string; caret: number };

const SENTENCE_END = /[.!?…]\s*$|\n\s*$|^\s*$/;
const NO_SPACE_BEFORE = /^[\s.,;:!?…)\]}]/;

/** Junta o que já é definitivo com o que ainda está sendo reconhecido (interino). */
export function joinSpeech(finalText: string, interimText: string): string {
  return [finalText, interimText]
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join(" ");
}

/**
 * Insere a fala no texto na posição `caret`, cuidando dos espaços em volta e da maiúscula no
 * começo de frase. Devolve o texto novo e onde o cursor fica (logo depois da fala).
 */
export function insertTranscript(base: DictationBase, speech: string): DictationBase {
  const caret = Math.min(Math.max(0, base.caret), base.text.length);
  const clean = speech.replace(/\s+/g, " ").trim();
  if (!clean) return { text: base.text, caret };
  const before = base.text.slice(0, caret);
  const after = base.text.slice(caret);
  const words = SENTENCE_END.test(before) ? clean.charAt(0).toLocaleUpperCase("pt-BR") + clean.slice(1) : clean;
  const lead = before && !/\s$/.test(before) ? " " : "";
  const trail = after && !NO_SPACE_BEFORE.test(after) ? " " : "";
  const inserted = `${lead}${words}${trail}`;
  return { text: before + inserted + after, caret: before.length + lead.length + words.length };
}

/** O campo durante o ditado: a base com a fala (definitiva + interina) no lugar do cursor. */
export function composeDictation(base: DictationBase, finalText: string, interimText: string): DictationBase {
  return insertTranscript(base, joinSpeech(finalText, interimText));
}
