import { setTimeout as delay } from "node:timers/promises";

/** Espera `ms`; rejeita (AbortError) se o sinal for abortado. Injetável nos testes. */
export type Sleep = (ms: number, signal: AbortSignal) => Promise<void>;

export const realSleep: Sleep = async (ms, signal) => {
  await delay(ms, undefined, { signal });
};
