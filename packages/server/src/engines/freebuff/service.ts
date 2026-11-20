import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  FREEBUFF_DEFAULT_MAX_OPEN_HOURS,
  FREEBUFF_DEFAULT_MODEL,
  FREEBUFF_HOUR_MS,
  FREEBUFF_MAX_OPEN_HOURS_LIMIT,
  freebuffBlock,
  type EngineBlock,
  type FreebuffHourSession,
  type FreebuffHoursInfo,
  type FreebuffModel,
  type FreebuffSettings,
  type EngineTestResult,
  type FreebuffUsageDetail,
} from "@cyno/shared";
import type { FastifyBaseLogger } from "fastify";
import { writeJsonAtomic } from "../../store/atomic-write";
import { WriteQueue } from "../../store/write-queue";
import type { HoursReading } from "./screen-reader";

/**
 * Lista de reserva (lida do `/model` em 12/11): só serve para saber o multiplicador do modelo antes de
 * a lista ser lida de verdade. O catálogo do Freebuff muda toda semana: a lista lida pela tela vale mais.
 */
export const FREEBUFF_REFERENCE_MODELS: readonly FreebuffModel[] = [
  { name: "DeepSeek V4.1 Flash Slow", multiplier: 1, efforts: ["low"], defaultEffort: "low", section: "STANDARD" },
  { name: "DeepSeek V4.1 Flash", multiplier: 2, efforts: ["low", "high"], defaultEffort: "high", section: "PREMIUM" },
  { name: "DeepSeek V4.1 Flash Fast", multiplier: 3, efforts: ["high"], defaultEffort: "high", section: "POWERFUL" },
];

/** A hora em que o dia do Freebuff vira (UTC), medida em 12/11: 03:00 UTC = meia-noite em Brasília. */
export const FREEBUFF_DAY_RESET_UTC_HOUR = 3;

/** O próximo "virar do dia" depois de `now` (ms). */
export function nextDayReset(now: number): number {
  const date = new Date(now);
  const reset = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), FREEBUFF_DAY_RESET_UTC_HOUR);
  return reset > now ? reset : reset + 24 * 3_600_000;
}

/** Uma hora aberta, como fica gravada (`engine-sessions.json`): o necessário para reassumir depois de um reinício. */
export type StoredHour = Omit<FreebuffHourSession, "hasProcess"> & {
  /** Id do chat do Freebuff (nome da pasta dele), para `--continue <id>`. */
  chatId?: string;
  /** A hora era de outro processo (o Freebuff a retomou): o custo dela não foi cobrado de novo. */
  joined?: boolean;
  /** Nome da pasta de trabalho (a pasta dos chats do Freebuff leva este nome). */
  folder: string;
  cwd: string;
};

type StoredHours = { total?: number; remaining?: number; wallet?: number; resetsAt?: string; measuredAt?: string; openedSince: number };

type StoreData = {
  settings: FreebuffSettings;
  sessions: StoredHour[];
  hours: StoredHours;
  models: FreebuffModel[];
  modelsReadAt?: string;
  test?: EngineTestResult;
};

export type FreebuffServiceEvent = { type: "expired"; agentId: string; workspaceId: string } | { type: "changed" };

/** Um agente: o id vale dentro do workspace. */
export type AgentRef = { workspaceId: string; agentId: string };
const sameAgent = (session: AgentRef, ref: AgentRef) => session.agentId === ref.agentId && session.workspaceId === ref.workspaceId;

export type FreebuffServiceDeps = {
  now: () => Date;
  /** Duração de uma hora aberta (padrão 60 min; só os testes com a TUI falsa de hora curta mudam). */
  hourMs?: number;
  /** O estado novo (vira o uso do provedor "freebuff" e sai pelo `usage:updated`). */
  publish?: (detail: FreebuffUsageDetail) => void;
  log?: Pick<FastifyBaseLogger, "info" | "warn">;
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isoOrUndefined = (value: unknown): string | undefined => (typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : undefined);
const numberOrUndefined = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined);

function defaults(): StoreData {
  return { settings: { model: FREEBUFF_DEFAULT_MODEL.name, effort: FREEBUFF_DEFAULT_MODEL.effort, maxOpenHours: FREEBUFF_DEFAULT_MAX_OPEN_HOURS }, sessions: [], hours: { openedSince: 0 }, models: [] };
}

function readData(raw: unknown): StoreData {
  const data = defaults();
  if (!isRecord(raw)) return data;
  if (isRecord(raw.settings)) {
    if (typeof raw.settings.model === "string" && raw.settings.model.trim()) data.settings.model = raw.settings.model.trim().slice(0, 80);
    if (typeof raw.settings.effort === "string" && raw.settings.effort.trim()) data.settings.effort = raw.settings.effort.trim().slice(0, 20);
    const max = numberOrUndefined(raw.settings.maxOpenHours);
    if (max !== undefined && max >= 1) data.settings.maxOpenHours = Math.min(FREEBUFF_MAX_OPEN_HOURS_LIMIT, Math.floor(max));
  }
  if (Array.isArray(raw.sessions)) {
    for (const item of raw.sessions) {
      if (!isRecord(item)) continue;
      const openedAt = isoOrUndefined(item.openedAt);
      const endsAt = isoOrUndefined(item.endsAt);
      if (typeof item.agentId !== "string" || typeof item.workspaceId !== "string" || typeof item.folder !== "string" || typeof item.cwd !== "string" || !openedAt || !endsAt) continue;
      data.sessions.push({
        agentId: item.agentId,
        workspaceId: item.workspaceId,
        ...(typeof item.agentName === "string" ? { agentName: item.agentName } : {}),
        openedAt,
        endsAt,
        endsAtSource: item.endsAtSource === "measured" ? "measured" : "estimated",
        multiplier: numberOrUndefined(item.multiplier) ?? 1,
        model: typeof item.model === "string" ? item.model : data.settings.model,
        ...(typeof item.effort === "string" ? { effort: item.effort } : {}),
        ...(typeof item.chatId === "string" ? { chatId: item.chatId } : {}),
        ...(item.joined === true ? { joined: true } : {}),
        folder: item.folder,
        cwd: item.cwd,
      });
    }
  }
  if (isRecord(raw.hours)) {
    const hours = raw.hours;
    data.hours = {
      ...(numberOrUndefined(hours.total) !== undefined ? { total: numberOrUndefined(hours.total)! } : {}),
      ...(numberOrUndefined(hours.remaining) !== undefined ? { remaining: numberOrUndefined(hours.remaining)! } : {}),
      ...(numberOrUndefined(hours.wallet) !== undefined ? { wallet: numberOrUndefined(hours.wallet)! } : {}),
      ...(isoOrUndefined(hours.resetsAt) ? { resetsAt: isoOrUndefined(hours.resetsAt)! } : {}),
      ...(isoOrUndefined(hours.measuredAt) ? { measuredAt: isoOrUndefined(hours.measuredAt)! } : {}),
      openedSince: numberOrUndefined(hours.openedSince) ?? 0,
    };
  }
  if (Array.isArray(raw.models)) {
    for (const item of raw.models) {
      if (!isRecord(item) || typeof item.name !== "string") continue;
      data.models.push({
        name: item.name.slice(0, 80),
        multiplier: numberOrUndefined(item.multiplier) ?? 1,
        efforts: Array.isArray(item.efforts) ? item.efforts.filter((effort): effort is string => typeof effort === "string").slice(0, 10) : [],
        ...(typeof item.defaultEffort === "string" ? { defaultEffort: item.defaultEffort } : {}),
        ...(typeof item.section === "string" ? { section: item.section } : {}),
      });
    }
  }
  if (isRecord(raw.test) && typeof raw.test.ok === "boolean" && typeof raw.test.ms === "number" && typeof raw.test.at === "string") {
    data.test = {
      ok: raw.test.ok,
      ms: raw.test.ms,
      at: raw.test.at,
      ...(typeof raw.test.text === "string" ? { text: raw.test.text } : {}),
      ...(typeof raw.test.error === "string" ? { error: raw.test.error } : {}),
      ...(typeof raw.test.model === "string" ? { model: raw.test.model } : {}),
    };
  }
  data.modelsReadAt = isoOrUndefined(raw.modelsReadAt);
  if (!data.modelsReadAt) delete data.modelsReadAt;
  return data;
}

/**
 * As HORAS ABERTAS do Freebuff (uma só para o servidor: a hora é da conta, não do workspace).
 *
 * - `sessions`: uma hora por agente com mensagem (o experimento mostrou: cada processo com mensagem abre a
 *   sua própria hora, e o custo é multiplicado pelo modelo). Fica gravada em `engine-sessions.json` e a
 *   hora continua contando se o servidor reiniciar.
 * - Teto de horas abertas ao mesmo tempo (padrão 1): quem precisa de uma hora nova com o teto cheio espera
 *   (`freebuffBlock`); quem já tem hora aberta usa a que já pagou.
 * - As horas do dia: o Cyno LÊ o saldo na tela do Freebuff (banner "N/21 hours remaining" e rodapé do
 *   `/model`) e, a cada hora que ele mesmo abre depois, desconta (por isso é estimativa até a próxima leitura).
 * - O modelo e o esforço do Freebuff: um só para a plataforma (a escolha da TUI é global na máquina).
 */
export class FreebuffService {
  private readonly listeners = new Set<(event: FreebuffServiceEvent) => void>();
  private readonly queue = new WriteQueue();
  private readonly alive = new Set<string>();
  /** Agentes com pedido na fila que ainda não abriram a hora (contam para o teto). */
  private readonly claims = new Map<string, { agentId: string; agentName?: string; workspaceId: string }>();
  private readonly aliveKey = (ref: AgentRef) => `${ref.workspaceId}/${ref.agentId}`;
  private timer: NodeJS.Timeout | undefined;
  private closed = false;

  private constructor(
    private readonly file: string | undefined,
    private data: StoreData,
    private readonly deps: FreebuffServiceDeps,
  ) {}

  static async open(file: string | undefined, deps: FreebuffServiceDeps): Promise<FreebuffService> {
    let data = defaults();
    if (file) {
      try {
        data = readData(JSON.parse(await readFile(file, "utf8")));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") deps.log?.warn({ err: error }, "engine-sessions.json ilegível: começando vazio");
      }
    }
    const service = new FreebuffService(file, data, deps);
    service.sweep();
    service.arm();
    return service;
  }

  // ---------- Leitura ----------

  private nowMs(): number {
    return this.deps.now().getTime();
  }

  settings(): FreebuffSettings {
    return { ...this.data.settings };
  }

  models(): { models: FreebuffModel[]; readAt?: string } {
    return { models: this.data.models.map((model) => ({ ...model, efforts: [...model.efforts] })), ...(this.data.modelsReadAt ? { readAt: this.data.modelsReadAt } : {}) };
  }

  /** Quantas horas do saldo cada hora aberta gasta com o modelo escolhido (lista lida, senão a de reserva, senão 1). */
  multiplier(): number {
    const name = this.data.settings.model;
    return this.data.models.find((model) => model.name === name)?.multiplier ?? FREEBUFF_REFERENCE_MODELS.find((model) => model.name === name)?.multiplier ?? 1;
  }

  /** As horas abertas agora. */
  sessions(): StoredHour[] {
    const now = this.nowMs();
    return this.data.sessions.filter((session) => Date.parse(session.endsAt) > now).map((session) => ({ ...session }));
  }

  sessionOf(ref: AgentRef): StoredHour | undefined {
    return this.sessions().find((session) => sameAgent(session, ref));
  }

  hours(): FreebuffHoursInfo {
    const { total, remaining, wallet, resetsAt, measuredAt, openedSince } = this.data.hours;
    return {
      ...(total !== undefined ? { total } : {}),
      ...(remaining !== undefined ? { remaining: Math.max(0, Math.round((remaining - openedSince) * 100) / 100) } : {}),
      ...(wallet !== undefined ? { wallet } : {}),
      ...(resetsAt ? { resetsAt } : total !== undefined ? { resetsAt: new Date(nextDayReset(this.nowMs())).toISOString() } : {}),
      ...(measuredAt ? { measuredAt } : {}),
      openedSince,
    };
  }

  /** O estado inteiro, no formato do uso da assinatura (`SubscriptionUsage.freebuff`). */
  detail(): FreebuffUsageDetail {
    return {
      settings: { ...this.data.settings, multiplier: this.multiplier() },
      hours: this.hours(),
      sessions: this.sessions().map((session) => ({ ...stripStored(session), hasProcess: this.alive.has(this.aliveKey(session)) })),
      ...(this.claims.size > 0 ? { pending: [...this.claims.values()].map((claim) => ({ ...claim })) } : {}),
    };
  }

  /** Por que o agente não pode abrir uma hora agora (mesma regra da tela). */
  blockFor(ref: AgentRef): EngineBlock | undefined {
    return freebuffBlock(this.detail(), ref, this.nowMs());
  }

  subscribe(listener: (event: FreebuffServiceEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ---------- Escrita ----------

  async setSettings(patch: Partial<FreebuffSettings>): Promise<FreebuffSettings> {
    const next = { ...this.data.settings };
    if (patch.model !== undefined) next.model = patch.model.trim();
    if (patch.effort !== undefined) next.effort = patch.effort.trim();
    if (patch.maxOpenHours !== undefined) next.maxOpenHours = Math.min(FREEBUFF_MAX_OPEN_HOURS_LIMIT, Math.max(1, Math.floor(patch.maxOpenHours)));
    // Trocou de modelo e não disse o esforço: usa o padrão dele (se a lista dele for conhecida).
    if (patch.model !== undefined && patch.effort === undefined) {
      const known = this.data.models.find((model) => model.name === next.model) ?? FREEBUFF_REFERENCE_MODELS.find((model) => model.name === next.model);
      if (known && !known.efforts.includes(next.effort)) next.effort = known.defaultEffort ?? known.efforts[0] ?? next.effort;
    }
    this.data.settings = next;
    await this.changed();
    return { ...next };
  }

  async setModels(models: FreebuffModel[]): Promise<void> {
    this.data.models = models.map((model) => ({ ...model, efforts: [...model.efforts] }));
    this.data.modelsReadAt = this.deps.now().toISOString();
    await this.changed();
  }

  /** O último "Testar" do Freebuff (a tela Motores). */
  lastTest(): EngineTestResult | undefined {
    return this.data.test ? { ...this.data.test } : undefined;
  }

  async setTest(result: EngineTestResult): Promise<void> {
    this.data.test = result;
    await this.save();
  }

  /** Horas gastas fora de um agente (o "Testar" abre uma hora que nenhum agente usa): entram na conta do dia. */
  async noteSpent(hours: number): Promise<void> {
    this.data.hours.openedSince += hours;
    await this.changed();
  }

  /** A tela mostrou o multiplicador de um modelo (ao escolhê-lo): vale até a lista inteira ser lida. */
  async noteMultiplier(name: string, multiplier: number): Promise<void> {
    const known = this.data.models.find((model) => model.name === name);
    if (known) {
      if (known.multiplier === multiplier) return;
      known.multiplier = multiplier;
    } else this.data.models.push({ name, multiplier, efforts: [] });
    await this.changed();
  }

  /** A tela do Freebuff disse o saldo do dia: vira a leitura medida (as horas que o Cyno abriu antes dela já estão contadas nela). */
  async measure(reading: HoursReading): Promise<void> {
    const now = this.nowMs();
    const resetsAt = reading.resetsInMs !== undefined ? new Date(now + reading.resetsInMs).toISOString() : (this.data.hours.resetsAt && Date.parse(this.data.hours.resetsAt) > now ? this.data.hours.resetsAt : new Date(nextDayReset(now)).toISOString());
    this.data.hours = {
      total: reading.total,
      remaining: reading.remaining,
      ...(reading.wallet !== undefined ? { wallet: reading.wallet } : this.data.hours.wallet !== undefined ? { wallet: this.data.hours.wallet } : {}),
      resetsAt,
      measuredAt: new Date(now).toISOString(),
      openedSince: 0,
    };
    this.arm();
    await this.changed();
  }

  /**
   * Abre a hora do agente (a primeira mensagem do processo dele). Devolve false, sem abrir, se o teto de
   * horas abertas está cheio com a hora de outro agente.
   */
  async openHour(input: { agentId: string; agentName?: string; workspaceId: string; folder: string; cwd: string; chatId?: string; effort?: string }): Promise<StoredHour | undefined> {
    const existing = this.sessionOf(input);
    if (existing) return existing;
    const now = this.nowMs();
    const block = freebuffBlock(this.detail(), input, now);
    if (block?.reason === "hour") return undefined;
    const multiplier = this.multiplier();
    const session: StoredHour = {
      agentId: input.agentId,
      workspaceId: input.workspaceId,
      ...(input.agentName ? { agentName: input.agentName } : {}),
      openedAt: new Date(now).toISOString(),
      endsAt: new Date(now + (this.deps.hourMs ?? FREEBUFF_HOUR_MS)).toISOString(),
      endsAtSource: "estimated",
      multiplier,
      model: this.data.settings.model,
      effort: input.effort ?? this.data.settings.effort,
      ...(input.chatId ? { chatId: input.chatId } : {}),
      folder: input.folder,
      cwd: input.cwd,
    };
    this.data.sessions = [...this.data.sessions.filter((candidate) => !sameAgent(candidate, input)), session];
    this.claims.delete(this.aliveKey(input));
    this.data.hours.openedSince += multiplier;
    this.deps.log?.info({ agentId: input.agentId, workspaceId: input.workspaceId, endsAt: session.endsAt, multiplier }, "hora do Freebuff aberta");
    this.arm();
    await this.changed();
    return { ...session };
  }

  /** O fim real da hora (lido do arquivo da sessão do Freebuff). */
  async setEnd(ref: AgentRef, endsAtMs: number): Promise<void> {
    const session = this.data.sessions.find((candidate) => sameAgent(candidate, ref));
    if (!session) return;
    const endsAt = new Date(endsAtMs).toISOString();
    if (session.endsAt === endsAt && session.endsAtSource === "measured") return;
    // O processo novo retoma a hora que outro deixou aberta ("resuming the hour a previous CLI left behind"): se o fim real
    // mostra que a hora começou antes da nossa abertura, ela foi REAPROVEITADA e nada foi cobrado: desfaz a estimativa.
    const startedMs = endsAtMs - (this.deps.hourMs ?? FREEBUFF_HOUR_MS);
    if (!session.joined && session.endsAtSource === "estimated" && startedMs < Date.parse(session.openedAt) - Math.min(60_000, (this.deps.hourMs ?? FREEBUFF_HOUR_MS) / 10)) {
      session.joined = true;
      session.openedAt = new Date(startedMs).toISOString();
      this.data.hours.openedSince = Math.max(0, this.data.hours.openedSince - session.multiplier);
    }
    session.endsAt = endsAt;
    session.endsAtSource = "measured";
    this.arm();
    await this.changed();
  }

  async setChat(ref: AgentRef, chatId: string): Promise<void> {
    const session = this.data.sessions.find((candidate) => sameAgent(candidate, ref));
    if (!session || session.chatId === chatId) return;
    session.chatId = chatId;
    await this.changed();
  }

  /**
   * O agente tem pedido na fila e vai abrir a hora (o processo ainda está subindo): a reserva já conta para o
   * teto, para dois agentes não começarem juntos. Sai quando a hora abre ou o pedido some (`release`).
   */
  claim(ref: AgentRef, agentName?: string): void {
    const key = this.aliveKey(ref);
    if (this.claims.has(key) || this.sessionOf(ref)) return;
    this.claims.set(key, { agentId: ref.agentId, workspaceId: ref.workspaceId, ...(agentName ? { agentName } : {}) });
    void this.changed(false);
  }

  release(ref: AgentRef): void {
    if (this.claims.delete(this.aliveKey(ref))) void this.changed(false);
  }

  /** O processo do agente subiu ou caiu (a hora continua; só muda o aviso "sem processo"). */
  setProcess(ref: AgentRef, alive: boolean): void {
    const key = this.aliveKey(ref);
    if (alive === this.alive.has(key)) return;
    if (alive) this.alive.add(key);
    else this.alive.delete(key);
    if (this.data.sessions.some((session) => sameAgent(session, ref))) void this.changed(false);
  }

  /** A hora do agente acabou (ou foi dada como perdida): sai da lista e as filas esperando por ela andam. */
  async closeHour(ref: AgentRef, reason: string): Promise<void> {
    const before = this.data.sessions.length;
    this.data.sessions = this.data.sessions.filter((session) => !sameAgent(session, ref));
    if (this.data.sessions.length === before) return;
    this.deps.log?.info({ ...ref, reason }, "hora do Freebuff fechada");
    this.arm();
    await this.changed();
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.listeners.clear();
  }

  flush(): Promise<void> {
    return this.queue.idle();
  }

  // ---------- Relógio ----------

  /** Tira as horas que já acabaram e vira o dia, se passou da hora. Devolve se algo mudou. */
  private sweep(): boolean {
    const now = this.nowMs();
    let changed = false;
    const expired = this.data.sessions.filter((session) => Date.parse(session.endsAt) <= now);
    if (expired.length > 0) {
      this.data.sessions = this.data.sessions.filter((session) => Date.parse(session.endsAt) > now);
      for (const session of expired) this.emit({ type: "expired", agentId: session.agentId, workspaceId: session.workspaceId });
      changed = true;
    }
    const { resetsAt, total } = this.data.hours;
    if (total !== undefined && resetsAt && Date.parse(resetsAt) <= now) {
      // O dia virou: o saldo volta ao total (estimativa até a próxima leitura da tela).
      let next = Date.parse(resetsAt);
      while (next <= now) next += 24 * 3_600_000;
      this.data.hours = { ...this.data.hours, remaining: total, resetsAt: new Date(next).toISOString(), measuredAt: new Date(now).toISOString(), openedSince: 0 };
      changed = true;
    }
    return changed;
  }

  private arm(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.closed) return;
    const times = [...this.data.sessions.map((session) => Date.parse(session.endsAt)), ...(this.data.hours.resetsAt ? [Date.parse(this.data.hours.resetsAt)] : [])];
    if (times.length === 0) return;
    const wait = Math.min(2 ** 31 - 1, Math.max(50, Math.min(...times) - this.nowMs() + 20));
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const changed = this.sweep();
      this.arm();
      if (changed) void this.changed();
    }, wait);
    this.timer.unref();
  }

  private emit(event: FreebuffServiceEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // um ouvinte com erro não impede os outros
      }
    }
  }

  private async changed(persist = true): Promise<void> {
    this.deps.publish?.(this.detail());
    this.emit({ type: "changed" });
    if (persist) await this.save();
  }

  private async save(): Promise<void> {
    const file = this.file;
    if (!file) return;
    const snapshot = JSON.parse(JSON.stringify(this.data)) as StoreData;
    try {
      await this.queue.enqueue(async () => {
        await mkdir(path.dirname(file), { recursive: true });
        await writeJsonAtomic(file, snapshot);
      });
    } catch (error) {
      // Quase todo chamador usa `void this.changed()`: um erro aqui viraria rejeição sem dono (derruba o processo). A hora segue valendo em memória e a próxima mudança grava de novo.
      this.deps.log?.warn({ err: error }, "engine-sessions.json: não consegui gravar");
    }
  }
}

function stripStored(session: StoredHour): Omit<FreebuffHourSession, "hasProcess"> {
  const { chatId: _chatId, folder: _folder, cwd: _cwd, joined: _joined, ...rest } = session;
  return rest;
}
