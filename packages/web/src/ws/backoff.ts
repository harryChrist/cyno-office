export const MIN_RETRY_MS = 1000;
export const MAX_RETRY_MS = 15_000;

/**
 * Espera antes da tentativa `attempt` (0 = primeira reconexão): dobra a cada falha até
 * MAX_RETRY_MS, com jitter de 50–100% para várias abas não reconectarem juntas.
 */
export function retryDelay(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(MAX_RETRY_MS, MIN_RETRY_MS * 2 ** Math.max(0, attempt));
  return Math.round(base * (0.5 + 0.5 * random()));
}

/** Teto da espera entre consultas ao /__backend-health (barata): reconecta logo que o server volta. */
export const MAX_HEALTH_POLL_MS = 2000;

/** Espera antes da consulta `probe` ao health do backend: 250 ms dobrando até MAX_HEALTH_POLL_MS, com jitter. */
export function healthPollDelay(probe: number, random: () => number = Math.random): number {
  const base = Math.min(MAX_HEALTH_POLL_MS, 250 * 2 ** Math.max(0, probe));
  return Math.round(base * (0.5 + 0.5 * random()));
}

/** Servidor da UI fora (sem HMR para avisar a volta, como em produção): de 5 s dobrando até 60 s. */
export const MIN_UI_DOWN_POLL_MS = 5000;
export const MAX_UI_DOWN_POLL_MS = 60_000;

/** Espera antes da consulta `probe` com o servidor da UI fora (cada uma é um erro de rede no console). */
export function uiDownPollDelay(probe: number, random: () => number = Math.random): number {
  const base = Math.min(MAX_UI_DOWN_POLL_MS, MIN_UI_DOWN_POLL_MS * 2 ** Math.max(0, probe));
  return Math.round(base * (0.5 + 0.5 * random()));
}
