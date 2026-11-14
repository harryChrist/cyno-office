import type { ForYouTypeIcon } from "@cyno/shared";

/** Círculo como trecho de path (dois arcos), para todo ícone caber numa lista de `d`. */
export function circlePath(cx: number, cy: number, r: number): string {
  return `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`;
}

/** Retângulo de cantos arredondados como path. */
export function roundRectPath(x: number, y: number, w: number, h: number, r: number): string {
  const iw = w - 2 * r;
  const ih = h - 2 * r;
  return `M${x + r} ${y}h${iw}a${r} ${r} 0 0 1 ${r} ${r}v${ih}a${r} ${r} 0 0 1 ${-r} ${r}h${-iw}a${r} ${r} 0 0 1 ${-r} ${-r}v${-ih}a${r} ${r} 0 0 1 ${r} ${-r}z`;
}

/**
 * Galeria de ícones dos tipos (a lista de nomes é fixa e mora no shared: FOR_YOU_TYPE_ICONS).
 * Grade 24×24, traço no estilo Lucide; cada ícone é uma lista de `d`.
 */
export const TYPE_ICON_PATHS = {
  interrogacao: [circlePath(12, 12, 9), "M9.5 9a2.5 2.5 0 0 1 4.9.7c0 1.7-2.4 2.3-2.4 3.8", "M12 17h.01"],
  pessoa: [circlePath(12, 8, 4), "M4 21c0-4 4-6 8-6s8 2 8 6"],
  "pessoa-mais": [circlePath(9, 8, 4), "M2 21c0-4 3-6 7-6s7 2 7 6", "M19 8v6M16 11h6"],
  sorriso: [circlePath(12, 12, 9), "M8 14c1 1.5 2.4 2 4 2s3-.5 4-2", "M9 9h.01M15 9h.01"],
  balao: ["M21 12a8 8 0 0 1-11.6 7.1L4 21l1.9-5.4A8 8 0 1 1 21 12z"],
  responder: ["M9 14 4 9l5-5", "M4 9h10a6 6 0 0 1 6 6v5"],
  comentario: ["M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z", "M7 8h10M7 12h6"],
  pagina: ["M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z", "M14 3v6h6M8 13h8M8 17h5"],
  ponto: [circlePath(12, 12, 3)],
  video: [roundRectPath(2, 6, 14, 12, 2), "M16 10.5 22 7v10l-6-3.5"],
  imagem: [roundRectPath(3, 3, 18, 18, 2), circlePath(9, 9, 2), "M21 15l-3.1-3.1a2 2 0 0 0-2.8 0L6 21"],
  email: [roundRectPath(2, 4, 20, 16, 2), "M22 7l-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"],
  calendario: [roundRectPath(3, 4, 18, 18, 2), "M16 2v4M8 2v4M3 10h18"],
  link: ["M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71", "M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"],
  estrela: ["M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z"],
  grafico: ["M3 3v18h18", "M18 17V9M13 17V5M8 17v-3"],
  megafone: ["M3 11l18-5v12L3 14z", "M11.6 16.8a3 3 0 1 1-5.8-1.6"],
  documento: [roundRectPath(8, 2, 8, 4, 1), "M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2", "M9 12h6M9 16h4"],
  codigo: ["M16 18l6-6-6-6", "M8 6l-6 6 6 6"],
  bug: [
    "M9 7.13v-1a3 3 0 1 1 6 0v1",
    "M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6",
    "M12 20v-9",
    "M6.53 9C4.6 8.8 3 7.1 3 5M6 13H2M3 21c0-2.1 1.7-3.9 3.8-4",
    "M20.97 5c0 2.1-1.6 3.8-3.5 4M22 13h-4M17.2 17c2.1.1 3.8 1.9 3.8 4",
  ],
  carrinho: [circlePath(8, 21, 1), circlePath(19, 21, 1), "M2 2h2l2.7 12.4a2 2 0 0 0 2 1.6h9.7a2 2 0 0 0 2-1.6L22 7H5.1"],
  telefone: [
    "M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.9.6 2.8.7a2 2 0 0 1 1.7 2z",
  ],
  local: ["M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z", circlePath(12, 10, 3)],
  lampada: ["M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5", "M9 18h6M10 22h4"],
  hashtag: ["M4 9h16M4 15h16", "M10 3 8 21M16 3l-2 18"],
  arroba: [circlePath(12, 12, 4), "M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8"],
  marcador: ["M19 21l-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"],
  coracao: ["M19 14c1.5-1.5 3-3.2 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.8 0-3 .5-4.5 2-1.5-1.5-2.7-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4 3 5.5l7 7z"],
  bandeira: ["M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z", "M4 22v-7"],
  escudo: ["M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"],
  globo: [circlePath(12, 12, 10), "M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20", "M2 12h20"],
  pessoas: ["M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2", circlePath(9, 7, 4), "M22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"],
  maleta: [roundRectPath(2, 7, 20, 14, 2), "M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"],
} satisfies Record<ForYouTypeIcon, readonly string[]>;

/** Ícones de traço do "Para você": a galeria dos tipos mais os das ações e avisos. */
export const ICON_PATHS = {
  ...TYPE_ICON_PATHS,
  todos: ["M4 6h16M4 12h16M4 18h16"],
  check: ["M20 6 9 17l-5-5"],
  cross: ["M18 6 6 18M6 6l12 12"],
  alert: ["M12 3 2 20h20z", "M12 10v4M12 17h.01"],
  copy: [roundRectPath(9, 9, 12, 12, 2), "M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"],
  reopen: ["M3 12a9 9 0 1 0 3-6.7L3 8", "M3 3v5h5"],
  undo: ["M9 14 4 9l5-5", "M4 9h11a5 5 0 0 1 0 10h-3"],
  agent: [roundRectPath(4, 7, 16, 12, 3), "M12 3v4M9 13h.01M15 13h.01"],
  clock: [circlePath(12, 12, 9), "M12 7v5l3 2"],
  pencil: ["M4 20h4L19 9l-4-4L4 16z"],
  gear: [circlePath(12, 12, 3), "M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"],
  merge: [circlePath(18, 18, 3), circlePath(6, 6, 3), "M6 21V9a9 9 0 0 0 9 9"],
  trash: ["M3 6h18", "M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6", "M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"],
  plus: ["M12 5v14M5 12h14"],
  back: ["M15 18l-6-6 6-6"],
  more: [circlePath(5, 12, 1), circlePath(12, 12, 1), circlePath(19, 12, 1)],
  refresh: ["M3 12a9 9 0 0 1 15.5-6.3L21 8", "M21 3v5h-5", "M21 12a9 9 0 0 1-15.5 6.3L3 16", "M3 21v-5h5"],
} satisfies Record<string, readonly string[]>;

export type IconName = keyof typeof ICON_PATHS;
