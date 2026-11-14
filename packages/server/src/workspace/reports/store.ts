import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { addDays, dayKeyOf, REPORT_DAY_RETENTION_DAYS, REPORT_KINDS, storedReportSchema, type ReportKind, type StoredReport } from "@cyno/shared";
import type { FastifyBaseLogger } from "fastify";
import { writeJsonAtomic } from "../../store/atomic-write";

/** Chaves aceitas no nome do arquivo (o dia, a semana e o mês): nada de `..` nem barra. */
const PERIOD_FILE = /^(\d{4}-\d{2}-\d{2}|\d{4}-W\d{2}|\d{4}-\d{2})$/;

type Log = Pick<FastifyBaseLogger, "warn">;

/**
 * Relatórios congelados em disco: `<dir>/{day,week,month}/<período>.json` (a pasta `retro/` fica livre para a fatia 6).
 * Escrita atômica (nunca um arquivo pela metade). Quem decide se um relatório pode ser refeito é o serviço; aqui só se guarda.
 */
export class ReportStore {
  constructor(
    private readonly dir: string,
    private readonly log?: Log,
  ) {}

  private file(kind: ReportKind, period: string): string {
    if (!(REPORT_KINDS as readonly string[]).includes(kind) || !PERIOD_FILE.test(period)) throw new Error(`relatório inválido: ${kind}/${period}`);
    return path.join(this.dir, kind, `${period}.json`);
  }

  async read(kind: ReportKind, period: string): Promise<StoredReport | undefined> {
    const file = this.file(kind, period);
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch {
      return undefined;
    }
    const parsed = storedReportSchema.safeParse(safeJson(text));
    if (!parsed.success) {
      this.log?.warn({ kind, period }, "relatório guardado ilegível: ignorado");
      return undefined;
    }
    return parsed.data;
  }

  /** Uma fila por arquivo: conferir o que há e gravar acontecem juntos, sem outra gravação no meio. */
  private readonly chains = new Map<string, Promise<unknown>>();

  /**
   * Grava o relatório. Um arquivo FINAL nunca é trocado por um que não é final, nem tem o conteúdo refeito: a única
   * mudança permitida é acrescentar o parágrafo de IA. Conferido na hora de gravar (uma geração parcial lenta, que
   * terminasse depois da cerimônia, não desfaz o final). Devolve `false` quando recusou (o final guardado fica como está).
   */
  async write(report: StoredReport): Promise<boolean> {
    const file = this.file(report.kind, report.period);
    const previous = this.chains.get(file) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(async () => {
      const current = await this.read(report.kind, report.period);
      if (current?.final && !onlyAddsAi(current, report)) {
        this.log?.warn({ kind: report.kind, period: report.period }, "relatório final guardado não é reescrito: gravação recusada");
        return false;
      }
      await mkdir(path.dirname(file), { recursive: true });
      await writeJsonAtomic(file, report);
      return true;
    });
    this.chains.set(file, run);
    try {
      return await run;
    } finally {
      if (this.chains.get(file) === run) this.chains.delete(file);
    }
  }

  /** Os relatórios de um tipo, do período mais novo ao mais antigo. */
  async list(kind: ReportKind): Promise<StoredReport[]> {
    let names: string[];
    try {
      names = await readdir(path.join(this.dir, kind));
    } catch {
      return [];
    }
    const periods = names.filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -5)).filter((name) => PERIOD_FILE.test(name));
    const reports = await Promise.all(periods.map((period) => this.read(kind, period)));
    return reports.filter((report): report is StoredReport => report !== undefined).sort((a, b) => b.period.localeCompare(a.period));
  }

  /** Apaga os resumos do dia com mais de 90 dias (semana e mês nunca são apagados). Devolve quantos. */
  async pruneDays(now: number): Promise<number> {
    const limit = addDays(dayKeyOf(now), -REPORT_DAY_RETENTION_DAYS);
    let names: string[];
    try {
      names = await readdir(path.join(this.dir, "day"));
    } catch {
      return 0;
    }
    let removed = 0;
    for (const name of names) {
      const key = name.slice(0, -5);
      if (name.endsWith(".json") && PERIOD_FILE.test(key) && key < limit) {
        await rm(this.file("day", key), { force: true });
        removed += 1;
      }
    }
    return removed;
  }
}

/** O novo é o mesmo relatório final, com no máximo o parágrafo de IA a mais (ou o mesmo parágrafo). */
function onlyAddsAi(current: StoredReport, next: StoredReport): boolean {
  if (!next.final) return false;
  const { ai: currentAi, ...rest } = current;
  const { ai: nextAi, ...nextRest } = next;
  if (currentAi !== undefined && stable(currentAi) !== stable(nextAi)) return false;
  return stable(rest) === stable(nextRest);
}

/** JSON com as chaves em ordem (a ordem em que o zod devolve não é a de quem montou o objeto) e sem `undefined`. */
function stable(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) => (entry && typeof entry === "object" && !Array.isArray(entry) ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b))) : entry));
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
