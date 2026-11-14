/**
 * Divisória arrastável entre a linha do tempo e a coluna lateral da tela de trabalho: a parte
 * pura (limites, passos do teclado, o que fica salvo). O componente fica em `WorkSplit.tsx`.
 */

/** Largura da lateral quando ainda não há medida do corpo (o padrão real é metade: 50/50). */
export const ASIDE_DEFAULT = 300;
/** A lateral nunca fica mais estreita que isto. */
export const ASIDE_MIN = 240;
/** A conversa (à esquerda) nunca fica mais estreita que isto, se couber. */
export const MAIN_MIN = 360;
/** Passo das setas; com Shift, o passo maior. */
export const KEY_STEP = 24;
export const KEY_STEP_LARGE = 96;

export type SplitBounds = { min: number; max: number };

/**
 * Limites da lateral para um corpo com `containerWidth` px. Se não couberem os dois mínimos, a
 * lateral fica no dela e a conversa encolhe (max = min). Sem medida (0), só o mínimo vale.
 */
export function asideBounds(containerWidth: number, asideMin = ASIDE_MIN, mainMin = MAIN_MIN): SplitBounds {
  if (!(containerWidth > 0)) return { min: asideMin, max: Number.POSITIVE_INFINITY };
  return { min: asideMin, max: Math.max(asideMin, Math.floor(containerWidth - mainMin)) };
}

/** Prende a largura nos limites (arredondada; valores inválidos voltam ao padrão). */
export function clampAside(width: number, bounds: SplitBounds): number {
  const value = Number.isFinite(width) ? Math.round(width) : ASIDE_DEFAULT;
  return Math.min(bounds.max, Math.max(bounds.min, value));
}

/**
 * Nova largura da lateral para uma tecla na divisória, ou null se a tecla não é dela.
 * ← move a divisória para a esquerda (a lateral cresce); → para a direita (encolhe).
 * Home/End levam ao mínimo/máximo da lateral.
 */
export function asideWidthForKey(key: string, shift: boolean, current: number, bounds: SplitBounds): number | null {
  const step = shift ? KEY_STEP_LARGE : KEY_STEP;
  switch (key) {
    case "ArrowLeft":
      return clampAside(current + step, bounds);
    case "ArrowRight":
      return clampAside(current - step, bounds);
    case "Home":
      return bounds.min;
    case "End":
      return Number.isFinite(bounds.max) ? bounds.max : null;
    default:
      return null;
  }
}

/** Padrão da lateral: metade do corpo (50/50); sem medida, ASIDE_DEFAULT. */
export function defaultAsideWidth(containerWidth: number): number {
  return containerWidth > 0 ? Math.floor(containerWidth / 2) : ASIDE_DEFAULT;
}

/** O que fica lembrado por painel. `width: null` = padrão (metade), até o usuário arrastar. */
export type SplitPrefs = { width: number | null; collapsed: boolean };

export const DEFAULT_PREFS: SplitPrefs = { width: null, collapsed: false };

/** v2: o padrão virou 50/50; larguras salvas antes (padrão 300 px) são esquecidas. */
export function splitStorageKey(splitKey: string): string {
  return `agent-office:split:v2:${splitKey}`;
}

/** Lê o que foi salvo; qualquer coisa estranha volta ao padrão (campo a campo). */
export function parseSplitPrefs(raw: string | null | undefined): SplitPrefs {
  if (!raw) return DEFAULT_PREFS;
  try {
    const data: unknown = JSON.parse(raw);
    if (!data || typeof data !== "object") return DEFAULT_PREFS;
    const { width, collapsed } = data as Record<string, unknown>;
    return {
      width: typeof width === "number" && Number.isFinite(width) && width > 0 ? Math.round(width) : null,
      collapsed: collapsed === true,
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

export function serializeSplitPrefs(prefs: SplitPrefs): string {
  return JSON.stringify({ width: prefs.width === null ? null : Math.round(prefs.width), collapsed: prefs.collapsed });
}
