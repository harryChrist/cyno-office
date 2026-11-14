import { readFile } from "node:fs/promises";
import { DEFAULT_ONE_SHOT_ACCOUNT, ONE_SHOT_ACCOUNT_MODES, ONE_SHOT_ENGINE_IDS, ONE_SHOT_LOCATIONS, SUPPORTED_ENGINE_IDS, type EngineChoices, type OneShotAccount, type EngineTestResult, type EngineVerifyResult, type OneShotEngineId, type SupportedEngineId } from "@cyno/shared";
import type { FastifyBaseLogger } from "fastify";
import { writeJsonAtomic } from "../../store/atomic-write";
import { WriteQueue } from "../../store/write-queue";

/**
 * O que a tela Motores guarda no servidor (DATA_DIR/platform/engines.json): o caminho do executável de
 * cada motor (vale sobre CLAUDE_BIN/AGY_BIN) e o último "Testar". Nada de senha nem de token: o login
 * é da própria CLI.
 */
/** Motores com caminho e teste guardados: os de assinatura (Claude, Antigravity) e os de um processo por turno (OpenClaw, Hermes). */
export type StoredEngineId = SupportedEngineId | OneShotEngineId;
const STORED_ENGINE_IDS: readonly StoredEngineId[] = [...SUPPORTED_ENGINE_IDS, ...ONE_SHOT_ENGINE_IDS];

/** Gateways do Hermes ao mesmo tempo: padrão e limites do teto que o dono escolhe na tela Motores (cada um são ~270 MB). */
export const DEFAULT_HERMES_GATEWAYS = 2;
export const MAX_HERMES_GATEWAYS = 8;

export type EngineSettingsData = {
  /** Hermes: quantos gateways (agentes em turno) ao mesmo tempo; os outros esperam na fila. Ausente = o padrão. */
  maxGateways?: number;
  paths: Partial<Record<StoredEngineId, string>>;
  tests: Partial<Record<StoredEngineId, EngineTestResult>>;
  /** OpenClaw e Hermes: modelo/esforço/provedor padrão (Configurar). */
  choices: Partial<Record<OneShotEngineId, EngineChoices>>;
  /** OpenClaw e Hermes: custo em dólar que o programa relatou (soma e último): informação. */
  spent: Partial<Record<OneShotEngineId, { usd: number; at: string }>>;
  /** OpenClaw e Hermes: o último "Verificar". */
  verify: Partial<Record<OneShotEngineId, EngineVerifyResult>>;
  /** OpenClaw e Hermes: a forma de conta (chave do painel ou configuração do próprio programa). Ausente = a chave do painel (como sempre foi). */
  account: Partial<Record<OneShotEngineId, OneShotAccount>>;
  /** OpenClaw e Hermes: a cerca de arquivos (Landlock) ligada ou desligada. Ausente = ligada (o padrão; só vale onde o computador tem Landlock). */
  fence: Partial<Record<OneShotEngineId, boolean>>;
};

const emptyData = (): EngineSettingsData => ({ paths: {}, tests: {}, choices: {}, spent: {}, verify: {}, account: {}, fence: {} });

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function readData(raw: unknown): EngineSettingsData {
  const data = emptyData();
  if (!isRecord(raw)) return data;
  if (typeof raw.maxGateways === "number" && Number.isFinite(raw.maxGateways) && raw.maxGateways >= 1) data.maxGateways = Math.min(MAX_HERMES_GATEWAYS, Math.floor(raw.maxGateways));
  for (const id of ONE_SHOT_ENGINE_IDS) {
    const choice = isRecord(raw.choices) ? raw.choices[id] : undefined;
    if (isRecord(choice)) {
      const efforts = ["low", "medium", "high", "xhigh", "max"];
      data.choices[id] = {
        ...(typeof choice.model === "string" && choice.model ? { model: choice.model } : {}),
        ...(typeof choice.provider === "string" && choice.provider ? { provider: choice.provider } : {}),
        ...(choice.unlisted === true && typeof choice.model === "string" && choice.model ? { unlisted: true } : {}),
        ...(typeof choice.effort === "string" && efforts.includes(choice.effort) ? { effort: choice.effort as EngineChoices["effort"] } : {}),
      };
    }
    const spent = isRecord(raw.spent) ? raw.spent[id] : undefined;
    if (isRecord(spent) && typeof spent.usd === "number" && typeof spent.at === "string") data.spent[id] = { usd: spent.usd, at: spent.at };
    const account = isRecord(raw.account) ? raw.account[id] : undefined;
    if (isRecord(account) && (ONE_SHOT_ACCOUNT_MODES as readonly unknown[]).includes(account.mode)) {
      data.account[id] = { mode: account.mode as OneShotAccount["mode"], location: (ONE_SHOT_LOCATIONS as readonly unknown[]).includes(account.location) ? (account.location as OneShotAccount["location"]) : "cyno" };
    }
    const fence = isRecord(raw.fence) ? raw.fence[id] : undefined;
    if (typeof fence === "boolean") data.fence[id] = fence;
    const verify = isRecord(raw.verify) ? raw.verify[id] : undefined;
    if (isRecord(verify) && typeof verify.at === "string" && typeof verify.ok === "boolean" && Array.isArray(verify.checks)) data.verify[id] = verify as unknown as EngineVerifyResult;
  }
  for (const id of STORED_ENGINE_IDS) {
    const pathValue = isRecord(raw.paths) ? raw.paths[id] : undefined;
    if (typeof pathValue === "string" && pathValue.trim()) data.paths[id] = pathValue.trim();
    const test = isRecord(raw.tests) ? raw.tests[id] : undefined;
    if (isRecord(test) && typeof test.ok === "boolean" && typeof test.ms === "number" && typeof test.at === "string") {
      data.tests[id] = {
        ok: test.ok,
        ms: test.ms,
        at: test.at,
        ...(typeof test.text === "string" ? { text: test.text } : {}),
        ...(typeof test.error === "string" ? { error: test.error } : {}),
        ...(typeof test.tokens === "number" ? { tokens: test.tokens } : {}),
        ...(typeof test.model === "string" ? { model: test.model } : {}),
      };
    }
  }
  return data;
}

export class EngineSettingsStore {
  private readonly queue = new WriteQueue();

  private constructor(
    private readonly file: string | undefined,
    private data: EngineSettingsData,
  ) {}

  static async load(file: string, log?: Pick<FastifyBaseLogger, "warn">): Promise<EngineSettingsStore> {
    let data = emptyData();
    try {
      data = readData(JSON.parse(await readFile(file, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") log?.warn({ err: error }, "engines.json ilegível: começando vazio");
    }
    return new EngineSettingsStore(file, data);
  }

  static inMemory(): EngineSettingsStore {
    return new EngineSettingsStore(undefined, emptyData());
  }

  paths(): Partial<Record<StoredEngineId, string>> {
    return { ...this.data.paths };
  }

  tests(): Partial<Record<StoredEngineId, EngineTestResult>> {
    return { ...this.data.tests };
  }

  /** O teto de gateways simultâneos do Hermes (lido a cada pedido de vaga). */
  maxGateways(): number {
    return this.data.maxGateways ?? DEFAULT_HERMES_GATEWAYS;
  }

  /** Chamado quando o teto muda (acorda os turnos que esperam vaga). */
  onMaxGateways: (() => void) | undefined;

  async setMaxGateways(count: number): Promise<void> {
    this.data.maxGateways = Math.min(MAX_HERMES_GATEWAYS, Math.max(1, Math.floor(count)));
    this.onMaxGateways?.();
    await this.save();
  }

  choices(engine: OneShotEngineId): EngineChoices {
    return { ...this.data.choices[engine] };
  }

  async setChoices(engine: OneShotEngineId, choices: EngineChoices): Promise<void> {
    if (Object.keys(choices).length > 0) this.data.choices[engine] = { ...choices };
    else delete this.data.choices[engine];
    await this.save();
  }

  /** A forma de conta do motor (padrão: a chave do OpenRouter pelo painel, na pasta do Cyno). */
  account(engine: OneShotEngineId): OneShotAccount {
    return { ...(this.data.account[engine] ?? DEFAULT_ONE_SHOT_ACCOUNT) };
  }

  async setAccount(engine: OneShotEngineId, account: OneShotAccount): Promise<void> {
    this.data.account[engine] = { ...account };
    await this.save();
  }

  /** A cerca de arquivos do motor está ligada (a opção da tela)? Padrão: sim. Se vale de verdade depende também de o computador ter Landlock. */
  fence(engine: OneShotEngineId): boolean {
    return this.data.fence[engine] ?? true;
  }

  async setFence(engine: OneShotEngineId, on: boolean): Promise<void> {
    this.data.fence[engine] = on;
    await this.save();
  }

  spent(engine: OneShotEngineId): { usd: number; at: string } | undefined {
    return this.data.spent[engine] ? { ...this.data.spent[engine]! } : undefined;
  }

  /** O programa relatou custo em dólar num turno: soma e guarda o instante. */
  async noteSpent(engine: OneShotEngineId, usd: number, at: string): Promise<void> {
    this.data.spent[engine] = { usd: (this.data.spent[engine]?.usd ?? 0) + usd, at };
    await this.save();
  }

  verify(engine: OneShotEngineId): EngineVerifyResult | undefined {
    return this.data.verify[engine] ? (JSON.parse(JSON.stringify(this.data.verify[engine])) as EngineVerifyResult) : undefined;
  }

  async setVerify(engine: OneShotEngineId, result: EngineVerifyResult): Promise<void> {
    this.data.verify[engine] = result;
    await this.save();
  }

  async clearVerify(engine: OneShotEngineId): Promise<void> {
    delete this.data.verify[engine];
    await this.save();
  }

  async setPath(engine: StoredEngineId, value: string | null): Promise<void> {
    if (value) this.data.paths[engine] = value;
    else delete this.data.paths[engine];
    await this.save();
  }

  async setTest(engine: StoredEngineId, result: EngineTestResult): Promise<void> {
    this.data.tests[engine] = result;
    await this.save();
  }

  private async save(): Promise<void> {
    const file = this.file;
    if (!file) return;
    const snapshot = JSON.parse(JSON.stringify(this.data)) as EngineSettingsData;
    await this.queue.enqueue(() => writeJsonAtomic(file, snapshot));
  }

  flush(): Promise<void> {
    return this.queue.idle();
  }
}
