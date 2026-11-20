import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  AGENT_ENGINES,
  ENGINE_LABELS,
  USAGE_GUARD_HYSTERESIS_POINTS,
  freebuffWalletState,
  resumeTimeLabel,
  usagePercent,
  type AgentEngine,
  type AttentionLevel,
  type EngineBlock,
  type SubscriptionUsage,
  type UsageGuardPause,
  type UsageGuardRuleBody,
  type UsageGuardSettings,
  type UsageGuardView,
} from "@cyno/shared";
import { writeJsonAtomic } from "../../store/atomic-write";
import { WriteQueue } from "../../store/write-queue";
import { GUARD_UNSUPPORTED, decideGuard, effectiveRule, guardCandidates, pauseAppliesTo, type GuardCandidate } from "./rules";

const ZONE = "America/Sao_Paulo";
/** A volta aparece no aviso por este tempo. */
const RELEASED_ALERT_MS = 2 * 3_600_000;

type Persisted = {
  settings: UsageGuardSettings;
  pauses: UsageGuardPause[];
  /** Pausas que o dono liberou na mão: não pausam de novo até o reset (ou até o uso cair de verdade). Chave -> até quando (ISO). */
  snoozed: Record<string, string>;
  walletInUse?: { since: string; ref: string };
};

/** Quem recebe o recado quando a pausa começa e quando acaba (o `app.ts` liga isto aos workspaces). */
export type GuardNotifier = {
  /** A pausa começou: os agentes deste motor que estão trabalhando recebem o recado de terminar o passo. */
  paused(pause: UsageGuardPause, text: string): void;
  /** A pausa acabou: o Maestro de cada workspace com agente desse motor recebe o recado de retomar. */
  released(pause: UsageGuardPause, text: string): void;
};

export type UsageGuardDeps = {
  file: string;
  now: () => Date;
  usage: { snapshot: () => SubscriptionUsage[]; hub: { subscribe: (listener: (event: { type: string }) => void) => () => void } };
  /** Consulta o uso da conta de novo (Claude e Antigravity); undefined = o motor não tem consulta. */
  refresh?: (engine: AgentEngine) => Promise<unknown> | undefined;
  /** Chamado quando as pausas mudam (a disponibilidade dos motores confere as filas de novo). */
  onChange: () => void;
  attention: {
    raiseUsagePause: (input: { ref: string; level: AttentionLevel; text: string; expiresAt?: number }) => void;
    clearUsagePause: (ref: string) => void;
  };
  notifier: GuardNotifier;
  log: { error: (obj: unknown, message?: string) => void; info: (obj: unknown, message?: string) => void };
  queue?: WriteQueue;
  /** De quanto em quanto tempo confere por relógio (reset que chegou, consulta nova). Padrão: 60 s. */
  tickMs?: number;
};

const refOf = (prefix: string, key: string) => `${prefix}-${key.replaceAll(":", "-")}`;

/**
 * Pausa por limite de uso do plano. Decide a cada leitura de uso (função pura em rules.ts), guarda as
 * pausas em disco (sobrevivem a reinício), barra os agentes do motor pela disponibilidade (`blockFor`),
 * avisa o dono, manda o recado aos agentes que estão trabalhando e, no reset, confere com uma consulta
 * nova antes de liberar e avisa o Maestro. O dono também libera na mão.
 */
export class UsageGuard {
  private readonly queue: WriteQueue;
  private timer: NodeJS.Timeout | undefined;
  private unsubscribe: (() => void) | undefined;
  private closed = false;
  private evaluating = false;
  private queued: { key: string | undefined } | undefined;

  private constructor(
    private readonly deps: UsageGuardDeps,
    private data: Persisted,
  ) {
    this.queue = deps.queue ?? new WriteQueue();
  }

  static async open(deps: UsageGuardDeps): Promise<UsageGuard> {
    let data: Persisted = { settings: { rules: {} }, pauses: [], snoozed: {} };
    try {
      const raw = JSON.parse(await readFile(deps.file, "utf8")) as Partial<Persisted>;
      data = {
        settings: sanitizeSettings(raw.settings),
        pauses: (Array.isArray(raw.pauses) ? raw.pauses : []).filter(isPause),
        snoozed: Object.fromEntries(Object.entries(raw.snoozed && typeof raw.snoozed === "object" ? raw.snoozed : {}).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
        ...(raw.walletInUse && typeof raw.walletInUse.ref === "string" && typeof raw.walletInUse.since === "string" ? { walletInUse: raw.walletInUse } : {}),
      };
    } catch {
      // Sem arquivo (ou quebrado): sem regras mudadas e sem pausas.
    }
    return new UsageGuard(deps, data);
  }

  /** Liga: reavalia já (as pausas do disco voltam a valer e o aviso delas reaparece) e a cada leitura de uso. */
  start(): void {
    if (this.unsubscribe || this.closed) return;
    for (const pause of this.data.pauses) this.raisePauseAlert(pause);
    this.unsubscribe = this.deps.usage.hub.subscribe((event) => {
      if (event.type === "usage:updated") void this.evaluate();
    });
    this.timer = setInterval(() => void this.confirmAndEvaluate(), this.deps.tickMs ?? 60_000);
    this.timer.unref();
    void this.evaluate();
  }

  async close(): Promise<void> {
    this.closed = true;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.queue.idle();
  }

  /** O motor deste agente está pausado agora? (a disponibilidade dos motores pergunta aqui) */
  blockFor(engine: AgentEngine | undefined, model?: string): EngineBlock | undefined {
    const pause = this.data.pauses.find((candidate) => pauseAppliesTo(candidate, engine, model));
    return pause ? { reason: "paused", label: pause.label, percent: pause.percent, ...(pause.resetsAt ? { resetsAt: pause.resetsAt } : {}) } : undefined;
  }

  pauses(): UsageGuardPause[] {
    return structuredClone(this.data.pauses);
  }

  // ---------- Tela ----------

  view(): UsageGuardView {
    const now = this.deps.now().getTime();
    const usages = this.deps.usage.snapshot();
    const candidates = guardCandidates(usages, now);
    const known = new Set(candidates.map((candidate) => candidate.key));
    const row = (candidate: GuardCandidate) => {
      const rule = effectiveRule(this.data.settings, candidate.key, candidate.kind);
      const pause = this.data.pauses.find((item) => item.key === candidate.key);
      return {
        key: candidate.key,
        engine: candidate.engine,
        engineLabel: ENGINE_LABELS[candidate.engine],
        windowId: candidate.windowId,
        ...(candidate.group ? { group: candidate.group } : {}),
        label: candidate.label,
        kind: candidate.kind,
        enabled: rule.enabled,
        percent: rule.percent,
        ...(candidate.utilization !== undefined ? { utilization: candidate.utilization } : {}),
        paused: pause !== undefined,
        ...(pause?.resetsAt ? { resumesAt: pause.resetsAt } : candidate.resetsAt && pause ? { resumesAt: candidate.resetsAt } : {}),
        ...(pause ? { pausedAt: pause.pausedAt } : {}),
        ...(!pause && this.data.snoozed[candidate.key] ? { releasedUntil: this.data.snoozed[candidate.key] } : {}),
      };
    };
    const rules = candidates.map(row);
    // Pausa cuja janela deixou de ser informada: continua na tela (para o dono liberar).
    for (const pause of this.data.pauses) {
      if (known.has(pause.key)) continue;
      rules.push(row({ key: pause.key, engine: pause.engine, windowId: pause.windowId, ...(pause.group ? { group: pause.group } : {}), label: pause.label, kind: pause.kind }));
    }
    const freebuff = usages.find((usage) => usage.provider === "freebuff")?.freebuff;
    const walletState = freebuffWalletState(freebuff, now);
    return {
      rules,
      unsupported: AGENT_ENGINES.filter((engine) => GUARD_UNSUPPORTED[engine]).map((engine) => ({ engine, engineLabel: ENGINE_LABELS[engine], reason: GUARD_UNSUPPORTED[engine]! })),
      ...(freebuff ? { freebuff: { ...(walletState.wallet !== undefined ? { wallet: walletState.wallet } : {}), usingWallet: walletState.usingWallet } } : {}),
      serverTime: this.deps.now().toISOString(),
    };
  }

  /** Muda a chave e/ou o percentual de uma regra e reavalia na hora. */
  async setRule(body: UsageGuardRuleBody): Promise<UsageGuardView> {
    const current = this.data.settings.rules[body.key] ?? {};
    this.data.settings.rules[body.key] = { ...current, ...(body.enabled !== undefined ? { enabled: body.enabled } : {}), ...(body.percent !== undefined ? { percent: body.percent } : {}) };
    // Mexer na regra é uma decisão nova do dono: a folga de quem foi liberado na mão deixa de valer.
    delete this.data.snoozed[body.key];
    await this.persist();
    await this.evaluate(body.key);
    return this.view();
  }

  /** Libera na mão uma pausa (`key`) ou todas. A regra continua ligada: se o uso ainda estiver acima, ela pausa de novo. */
  async release(key?: string): Promise<UsageGuardView> {
    const targets = this.data.pauses.filter((pause) => key === undefined || pause.key === key);
    if (targets.length > 0) {
      // O uso atual ainda pode estar acima do limite: sem isto a pausa reabriria na mesma hora. Fica de folga até o reset.
      for (const pause of targets) {
        this.data.snoozed[pause.key] = pause.resetsAt ?? new Date(this.deps.now().getTime() + 3_600_000).toISOString();
        this.finish(pause, "manual");
      }
      await this.persist();
      this.deps.onChange();
    }
    return this.view();
  }

  // ---------- Decisão ----------

  /** Reset que chegou: confere o uso com uma consulta nova (Claude e Antigravity) antes de decidir. */
  private async confirmAndEvaluate(): Promise<void> {
    const now = this.deps.now().getTime();
    const due = new Set(this.data.pauses.filter((pause) => pause.resetsAt !== undefined && Date.parse(pause.resetsAt) <= now).map((pause) => pause.engine));
    for (const engine of due) {
      try {
        await this.deps.refresh?.(engine);
      } catch {
        // sem consulta: vale a última leitura
      }
    }
    await this.evaluate();
  }

  /** `changedKey`: a regra que o dono acabou de mudar (a volta da pausa dela não é "o limite voltou", e solta sem a folga da histerese). */
  async evaluate(changedKey?: string): Promise<void> {
    if (this.closed) return;
    if (this.evaluating) {
      // Já há uma reavaliação gravando: esta roda logo depois (sem isto, uma mudança de regra feita nesse instante esperaria o próximo minuto).
      this.queued = { key: changedKey ?? this.queued?.key };
      return;
    }
    this.evaluating = true;
    try {
      const now = this.deps.now();
      const usages = this.deps.usage.snapshot();
      const candidates = guardCandidates(usages, now.getTime());
      let changed = this.dropSnoozes(candidates, now.getTime());
      const decision = decideGuard({ candidates, settings: this.data.settings, pauses: this.data.pauses, snoozed: new Set(Object.keys(this.data.snoozed)), ...(changedKey !== undefined ? { changedKey } : {}), now: now.getTime(), nowIso: now.toISOString() });
      for (const release of decision.release) {
        const pause = this.data.pauses.find((item) => item.key === release.key);
        if (pause) {
          this.finish(pause, release.why === "dropped" && release.key === changedKey ? "rule" : release.why);
          changed = true;
        }
      }
      for (const pause of decision.pause) {
        this.data.pauses.push(pause);
        this.announcePause(pause);
        changed = true;
      }
      if (this.trackWallet(usages, now)) changed = true;
      if (changed) {
        await this.persist();
        this.deps.onChange();
      }
    } catch (error) {
      this.deps.log.error({ err: error }, "pausa por limite de uso: falha ao avaliar");
    } finally {
      this.evaluating = false;
    }
    const next = this.queued;
    this.queued = undefined;
    if (next) await this.evaluate(next.key);
  }

  /** A folga acaba quando o reset passa ou o uso cai de verdade abaixo do limite. */
  private dropSnoozes(candidates: GuardCandidate[], now: number): boolean {
    let changed = false;
    for (const [key, until] of Object.entries(this.data.snoozed)) {
      const candidate = candidates.find((item) => item.key === key);
      const rule = candidate ? effectiveRule(this.data.settings, key, candidate.kind) : undefined;
      const dropped = candidate?.utilization !== undefined && rule !== undefined && candidate.utilization * 100 < rule.percent - USAGE_GUARD_HYSTERESIS_POINTS;
      if (dropped || !candidate || Date.parse(until) <= now) {
        delete this.data.snoozed[key];
        changed = true;
      }
    }
    return changed;
  }

  private announcePause(pause: UsageGuardPause): void {
    this.deps.log.info({ key: pause.key, percent: pause.percent }, "pausa por limite de uso do plano");
    this.raisePauseAlert(pause);
    const back = pause.resetsAt ? `a volta está prevista para ${this.clock(pause.resetsAt)}` : "sem hora de volta informada";
    const engine = ENGINE_LABELS[pause.engine];
    const reason = pause.kind === "no_wallet" ? `a cota do dia do ${engine} acabou e o dono não quer gastar a carteira` : `o plano do ${engine} chegou a ${pause.percent}% (${pause.label})`;
    const text = `[Cyno] Limite de uso: ${reason}. Termine só o passo em que está (sem deixar arquivo pela metade), entregue com submit_result o que já fez e o que falta, e NÃO comece a próxima tarefa. Nada novo começa até o limite voltar; ${back}. O Maestro avisa quando puder retomar.`;
    try {
      this.deps.notifier.paused(pause, text);
    } catch (error) {
      this.deps.log.error({ err: error }, "pausa por limite de uso: falha ao avisar os agentes");
    }
  }

  private raisePauseAlert(pause: UsageGuardPause): void {
    const engine = ENGINE_LABELS[pause.engine];
    const back = pause.resetsAt ? ` · volta ${this.clock(pause.resetsAt)}` : "";
    const text = pause.kind === "no_wallet" ? `${engine}: cota do dia acabou, pausado para não gastar a carteira${back}` : `${engine}: ${pause.label} em ${usagePercent(pause.utilization)}%, trabalho pausado${back}`;
    const expiresAt = pause.resetsAt ? Date.parse(pause.resetsAt) : undefined;
    this.deps.attention.raiseUsagePause({ ref: refOf("pausa", pause.key), level: "alert", text, ...(expiresAt !== undefined && Number.isFinite(expiresAt) ? { expiresAt: expiresAt + 3_600_000 } : {}) });
  }

  /** Tira a pausa da lista, avisa o dono e manda o recado ao Maestro. */
  private finish(pause: UsageGuardPause, why: "dropped" | "disabled" | "clock" | "gone" | "manual" | "rule"): void {
    this.data.pauses = this.data.pauses.filter((item) => item.key !== pause.key);
    const engine = ENGINE_LABELS[pause.engine];
    this.deps.attention.clearUsagePause(refOf("pausa", pause.key));
    const how = why === "manual" ? "liberado na mão" : why === "disabled" ? "regra desligada" : why === "rule" ? "regra alterada" : "limite voltou";
    this.deps.attention.raiseUsagePause({
      ref: `${refOf("liberado", pause.key)}-${this.deps.now().getTime()}`,
      level: "info",
      text: `${engine}: ${pause.label} liberada (${how}), o trabalho segue`,
      expiresAt: this.deps.now().getTime() + RELEASED_ALERT_MS,
    });
    const text = `[Cyno] O limite de uso do ${engine} (${pause.label}) voltou e a pausa acabou (${how}). Os agentes desse motor podem retomar de onde pararam: reveja o que ficou parado ou incompleto por causa da pausa e redistribua.`;
    try {
      this.deps.notifier.released(pause, text);
    } catch (error) {
      this.deps.log.error({ err: error }, "pausa por limite de uso: falha ao avisar o Maestro");
    }
  }

  /** Freebuff: a cota do dia acabou e ele passou a gastar a carteira (um aviso por virada). Devolve se mudou algo para gravar. */
  private trackWallet(usages: SubscriptionUsage[], now: Date): boolean {
    const state = freebuffWalletState(usages.find((usage) => usage.provider === "freebuff")?.freebuff, now.getTime());
    const resets = usages.find((usage) => usage.provider === "freebuff")?.freebuff?.hours.resetsAt;
    if (state.usingWallet && !this.data.walletInUse) {
      const ref = `carteira-${(resets ?? now.toISOString()).slice(0, 13)}`;
      this.data.walletInUse = { since: now.toISOString(), ref };
      const paused = this.data.pauses.some((pause) => pause.kind === "no_wallet");
      if (!paused) {
        this.deps.attention.raiseUsagePause({
          ref,
          level: "warn",
          text: `Freebuff: a cota do dia acabou, agora gasta da carteira${state.wallet !== undefined ? ` (${state.wallet} h)` : ""}`,
          ...(resets ? { expiresAt: Date.parse(resets) } : {}),
        });
      }
      return true;
    }
    if (!state.usingWallet && this.data.walletInUse && !state.dailyExhausted) {
      this.deps.attention.clearUsagePause(this.data.walletInUse.ref);
      delete this.data.walletInUse;
      return true;
    }
    return false;
  }

  private clock(iso: string): string {
    const label = resumeTimeLabel(iso, this.deps.now().getTime(), ZONE);
    return label.includes(" ") ? `em ${label}` : `às ${label}`;
  }

  private persist(): Promise<void> {
    return this.queue.enqueue(async () => {
      await mkdir(path.dirname(this.deps.file), { recursive: true });
      await writeJsonAtomic(this.deps.file, this.data);
    });
  }
}

function sanitizeSettings(raw: unknown): UsageGuardSettings {
  const rules: UsageGuardSettings["rules"] = {};
  const source = raw && typeof raw === "object" ? (raw as { rules?: unknown }).rules : undefined;
  if (source && typeof source === "object" && !Array.isArray(source)) {
    for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
      if (!value || typeof value !== "object") continue;
      const { enabled, percent } = value as { enabled?: unknown; percent?: unknown };
      rules[key] = { ...(typeof enabled === "boolean" ? { enabled } : {}), ...(typeof percent === "number" && Number.isFinite(percent) ? { percent } : {}) };
    }
  }
  return { rules };
}

function isPause(value: unknown): value is UsageGuardPause {
  if (!value || typeof value !== "object") return false;
  const pause = value as Partial<UsageGuardPause>;
  return typeof pause.key === "string" && typeof pause.engine === "string" && (AGENT_ENGINES as readonly string[]).includes(pause.engine) && typeof pause.pausedAt === "string" && typeof pause.label === "string" && typeof pause.percent === "number" && typeof pause.utilization === "number" && (pause.kind === "window" || pause.kind === "no_wallet");
}
