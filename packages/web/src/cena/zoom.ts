/** Zoom só em inteiros, para manter cada pixel da arte nítido. */
export const ZOOM_LEVELS = [1, 2, 3, 4] as const;
export type ZoomLevel = (typeof ZOOM_LEVELS)[number];

export const MIN_ZOOM: ZoomLevel = ZOOM_LEVELS[0];
export const MAX_ZOOM: ZoomLevel = ZOOM_LEVELS[ZOOM_LEVELS.length - 1]!;
/** O enquadramento automático (mapa e foco de quarto) para aqui; 4x só pelo zoom manual. */
export const FIT_MAX_ZOOM: ZoomLevel = 3;

export function clampZoom(value: number): ZoomLevel {
  const rounded = Math.round(value);
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, rounded)) as ZoomLevel;
}

export function stepZoom(current: ZoomLevel, delta: 1 | -1): ZoomLevel {
  return clampZoom(current + delta);
}
