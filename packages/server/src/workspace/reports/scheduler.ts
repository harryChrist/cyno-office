import { gestaoSettings, type GestaoOverrides, type ReportKind } from "@cyno/shared";
import type { FastifyBaseLogger } from "fastify";
import { dailyDue, weeklyDue, type DueMoment } from "./period";
import type { ReportService } from "./service";

/** De quanto em quanto tempo o relógio confere (a hora mais fina é o minuto, como o relógio dos horários das rotinas). */
export const REPORT_TICK_MS = 60_000;

/** Espera entre tentativas depois de uma falha: 5 min, dobrando até 1 h. */
export const REPORT_RETRY_BASE_MS = 5 * 60_000;
export const REPORT_RETRY_MAX_MS = 60 * 60_000;

export type ReportSchedulerDeps = {
  reports: Pick<ReportService, "generate" | "hasFinal" | "closeMonthOf" | "store">;
  /** A retrospectiva sai junto da revisão da semana (só código; os cartões de regra por molde abrem na hora, sem IA). */
  retro?: { generate: (trigger: "schedule", period: string) => Promise<unknown> };
  /** O que o workspace guardou em `gestao` (o padrão completa o resto). */
  settings: () => GestaoOverrides | undefined;
  now: () => Date;
  log: Pick<FastifyBaseLogger, "info" | "warn" | "error">;
  /** A semana deste workspace foi resolvida (gerada, já existia ou não teve movimento): a plataforma soma quando todos resolvem. */
  weekSettled?: (period: string) => void;
  everyMs?: number;
};

/**
 * Relógio dos relatórios (um por workspace), irmão do `SlotClock`: a cada minuto confere se o horário do resumo do dia
 * ou da revisão da semana chegou e, se o relatório daquele período ainda não está guardado, gera. É só código, sem token,
 * e NUNCA acorda o Maestro (o parágrafo de IA, se ligado em Configurações, é pedido à parte pelo serviço).
 *
 * Gera uma vez: o arquivo final guardado é a marca (sobrevive a reinício) e um conjunto em memória evita refazer a conta
 * a cada minuto. Horário perdido (servidor desligado): na próxima passada gera só o ÚLTIMO período devido, nunca uma fila
 * de períodos atrasados. Período sem movimento algum não vira relatório.
 */
export class ReportScheduler {
  private timer: NodeJS.Timeout | undefined;
  private stopped = true;
  private running = false;
  private readonly settled = new Set<string>();
  /** Falhas por período: quando tentar de novo (espera que dobra de 5 min até 1 h), para não repetir a cada minuto. */
  private readonly retries = new Map<string, { attempts: number; at: number }>();

  constructor(private readonly deps: ReportSchedulerDeps) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.tick().catch((error: unknown) => this.deps.log.error({ err: error }, "relógio dos relatórios falhou"));
    this.schedule();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.tick()
        .catch((error: unknown) => this.deps.log.error({ err: error }, "relógio dos relatórios falhou"))
        .finally(() => this.schedule());
    }, this.deps.everyMs ?? REPORT_TICK_MS);
    this.timer.unref();
  }

  /** Uma passada (os testes chamam direto). */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const now = this.deps.now().getTime();
      const settings = gestaoSettings(this.deps.settings());
      if (settings.dailyAt) {
        const due = dailyDue(settings.dailyAt, now);
        if (due) await this.ceremony("day", due, now);
      }
      const weekly = weeklyDue(settings.weekly, now);
      if (weekly) {
        // A semana só vale como resolvida depois de gerada (ou sem movimento); se falhou, tenta de novo mais tarde.
        if (await this.ceremony("week", weekly, now)) this.deps.weekSettled?.(weekly.period.key);
      }
      await this.deps.reports.store.pruneDays(now);
    } finally {
      this.running = false;
    }
  }

  /** `true` = o período está resolvido (gerado, já guardado ou sem movimento); `false` = falhou ou espera a próxima tentativa. */
  private async ceremony(kind: ReportKind, due: DueMoment, now: number): Promise<boolean> {
    const mark = `${kind}:${due.period.key}`;
    if (this.settled.has(mark)) return true;
    if (await this.deps.reports.hasFinal(kind, due.period.key)) {
      this.settled.add(mark);
      return true;
    }
    const retry = this.retries.get(mark);
    if (retry && now < retry.at) return false;
    try {
      const result = await this.deps.reports.generate(kind, due.period.key, { trigger: "schedule", ceremony: true, skipIfIdle: true });
      this.settled.add(mark);
      this.retries.delete(mark);
      if (result.note === "idle") this.deps.log.info({ kind, period: due.period.key }, "relatório sem movimento: não gerado");
      else this.deps.log.info({ kind, period: due.period.key }, "relatório gerado");
    } catch (error) {
      const attempts = (retry?.attempts ?? 0) + 1;
      const wait = Math.min(REPORT_RETRY_MAX_MS, REPORT_RETRY_BASE_MS * 2 ** (attempts - 1));
      this.retries.set(mark, { attempts, at: now + wait });
      this.deps.log.error({ err: error, kind, period: due.period.key, attempts, retryInMs: wait }, "não foi possível gerar o relatório: tenta de novo mais tarde");
      return false;
    }
    // A semana que fecha o mês fecha o mensal (da soma das semanas guardadas), mesmo que ela própria não tenha movimento.
    if (kind === "week") {
      try {
        await this.deps.reports.closeMonthOf(due.period.key);
      } catch (error) {
        this.deps.log.error({ err: error, period: due.period.key }, "não foi possível fechar o mês");
      }
      // Junto da revisão da semana (e mesmo se ela não teve movimento): os padrões dos últimos 14 dias.
      await this.deps.retro?.generate("schedule", due.period.key).catch((error: unknown) => this.deps.log.error({ err: error, period: due.period.key }, "não foi possível gerar a retrospectiva"));
    }
    return true;
  }
}
