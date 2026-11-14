// Os pequenos desenhos que acompanham os bichos: o coração do carinho, o balãozinho com a nota do assobio, o "z" do
// sono e o poleirinho da calopsita. Mesmo sistema da arte dos bichos (modelos ASCII, rampas, contorno automático).
import { bufDosPes, fechar, ramp, type Quadro } from "./arteComum";

const MADEIRA = ramp("#b07c4c", 0.08);

const PALETA = {
  R: "#e8566e",
  r: "#f58fa0",
  d: "#b73a55",
  W: "#fdfdff",
  g: "#dfe2ee",
  N: "#3d3656",
  z: "#cfe2ff",
  Z: "#8fb2e8",
  m: MADEIRA.base,
  M: MADEIRA.lt,
  n: MADEIRA.dk,
  q: MADEIRA.dd,
  s: "#8a8fa6",
};

const cache = new Map<string, Quadro>();
const guardar = (k: string, f: () => Quadro): Quadro => {
  let q = cache.get(k);
  if (!q) cache.set(k, (q = f()));
  return q;
};

/** O coração do carinho: 7 x 6, âncora na ponta de baixo. */
export function quadroCoracao(): Quadro {
  return guardar("coracao", () => {
    const buf = bufDosPes(9, 8, 1, 1);
    buf.stamp([".RR.RR.", "RrRRRRd", "RRRRRRd", ".RRRRd.", "..RRd..", "...d..."], 0, 0, PALETA);
    return fechar(buf, 4, 7);
  });
}

/** O balãozinho do assobio, com a nota musical: dois quadros (a nota balança). 9 x 9, âncora na pontinha do balão. */
export function quadroNota(i: number): Quadro {
  const n = ((i % 2) + 2) % 2;
  return guardar(`nota${n}`, () => {
    const buf = bufDosPes(11, 11, 1, 1);
    buf.stamp([".WWWWWWW.", "WWWWWWWWW", "WWWWWWWWW", "WWWWWWWWW", "WWWWWWWWW", "WWWWWWWWg", ".WWWWWWgg"], 0, 0, PALETA);
    buf.stamp(["gg.", "WWg"], 1, 7, PALETA);
    // a nota (colcheia); no segundo quadro desce um pixel
    buf.stamp(["..NNN", "..N.N", "..N..", "..N..", "NNN..", "NN..."], 2, 1 + n, PALETA);
    return fechar(buf, 3, 8);
  });
}

/** O "z" do sono: dois tamanhos que sobem (i = 0 pequeno, 1 grande). */
export function quadroZ(i: number): Quadro {
  const n = ((i % 2) + 2) % 2;
  return guardar(`z${n}`, () => {
    const buf = bufDosPes(9, 9, 1, 1);
    if (n === 0) buf.stamp(["zzz", "..Z", ".Z.", "zzz"].map((r) => r.replace(/z/g, "Z")), 0, 0, PALETA);
    else buf.stamp(["ZZZZ", "..Z.", ".Z..", "ZZZZ"], 0, 0, PALETA);
    return fechar(buf, 2, 4);
  });
}

/**
 * O poleirinho: barra de madeira sobre um pé de disco. A âncora fica no meio do topo da barra, onde a calopsita
 * pisa. 12 x 12.
 */
export function quadroPoleiro(): Quadro {
  return guardar("poleiro", () => {
    const buf = bufDosPes(13, 11, 1, 1);
    buf.stamp(["MMMMMMMMMMM", "mmmmmmmmmmm", ".....n.....", ".....n.....", ".....n.....", "...nnmmn...", "..nmmmmmmn."], 0, 0, PALETA);
    return fechar(buf, 6, 1);
  });
}
