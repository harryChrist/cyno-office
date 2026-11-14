// A calopsita no estilo do mapa novo: cinza, rosto e crista amarelos, bochecha laranja redonda, faixa branca na asa.
// Desenhada à mão em modelos ASCII (como os móveis do motor), com paleta em rampas e contorno automático.
// De pé no poleiro, esguia, com a crista varrida para trás e a cauda comprida e afilada pendurada atrás.
// Olha para a direita; o espelho vem de `noLado`. Âncora nos pés, no centro.
import { bufDosPes, fechar, noLado, ramp, type Lado, type Quadro } from "./arteComum";

export type PoseCalopsita =
  | "parada" //     de pé, crista relaxada
  | "pisca" //      olho fechado
  | "frente" //     cabeça virada de frente (olha para quem está na tela)
  | "crista" //     crista em pé (surpresa, curiosidade)
  | "assobio" //    crista em pé e bico aberto (a nota musical é outro desenho)
  | "asas"; //      bate as asas no poleiro (4 quadros)

export const QUADROS_CALOPSITA: Readonly<Record<PoseCalopsita, number>> = { parada: 1, pisca: 1, frente: 1, crista: 1, assobio: 1, asas: 4 };

const AMARELO = ramp("#f4d24b");
const CINZA = ramp("#9aa0ab", 0.07);
const LARANJA = "#ee7f34";
const BICO = "#a69b8e";
const BICO_ESCURO = "#6b5e52";
const OLHO = "#1c1a26";
const BRANCO = "#f6f6fa";
const PATA = "#c9a8a0";

const PALETA = {
  Y: AMARELO.base,
  Z: AMARELO.lt,
  y: AMARELO.dk,
  o: LARANJA,
  g: CINZA.base,
  G: CINZA.lt,
  d: CINZA.dk,
  D: CINZA.dd,
  w: BRANCO,
  k: OLHO,
  e: CINZA.dd,
  b: BICO,
  B: BICO_ESCURO,
  l: PATA,
};

type Crista = "baixa" | "normal" | "alta";

// Versão compacta (13/11, pedido do dono: "muito grande"): o mesmo desenho de pé, com crista varrida, bochecha redonda e
// cauda longa, em 10 x 15 px de modelo (antes 13 x 22). No mapa ela fica menor que um agente, do tamanho de um bicho.

/**
 * Crista, 3 linhas acima do crânio. Tufo de penas que nasce na testa (à direita) e varre para trás e para cima:
 * relaxado (deitado para trás), normal (arqueado) ou em pé (surpresa).
 */
const CRISTA: Readonly<Record<Crista, readonly string[]>> = {
  baixa: ["..........", "..yy......", ".yYYYYy..."],
  normal: ["..Yy......", "..YYy.....", "...YYYy..."],
  alta: ["..Y..y....", "..YYyYy...", "...YYYYy.."],
};

/**
 * Cabeça de lado (olhando para a direita), 4 linhas: crânio redondo, olho, bochecha laranja logo atrás e abaixo do
 * olho, bico pequeno e curvo, queixo amarelo que vira pescoço.
 */
function cabeca(olho: "aberto" | "fechado", bico: "fechado" | "aberto"): string[] {
  return [
    "...YYYYy..",
    olho === "aberto" ? "..YYYYkY.." : "..YYYeeY..",
    "..YooYYYbb",
    bico === "fechado" ? "...YoYYyb." : "...YoYYykb",
  ];
}

/** Corpo de lado, esguio e de pé: pescoço amarelo que vira cinza, peito claro, asa escura com a faixa branca, cauda longa. */
const CORPO = ["..gYYYGg..", ".gdGGGGGg.", ".ddwGGGGg.", ".dddwGGg..", ".dDdgGg...", ".dDd.l.l..", "dDd.......", "dD........"];

/** Corpo ao bater as asas: quatro quadros (meio, alto, meio, baixo). Só mudam as linhas das asas. */
const ASA_ALTA = ["d.gYYYGg..", "ddgGGGGGg.", ".dwGGGGGg.", ".ddwGGGg..", ".dDdgGg...", ".dDd.l.l..", "dDd.......", "dD........"];
const ASA_MEIA = ["..gYYYGg..", "dddGGGGGg.", "dddwGGGGg.", ".dd.wGGg..", ".dDdgGg...", ".dDd.l.l..", "dDd.......", "dD........"];
const ASA_BAIXA = ["..gYYYGg..", ".gdGGGGGg.", "ddwwGGGGg.", "dd.wdGGg..", "dd.DdGg...", ".dDd.l.l..", "dDd.......", "dD........"];
/** Ponta da asa levantada (quadro alto): sobe atrás das costas, ao lado da cabeça. */
const ASA_ALTA_PONTA = ["d...", "dd.."];
const CORPO_ASAS: readonly (readonly string[])[] = [ASA_MEIA, ASA_ALTA, ASA_MEIA, ASA_BAIXA];

/** Margem de 1 px em volta (o contorno precisa de espaço): crista 3 linhas, cabeça 4, corpo 8 (com a cauda). */
const LARGURA = 13;
const ALTURA = 18;
/** Âncora nos pés: coluna entre as duas patas, logo abaixo delas (a cauda pende para baixo do poleiro). */
const AX = 7;
const AY = 15;

function perfil(opts: { olho: "aberto" | "fechado"; bico: "fechado" | "aberto"; crista: Crista; corpo?: readonly string[]; asaAlta?: boolean }): Quadro {
  const buf = bufDosPes(LARGURA, ALTURA, 1, 1);
  buf.stamp(CRISTA[opts.crista], 0, 0, PALETA);
  buf.stamp(cabeca(opts.olho, opts.bico), 0, 3, PALETA);
  buf.stamp(opts.corpo ?? CORPO, 0, 7, PALETA);
  if (opts.asaAlta) buf.stamp(ASA_ALTA_PONTA, 0, 5, PALETA);
  return fechar(buf, AX, AY);
}

/** Cabeça virada de frente: dois olhos, duas bochechas, bico no meio; as asas caem dos dois lados e a cauda aparece embaixo. */
function deFrente(): Quadro {
  const buf = bufDosPes(LARGURA, ALTURA, 1, 1);
  buf.stamp(
    ["....Y....", "...YYy...", "..YYYYY..", ".YYYYYYY.", ".YkYYYkY.", ".oYYbYYo.", "..YYbYY..", "..gYYYg..", ".gGGGGGg.", "dwGGGGGwd", "ddGGGGGdd", ".d.GGG.d.", "...lDl...", "...dDd...", "....D...."],
    2,
    0,
    PALETA,
  );
  return fechar(buf, AX, AY);
}

const cache = new Map<string, Quadro>();

/** O quadro da calopsita numa pose; `quadro` é o índice da animação (módulo a quantidade). */
export function quadroCalopsita(pose: PoseCalopsita, quadro: number, lado: Lado): Quadro {
  const n = QUADROS_CALOPSITA[pose];
  const i = ((Math.floor(quadro) % n) + n) % n;
  const key = `${pose}|${i}|${lado}`;
  let q = cache.get(key);
  if (!q) {
    let base: Quadro;
    switch (pose) {
      case "parada":
        base = perfil({ olho: "aberto", bico: "fechado", crista: "normal" });
        break;
      case "pisca":
        base = perfil({ olho: "fechado", bico: "fechado", crista: "baixa" });
        break;
      case "frente":
        base = deFrente();
        break;
      case "crista":
        base = perfil({ olho: "aberto", bico: "fechado", crista: "alta" });
        break;
      case "assobio":
        base = perfil({ olho: "aberto", bico: "aberto", crista: "alta" });
        break;
      case "asas":
        base = perfil({ olho: "aberto", bico: "fechado", crista: "alta", corpo: CORPO_ASAS[i], asaAlta: i === 1 });
        break;
    }
    q = noLado(base, lado);
    cache.set(key, q);
  }
  return q;
}
