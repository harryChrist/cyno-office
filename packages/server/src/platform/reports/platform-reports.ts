import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { platformReportSchema, sumDigests, type PlatformReport } from "@cyno/shared";
import type { FastifyBaseLogger } from "fastify";
import { writeJsonAtomic } from "../../store/atomic-write";
import { latestClosed, periodOf } from "../../workspace/reports/period";
import { ptDuration, ptPercent, ptUsd } from "../../workspace/reports/model";
import type { ReportService } from "../../workspace/reports/service";

export type PlatformReportsDeps = {
  /** `data/platform/reports/`. */
  dir: string;
  workspaces: () => { id: string; name: string; reports: Pick<ReportService, "weekFor"> }[];
  /** Todos os workspaces cadastrados (mesmo os que ainda estão abrindo no boot): a semana só fecha quando TODOS resolveram. Ausente = os de `workspaces()`. */
  expected?: () => readonly string[];
  now: () => Date;
  log: Pick<FastifyBaseLogger, "info" | "warn" | "error">;
};

const WEEK_FILE = /^\d{4}-W\d{2}$/;

/**
 * A semana da plataforma: `data/platform/reports/week/AAAA-Www.json` com a soma de todos os workspaces e um bloco por workspace.
 * Gerada DEPOIS que o último workspace resolve a semana dele (cada relógio de relatórios avisa por `settled`); lê, para cada
 * workspace, o relatório da semana guardado (ou o monta sem gravar, se ele não teve movimento). Uma vez gravada, não muda.
 */
export class PlatformReports {
  private readonly settledBy = new Map<string, Set<string>>();

  constructor(private readonly deps: PlatformReportsDeps) {}

  private file(period: string): string {
    if (!WEEK_FILE.test(period)) throw new Error(`semana inválida: ${period}`);
    return path.join(this.deps.dir, "week", `${period}.json`);
  }

  async read(period: string): Promise<PlatformReport | undefined> {
    try {
      const parsed = platformReportSchema.safeParse(JSON.parse(await readFile(this.file(period), "utf8")));
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }

  /** Um workspace resolveu a semana: se todos já resolveram, gera a da plataforma. */
  settled(workspace: string, period: string): void {
    const set = this.settledBy.get(period) ?? new Set<string>();
    set.add(workspace);
    this.settledBy.set(period, set);
    const all = this.deps.workspaces();
    // No boot, o primeiro workspace pode resolver antes de o último abrir: sem conferir o cadastro, a semana saía gravada sem ele.
    const wanted = new Set([...all.map((item) => item.id), ...(this.deps.expected?.() ?? [])]);
    if (wanted.size === 0 || ![...wanted].every((id) => set.has(id))) return;
    void this.generate(period).catch((error: unknown) => this.deps.log.error({ err: error, period }, "não foi possível gerar a semana da plataforma"));
  }

  /** A semana da plataforma: a guardada, ou (se a semana já fechou) a montada agora e guardada. "latest" = a última fechada. */
  async ensure(requested: string | undefined): Promise<PlatformReport | undefined> {
    const text = requested?.trim();
    const period = !text || text === "latest" ? latestClosed("week", this.deps.now().getTime()) : periodOf("week", text);
    if (!period) return undefined;
    return (await this.read(period.key)) ?? (period.to <= this.deps.now().getTime() ? this.generate(period.key) : undefined);
  }

  private async generate(periodKey: string): Promise<PlatformReport | undefined> {
    const existing = await this.read(periodKey);
    if (existing) return existing;
    const period = periodOf("week", periodKey);
    if (!period) return undefined;
    const blocks: PlatformReport["workspaces"] = [];
    for (const item of this.deps.workspaces()) {
      const report = await item.reports.weekFor(periodKey);
      if (!report) continue;
      blocks.push({ workspace: item.id, name: item.name, digest: report.digest, deliveries: report.digest.deliveries, ...(report.sections.agents[0] ? { bestAgent: report.sections.agents[0].name } : {}) });
    }
    const report: PlatformReport = {
      v: 1,
      kind: "week",
      period: periodKey,
      from: new Date(period.from).toISOString(),
      to: new Date(period.to).toISOString(),
      generatedAt: this.deps.now().toISOString(),
      total: sumDigests(blocks.map((block) => block.digest)),
      workspaces: blocks,
    };
    await mkdir(path.dirname(this.file(periodKey)), { recursive: true });
    await writeJsonAtomic(this.file(periodKey), report);
    this.deps.log.info({ period: periodKey, workspaces: blocks.length }, "semana da plataforma gerada");
    return report;
  }
}

const usd = (value: number | null): string => (value === null ? "-" : `$${value.toFixed(2)}`);
const rate = (r: { hits: number; n: number }): string => (r.n === 0 ? "none (n=0)" : `${Math.round((r.hits / r.n) * 100)}% (${r.hits}/${r.n}${r.n < 5 ? ", few data" : ""})`);

/** O texto (inglês, compacto) da semana da plataforma para o `get_report` do Cyno. */
export function renderPlatformReportText(report: PlatformReport): string {
  const t = report.total;
  const out = [
    `Platform week ${report.period} (America/Sao_Paulo), frozen, generated ${report.generatedAt} by code. Sum of ${report.workspaces.length} workspaces: ${t.deliveries} deliveries; API-equivalent spend ${usd(t.spendUsd)} (subscription: equivalent, not money paid; read with the quota); rejection ${rate(t.rejection)}; rework ${rate(t.rework)}; failures ${rate(t.failure)}; goals hit ${t.goals.hit}/${t.goals.total}.`,
  ];
  for (const block of report.workspaces) out.push(`  ${block.name}: ${block.deliveries} deliveries${block.bestAgent ? ` (most: ${block.bestAgent})` : ""}; spend ${usd(block.digest.spendUsd)}; rejection ${rate(block.digest.rejection)}; goals ${block.digest.goals.hit}/${block.digest.goals.total}; median time to deliver ${block.digest.cycle.median === null ? "-" : ptDuration(block.digest.cycle.median)} (n=${block.digest.cycle.n})`);
  return out.join("\n");
}

/** O Markdown (pt-BR) da semana da plataforma. */
export function renderPlatformReportMarkdown(report: PlatformReport): string {
  const t = report.total;
  const out = [`# Semana da plataforma · ${report.period}`, "", `Calculado por código em ${report.generatedAt}. Valores em dólar são equivalentes à API (a conta é assinatura): leia junto da cota.`, "", `**Soma:** ${t.deliveries} entregas · custo equivalente ${ptUsd(t.spendUsd)} · metas ${t.goals.hit}/${t.goals.total} · recusado ${t.rejection.n === 0 ? "—" : ptPercent(t.rejection.hits / t.rejection.n)}`, "", "| Workspace | Entregas | Gasto equivalente | Recusado | Metas | Mais entregou |", "|---|---|---|---|---|---|"];
  for (const block of report.workspaces) out.push(`| ${block.name} | ${block.deliveries} | ${ptUsd(block.digest.spendUsd)} | ${block.digest.rejection.n === 0 ? "—" : ptPercent(block.digest.rejection.hits / block.digest.rejection.n)} | ${block.digest.goals.hit}/${block.digest.goals.total} | ${block.bestAgent ?? "—"} |`);
  return `${out.join("\n")}\n`;
}
