// Móveis da Sala do Maestro (arquivo do Cyno, não existe no Habblaud; patch 13): a mesa de chefe com o setup dele.
// Mesma base dos outros móveis (`PixelBuf`, `floorSheet`, rampas e kit de desenho); coordenadas = footprint
// (0,0 no canto superior esquerdo; a base fica em y = h*TILE).
import { ramp, type Ramp } from '../core/color';
import { floorSheet, type BufFurniture } from '../core/sprite';
import type { PixelBuf } from '../core/pixbuf';
import { M, contact, frontFace, pencilCup, topFace, underRect, woodGrain } from './kit';

const GOLD = { hi: '#f4dc92', base: '#d7b25c', dk: '#a8823a' } as const;
/** Nogueira funda do frontal e das laterais (mais escura que o tampo, para o tampo se destacar). */
const FRONT = ramp('#5b4335', 0.06);
const COUCRO = { base: '#3b3531', lt: '#4a433d', dk: '#2a2623', stitch: '#6b6159' } as const;

/** Cores do LED do setup (o brilho do teclado e da torre): rosa, violeta, azul, ciano, verde. */
const RGB = ['#ff4fa8', '#b45cff', '#4f8bff', '#3de0f0', '#5dff9a'] as const;

/** Torre gamer de frente: caixa grafite, painel de vidro com dois ventiladores de LED e frisos. */
function tower(b: PixelBuf, x: number, y: number): void {
  const w = 10;
  const h = 18;
  const body = ramp('#3a3f4e', 0.07);
  // sombra no tampo
  b.hline(x + 2, x + w, y + h + 1, 'rgba(24,18,16,0.32)');
  b.rect(x, y, w, h, body.base);
  b.hline(x, x + w - 1, y, body.hi);
  b.vline(x, y + 1, y + h - 1, body.lt);
  b.vline(x + w - 1, y + 1, y + h - 1, body.dk);
  b.hline(x, x + w - 1, y + h - 1, body.dd);
  // painel de vidro escuro com reflexo diagonal
  b.rect(x + 1, y + 2, w - 3, h - 5, '#1b1f2b');
  b.vline(x + 2, y + 3, y + 5, '#2c3345');
  b.hline(x + 2, x + 3, y + 3, '#2c3345');
  // dois ventiladores com anel de LED
  for (let i = 0; i < 2; i++) {
    const cy = y + 6 + i * 6;
    const cx = x + 4;
    const ring = i === 0 ? '#ff4fa8' : '#3de0f0';
    const dim = i === 0 ? '#9d2f6b' : '#2a8c99';
    b.hline(cx - 1, cx + 1, cy - 2, ring);
    b.hline(cx - 1, cx + 1, cy + 2, dim);
    b.vline(cx - 2, cy - 1, cy + 1, ring);
    b.vline(cx + 2, cy - 1, cy + 1, dim);
    b.set(cx, cy, '#e9edf5');
    b.set(cx - 1, cy - 1, dim);
    b.set(cx + 1, cy + 1, dim);
  }
  // botão de ligar aceso e grade de ventilação no topo
  b.set(x + w - 3, y + 1, '#5fd07a');
  b.hline(x + 2, x + 5, y + 1, body.dd);
  // pezinhos
  b.set(x + 1, y + h, body.dd);
  b.set(x + w - 2, y + h, body.dd);
}

/** Monitor ultrawide curvo visto por trás (de frente para o Maestro): carcaça escura, VESA, pé e tira de LED. */
function ultrawideBack(b: PixelBuf, x: number, y: number, w: number, h: number): void {
  const p = { hi: '#6a7183', lt: '#4f566a', base: '#3c4152', dk: '#2c303d', line: '#1c1f29', foot: '#262a36' };
  const cx = x + Math.floor(w / 2);
  // luz do LED espalhada no tampo, na frente e nos lados do monitor (atrás dele, para o Maestro)
  for (let i = 0; i < w - 2; i++) b.set(x + 1 + i, y + h + 3, `rgba(${rgbOf(RGB[Math.floor((i / (w - 2)) * RGB.length)])},0.34)`);
  // pé (base achatada + pescoço)
  b.rect(cx - 6, y + h + 1, 12, 2, p.foot);
  b.hline(cx - 6, cx + 5, y + h + 1, '#575e72');
  b.rect(cx - 1, y + h - 1, 3, 3, '#4b5164');
  // carcaça curva: cantos cortados, mais fina nas pontas
  b.rect(x, y, w, h, p.base);
  b.hline(x + 1, x + w - 2, y, p.hi);
  b.hline(x + 1, x + w - 2, y + 1, p.lt);
  b.vline(x, y + 1, y + h - 2, p.lt);
  b.vline(x + w - 1, y + 1, y + h - 2, p.dk);
  b.hline(x + 1, x + w - 2, y + h - 1, p.dk);
  b.clear(x, y);
  b.clear(x + w - 1, y);
  // grade de ventilação e ressalto do suporte
  for (let xx = x + 4; xx <= x + w - 5; xx += 3) {
    b.hline(xx, xx + 1, y + 2, p.dk);
  }
  b.rect(cx - 3, y + 3, 7, h - 5, p.lt);
  b.hline(cx - 3, cx + 3, y + 3, p.hi);
  b.hline(cx - 3, cx + 3, y + h - 3, p.dk);
  b.set(cx - 1, y + 4, '#cfd5e2');
  b.set(cx, y + 4, '#cfd5e2');
  // tira de LED colada à borda de baixo (o degradê do setup)
  for (let i = 0; i < w - 2; i++) b.set(x + 1 + i, y + h - 1, RGB[Math.floor((i / (w - 2)) * RGB.length)]);
}

function rgbOf(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`;
}

/** Corpo da mesa: frontal com três almofadas, friso dourado, tampo de nogueira com veios e beiral. */
function body(b: PixelBuf, top: Ramp, seed: number): void {
  const W = 64;
  // frontal (voltado para quem visita) e plinto
  frontFace(b, 1, 7, W - 2, 9, FRONT);
  b.hline(1, W - 2, 15, FRONT.dd);
  // três almofadas rebaixadas
  for (const px of [4, 23, 42]) {
    b.rect(px, 10, 18, 4, FRONT.dk);
    b.rect(px + 1, 10, 16, 3, FRONT.lt);
    b.hline(px + 1, px + 16, 10, FRONT.hi);
    b.vline(px + 17, 10, 13, FRONT.dd);
  }
  // plaquinha dourada ao centro
  b.rect(28, 11, 8, 2, GOLD.base);
  b.hline(28, 35, 11, GOLD.hi);
  b.hline(28, 35, 12, GOLD.dk);
  // laterais (pés) em bloco
  for (const x of [0, W - 3]) {
    b.rect(x, 8, 3, 8, FRONT.base);
    b.vline(x, 8, 15, FRONT.lt);
    b.vline(x + 2, 8, 15, FRONT.dk);
    b.hline(x, x + 2, 15, FRONT.dd);
  }
  // tampo: 12 linhas de nogueira + beiral com friso dourado
  topFace(b, 0, -6, W, 12, top);
  woodGrain(b, 1, -5, W - 2, 10, top, seed);
  b.hline(0, W - 1, 6, '#6a4d3b');
  b.hline(0, W - 1, 7, GOLD.dk);
  b.hline(1, W - 2, 7, GOLD.base);
  b.set(0, 6, top.hi);
}

/** Mesa de chefe (4x1): o balcão de nogueira com o setup do Maestro. O Maestro senta ao norte, de frente para a câmera. */
export function bossDesk(seed: number): BufFurniture {
  const s = floorSheet(4, 1, 26);
  const b = s.buf;
  body(b, M.walnut, seed);
  // mata-borrão de couro sob o setup
  b.rect(16, -4, 33, 9, COUCRO.base);
  b.hline(16, 48, -4, COUCRO.lt);
  b.hline(16, 48, 4, COUCRO.dk);
  b.vline(16, -3, 3, COUCRO.lt);
  b.vline(48, -3, 3, COUCRO.dk);
  for (let x = 18; x < 47; x += 2) b.set(x, -3, COUCRO.stitch);
  // torre à esquerda, porta-lápis e o ultrawide ao centro
  tower(b, 3, -15);
  pencilCup(b, 13, -1);
  ultrawideBack(b, 19, -9, 30, 10);
  // a ponta direita fica livre (o poleiro da calopsita)
  b.outline();
  underRect(b, 3, 8, 58, 7, 'rgba(30,34,52,0.2)');
  contact(b, -1, 13, 66, 4, 0.2);
  return { base: s };
}
