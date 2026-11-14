// Contas do desenho do avatar pequeno (cabeça e ombros), sem React: o AvatarSprite e os testes usam daqui.

/** Quadro do motor: 24x34. O busto (cabeça e ombros) é o recorte de 20x20 que ele usa nos avatares pequenos. */
export const QUADRO_LARGURA = 24;
export const QUADRO_ALTURA = 34;
export const BUSTO = 20;
/** O "rosto": o mesmo busto sem a margem vazia de 1 px (18x18), para caber em ampliação inteira em caixas de ~36 px. */
export const ROSTO = 18;

/** Medidas do desenho de uma cabeça numa caixa de `size` px de tela: o recorte, a ampliação inteira e o tamanho do canvas. */
export type MedidaDaCabeca = { recorte: number; ampliacao: number; pixelsDoCanvas: number; cssPx: number };

/**
 * Escolhe, para uma caixa de `size` px de tela (em CSS) e a densidade `dpr` do aparelho, o recorte (busto de 20 px ou
 * rosto de 18 px) e a maior ampliação inteira em pixels do aparelho que cabem, ficando com o que mais enche a caixa
 * (empate: o busto, que mostra os ombros). Os pixels do personagem ficam alinhados aos do aparelho: nada de borrão.
 */
export function medirCabeca(size: number, dpr = 1): MedidaDaCabeca {
  const alvo = Math.max(1, size * Math.max(1, dpr));
  let melhor: MedidaDaCabeca | null = null;
  let melhorPreenchimento = -1;
  for (const recorte of [BUSTO, ROSTO]) {
    const ampliacao = Math.max(1, Math.floor(alvo / recorte));
    const pixelsDoCanvas = recorte * ampliacao;
    const preenchimento = Math.min(1, pixelsDoCanvas / alvo);
    if (preenchimento > melhorPreenchimento + 1e-9) {
      melhorPreenchimento = preenchimento;
      melhor = { recorte, ampliacao, pixelsDoCanvas, cssPx: pixelsDoCanvas / Math.max(1, dpr) };
    }
  }
  return melhor as MedidaDaCabeca;
}
