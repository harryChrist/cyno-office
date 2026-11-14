/**
 * Lógica pura da gaveta de detalhe da Mídia: de que tamanho ela abre, até onde dá para alargar e estreitar, o arrasto
 * da borda e a largura guardada no navegador. A gaveta nunca é menor que metade da janela.
 */

/** Abaixo disso a gaveta ocupa a tela inteira (não há o que mostrar ao lado). */
export const DRAWER_FULL_BELOW = 900;
/** Largura mínima em pixels (vale quando metade da janela é menos que isso). */
export const DRAWER_MIN_PX = 560;
/** Teto da largura inicial sugerida, para telas enormes. */
const DRAWER_MAX_PX = 1600;

export type DrawerLimits = { full: boolean; min: number; max: number; initial: number };

/** Os limites para uma janela de `viewport` pixels de largura. Em tela estreita, `full` e tudo igual à janela. */
export function drawerLimits(viewport: number): DrawerLimits {
  if (viewport < DRAWER_FULL_BELOW) return { full: true, min: viewport, max: viewport, initial: viewport };
  const min = Math.max(DRAWER_MIN_PX, Math.ceil(viewport / 2));
  const max = Math.max(min, Math.min(Math.round(viewport * 0.85), DRAWER_MAX_PX));
  const initial = Math.min(max, Math.max(min, Math.round(viewport * 0.55)));
  return { full: false, min, max, initial };
}

/** Segura a largura dentro dos limites (NaN vira a inicial). */
export function clampDrawerWidth(width: number, viewport: number): number {
  const { min, max, initial } = drawerLimits(viewport);
  if (!Number.isFinite(width)) return initial;
  return Math.min(max, Math.max(min, Math.round(width)));
}

/** A largura a usar: a guardada (já limitada à janela de agora) ou a inicial. */
export function drawerWidth(stored: number | null, viewport: number): number {
  return stored === null ? drawerLimits(viewport).initial : clampDrawerWidth(stored, viewport);
}

/** Arrastar a borda esquerda para a esquerda alarga (a gaveta é encostada na direita). */
export function dragDrawerWidth(startWidth: number, startX: number, x: number, viewport: number): number {
  return clampDrawerWidth(startWidth + (startX - x), viewport);
}

const KEY = "cyno.media.drawerWidth";

export function loadDrawerWidth(): number | null {
  try {
    const value = Number(localStorage.getItem(KEY));
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

export function saveDrawerWidth(width: number): void {
  try {
    localStorage.setItem(KEY, String(Math.round(width)));
  } catch {
    // sem armazenamento: a largura vale só nesta visita
  }
}
