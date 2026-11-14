// O gato laranja no estilo do mapa novo: cabeça grande de frente (orelhas, olhos, focinho claro) sobre o corpo de
// lado; sentado, é o gato de frente. Modelos ASCII à mão, paleta em rampas, contorno automático. Olha para a
// direita; o espelho vem de `noLado`. Âncora nos pés, no centro.
import { bufDosPes, fechar, noLado, ramp, type Lado, type PixelBuf, type Quadro } from "./arteComum";

export type PoseGato = "anda" | "para" | "senta" | "deita" | "dorme" | "espreguica" | "carinho";

export const QUADROS_GATO: Readonly<Record<PoseGato, number>> = { anda: 4, para: 2, senta: 2, deita: 2, dorme: 2, espreguica: 2, carinho: 2 };

const LARANJA = ramp("#ee9b4f", 0.075);
const CLARO = "#f9d9a6";
const FOCINHO = "#fcecd2";
const ROSA = "#ef9aa6";
const OLHO = "#272130";

const PALETA = {
  O: LARANJA.base,
  o: LARANJA.lt,
  B: LARANJA.dk,
  D: LARANJA.dd,
  L: CLARO,
  W: FOCINHO,
  p: ROSA,
  n: "#e0788a",
  k: OLHO,
  e: LARANJA.dd,
  y: "#b2d8a4",
};

/** Cabeça de frente, 7 x 6: orelhas com o rosa por dentro, olhos de 1 x 2, nariz, focinho claro. */
const CABECA_ABERTA = ["O.....O", "OpO.OpO", "OOOOOOO", "OkOOOkO", "OkOnOkO", ".OWWWO."];
/** Olhos fechados (sono, carinho): só um traço escuro. */
const CABECA_FECHADA = ["O.....O", "OpO.OpO", "OOOOOOO", "OOOOOOO", "OeOnOeO", ".OWWWO."];
/** Olhos felizes (carinho): arcos para cima. */
const CABECA_FELIZ = ["O.....O", "OpO.OpO", "OOOOOOO", "OkOOOkO", "OOOnOOO", ".OWWWO."];

/**
 * Corpo de lado, sem as pernas: costas listradas, barriga clara, 11 colunas x 5 linhas (a cabeça se encaixa à
 * direita; a cauda sai pela esquerda).
 */
const CORPO_LADO = ["..BOBOBOOO.", ".BOOBOOBOOO", "BOOOOOOOOOO", "OOOLLLLLOOO", ".OOOLLLLOO."];

type Cabeca = "aberta" | "fechada" | "feliz";
const CABECAS: Readonly<Record<Cabeca, readonly string[]>> = { aberta: CABECA_ABERTA, fechada: CABECA_FECHADA, feliz: CABECA_FELIZ };

/** Uma perna de 2 px: `h` linhas de altura, patinha clara embaixo. */
function perna(buf: PixelBuf, x: number, y: number, h: number): void {
  buf.rect(x, y, 2, h, PALETA.O);
  buf.set(x, y + h - 1, PALETA.L);
  buf.set(x + 1, y + h - 1, PALETA.L);
  buf.set(x, y, PALETA.B);
}

/** Cauda: de baixo para cima, curvando; `balanco` -1, 0 ou 1 empurra a ponta. */
function cauda(buf: PixelBuf, x: number, y: number, balanco: number, altura = 5): void {
  for (let i = 0; i < altura; i++) {
    const dx = i >= altura - 2 ? balanco : 0;
    buf.set(x + dx, y - i, i % 2 === 0 ? PALETA.O : PALETA.B);
    if (i < altura - 1) buf.set(x + 1 + dx, y - i, PALETA.O);
  }
  buf.set(x + balanco, y - altura, PALETA.D);
}

const LARGURA = 24;
const ALTURA = 22;
/** Tudo é desenhado com a origem nos pés (o centro do corpo): coordenadas relativas, y negativo é para cima. */
const AX = 12;
const AY = 19;

function novo(): PixelBuf {
  return bufDosPes(LARGURA, ALTURA, AX, AY);
}

/** Em pé ou andando: quadro 0..3 do ciclo (pernas em diagonal) e balanço da cauda. */
function emPe(ciclo: number, andando: boolean, balanco: number, cabeca: Cabeca = "aberta"): Quadro {
  const buf = novo();
  // corpo e cabeça
  buf.stamp(CORPO_LADO, -8, -9, PALETA);
  buf.stamp(CABECAS[cabeca], 2, -14, PALETA);
  // pernas (traseiras à esquerda, dianteiras à direita)
  const passo = andando ? ([0, 1, 0, -1][ciclo % 4] ?? 0) : 0;
  const alta = andando ? ([false, true, false, true][ciclo % 4] ?? false) : false;
  perna(buf, -7 + passo, -4, alta ? 3 : 4);
  perna(buf, -4 - passo, -4, !alta && andando ? 3 : 4);
  perna(buf, -1 - passo, -4, alta ? 4 : andando ? 3 : 4);
  perna(buf, 1 + passo, -4, alta ? 3 : 4);
  cauda(buf, -9, -9, balanco);
  return fechar(buf, AX, AY);
}

/** Sentado, de frente: cabeça no alto, peito claro, patinhas na frente, cauda enrolada ao lado. */
function sentado(balanco: number, cabeca: Cabeca): Quadro {
  const buf = novo();
  buf.stamp(CABECAS[cabeca], -3, -17, PALETA);
  buf.stamp(["..OOOOO..", ".OOLLLOO.", ".OOLLLOO.", "OOOLLLOOO", "OOOLLLOOO", "OBOWOWOBO", "OOWWOWWOO"], -4, -11, PALETA);
  // cauda enrolada à direita, subindo
  buf.stamp(["..OO", ".OBO", ".OB.", "OB.."], 4, -7, PALETA);
  buf.set(7 + balanco, -9, PALETA.D);
  buf.set(7 + balanco, -10, PALETA.B);
  return fechar(buf, AX, AY);
}

/** Deitado como um pão: cabeça erguida à direita, patas dobradas, cauda ao longo do corpo. */
function deitado(cabeca: Cabeca, balanco: number): Quadro {
  const buf = novo();
  buf.stamp(["..BOBOBOOO.", ".BOOBOOBOOO", "BOOOOOOOOOO", "OOOOLLLOOOO"], -9, -6, PALETA);
  buf.stamp(CABECAS[cabeca], 0, -10, PALETA);
  buf.stamp(["WW", "WW"], 3, -4, PALETA);
  // cauda deitada atrás, ponta mexendo
  buf.stamp(["OBOB", "..OD"], -13, -2, PALETA);
  buf.set(-14 + balanco, -2, PALETA.D);
  return fechar(buf, AX, AY);
}

/** Enrolado dormindo: uma bola com a cabeça aninhada, orelha para cima, cauda em volta; a barriga sobe e desce. */
function dormindo(respira: number): Quadro {
  const buf = novo();
  const h = respira ? 1 : 0;
  buf.stamp(["..BOBOBOBO..", ".BOOBOOBOOB.", "BOOOOOOOOOOB", "OOLLLOOOOOOO", "OOLLLLOOBOOO", ".OOOOOOOOOO.", "..DDBBBBDD.."], -6, -7 - h, PALETA);
  // cabeça apoiada na frente: orelhas, olho fechado
  buf.stamp(["O...O", "OpOpO", "OOOOO", "OeOnO"], 2, -9 - h, PALETA);
  return fechar(buf, AX, AY);
}

/** Espreguiçando: patas da frente esticadas à frente, o bumbum para cima e a cauda em pé. */
function espreguicando(quadro: number): Quadro {
  const buf = novo();
  const alto = quadro % 2 === 0;
  buf.stamp(["...BOBOBOO.", "..BOOBOOBOO", ".BOOOOOOOOO", "BOOOOLLOOO."], -9, alto ? -11 : -10, PALETA);
  // traseiras em pé, dianteiras esticadas
  perna(buf, -8, alto ? -7 : -6, alto ? 4 : 3);
  perna(buf, -5, alto ? -7 : -6, alto ? 4 : 3);
  buf.stamp(CABECAS.fechada, 2, -9, PALETA);
  buf.stamp(["OOOOOO", "OLLLLL"], 0, -3, PALETA);
  cauda(buf, -9, alto ? -11 : -10, alto ? 1 : 0, 4);
  return fechar(buf, AX, AY);
}

const cache = new Map<string, Quadro>();

/** O quadro do gato numa pose; `quadro` é o índice da animação (módulo a quantidade). */
export function quadroGato(pose: PoseGato, quadro: number, lado: Lado): Quadro {
  const n = QUADROS_GATO[pose];
  const i = ((Math.floor(quadro) % n) + n) % n;
  const key = `${pose}|${i}|${lado}`;
  let q = cache.get(key);
  if (!q) {
    let base: Quadro;
    switch (pose) {
      case "anda":
        base = emPe(i, true, [0, 1, 0, -1][i] ?? 0);
        break;
      case "para":
        base = emPe(0, false, i === 0 ? 0 : 1);
        break;
      case "senta":
        base = sentado(i === 0 ? 0 : 1, "aberta");
        break;
      case "deita":
        base = deitado(i === 0 ? "aberta" : "fechada", i);
        break;
      case "dorme":
        base = dormindo(i);
        break;
      case "espreguica":
        base = espreguicando(i);
        break;
      case "carinho":
        base = sentado(i, "feliz");
        break;
    }
    q = noLado(base, lado);
    cache.set(key, q);
  }
  return q;
}
