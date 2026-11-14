import {
  BUDGET_PERIODS,
  BUDGET_STEPS,
  budgetAlertText,
  budgetLimitKey,
  budgetStepOf,
  budgetToneOf,
  type BudgetLimits,
  type BudgetPeriod,
  type BudgetPeriodStatus,
  type BudgetResponse,
  type ServerEvent,
  type UsageRecord,
} from "@cyno/shared";
import { priceRecord } from "../../engines/usage/usage-aggregate";
import { addDays, dayKeyOf, nextMonth, monthKeyOf, startOfDay, weekStartOf } from "../../engines/usage/usage-time";

/** Um workspace como o vigia o enxerga (o `app.ts` monta um por runtime; os testes usam falsos). */
export type BudgetSource = {
  id: string;
  /** Avisa de cada evento do workspace (ausente: a fonte só entra na conta, sem disparar conferência). */
  subscribe?: (listener: (event: ServerEvent) => void) => () => void;
  /** Linhas do histórico de gastos com `at` entre `fromMs` (inclusive) e `toMs` (exclusive). */
  read: (fromMs: number, toMs: number) => Promise<UsageRecord[]>;
};

export type BudgetWatcherDeps = {
  sources: () => BudgetSource[];
  subscribeList: (listener: () => void) => () => void;
  limits: () => BudgetLimits;
  usdBrl: () => number;
  updatedAt: () => string | undefined;
  attention: {
    raiseBudget: (input: { ref: string; level: "warn" | "alert"; text: string; expiresAt?: number; replay?: boolean }) => void;
    clearBudget: (keep?: (ref: string) => boolean) => void;
  };
  now: () => Date;
  /** Espera depois de um turno gravado, antes de reconferir (vários turnos juntos = uma conta). */
  debounceMs?: number;
  /** Intervalo da conferência por relógio (padrão 5 min). */
  tickMs?: number;
  log: { warn: (obj: unknown, message?: string) => void };
};

/** Início (inclusive) e fim (exclusive) do período que contém `nowMs`, no fuso de São Paulo, e a chave dele. */
export function budgetPeriodBounds(period: BudgetPeriod, nowMs: number): { key: string; startMs: number; endMs: number } {
  const today = dayKeyOf(nowMs);
  if (period === "day") return { key: `dia-${today}`, startMs: startOfDay(today), endMs: startOfDay(addDays(today, 1)) };
  if (period === "week") {
    const first = weekStartOf(today);
    return { key: `semana-${first}`, startMs: startOfDay(first), endMs: startOfDay(addDays(first, 7)) };
  }
  const month = monthKeyOf(nowMs);
  return { key: `mes-${month}`, startMs: startOfDay(`${month}-01`), endMs: startOfDay(`${nextMonth(month)}-01`) };
}

/**
 * O orçamento só AVISA, nunca trava (decisão do dono, 12/11): a cada gasto gravado (`usage:agents` de
 * qualquer workspace) soma o custo equivalente do dia, da semana e do mês de todos os workspaces (a
 * mesma fonte da página Gastos: sem as linhas suspeitas, com os parciais) e, ao chegar em 80% e em
 * 100% do limite, levanta um alerta `budget` na cadeia de atenção, uma vez por degrau e por período.
 * Sem limite definido, não faz nada e `status()` devolve a lista vazia.
 *
 * No boot (e ao mudar um limite com o período já acima do degrau) o alerta vale: entra quieto
 * (`replay`) se foi o boot, e avisa de verdade se o dono acabou de definir um limite já ultrapassado.
 */
export class BudgetWatcher {
  /** Degraus já avisados: `${período-chave}:${limite}:${degrau}` (um limite novo avisa de novo). */
  private readonly fired = new Set<string>();
  private readonly watching = new Map<string, () => void>();
  private offList: (() => void) | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private tick: ReturnType<typeof setInterval> | undefined;
  private running: Promise<void> = Promise.resolve();
  private started = false;
  private closed = false;

  constructor(private readonly deps: BudgetWatcherDeps) {}

  /** Liga o vigia: confere o que já estourou (quieto), e passa a escutar os workspaces. */
  async start(): Promise<void> {
    if (this.started || this.closed) return;
    this.started = true;
    this.syncSources();
    this.offList = this.deps.subscribeList(() => this.syncSources());
    // Uma conferência de tempos em tempos também: o gasto do Cyno (fora dos workspaces) não dispara evento, e o período vira sozinho.
    this.tick = setInterval(() => void this.evaluate({ boot: false }), this.deps.tickMs ?? 5 * 60_000);
    this.tick.unref();
    await this.evaluate({ boot: true });
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.tick) clearInterval(this.tick);
    this.offList?.();
    for (const off of this.watching.values()) off();
    this.watching.clear();
    await this.running;
  }

  /** O dono mudou o orçamento: confere na hora (avisa se o período já passou do degrau do limite novo). */
  async limitsChanged(): Promise<void> {
    await this.evaluate({ boot: false });
  }

  /** Espera a conferência em andamento (testes). */
  idle(): Promise<void> {
    return this.running;
  }

  /** O consumo de cada período com limite (tudo vazio sem orçamento). */
  async status(): Promise<BudgetResponse> {
    const limits = this.deps.limits();
    const usdBrl = this.deps.usdBrl();
    const nowMs = this.deps.now().getTime();
    const periods: BudgetPeriodStatus[] = [];
    const spent = await this.spentByPeriod(limits, nowMs);
    for (const period of BUDGET_PERIODS) {
      const limitUsd = limits[budgetLimitKey(period)];
      if (limitUsd === undefined) continue;
      const bounds = budgetPeriodBounds(period, nowMs);
      const spentUsd = spent.get(period) ?? 0;
      const percent = (spentUsd / limitUsd) * 100;
      periods.push({
        period,
        limitUsd,
        spentUsd,
        spentBrl: spentUsd * usdBrl,
        percent,
        step: budgetStepOf(percent),
        tone: budgetToneOf(percent),
        start: new Date(bounds.startMs).toISOString(),
        end: new Date(bounds.endMs).toISOString(),
      });
    }
    const updatedAt = this.deps.updatedAt();
    return { limits, usdBrl, periods, ...(updatedAt ? { updatedAt } : {}) };
  }

  // ---------- Conta ----------

  private syncSources(): void {
    if (this.closed) return;
    const sources = this.deps.sources();
    const ids = new Set(sources.map((source) => source.id));
    for (const source of sources) {
      if (this.watching.has(source.id) || !source.subscribe) continue;
      this.watching.set(
        source.id,
        source.subscribe((event) => {
          if (event.type === "usage:agents") this.schedule();
        }),
      );
    }
    for (const id of [...this.watching.keys()]) {
      if (ids.has(id)) continue;
      this.watching.get(id)?.();
      this.watching.delete(id);
    }
  }

  private schedule(): void {
    if (this.closed || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.evaluate({ boot: false });
    }, this.deps.debounceMs ?? 1500);
    this.timer.unref();
  }

  /** O gasto equivalente de cada período com limite: lê o intervalo mais largo uma vez só. */
  private async spentByPeriod(limits: BudgetLimits, nowMs: number): Promise<Map<BudgetPeriod, number>> {
    const wanted = BUDGET_PERIODS.filter((period) => limits[budgetLimitKey(period)] !== undefined);
    const out = new Map<BudgetPeriod, number>();
    if (wanted.length === 0) return out;
    const bounds = new Map(wanted.map((period) => [period, budgetPeriodBounds(period, nowMs)] as const));
    const fromMs = Math.min(...[...bounds.values()].map((bound) => bound.startMs));
    const records: UsageRecord[] = [];
    for (const source of this.deps.sources()) {
      try {
        records.push(...(await source.read(fromMs, nowMs + 1)));
      } catch (error) {
        this.deps.log.warn({ err: error, workspace: source.id }, "orçamento: não foi possível ler o histórico de gastos");
      }
    }
    for (const record of records) {
      const at = Date.parse(record.at);
      const priced = priceRecord(record);
      if (priced.suspect || priced.cost.usd === null) continue;
      for (const [period, bound] of bounds) {
        if (at >= bound.startMs && at < bound.endMs) out.set(period, (out.get(period) ?? 0) + priced.cost.usd);
      }
    }
    return out;
  }

  private evaluate(options: { boot: boolean }): Promise<void> {
    this.running = this.running.then(() => this.run(options)).catch((error: unknown) => this.deps.log.warn({ err: error }, "orçamento: conferência falhou"));
    return this.running;
  }

  private async run(options: { boot: boolean }): Promise<void> {
    if (this.closed) return;
    const limits = this.deps.limits();
    const nowMs = this.deps.now().getTime();
    const spent = await this.spentByPeriod(limits, nowMs);
    const live = new Set<string>();
    for (const period of BUDGET_PERIODS) {
      const limitUsd = limits[budgetLimitKey(period)];
      if (limitUsd === undefined) continue;
      const bounds = budgetPeriodBounds(period, nowMs);
      const spentUsd = spent.get(period) ?? 0;
      const percent = (spentUsd / limitUsd) * 100;
      const reached = budgetStepOf(percent);
      // Só o degrau mais alto alcançado vive (o de 80% some quando chega o de 100%); se dois degraus ficaram pendentes de uma
      // vez (boot, limite novo já ultrapassado), avisa uma vez só, pelo mais alto.
      const steps = BUDGET_STEPS.filter((step) => step <= reached);
      if (steps.length === 0) continue;
      const top = steps[steps.length - 1]!;
      live.add(`${bounds.key}-${top}`);
      const unfired = steps.filter((step) => !this.fired.has(`${bounds.key}:${limitUsd}:${step}`));
      for (const step of steps) this.fired.add(`${bounds.key}:${limitUsd}:${step}`);
      if (unfired.length === 0) continue;
      this.deps.attention.raiseBudget({
        ref: `${bounds.key}-${top}`,
        level: top >= 100 ? "alert" : "warn",
        text: budgetAlertText({ period, limitUsd, spentUsd, percent }),
        expiresAt: bounds.endMs,
        ...(options.boot ? { replay: true } : {}),
      });
    }
    // Limite tirado ou trocado: o alerta de um limite que não vale mais sai. (O degrau de um período em curso volta
    // a avisar se o limite mudar: a chave de `fired` leva o valor.)
    this.deps.attention.clearBudget((ref) => live.has(ref));
  }
}
