import { z } from "zod";
import type { AgentEngine } from "./terminal";

/**
 * Pausa por limite de uso do PLANO (assinatura): o dono define, por motor e por janela, o percentual
 * em que o trabalho daquele motor PAUSA (os agentes terminam o passo em que estão, nada novo começa) e
 * a pausa se desfaz sozinha quando a janela reinicia. O orçamento em dinheiro é outra coisa e só avisa.
 */

export const USAGE_GUARD_PATH = "/api/usage-guard";
export const USAGE_GUARD_RULE_PATH = "/api/usage-guard/rule";
export const USAGE_GUARD_RELEASE_PATH = "/api/usage-guard/release";

/** Percentual padrão em que o trabalho pausa. */
export const USAGE_GUARD_DEFAULT_PERCENT = 90;
/** O menor percentual aceito (abaixo disso a pausa viraria regra, não exceção). */
export const USAGE_GUARD_MIN_PERCENT = 10;
/** O uso precisa cair tanto (pontos percentuais) abaixo do limite para a pausa poder acabar (evita liga e desliga). */
export const USAGE_GUARD_HYSTERESIS_POINTS = 5;

/** Chave da regra "parar quando a cota diária do Freebuff acabar (não gastar a carteira)". */
export const FREEBUFF_NO_WALLET_KEY = "freebuff:daily_hours:no_wallet";

/** Chave de uma regra: motor, janela e (se houver) o grupo de modelos da janela. */
export function usageGuardKey(engine: string, windowId: string, group?: string): string {
  return `${engine}:${windowId}${group ? `:${group}` : ""}`;
}

export type UsageGuardRuleSetting = { enabled: boolean; percent: number };

/** As escolhas do dono (só o que ele mudou; o resto vale o padrão). */
export type UsageGuardSettings = { rules: Record<string, Partial<UsageGuardRuleSetting>> };

/** `PATCH /api/usage-guard/rule`: muda a chave e/ou o percentual de uma regra. */
export const usageGuardRuleBodySchema = z.strictObject({
  key: z.string().min(1).max(160),
  enabled: z.boolean().optional(),
  percent: z.number().int().min(USAGE_GUARD_MIN_PERCENT).max(100).optional(),
});
export type UsageGuardRuleBody = z.infer<typeof usageGuardRuleBodySchema>;

/** `POST /api/usage-guard/release`: libera na mão uma pausa (`key`) ou todas (sem `key`). */
export const usageGuardReleaseBodySchema = z.strictObject({ key: z.string().min(1).max(160).optional() });
export type UsageGuardReleaseBody = z.infer<typeof usageGuardReleaseBodySchema>;

/** Uma pausa em vigor (guardada em disco: sobrevive a reinício). */
export type UsageGuardPause = {
  key: string;
  engine: AgentEngine;
  windowId: string;
  group?: string;
  /** Modelos a que a janela vale (veja `UsageWindow.appliesTo`); ausente = todos do motor. */
  appliesTo?: string[];
  /** Nome da janela para o dono ("5 h", "semana", "Horas do dia"). */
  label: string;
  /** Percentual que disparou a pausa (0 a 100). */
  percent: number;
  /** Uso (0 a 1) no momento da pausa. */
  utilization: number;
  pausedAt: string;
  /** Quando a janela reinicia (ISO), guardado na hora da pausa. */
  resetsAt?: string;
  /** `no_wallet`: parou porque a cota diária do Freebuff acabou e o dono não quer gastar a carteira. */
  kind: "window" | "no_wallet";
};

/** Uma linha da tela: uma regra (motor + janela). */
export type UsageGuardRuleView = {
  key: string;
  engine: AgentEngine;
  engineLabel: string;
  windowId: string;
  group?: string;
  label: string;
  kind: "window" | "no_wallet";
  enabled: boolean;
  percent: number;
  /** Uso atual da janela (0 a 1); ausente = sem leitura. */
  utilization?: number;
  paused: boolean;
  /** Hora prevista de volta (ISO), quando pausado e a janela informou. */
  resumesAt?: string;
  pausedAt?: string;
  /** O dono liberou a pausa na mão: a regra não pausa de novo até esta hora (ISO), a não ser que ele mude a regra. */
  releasedUntil?: string;
};

export type UsageGuardView = {
  rules: UsageGuardRuleView[];
  /** Motores que não entram (sem dado confiável do plano), com o motivo curto. */
  unsupported: { engine: AgentEngine; engineLabel: string; reason: string }[];
  /** Freebuff: carteira (horas) e se a cota do dia acabou e ele já gasta dela. */
  freebuff?: { wallet?: number; usingWallet: boolean };
  serverTime: string;
};

/** O que `GET /api/usage-guard` devolve (e `PATCH`/`POST` repetem depois da mudança). */
export type UsageGuardResponse = UsageGuardView;

/** Percentual (0 a 100) de uma utilização (0 a 1), arredondado. */
export const usagePercent = (utilization: number): number => Math.round(Math.min(1, Math.max(0, utilization)) * 100);
