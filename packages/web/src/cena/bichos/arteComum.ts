// Peças comuns da arte dos bichos do escritório (puro: só buffers de pixels, sem DOM). Os desenhos são feitos por
// código com a base `PixelBuf` do motor de cena, no mesmo sistema dos personagens e móveis: pixel em 1x (a câmera
// amplia), cores em rampas de cinco tons (luz de cima, sombra puxada para o azul) e contorno automático de 1 px.
import { PixelBuf, ramp, shade, type Ramp } from "@cyno/cena/arte";

export { PixelBuf, ramp, shade };
export type { Ramp };

export type Lado = "left" | "right";

/** Um quadro pronto: o buffer e a âncora (px do buffer) nos pés do bicho, no centro. */
export interface Quadro {
  buf: PixelBuf;
  ax: number;
  ay: number;
}

/** Os desenhos olham para a direita; para a esquerda, espelha-se o quadro inteiro (e a âncora junto). */
export function espelhar(q: Quadro): Quadro {
  return { buf: q.buf.flipped(), ax: q.buf.w - 1 - q.ax, ay: q.ay };
}

/** Escolhe o lado: o quadro como foi desenhado (direita) ou o espelho (esquerda). */
export function noLado(q: Quadro, lado: Lado): Quadro {
  return lado === "right" ? q : espelhar(q);
}

/** Cria um buffer com a origem de desenho nos pés: (0, 0) é o ponto dos pés; y negativo é para cima. */
export function bufDosPes(w: number, h: number, ax: number, ay: number): PixelBuf {
  const buf = new PixelBuf(w, h);
  buf.ox = ax;
  buf.oy = ay;
  return buf;
}

/** Fecha o quadro: contorno de 1 px em volta de tudo o que foi pintado. A origem do buffer volta a zero. */
export function fechar(buf: PixelBuf, ax: number, ay: number): Quadro {
  buf.ox = 0;
  buf.oy = 0;
  buf.outline();
  return { buf, ax, ay };
}

/** Pinta uma elipse sombreada: base, luz no alto à esquerda e sombra embaixo (rampa). */
export function elipseSombreada(buf: PixelBuf, cx: number, cy: number, rx: number, ry: number, r: Ramp, opts: { luz?: boolean; sombra?: boolean } = {}): void {
  const luz = opts.luz ?? true;
  const sombra = opts.sombra ?? true;
  for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) {
    for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
      const nx = (x + 0.5 - cx) / rx;
      const ny = (y + 0.5 - cy) / ry;
      const d = nx * nx + ny * ny;
      if (d > 1) continue;
      let c = r.base;
      if (sombra && (ny > 0.38 || nx < -0.62 || d > 0.82) && ny > -0.2) c = r.dk;
      else if (luz && ny < -0.45 && nx < 0.3) c = r.lt;
      buf.set(x, y, c);
    }
  }
}

/** Hash simples e estável de texto (para desempatar sementes). */
export function hashTexto(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Gerador de números pseudoaleatórios determinístico (mulberry32): o mesmo valor inicial dá a mesma sequência. */
export function mulberry32(semente: number): () => number {
  let a = semente >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
