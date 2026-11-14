import { describe, expect, it } from "vitest";
import { QUADROS_CACHORRO, quadroCachorro, type PoseCachorro } from "./arteCachorro";
import { QUADROS_CALOPSITA, quadroCalopsita, type PoseCalopsita } from "./arteCalopsita";
import type { Lado, Quadro } from "./arteComum";
import { quadroCoracao, quadroNota, quadroPoleiro, quadroZ } from "./arteEfeitos";
import { QUADROS_GATO, quadroGato, type PoseGato } from "./arteGato";

const LADOS: Lado[] = ["right", "left"];

function todos<P extends string>(quadros: Readonly<Record<P, number>>, f: (p: P, i: number, l: Lado) => Quadro): { nome: string; q: Quadro }[] {
  const out: { nome: string; q: Quadro }[] = [];
  for (const p of Object.keys(quadros) as P[]) for (let i = 0; i < quadros[p]; i++) for (const l of LADOS) out.push({ nome: `${p}#${i}/${l}`, q: f(p, i, l) });
  return out;
}

/** O desenho de verdade (sem as margens do buffer). */
const caixa = (q: Quadro) => q.buf.bounds()!;

describe("a arte dos bichos (feita por código, no sistema do motor)", () => {
  const cat = todos(QUADROS_GATO, (p: PoseGato, i, l) => quadroGato(p, i, l));
  const dog = todos(QUADROS_CACHORRO, (p: PoseCachorro, i, l) => quadroCachorro(p, i, l));
  const bird = todos(QUADROS_CALOPSITA, (p: PoseCalopsita, i, l) => quadroCalopsita(p, i, l));

  it("existem todas as poses do gato (7), do cachorro (7) e da calopsita (6), em todos os quadros e nos dois lados", () => {
    expect(Object.keys(QUADROS_GATO)).toEqual(["anda", "para", "senta", "deita", "dorme", "espreguica", "carinho"]);
    expect(Object.keys(QUADROS_CACHORRO)).toEqual(["anda", "trota", "senta", "deita", "cochila", "abana", "carinho"]);
    expect(Object.keys(QUADROS_CALOPSITA)).toEqual(["parada", "pisca", "frente", "crista", "assobio", "asas"]);
    expect(cat).toHaveLength((4 + 2 + 2 + 2 + 2 + 2 + 2) * 2);
    expect(dog).toHaveLength((4 + 4 + 2 + 2 + 2 + 2 + 2) * 2);
    expect(bird).toHaveLength((1 + 1 + 1 + 1 + 1 + 4) * 2);
    for (const { nome, q } of [...cat, ...dog, ...bird]) {
      expect(q.buf.countOpaque(), nome).toBeGreaterThan(30);
      // a âncora (os pés) fica dentro do desenho
      expect(q.ax, nome).toBeGreaterThan(0);
      expect(q.ax, nome).toBeLessThan(q.buf.w);
      expect(q.ay, nome).toBeGreaterThan(0);
      expect(q.ay, nome).toBeLessThanOrEqual(q.buf.h);
    }
  });

  it("os quadros são os mesmos a cada pedido (cache) e o lado esquerdo é o espelho do direito", () => {
    expect(quadroGato("anda", 1, "right")).toBe(quadroGato("anda", 1, "right"));
    expect(quadroGato("anda", 5, "right")).toBe(quadroGato("anda", 1, "right"));
    const d = quadroCachorro("senta", 0, "right");
    const e = quadroCachorro("senta", 0, "left");
    expect(e.ax).toBe(d.buf.w - 1 - d.ax);
    expect(Array.from(e.buf.data)).toEqual(Array.from(d.buf.flipped().data));
  });

  it("o gato e o cachorro em pé têm de 14 a 22 px de comprimento (corpo de uns 18, mais a cauda e o contorno) (proporcional ao personagem de 24 x 34)", () => {
    for (const q of [quadroGato("anda", 0, "right"), quadroGato("para", 0, "right"), quadroCachorro("anda", 0, "right"), quadroCachorro("trota", 2, "right"), quadroCachorro("abana", 0, "right")]) {
      const b = caixa(q);
      expect(b.w).toBeGreaterThanOrEqual(14);
      expect(b.w).toBeLessThanOrEqual(22);
      expect(b.h).toBeGreaterThanOrEqual(10);
      expect(b.h).toBeLessThanOrEqual(19);
    }
    for (const q of [quadroGato("deita", 0, "right"), quadroGato("dorme", 0, "right"), quadroCachorro("deita", 0, "right"), quadroCachorro("cochila", 0, "right")]) {
      expect(caixa(q).w).toBeGreaterThanOrEqual(14);
      expect(caixa(q).w).toBeLessThanOrEqual(22);
      expect(caixa(q).h).toBeLessThanOrEqual(13);
    }
  });

  it("a calopsita é esguia e de pé, mas pequena: de 14 a 18 px de altura (crista ao fim da cauda, com o contorno), mais alta que larga", () => {
    for (const p of ["parada", "pisca", "crista", "assobio", "frente", "asas"] as const) {
      const b = caixa(quadroCalopsita(p, 0, "right"));
      expect(b.h, p).toBeGreaterThanOrEqual(14);
      expect(b.h, p).toBeLessThanOrEqual(18);
      expect(b.w, p).toBeLessThanOrEqual(13);
      expect(b.h, p).toBeGreaterThan(b.w);
    }
  });

  it("cada quadro da calopsita tem desenho, a âncora cai dentro do buffer e o espelho é um espelho de verdade", () => {
    for (const p of Object.keys(QUADROS_CALOPSITA) as PoseCalopsita[]) {
      for (let i = 0; i < QUADROS_CALOPSITA[p]; i++) {
        const d = quadroCalopsita(p, i, "right");
        const e = quadroCalopsita(p, i, "left");
        expect(d.buf.countOpaque(), `${p}#${i}`).toBeGreaterThan(80);
        expect(d.ax, `${p}#${i} ax`).toBeGreaterThanOrEqual(0);
        expect(d.ax, `${p}#${i} ax`).toBeLessThan(d.buf.w);
        expect(d.ay, `${p}#${i} ay`).toBeGreaterThan(0);
        expect(d.ay, `${p}#${i} ay`).toBeLessThanOrEqual(d.buf.h);
        expect(e.ax).toBe(d.buf.w - 1 - d.ax);
        expect(e.ay).toBe(d.ay);
        for (let y = 0; y < d.buf.h; y++) {
          for (let x = 0; x < d.buf.w; x++) {
            const a = (y * d.buf.w + x) * 4;
            const b = (y * e.buf.w + (d.buf.w - 1 - x)) * 4;
            for (let c = 0; c < 4; c++) expect(e.buf.data[b + c]).toBe(d.buf.data[a + c]);
          }
        }
      }
    }
  });

  it("a cauda da calopsita pende abaixo da âncora (dos pés no poleiro) e a crista fica bem acima", () => {
    const q = quadroCalopsita("parada", 0, "right");
    const b = caixa(q);
    expect(b.y + b.h).toBeGreaterThan(q.ay);
    expect(q.ay - b.y).toBeGreaterThanOrEqual(12);
  });

  it("tem contorno escuro de 1 px (o sistema do motor): o pixel de borda do desenho é escuro, não a cor do corpo", () => {
    for (const q of [quadroGato("para", 0, "right"), quadroCachorro("senta", 0, "right"), quadroCalopsita("parada", 0, "right")]) {
      const b = caixa(q);
      let escuros = 0;
      let borda = 0;
      for (let x = b.x; x < b.x + b.w; x++) {
        // o primeiro pixel opaco de cada coluna, de cima para baixo, é contorno
        for (let y = b.y; y < b.y + b.h; y++) {
          const i = (y * q.buf.w + x) * 4;
          if (q.buf.data[i + 3]! > 200) {
            borda++;
            if (q.buf.data[i]! + q.buf.data[i + 1]! + q.buf.data[i + 2]! < 255) escuros++;
            break;
          }
        }
      }
      expect(escuros / borda).toBeGreaterThan(0.8);
    }
  });

  it("as cores certas: gato laranja, cachorro caramelo, calopsita cinza com crista e bochecha", () => {
    const media = (q: Quadro, filtro: (r: number, g: number, b: number) => boolean) => {
      let n = 0;
      for (let i = 0; i < q.buf.data.length; i += 4) if (q.buf.data[i + 3]! > 200 && filtro(q.buf.data[i]!, q.buf.data[i + 1]!, q.buf.data[i + 2]!)) n++;
      return n;
    };
    const gato = quadroGato("senta", 0, "right");
    expect(media(gato, (r, g, b) => r > 200 && g > 120 && g < 190 && b < 120)).toBeGreaterThan(40);
    const cao = quadroCachorro("senta", 0, "right");
    expect(media(cao, (r, g, b) => r > 190 && g > 140 && g < 180 && b > 80 && b < 130)).toBeGreaterThan(30);
    const ave = quadroCalopsita("parada", 0, "right");
    expect(media(ave, (r, g, b) => Math.abs(r - g) < 14 && Math.abs(g - b) < 22 && r > 120 && r < 190)).toBeGreaterThan(20); // cinza
    expect(media(ave, (r, g, b) => r > 235 && g > 195 && b < 110)).toBeGreaterThan(20); // amarelo
    expect(media(ave, (r, g, b) => r > 220 && g > 110 && g < 140 && b < 80)).toBeGreaterThanOrEqual(3); // bochecha laranja
  });

  it("os quadros de uma animação diferem entre si (a caminhada anda, a calopsita bate as asas e abre o bico)", () => {
    const dist = (a: Quadro, b: Quadro) => Array.from(a.buf.data).reduce((s, v, i) => s + (v === b.buf.data[i] ? 0 : 1), 0);
    expect(dist(quadroGato("anda", 0, "right"), quadroGato("anda", 1, "right"))).toBeGreaterThan(4);
    expect(dist(quadroCachorro("trota", 0, "right"), quadroCachorro("trota", 1, "right"))).toBeGreaterThan(4);
    expect(dist(quadroCalopsita("asas", 0, "right"), quadroCalopsita("asas", 1, "right"))).toBeGreaterThan(4);
    expect(dist(quadroCalopsita("crista", 0, "right"), quadroCalopsita("assobio", 0, "right"))).toBeGreaterThan(0);
    expect(dist(quadroCalopsita("parada", 0, "right"), quadroCalopsita("crista", 0, "right"))).toBeGreaterThan(2);
    expect(dist(quadroCalopsita("parada", 0, "right"), quadroCalopsita("pisca", 0, "right"))).toBeGreaterThan(2);
  });

  it("os extras: coração, balão da nota, 'z' e poleiro existem e são pequenos", () => {
    for (const q of [quadroCoracao(), quadroNota(0), quadroNota(1), quadroZ(0), quadroZ(1), quadroPoleiro()]) {
      expect(q.buf.countOpaque()).toBeGreaterThan(15);
      expect(q.buf.w).toBeLessThanOrEqual(14);
      expect(q.buf.h).toBeLessThanOrEqual(14);
    }
    expect(quadroNota(0)).not.toBe(quadroNota(1));
  });
});
