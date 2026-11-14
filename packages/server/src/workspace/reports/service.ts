import { DAY_MS, type GestaoSettings, type MetricsReport, type ReportKind, type ReportListItem, type ReportTrigger, type RoutineResult, type StoredReport, type TodayView } from "@cyno/shared";
import type { FastifyBaseLogger } from "fastify";
import type { Delivery } from "../metrics/compute";
import { buildMonthReport, buildPeriodReport } from "./build";
import { isClosed, latestClosed, monthClosedBy, periodAt, periodOf, previousPeriod, resolvePeriod, weeksOfMonth, type Period } from "./period";
import { renderReportMarkdown } from "./render-md";
import { ReportStore } from "./store";

/** Tudo de que o serviço precisa, sem conhecer o runtime (os testes dão versões em memória). */
export type ReportDeps = {
  workspaceId: string;
  workspaceName: () => string;
  store: ReportStore;
  now: () => Date;
  settings: () => GestaoSettings;
  /** `computeMetrics` da janela [from, to) (ms). */
  metrics: (window: { from: number; to: number }) => Promise<MetricsReport>;
  deliveries: () => readonly Delivery[];
  results: () => readonly RoutineResult[];
  routineTitle: (routineId: string) => string;
  names: () => Readonly<Record<string, string>>;
  today: () => TodayView;
  nextTasks: () => readonly { title: string; project?: string; agent?: string }[];
  /**
   * Pede ao Maestro UM parágrafo por cima do relatório (só chamado com a chave de IA ligada em Configurações).
   * Devolve o texto, ou undefined se não deu (sem Maestro, sem cota, tempo esgotado).
   */
  ai?: (input: { kind: ReportKind; period: string; markdown: string }) => Promise<string | undefined>;
  log: Pick<FastifyBaseLogger, "info" | "warn" | "error">;
};

export type GenerateOptions = {
  trigger: ReportTrigger;
  /** O horário da cerimônia chegou: congela mesmo com o período ainda aberto (o dia às 18:30, a semana numa sexta). */
  ceremony?: boolean;
  /** Não grava (nem gera) se o período não teve movimento nenhum. */
  skipIfIdle?: boolean;
  /** Só monta: não grava no disco (o `get_report` de um período ainda aberto). */
  persist?: boolean;
};

export type GenerateResult = { report: StoredReport; regenerated: boolean; note?: string };

/** O período não teve entrega, gasto, decisão do dono nem falha: não vale um relatório (o que está parado ou pendente agora é condição, não movimento). */
export function isIdle(report: StoredReport): boolean {
  const m = report.metrics;
  if (!m) return report.digest.deliveries === 0 && report.digest.spendUsd === 0;
  return report.digest.deliveries === 0 && report.digest.spendUsd === 0 && m.rejectionRate.n === 0 && m.failureRate.n === 0 && m.approvalWait.n === 0;
}

const AI_KINDS: Record<ReportKind, keyof GestaoSettings["ai"] | undefined> = { day: "daily", week: "weekly", month: undefined };

/**
 * Os relatórios de um workspace: monta (por código), congela e lê. Um relatório FINAL (período fechado, ou horário da
 * cerimônia) nunca é refeito: pedir de novo devolve o guardado. O parcial ("Gerar agora" no meio do período) é
 * substituído pelo próximo. O parágrafo de IA é o único acréscimo permitido a um final, e só com a chave ligada.
 */
export class ReportService {
  constructor(private readonly deps: ReportDeps) {}

  get store(): ReportStore {
    return this.deps.store;
  }

  /** O que vale em Configurações > Gestão (horários e chave de IA). */
  settings(): GestaoSettings {
    return this.deps.settings();
  }

  async read(kind: ReportKind, period: string): Promise<StoredReport | undefined> {
    return this.deps.store.read(kind, period);
  }

  async list(): Promise<ReportListItem[]> {
    const kinds: ReportKind[] = ["day", "week", "month"];
    const all = (await Promise.all(kinds.map((kind) => this.deps.store.list(kind)))).flat();
    return all.map((report) => ({ kind: report.kind, period: report.period, from: report.from, to: report.to, generatedAt: report.generatedAt, final: report.final, deliveries: report.digest.deliveries, hasAi: report.ai !== undefined }));
  }

  /**
   * "latest": o último período fechado, ou o relatório final mais novo guardado se ele for mais novo (o resumo de hoje
   * às 18:30 vale mais, às 20:00, que o de ontem). Chave: o período dela (undefined = chave inválida para o tipo).
   */
  async resolve(kind: ReportKind, requested: string | undefined): Promise<Period | undefined> {
    const now = this.deps.now().getTime();
    const text = requested?.trim();
    if (text && text !== "latest") return periodOf(kind, text);
    const closed = latestClosed(kind, now);
    const newest = (await this.deps.store.list(kind)).find((report) => report.final);
    if (newest && newest.period > closed.key) return periodOf(kind, newest.period) ?? closed;
    return resolvePeriod(kind, "latest", now);
  }

  /** O guardado, ou montado na hora: período fechado é gravado; aberto volta parcial e NÃO é gravado (leitura não escreve parcial). */
  async ensure(kind: ReportKind, requested: string | undefined, trigger: ReportTrigger = "mcp"): Promise<StoredReport | undefined> {
    const period = await this.resolve(kind, requested);
    if (!period) return undefined;
    const stored = await this.deps.store.read(kind, period.key);
    if (stored?.final) return stored;
    const closed = isClosed(period, this.deps.now().getTime());
    return (await this.generate(kind, period.key, { trigger, persist: closed })).report;
  }

  /**
   * Gera o relatório de um período. Sem `requested`: o período de agora (parcial). Um final já guardado volta como está.
   */
  async generate(kind: ReportKind, requested: string | undefined, options: GenerateOptions): Promise<GenerateResult> {
    const nowMs = this.deps.now().getTime();
    const text = requested?.trim();
    const period = !text ? periodAt(kind, nowMs) : text === "latest" ? latestClosed(kind, nowMs) : periodOf(kind, text);
    if (!period) throw new RangeError(`Período inválido para ${kind}: "${requested}"`);
    const stored = await this.deps.store.read(kind, period.key);
    if (stored?.final) return { report: stored, regenerated: false, note: "Esse período já estava fechado: o relatório guardado não muda." };
    const final = isClosed(period, nowMs) || options.ceremony === true;
    const report = await this.build(period, nowMs, final, options.trigger);
    if (options.skipIfIdle && isIdle(report)) return { report, regenerated: false, note: "idle" };
    if (options.persist !== false) {
      if (!(await this.deps.store.write(report))) {
        // Outra geração gravou o final no meio do caminho: vale o guardado.
        const kept = await this.deps.store.read(kind, period.key);
        if (kept?.final) return { report: kept, regenerated: false, note: "Esse período já estava fechado: o relatório guardado não muda." };
      }
      if (final) void this.addAi(report).catch((error: unknown) => this.deps.log.warn({ err: error }, "parágrafo de IA do relatório falhou"));
    }
    return { report, regenerated: stored !== undefined };
  }

  private async build(period: Period, now: number, final: boolean, trigger: ReportTrigger): Promise<StoredReport> {
    const base = { period, now, workspace: this.deps.workspaceId, workspaceName: this.deps.workspaceName(), final, trigger, names: this.deps.names() };
    if (period.kind === "month") {
      const expected = weeksOfMonth(period.key);
      const weeks = (await Promise.all(expected.map((week) => this.deps.store.read("week", week.key)))).filter((week): week is StoredReport => week?.final === true);
      return buildMonthReport({ ...base, weeks, expected });
    }
    const metrics = await this.deps.metrics({ from: period.from, to: period.to });
    const compare = period.kind === "day" ? await this.deps.metrics({ from: period.from - 7 * DAY_MS, to: period.to - 7 * DAY_MS }) : undefined;
    const live = now >= period.from && now < period.to;
    return buildPeriodReport({
      ...base,
      metrics,
      ...(compare ? { compare } : {}),
      deliveries: this.deps.deliveries(),
      results: this.deps.results(),
      routineTitle: this.deps.routineTitle,
      ...(live && period.kind === "day" ? { today: this.deps.today(), nextTasks: this.deps.nextTasks() } : {}),
    });
  }

  /** O parágrafo de IA, só se a chave do tipo está ligada (padrão desligada: nada é pedido ao Maestro). */
  private async addAi(report: StoredReport): Promise<void> {
    const key = AI_KINDS[report.kind];
    if (!key || !this.deps.ai || !this.deps.settings().ai[key]) return;
    const text = (await this.deps.ai({ kind: report.kind, period: report.period, markdown: renderReportMarkdown(report) }))?.replace(/\s+/g, " ").trim();
    if (!text) return;
    const current = await this.deps.store.read(report.kind, report.period);
    if (!current || current.ai) return;
    await this.deps.store.write({ ...current, ai: { text: text.slice(0, 1500), at: this.deps.now().toISOString(), by: "Maestro" } });
  }

  /** O mensal que a semana fecha (se ela for a última do mês): gera junto, a partir das semanas guardadas. */
  async closeMonthOf(weekKey: string): Promise<StoredReport | undefined> {
    const week = periodOf("week", weekKey);
    const month = week ? monthClosedBy(week) : undefined;
    if (!month) return undefined;
    if ((await this.deps.store.read("month", month.key))?.final) return undefined;
    const { report, note } = await this.generate("month", month.key, { trigger: "schedule", ceremony: true, skipIfIdle: true });
    return note === "idle" ? undefined : report;
  }

  /** Resumo (do dia, da semana) já guardado como final? */
  async hasFinal(kind: ReportKind, period: string): Promise<boolean> {
    return (await this.deps.store.read(kind, period))?.final === true;
  }

  /** O relatório da semana (guardado ou montado na hora, sem gravar) para a soma da plataforma. */
  async weekFor(period: string): Promise<StoredReport | undefined> {
    const stored = await this.deps.store.read("week", period);
    if (stored) return stored;
    const found = periodOf("week", period);
    if (!found) return undefined;
    return (await this.generate("week", period, { trigger: "mcp", persist: false })).report;
  }

  /** O período anterior (a semana que fechou antes desta, por exemplo). */
  previous(kind: ReportKind): Period {
    return previousPeriod(periodAt(kind, this.deps.now().getTime()));
  }
}
