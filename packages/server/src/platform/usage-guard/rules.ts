import {
  ENGINE_LABELS,
  FREEBUFF_NO_WALLET_KEY,
  freebuffWalletState,
  USAGE_GUARD_DEFAULT_PERCENT,
  USAGE_GUARD_HYSTERESIS_POINTS,
  USAGE_GUARD_MIN_PERCENT,
  sortUsageWindows,
  usageGuardKey,
  type AgentEngine,
  type SubscriptionUsage,
  type UsageGuardPause,
  type UsageGuardRuleSetting,
  type UsageGuardSettings,
  type UsageWindow,
} from "@cyno/shared";

/**
 * As regras da pausa por limite de uso do plano, todas funções puras: que janelas entram, o que o
 * dono configurou, quando pausar e quando liberar. O `UsageGuard` (service.ts) só liga isto aos
 * eventos de uso, ao disco, aos avisos e à disponibilidade dos motores.
 */

/** Passado o reset previsto por tanto tempo sem uma leitura nova, a pausa acaba pelo relógio (a janela já zerou de certeza). */
export const USAGE_GUARD_CLOCK_FALLBACK_MS = 30 * 60_000;

/** Pausa sem hora de volta cuja janela deixou de ser informada: acaba depois deste tempo (a maior janela curta é a de 5 h). */
export const USAGE_GUARD_ORPHAN_MS = 6 * 3_600_000;

/** As janelas do Claude Code que valem para a conta inteira. */
const CLAUDE_WINDOWS = new Set(["five_hour", "seven_day"]);
/** Janela semanal de um modelo só (`seven_day_opus`, `seven_day_sonnet`...): regra à parte, que só segura os agentes daquele modelo. */
const CLAUDE_MODEL_WINDOW = /^seven_day_([a-z0-9_]+)$/;

/** O modelo de uma janela semanal por modelo do Claude Code ("opus"), ou undefined se a janela é da conta inteira. */
function claudeModelOf(windowId: string): string | undefined {
  return CLAUDE_WINDOWS.has(windowId) ? undefined : CLAUDE_MODEL_WINDOW.exec(windowId)?.[1]?.replaceAll("_", " ");
}

/** Motores com dado do plano em que se pode confiar, e os que ficam de fora (o motivo aparece na tela). */
export const GUARD_UNSUPPORTED: Partial<Record<AgentEngine, string>> = {
  codex: "não informa o uso do plano",
  opencode: "não informa o uso do plano",
  openclaw: "usa chave do OpenRouter, não plano",
  hermes: "usa chave do OpenRouter, não plano",
};

/** Uma janela que pode ter regra, já com a leitura. `utilization` ausente = sem leitura confiável (renovou e ainda não veio dado novo). */
export type GuardCandidate = {
  key: string;
  engine: AgentEngine;
  windowId: string;
  group?: string;
  appliesTo?: string[];
  label: string;
  kind: "window" | "no_wallet";
  utilization?: number;
  resetsAt?: string;
};

const WINDOW_LABELS: Record<string, string> = { five_hour: "5 h", seven_day: "semana", daily_hours: "Horas do dia" };

function windowLabel(window: Pick<UsageWindow, "id" | "label">): string {
  return window.label ?? WINDOW_LABELS[window.id] ?? window.id;
}

/** A leitura de uma janela: 1 se a CLI diz "rejected"; sem leitura se o reset dela já passou (o número é de antes). */
function readingOf(window: UsageWindow, now: number): number | undefined {
  if (window.resetsAt !== undefined && Date.parse(window.resetsAt) <= now) return undefined;
  if (window.status === "rejected") return 1;
  return Math.min(1, Math.max(0, window.utilization));
}

/** Todas as janelas com regra possível, a partir do uso conhecido de cada provedor. */
export function guardCandidates(usages: readonly SubscriptionUsage[], now: number): GuardCandidate[] {
  const out: GuardCandidate[] = [];
  for (const usage of usages) {
    const engine = usage.provider as AgentEngine;
    if (usage.provider === "freebuff") {
      const daily = usage.windows.find((window) => window.id === "daily_hours");
      const reading = daily ? readingOf(daily, now) : undefined;
      if (daily) out.push({ key: usageGuardKey(engine, daily.id), engine, windowId: daily.id, label: windowLabel(daily), kind: "window", ...(reading !== undefined ? { utilization: reading } : {}), ...(daily.resetsAt ? { resetsAt: daily.resetsAt } : {}) });
      if (daily && usage.freebuff) {
        const state = freebuffWalletState(usage.freebuff, now);
        out.push({
          key: FREEBUFF_NO_WALLET_KEY,
          engine,
          windowId: daily.id,
          label: "Carteira (parar quando a cota do dia acabar)",
          kind: "no_wallet",
          // Só vale com a leitura do saldo do dia (medida na tela do Freebuff): sem ela, sem decisão.
          ...(usage.freebuff.hours.remaining !== undefined ? { utilization: state.dailyExhausted ? 1 : 0 } : {}),
          ...(daily.resetsAt ? { resetsAt: daily.resetsAt } : {}),
        });
      }
      continue;
    }
    if (GUARD_UNSUPPORTED[engine] || (usage.provider !== "claude" && usage.provider !== "gemini")) continue;
    for (const window of sortUsageWindows([...usage.windows])) {
      const claudeModel = usage.provider === "claude" ? claudeModelOf(window.id) : undefined;
      if (usage.provider === "claude" && !CLAUDE_WINDOWS.has(window.id) && claudeModel === undefined) continue;
      const reading = readingOf(window, now);
      const appliesTo = window.appliesTo ?? (claudeModel !== undefined ? [claudeModel] : undefined);
      out.push({
        key: usageGuardKey(engine, window.id, window.group),
        engine,
        windowId: window.id,
        ...(window.group ? { group: window.group } : {}),
        ...(appliesTo ? { appliesTo } : {}),
        label: window.group ? `${windowLabel(window)} · ${window.group}` : claudeModel !== undefined ? `semana · só ${claudeModel.charAt(0).toUpperCase()}${claudeModel.slice(1)}` : windowLabel(window),
        kind: "window",
        ...(reading !== undefined ? { utilization: reading } : {}),
        ...(window.resetsAt ? { resetsAt: window.resetsAt } : {}),
      });
    }
  }
  return out;
}

/**
 * O que vale para uma regra: o que o dono escolheu, ou o padrão. Toda regra nasce DESLIGADA, com 90% já preenchido
 * (decisão do dono, 19/11: a pausa só existe para quem liga; nada pausa sozinho numa instalação nova).
 */
export function effectiveRule(settings: UsageGuardSettings, key: string, kind: "window" | "no_wallet"): UsageGuardRuleSetting {
  const chosen = settings.rules[key] ?? {};
  if (kind === "no_wallet") return { enabled: chosen.enabled ?? false, percent: 100 };
  const percent = Math.min(100, Math.max(USAGE_GUARD_MIN_PERCENT, Math.round(chosen.percent ?? USAGE_GUARD_DEFAULT_PERCENT)));
  return { enabled: chosen.enabled ?? false, percent };
}

export type GuardDecision = {
  pause: UsageGuardPause[];
  release: { key: string; why: "dropped" | "disabled" | "clock" | "gone" }[];
};

/**
 * Decide o que pausar e o que liberar agora.
 * - Pausa: a regra está ligada, há leitura e o uso chegou ao percentual (a janela já pausada não pausa de novo).
 * - Libera: a regra foi desligada; ou a leitura é nova e caiu pelo menos `USAGE_GUARD_HYSTERESIS_POINTS` abaixo do
 *   percentual (a janela reiniciou; sem folga, o uso oscilando em torno do limite ligaria e desligaria); ou o reset
 *   passou há mais de 30 min sem nenhuma leitura nova (pelo relógio); ou a janela sumiu depois do reset.
 *   Uma leitura que ainda é alta depois do reset NÃO libera: a pausa espera a leitura cair.
 */
export function decideGuard(input: {
  candidates: readonly GuardCandidate[];
  settings: UsageGuardSettings;
  pauses: readonly UsageGuardPause[];
  snoozed?: ReadonlySet<string>;
  /** A regra que o dono acabou de mudar: para ela a folga da histerese não vale (uso abaixo do percentual novo já solta). */
  changedKey?: string;
  now: number;
  nowIso: string;
}): GuardDecision {
  const { candidates, settings, pauses, now, nowIso } = input;
  const snoozed = input.snoozed ?? new Set<string>();
  const byKey = new Map(candidates.map((candidate) => [candidate.key, candidate]));
  const paused = new Set(pauses.map((pause) => pause.key));
  const decision: GuardDecision = { pause: [], release: [] };
  for (const candidate of candidates) {
    if (paused.has(candidate.key) || snoozed.has(candidate.key) || candidate.utilization === undefined) continue;
    const rule = effectiveRule(settings, candidate.key, candidate.kind);
    if (!rule.enabled || candidate.utilization * 100 < rule.percent - 1e-9) continue;
    decision.pause.push({
      key: candidate.key,
      engine: candidate.engine,
      windowId: candidate.windowId,
      ...(candidate.group ? { group: candidate.group } : {}),
      ...(candidate.appliesTo ? { appliesTo: candidate.appliesTo } : {}),
      label: candidate.label,
      percent: rule.percent,
      utilization: candidate.utilization,
      pausedAt: nowIso,
      ...(candidate.resetsAt ? { resetsAt: candidate.resetsAt } : {}),
      kind: candidate.kind,
    });
  }
  for (const pause of pauses) {
    const candidate = byKey.get(pause.key);
    const rule = effectiveRule(settings, pause.key, pause.kind);
    if (!rule.enabled) {
      decision.release.push({ key: pause.key, why: "disabled" });
      continue;
    }
    if (!candidate) {
      // A janela deixou de ser informada: só libera depois do reset previsto (mais a reserva). Sem hora de volta
      // guardada, a pausa não pode ficar presa para sempre: vale um teto contado de quando ela começou.
      const until = pause.resetsAt !== undefined ? Date.parse(pause.resetsAt) + USAGE_GUARD_CLOCK_FALLBACK_MS : Date.parse(pause.pausedAt) + USAGE_GUARD_ORPHAN_MS;
      if (Number.isFinite(until) && now >= until) decision.release.push({ key: pause.key, why: "gone" });
      continue;
    }
    const slack = pause.key === input.changedKey ? 0 : USAGE_GUARD_HYSTERESIS_POINTS;
    const below = candidate.utilization !== undefined && candidate.utilization * 100 < rule.percent - slack;
    if (below) {
      decision.release.push({ key: pause.key, why: "dropped" });
      continue;
    }
    const resets = pause.resetsAt ? Date.parse(pause.resetsAt) : undefined;
    if (candidate.utilization === undefined && resets !== undefined && now >= resets + USAGE_GUARD_CLOCK_FALLBACK_MS) decision.release.push({ key: pause.key, why: "clock" });
  }
  return decision;
}

/** A pausa vale para um agente deste motor e modelo? (janela de um grupo de modelos, ou de um modelo só, segura apenas quem usa aquilo) */
export function pauseAppliesTo(pause: Pick<UsageGuardPause, "engine" | "appliesTo">, engine: AgentEngine | undefined, model: string | undefined): boolean {
  if (engine !== pause.engine) return false;
  if (!pause.appliesTo || pause.appliesTo.length === 0) return true;
  // Sem modelo escolhido: no Antigravity vale (não dá para saber o grupo); no Claude Code a janela de um modelo só não segura quem não o usa de propósito.
  if (model === undefined) return pause.engine !== "claude";
  const words = ` ${model.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;
  return pause.appliesTo.some((keyword) => {
    const key = ` ${keyword.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;
    return key.trim() !== "" && words.includes(key);
  });
}

export function engineLabelOf(engine: AgentEngine): string {
  return ENGINE_LABELS[engine];
}

/** Hora do próximo instante em que vale reavaliar sem evento de uso: o reset (e o relógio de reserva) de cada pausa. */
export function nextGuardWakeup(pauses: readonly UsageGuardPause[], now: number): number | undefined {
  const times = pauses.flatMap((pause) => (pause.resetsAt ? [Date.parse(pause.resetsAt), Date.parse(pause.resetsAt) + USAGE_GUARD_CLOCK_FALLBACK_MS] : [])).filter((at) => Number.isFinite(at) && at > now);
  return times.length > 0 ? Math.min(...times) : undefined;
}
