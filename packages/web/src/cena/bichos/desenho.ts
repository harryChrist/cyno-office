// Do quadro em buffer de pixels para um canvas 2D (única parte da arte dos bichos que usa o DOM).
import type { Quadro } from "./arteComum";

export interface QuadroDesenhavel {
  canvas: HTMLCanvasElement;
  ax: number;
  ay: number;
}

const memo = new WeakMap<Quadro, QuadroDesenhavel>();

/** Converte (com cache por quadro) o buffer de pixels num canvas do tamanho exato dele. */
export function paraCanvas(q: Quadro): QuadroDesenhavel {
  let d = memo.get(q);
  if (d) return d;
  const canvas = document.createElement("canvas");
  canvas.width = q.buf.w;
  canvas.height = q.buf.h;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(q.buf.w, q.buf.h);
  img.data.set(q.buf.data);
  ctx.putImageData(img, 0, 0);
  d = { canvas, ax: q.ax, ay: q.ay };
  memo.set(q, d);
  return d;
}
