// Onde cada workspace mora na cidade: o lote da espiral do Habblaud (a partir da praça), guardado para não mudar.
// Puro e sem dependências do motor (a página do Cyno o importa sem baixar a cena). A geometria é a de
// `packages/cena/shared/world/city.ts` (mesma conta: 3 x 2 lotes por quarteirão, quarteirões em espiral, o 0,0 é a praça).

export type Lote = { x: number; y: number };

/** Índice do lote na espiral (0 = o primeiro, ao leste da praça) por id de workspace. */
export type Lotes = Record<string, number>;

const BLOCO = { w: 3, h: 2 } as const;

/** Quarteirões em espiral quadrada a partir de (0, 0): leste, sul, oeste, norte; passos 1, 1, 2, 2, 3, 3... */
function* quarteiroes(): Generator<Lote> {
  let x = 0;
  let y = 0;
  yield { x, y };
  const dirs = [
    [1, 0],
    [0, 1],
    [-1, 0],
    [0, -1],
  ] as const;
  for (let len = 1, d = 0; ; len++) {
    for (let volta = 0; volta < 2; volta++, d++) {
      const dir = dirs[d % 4] ?? dirs[0];
      for (let i = 0; i < len; i++) {
        x += dir[0];
        y += dir[1];
        yield { x, y };
      }
    }
  }
}

const cache: Lote[] = [];
const gerador = (function* (): Generator<Lote> {
  for (const b of quarteiroes()) {
    if (b.x === 0 && b.y === 0) continue; // a praça não tem lotes
    for (let j = 0; j < BLOCO.h; j++) for (let i = 0; i < BLOCO.w; i++) yield { x: b.x * BLOCO.w + i, y: b.y * BLOCO.h + j };
  }
})();

/** O lote de um índice da espiral (os primeiros 12: (3,0) (4,0) (5,0) (3,1) (4,1) (5,1) (3,2) (4,2) (5,2) (3,3) (4,3) (5,3)). */
export function loteDoIndice(indice: number): Lote {
  while (cache.length <= indice) cache.push(gerador.next().value as Lote);
  return cache[indice]!;
}

/**
 * Atribui lotes: quem já tinha um lote o mantém (se ele ainda é válido); quem é novo pega o menor índice livre, na
 * ordem recebida (a ordem de criação); quem sumiu libera o lote. Devolve um objeto novo; o de entrada não é alterado.
 */
export function atribuirLotes(ids: readonly string[], antes: Lotes): Lotes {
  const depois: Lotes = {};
  const usados = new Set<number>();
  for (const id of ids) {
    const i = antes[id];
    if (typeof i === "number" && Number.isInteger(i) && i >= 0 && !usados.has(i)) {
      depois[id] = i;
      usados.add(i);
    }
  }
  let proximo = 0;
  for (const id of ids) {
    if (id in depois) continue;
    while (usados.has(proximo)) proximo++;
    depois[id] = proximo;
    usados.add(proximo);
  }
  return depois;
}

const CHAVE = "cyno.cidade.lotes";

function guardado(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** Lê os lotes guardados (qualquer defeito vira vazio). */
export function lerLotes(armazem: Pick<Storage, "getItem"> | null = guardado()): Lotes {
  try {
    const bruto = armazem?.getItem(CHAVE);
    if (!bruto) return {};
    const dado: unknown = JSON.parse(bruto);
    if (!dado || typeof dado !== "object" || Array.isArray(dado)) return {};
    const saida: Lotes = {};
    for (const [id, i] of Object.entries(dado)) if (typeof i === "number" && Number.isInteger(i) && i >= 0) saida[id] = i;
    return saida;
  } catch {
    return {};
  }
}

export function guardarLotes(lotes: Lotes, armazem: Pick<Storage, "setItem"> | null = guardado()): void {
  try {
    armazem?.setItem(CHAVE, JSON.stringify(lotes));
  } catch {
    // sem armazenamento: a posição vale só nesta sessão
  }
}
