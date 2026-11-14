import type { UsageRecordTokens } from "./usage-history";

/**
 * Guarda de sanidade do gasto (Junção V2, J2-09). Um turno com valor impossível não entra nos totais:
 * fica gravado, marcado como suspeito, e aparece à parte na página Gastos (não se perde dado).
 *
 * Os limites vêm do `JUMP_LIMITS` do Habblaud (github.com/marmottajr/habblaud, MIT, Copyright (c)
 * 2026 Márcio Junior), que usa o mesmo corte para descartar "releitura" de transcrição; aqui o
 * corte vale por turno: mais de 5 milhões de tokens de entrada (entrada + cache lido + cache
 * gravado), mais de 500 mil de saída ou mais de US$ 50 equivalentes num turno só. Além disso,
 * número negativo ou que não é número nunca é um gasto de verdade.
 */
export const SUSPECT_LIMITS = { inputTokens: 5_000_000, outputTokens: 500_000, costUsd: 50 } as const;

export const SUSPECT_REASONS = ["negative", "input", "output", "cost"] as const;
export type UsageSuspectReason = (typeof SUSPECT_REASONS)[number];

export const SUSPECT_REASON_LABELS: Record<UsageSuspectReason, string> = {
  negative: "número negativo ou inválido",
  input: "entrada impossível (mais de 5 milhões de tokens num turno)",
  output: "saída impossível (mais de 500 mil tokens num turno)",
  cost: "custo impossível (mais de US$ 50 num turno)",
};

/** O motivo pelo qual o turno é impossível, ou undefined se está dentro do possível. */
export function suspectReasonOf(tokens: Partial<UsageRecordTokens> | undefined, costUsd?: number | null): UsageSuspectReason | undefined {
  if (tokens) {
    const values = [tokens.input, tokens.output, tokens.cacheRead, tokens.cacheCreation, tokens.cacheCreation5m, tokens.cacheCreation1h];
    if (values.some((value) => value !== undefined && (!Number.isFinite(value) || value < 0))) return "negative";
    const input = (tokens.input ?? 0) + (tokens.cacheRead ?? 0) + (tokens.cacheCreation ?? 0);
    if (input > SUSPECT_LIMITS.inputTokens) return "input";
    if ((tokens.output ?? 0) > SUSPECT_LIMITS.outputTokens) return "output";
  }
  if (costUsd !== undefined && costUsd !== null && (!Number.isFinite(costUsd) || costUsd < 0)) return "negative";
  if (costUsd !== undefined && costUsd !== null && costUsd > SUSPECT_LIMITS.costUsd) return "cost";
  return undefined;
}
