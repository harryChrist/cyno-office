import { mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { forYouRuleScopeSchema, RETRO_PERIOD_PATTERN, retroGroupSchema, storedRetroSchema, type StoredRetro } from "@cyno/shared";
import { z } from "zod";
import { writeJsonAtomic } from "../../store/atomic-write";

/** Uma regra proposta e em que pé ela está (o que a retrospectiva precisa lembrar entre uma semana e outra). */
export const ruleRecordSchema = z.object({
  itemId: z.string(),
  groupId: z.string(),
  /** O padrão de onde veio (a conta do antes/depois repete a mesma fórmula nele). */
  target: retroGroupSchema.pick({ kind: true, type: true, key: true, trait: true, words: true, agentIds: true }),
  typeName: z.string(),
  agentNames: z.array(z.string()),
  line: z.string(),
  text: z.string(),
  scope: forYouRuleScopeSchema,
  source: z.enum(["molde", "maestro"]),
  retro: z.string(),
  state: z.enum(["esperando", "aprovada", "recusada"]),
  proposedAt: z.string(),
  decidedAt: z.string().optional(),
  notePath: z.string().optional(),
});
export type RuleRecord = z.infer<typeof ruleRecordSchema>;

const stateSchema = z.object({
  v: z.literal(1),
  /** Padrões recusados: o id do grupo e até quando ele não volta (ISO). */
  suppressed: z.record(z.string(), z.string()).default({}),
  rules: z.array(ruleRecordSchema).default([]),
});
export type RetroState = z.infer<typeof stateSchema>;

export const emptyRetroState = (): RetroState => ({ v: 1, suppressed: {}, rules: [] });

/**
 * A retrospectiva em disco, dentro de `reports/retro/`: `state.json` (regras propostas e padrões recusados) e uma retrospectiva
 * por semana (`2026-W46.json`). Escrita atômica; arquivo ilegível vira estado vazio (nunca derruba nada).
 */
export class RetroStore {
  constructor(private readonly dir: string) {}

  private statePath(): string {
    return path.join(this.dir, "state.json");
  }

  private reportPath(period: string): string {
    if (!RETRO_PERIOD_PATTERN.test(period)) throw new Error(`retrospectiva inválida: ${period}`);
    return path.join(this.dir, `${period}.json`);
  }

  async readState(): Promise<RetroState> {
    try {
      const parsed = stateSchema.safeParse(JSON.parse(await readFile(this.statePath(), "utf8")));
      return parsed.success ? parsed.data : emptyRetroState();
    } catch {
      return emptyRetroState();
    }
  }

  async writeState(state: RetroState): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeJsonAtomic(this.statePath(), state);
  }

  async read(period: string): Promise<StoredRetro | undefined> {
    try {
      const parsed = storedRetroSchema.safeParse(JSON.parse(await readFile(this.reportPath(period), "utf8")));
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }

  async write(report: StoredRetro): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeJsonAtomic(this.reportPath(report.period), report);
  }

  /** As retrospectivas guardadas, da mais nova à mais antiga. */
  async list(): Promise<{ period: string; generatedAt: string }[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return [];
    }
    const periods = names.filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -5)).filter((name) => RETRO_PERIOD_PATTERN.test(name));
    const reports = await Promise.all(periods.map((period) => this.read(period)));
    return reports.filter((report): report is StoredRetro => report !== undefined).map((report) => ({ period: report.period, generatedAt: report.generatedAt })).sort((a, b) => b.period.localeCompare(a.period));
  }
}
