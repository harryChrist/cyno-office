/** Palavras e emojis em minúsculas: tirar um emoji muda os bigramas (a edição "cortou emoji" aparece). */
const TOKEN = /[\p{L}\p{N}]+|\p{Extended_Pictographic}/gu;

export function tokensOf(text: string): string[] {
  return text.toLowerCase().match(TOKEN) ?? [];
}

/** Bigramas de palavras (multiconjunto); um texto de uma palavra só vira um "bigrama" dela mesma. */
function bigrams(tokens: readonly string[]): Map<string, number> {
  const out = new Map<string, number>();
  const add = (key: string) => out.set(key, (out.get(key) ?? 0) + 1);
  if (tokens.length === 1) add(tokens[0]!);
  for (let i = 0; i + 1 < tokens.length; i += 1) add(`${tokens[i]} ${tokens[i + 1]}`);
  return out;
}

/**
 * Similaridade de Dice sobre bigramas de palavras, de 0 (nada em comum) a 1 (igual): `2·|A∩B| / (|A|+|B|)`,
 * contando repetições. Dois textos sem palavra nenhuma são iguais (1).
 */
export function diceSimilarity(a: string, b: string): number {
  const left = bigrams(tokensOf(a));
  const right = bigrams(tokensOf(b));
  const total = [...left.values(), ...right.values()].reduce((sum, count) => sum + count, 0);
  if (total === 0) return 1;
  let common = 0;
  for (const [key, count] of left) common += Math.min(count, right.get(key) ?? 0);
  return (2 * common) / total;
}

/** Quanto o dono trocou do texto: `1 - similaridade` (0 a 1). */
export const editIntensity = (original: string, edited: string): number => 1 - diceSimilarity(original, edited);
