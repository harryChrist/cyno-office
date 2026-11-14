import { readFile } from "node:fs/promises";
import { DEFAULT_USD_BRL, type BudgetLimits, type SpendSettingsResponse, type UpdateBudgetBody } from "@cyno/shared";
import type { FastifyBaseLogger } from "fastify";
import { z } from "zod";
import { writeJsonAtomic } from "../../store/atomic-write";
import { WriteQueue } from "../../store/write-queue";

const limitSchema = z.number().positive().max(1_000_000).optional();
const fileSchema = z.object({
  usdBrl: z.number().positive().max(1000),
  updatedAt: z.string().optional(),
  /** Orçamento de consumo equivalente (J2-09): só avisa, nunca trava. */
  budget: z.object({ dayUsd: limitSchema, weekUsd: limitSchema, monthUsd: limitSchema, updatedAt: z.string().optional() }).optional(),
});
type Stored = z.infer<typeof fileSchema>;

/**
 * Configuração dos gastos da instalação, em DATA_DIR/spend.json: a cotação USD→BRL que a página
 * Gastos usa (editável na própria página). Sem arquivo (ou inválido) = DEFAULT_USD_BRL (PTAX de
 * venda do Banco Central perto de 2026-11-09).
 */
export class SpendSettingsStore {
  private readonly queue = new WriteQueue();

  private constructor(
    private readonly file: string | undefined,
    private current: Stored,
  ) {}

  static async load(file: string, log?: Pick<FastifyBaseLogger, "warn">): Promise<SpendSettingsStore> {
    let current: Stored = { usdBrl: DEFAULT_USD_BRL };
    try {
      const parsed = fileSchema.safeParse(JSON.parse(await readFile(file, "utf8")));
      if (parsed.success) current = parsed.data;
      else log?.warn({ file }, "spend.json inválido: usando a cotação padrão");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") log?.warn({ err: error }, "spend.json ilegível: usando a cotação padrão");
    }
    return new SpendSettingsStore(file, current);
  }

  /** Só em memória (testes). */
  static inMemory(usdBrl = DEFAULT_USD_BRL): SpendSettingsStore {
    return new SpendSettingsStore(undefined, { usdBrl });
  }

  usdBrl(): number {
    return this.current.usdBrl;
  }

  snapshot(): SpendSettingsResponse {
    return { usdBrl: this.current.usdBrl, defaultUsdBrl: DEFAULT_USD_BRL, ...(this.current.updatedAt ? { updatedAt: this.current.updatedAt } : {}) };
  }

  async setUsdBrl(usdBrl: number, now: Date = new Date()): Promise<SpendSettingsResponse> {
    this.current = { ...this.current, usdBrl, updatedAt: now.toISOString() };
    await this.save();
    return this.snapshot();
  }

  /** Os limites do orçamento (dia, semana, mês), em dólar equivalente. */
  budget(): BudgetLimits {
    const { dayUsd, weekUsd, monthUsd } = this.current.budget ?? {};
    return { ...(dayUsd !== undefined ? { dayUsd } : {}), ...(weekUsd !== undefined ? { weekUsd } : {}), ...(monthUsd !== undefined ? { monthUsd } : {}) };
  }

  budgetUpdatedAt(): string | undefined {
    return this.current.budget?.updatedAt;
  }

  /** Troca só o que veio; `null` tira o limite daquele período. */
  async setBudget(body: UpdateBudgetBody, now: Date = new Date()): Promise<BudgetLimits> {
    const next: NonNullable<Stored["budget"]> = { ...(this.current.budget ?? {}), updatedAt: now.toISOString() };
    for (const key of ["dayUsd", "weekUsd", "monthUsd"] as const) {
      if (body[key] === null) delete next[key];
      else if (body[key] !== undefined) next[key] = body[key];
    }
    this.current = { ...this.current, budget: next };
    await this.save();
    return this.budget();
  }

  private async save(): Promise<void> {
    const data = structuredClone(this.current);
    const file = this.file;
    if (file) await this.queue.enqueue(() => writeJsonAtomic(file, data));
  }

  flush(): Promise<void> {
    return this.queue.idle();
  }
}
