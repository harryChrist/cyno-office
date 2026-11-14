// O cachorro caramelo no estilo do mapa novo: cabeça grande de frente (orelhas caídas, focinho claro, nariz escuro)
// sobre o corpo de lado; sentado, é o cachorro de frente. Modelos ASCII à mão, paleta em rampas, contorno
// automático. Olha para a direita; o espelho vem de `noLado`. Âncora nos pés, no centro.
import { bufDosPes, fechar, noLado, ramp, type Lado, type PixelBuf, type Quadro } from "./arteComum";

export type PoseCachorro = "anda" | "trota" | "senta" | "deita" | "cochila" | "abana" | "carinho";

export const QUADROS_CACHORRO: Readonly<Record<PoseCachorro, number>> = { anda: 4, trota: 4, senta: 2, deita: 2, cochila: 2, abana: 2, carinho: 2 };

const CARAMELO = ramp("#dba264", 0.075);
const CLARO = "#f6dfb8";
const OLHO = "#241e2a";

const PALETA = {
  O: CARAMELO.base,
  o: CARAMELO.lt,
  B: CARAMELO.dk,
  D: "#a8693a",
  L: CLARO,
  W: "#f9e8c9",
  n: "#2c2429",
  k: OLHO,
  e: CARAMELO.dd,
  t: "#e8707f",
};

type Cabeca = "aberta" | "fechada" | "feliz";
/** Cabeça de frente, 7 x 6: orelhas caídas nos lados, olhos juntos, focinho claro com o nariz escuro. */
const CABECAS: Readonly<Record<Cabeca, readonly string[]>> = {
  aberta: [".OOOOO.", "DOOOOOD", "DOkOkOD", "DOkOkOD", "DOWnWOD", ".OWWWO."],
  fechada: [".OOOOO.", "DOOOOOD", "DOOOOOD", "DOeOeOD", "DOWnWOD", ".OWWWO."],
  feliz: [".OOOOO.", "DOOOOOD", "DOkOkOD", "DOOOOOD", "DOWnWOD", ".OWtWO."],
};

/** Corpo de lado, sem as pernas: costas, barriga clara; 11 colunas x 5 linhas. */
const CORPO_LADO = ["..OOOOOOOO.", ".OOOOOOOOOO", "OOOOOOOOOOO", "OOOLLLLLOOO", ".OOOLLLLOO."];

const LARGURA = 24;
const ALTURA = 22;
const AX = 12;
const AY = 19;

function novo(): PixelBuf {
  return bufDosPes(LARGURA, ALTURA, AX, AY);
}

/** Uma perna de 2 px: `h` linhas, patinha clara. */
function perna(buf: PixelBuf, x: number, y: number, h: number): void {
  buf.rect(x, y, 2, h, PALETA.O);
  buf.set(x, y + h - 1, PALETA.L);
  buf.set(x + 1, y + h - 1, PALETA.L);
  buf.set(x, y, PALETA.B);
}

/** Rabo curto e grosso subindo; `balanco` (-2..2) joga a ponta de um lado ao outro (abanar). */
function rabo(buf: PixelBuf, x: number, y: number, balanco: number): void {
  buf.set(x, y, PALETA.O);
  buf.set(x - 1, y - 1, PALETA.O);
  buf.set(x - 1 + (balanco > 0 ? 1 : 0), y - 2, PALETA.B);
  buf.set(x - 2 + balanco, y - 3, PALETA.O);
  buf.set(x - 1 + balanco, y - 3, PALETA.B);
}

/** Em pé, andando ou trotando: o ciclo de quatro quadros (pernas em diagonal), rabo balançando. */
function emPe(ciclo: number, modo: "para" | "anda" | "trota", balanco: number, cabeca: Cabeca = "aberta"): Quadro {
  const buf = novo();
  const sobe = modo === "trota" ? 1 : 0;
  buf.stamp(CORPO_LADO, -8, -9 - (modo === "trota" && ciclo % 2 === 1 ? 1 : 0), PALETA);
  buf.stamp(CABECAS[cabeca], 2, -14 - (modo === "trota" && ciclo % 2 === 1 ? 1 : 0), PALETA);
  const passo = modo === "para" ? 0 : [0, 1, 0, -1][ciclo % 4] ?? 0;
  const alta = modo === "para" ? false : [false, true, false, true][ciclo % 4] ?? false;
  const h = (lev: boolean) => (lev ? 3 - sobe * 0 : 4);
  perna(buf, -7 + passo, -4, h(alta));
  perna(buf, -4 - passo, -4, h(!alta && modo !== "para"));
  perna(buf, -1 - passo, -4, h(alta && modo === "trota"));
  perna(buf, 1 + passo, -4, h(modo !== "para" && !alta));
  rabo(buf, -8, -9, balanco);
  return fechar(buf, AX, AY);
}

/** Sentado, de frente: cabeça, peito claro, patinhas na frente, rabo abanando no chão ao lado. */
function sentado(balanco: number, cabeca: Cabeca): Quadro {
  const buf = novo();
  buf.stamp(CABECAS[cabeca], -3, -17, PALETA);
  buf.stamp(["..OOOOO..", ".OOLLLOO.", ".OOLLLOO.", "OOOLLLOOO", "OOOLLLOOO", "OOWOOOWOO", "OWWOOOWWO"], -4, -11, PALETA);
  const x = 5 + (balanco ? 1 : 0);
  buf.stamp(["OO.", ".BO"], x, -4, PALETA);
  return fechar(buf, AX, AY);
}

/** Deitado de peito no chão, cabeça erguida à direita, rabo mexendo atrás. */
function deitado(cabeca: Cabeca, balanco: number): Quadro {
  const buf = novo();
  buf.stamp(["..OOOOOOOO.", ".OOOOOOOOOO", "OOOOOOOOOOO", "OOOLLLLOOOO"], -9, -6, PALETA);
  buf.stamp(CABECAS[cabeca], 0, -10, PALETA);
  buf.stamp(["WW", "WW"], 3, -4, PALETA);
  buf.stamp(["OB", ".O"], -11 + balanco, -3, PALETA);
  return fechar(buf, AX, AY);
}

/** Cochilando: deitado, queixo apoiado nas patas, olhos fechados; o peito sobe e desce. */
function cochilando(respira: number): Quadro {
  const buf = novo();
  const h = respira ? 1 : 0;
  buf.stamp(["..OOOOOOOO.", ".OOOOOOOOOO", "OOOOOOOOOOO", "OOOLLLLOOOO"], -9, -6 - h, PALETA);
  buf.stamp(CABECAS.fechada, 1, -8, PALETA);
  buf.stamp(["WWW", "OOO"], 1, -3, PALETA);
  buf.stamp(["OB", ".O"], -11, -3, PALETA);
  return fechar(buf, AX, AY);
}

const cache = new Map<string, Quadro>();

/** O quadro do cachorro numa pose; `quadro` é o índice da animação (módulo a quantidade). */
export function quadroCachorro(pose: PoseCachorro, quadro: number, lado: Lado): Quadro {
  const n = QUADROS_CACHORRO[pose];
  const i = ((Math.floor(quadro) % n) + n) % n;
  const key = `${pose}|${i}|${lado}`;
  let q = cache.get(key);
  if (!q) {
    let base: Quadro;
    switch (pose) {
      case "anda":
        base = emPe(i, "anda", 0);
        break;
      case "trota":
        base = emPe(i, "trota", i % 2 ? 1 : -1);
        break;
      case "senta":
        base = sentado(i, "aberta");
        break;
      case "deita":
        base = deitado(i === 0 ? "aberta" : "fechada", i);
        break;
      case "cochila":
        base = cochilando(i);
        break;
      case "abana":
        base = emPe(0, "para", i === 0 ? -2 : 2);
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
