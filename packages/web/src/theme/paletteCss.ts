import { PALETTE, PALETTE_COLOR_IDS } from "@cyno/shared";

/** Expõe a paleta como variáveis CSS (--p-<id>) para a UI usar só cores da paleta. */
export function applyPaletteCssVars(root: HTMLElement = document.documentElement): void {
  for (const id of PALETTE_COLOR_IDS) root.style.setProperty(`--p-${id}`, PALETTE[id]);
}
