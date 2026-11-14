import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { suspectReasonOf, type Agent, type AgentProvider, type Task, type TurnUsage, type UsageRecord, type UsageRecordTokens } from "@cyno/shared";
import type { FastifyBaseLogger } from "fastify";
import type { WriteQueue } from "../../store/write-queue";
import type { TerminalEvent } from "../terminals/types";
import { computeCost, PRICE_TABLE, resolveModel } from "./pricing";
import { monthKeyOf } from "./usage-time";

/**
 * Histórico de gastos de um workspace, para sempre: cada turno de um agente de CLI vira uma linha
 * em `usage/YYYY-MM.jsonl` (mês no fuso de São Paulo; o arquivo só cresce). O que veio da
 * importação das conversas antigas fica em `usage/backfill-YYYY-MM.jsonl` (o importador roda fora
 * do server e nunca escreve no mesmo arquivo que ele). O "Por agente" ao vivo (AgentUsageLedger)
 * continua igual; isto anda ao lado.
 */

const LIVE_FILE = /^(\d{4}-\d{2})\.jsonl$/;
const BACKFILL_FILE = /^backfill-(\d{4}-\d{2})\.jsonl$/;

/** Pasta do histórico dentro da pasta do workspace. */
export function usageDir(workspaceDir: string): string {
  return path.join(workspaceDir, "usage");
}

export function usageFile(dir: string, monthKey: string, source: UsageRecord["source"] = "live"): string {
  return path.join(dir, source === "backfill" ? `backfill-${monthKey}.jsonl` : `${monthKey}.jsonl`);
}

/** Lê uma linha do histórico (linha quebrada ou de outro formato = undefined). */
export function parseUsageLine(line: string): UsageRecord | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  try {
    const data = JSON.parse(trimmed) as Partial<UsageRecord>;
    if (typeof data !== "object" || data === null) return undefined;
    if (typeof data.id !== "string" || typeof data.at !== "string" || typeof data.agentId !== "string") return undefined;
    if (data.provider !== "claude" && data.provider !== "gemini" && data.provider !== "openclaw" && data.provider !== "hermes") return undefined;
    if (Number.isNaN(Date.parse(data.at))) return undefined;
    return data as UsageRecord;
  } catch {
    return undefined;
  }
}

const tokensOf = (usage: TurnUsage): UsageRecordTokens => ({
  input: usage.inputTokens,
  output: usage.outputTokens,
  cacheRead: usage.cacheReadTokens,
  cacheCreation: usage.cacheCreationTokens,
  ...(usage.cacheCreation5mTokens !== undefined ? { cacheCreation5m: usage.cacheCreation5mTokens } : {}),
  ...(usage.cacheCreation1hTokens !== undefined ? { cacheCreation1h: usage.cacheCreation1hTokens } : {}),
});

/**
 * Título curto de uma tarefa: a primeira linha do pedido (o Maestro grava "título\n\ndescrição"; a
 * descrição não entra no título, nem nas frases da Atividade e nas notificações).
 */
export function taskTitleOf(task: Pick<Task, "prompt">): string {
  const first = task.prompt.split("\n").find((candidate) => candidate.trim().length > 0) ?? "";
  const line = first.replace(/\s+/g, " ").trim();
  return line.length > 120 ? `${line.slice(0, 119)}…` : line;
}

/** O pedido de origem de uma tarefa (sobe pelos `projectId`). */
export function rootTaskOf(task: Task, tasks: readonly Task[]): Task {
  const byId = new Map(tasks.map((item) => [item.id, item]));
  let current = task;
  for (let i = 0; i < 20 && current.projectId; i += 1) {
    const parent = byId.get(current.projectId);
    if (!parent) break;
    current = parent;
  }
  return current;
}

type FileCache = { mtimeMs: number; size: number; records: UsageRecord[] };

export type UsageHistoryDeps = {
  /** Pasta do histórico (workspaces/<ws>/usage). */
  dir: string;
  /** Fila de escrita do workspace (as linhas entram na ordem, sem disputar com o resto). */
  queue: WriteQueue;
  agents: () => readonly Agent[];
  tasks: () => readonly Task[];
  log: Pick<FastifyBaseLogger, "warn">;
  now: () => Date;
};

/** O que o gravador lembra de cada agente entre os eventos do terminal. */
type AgentTurnState = { tag?: string; startedAt?: number; sessionId?: string; sessionModel?: string };

export class UsageHistory {
  private readonly cache = new Map<string, FileCache>();
  private readonly turns = new Map<string, AgentTurnState>();
  /** Ids dos gastos parciais já gravados nesta execução (um corte nunca vira duas linhas). */
  private readonly cutIds = new Set<string>();

  constructor(private readonly deps: UsageHistoryDeps) {}

  get dir(): string {
    return this.deps.dir;
  }

  /** Grava uma linha no arquivo do mês dela (pela fila; uma falha vai para o log, nunca derruba o turno). */
  append(record: UsageRecord): Promise<void> {
    const file = usageFile(this.deps.dir, monthKeyOf(Date.parse(record.at)), record.source);
    return this.deps.queue
      .enqueue(async () => {
        await mkdir(this.deps.dir, { recursive: true });
        await appendFile(file, `${JSON.stringify(record)}\n`, "utf8");
      })
      .catch((error: unknown) => this.deps.log.warn({ err: error }, "não foi possível gravar o histórico de gastos"));
  }

  /**
   * O gasto do "Testar" de um motor (tela Motores): uma linha de turno com a marca `test`, em nome do `label`
   * (não é um agente). Entra nos totais de Gastos como qualquer turno. Nunca lança.
   */
  recordTest(input: { provider: AgentProvider; label: string; model?: string; usage: TurnUsage; durationMs?: number }): Promise<void> {
    try {
      const usage: TurnUsage = { ...input.usage, ...(input.model && !input.usage.models?.length ? { models: [input.model] } : {}), ...(input.durationMs !== undefined && input.usage.durationMs === undefined ? { durationMs: input.durationMs } : {}) };
      const record = this.recordFor("engine-test", input.provider, {}, { usage, turns: 1 });
      return this.append({ ...record, agentName: input.label, channel: "other", test: true });
    } catch (error) {
      this.deps.log.warn({ err: error }, "histórico de gastos: teste de motor ignorado");
      return Promise.resolve();
    }
  }

  /** Espera as gravações pedidas até agora. */
  idle(): Promise<void> {
    return this.deps.queue.idle();
  }

  /**
   * Todas as linhas (do vivo e da importação) com `at` entre `fromMs` (inclusive) e `toMs`
   * (exclusive), na ordem dos arquivos. Cada arquivo é relido só se mudou (tamanho/data).
   */
  async read(fromMs = -Infinity, toMs = Infinity): Promise<UsageRecord[]> {
    let names: string[];
    try {
      names = await readdir(this.deps.dir);
    } catch {
      return [];
    }
    const fromMonth = Number.isFinite(fromMs) ? monthKeyOf(fromMs) : "";
    const toMonth = Number.isFinite(toMs) ? monthKeyOf(toMs) : "9999-99";
    const out: UsageRecord[] = [];
    for (const name of names.sort()) {
      const month = LIVE_FILE.exec(name)?.[1] ?? BACKFILL_FILE.exec(name)?.[1];
      if (!month || month < fromMonth || month > toMonth) continue;
      for (const record of await this.readFile(path.join(this.deps.dir, name))) {
        const at = Date.parse(record.at);
        if (at >= fromMs && at < toMs) out.push(record);
      }
    }
    return out;
  }

  private async readFile(file: string): Promise<UsageRecord[]> {
    try {
      const info = await stat(file);
      const cached = this.cache.get(file);
      if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached.records;
      const text = await readFile(file, "utf8");
      const records = text.split("\n").map(parseUsageLine).filter((record): record is UsageRecord => record !== undefined);
      this.cache.set(file, { mtimeMs: info.mtimeMs, size: info.size, records });
      return records;
    } catch {
      return [];
    }
  }

  /**
   * Eventos do terminal de um agente (TerminalManager): lembra a sessão, o modelo e a tag do
   * turno; cada `turn_end` vira uma linha (com ou sem tokens) e cada `turn_partial` (nota injetada
   * no meio do turno) uma linha só de tokens. Nunca lança.
   */
  observe(agentId: string, provider: AgentProvider, event: TerminalEvent): void {
    try {
      const state = this.turns.get(agentId) ?? {};
      this.turns.set(agentId, state);
      if (event.type === "session") {
        state.sessionId = event.sessionId;
        if (event.model) state.sessionModel = event.model;
      } else if (event.type === "turn_start") {
        state.tag = event.tag;
        state.startedAt = this.deps.now().getTime();
      } else if (event.type === "turn_end") {
        const tag = event.tag ?? state.tag;
        const startedAt = state.startedAt;
        state.tag = undefined;
        state.startedAt = undefined;
        void this.append(this.recordFor(agentId, provider, state, { tag, usage: event.usage, turns: 1, startedAt }));
      } else if (event.type === "turn_cut") {
        // Turno cortado (cancelado, terminal parado ou caído): o gasto parcial entra marcado `partial`, sem contar como turno.
        // O id é fixo por tentativa (agente + tag + início): o mesmo corte, visto duas vezes, grava uma linha só, e a
        // retomada do turno (tentativa nova, com outro início) gasta de verdade de novo, sem dobrar o que já foi gravado.
        const tag = event.tag ?? state.tag;
        const id = `partial:${agentId}:${tag ?? "-"}:${state.startedAt ?? 0}`;
        if (!this.cutIds.has(id)) {
          this.cutIds.add(id);
          if (this.cutIds.size > 500) this.cutIds.delete(this.cutIds.values().next().value as string);
          void this.append({ ...this.recordFor(agentId, provider, state, { tag, usage: event.usage, turns: 0 }), id, partial: true });
        }
      } else if (event.type === "turn_partial" && event.usage) {
        void this.append(this.recordFor(agentId, provider, state, { tag: state.tag, usage: event.usage, turns: 0 }));
      }
    } catch (error) {
      this.deps.log.warn({ err: error, agentId }, "histórico de gastos: evento do terminal ignorado");
    }
  }

  private recordFor(
    agentId: string,
    provider: AgentProvider,
    state: AgentTurnState,
    turn: { tag?: string; usage?: TurnUsage; turns: 0 | 1; startedAt?: number },
  ): UsageRecord {
    const now = this.deps.now();
    const at = now.toISOString();
    const agent = this.deps.agents().find((item) => item.id === agentId);
    const { model, modelSource } = pickModel(turn.usage?.models, state.sessionModel, agent?.model);
    const tasks = this.deps.tasks();
    const task = turn.tag ? tasks.find((item) => item.id === turn.tag) : undefined;
    const root = task ? rootTaskOf(task, tasks) : undefined;
    const tokens = turn.usage ? tokensOf(turn.usage) : undefined;
    const durationMs = turn.usage?.durationMs ?? (turn.startedAt !== undefined ? Math.max(0, now.getTime() - turn.startedAt) : undefined);
    const cost = computeCost({ model, at, tokens, speed: turn.usage?.speed, webSearches: turn.usage?.webSearches });
    // Valor impossível: grava assim mesmo, marcado, e fica fora dos totais (usage-sanity.ts).
    const suspect = suspectReasonOf(tokens, cost.usd);
    return {
      v: 1,
      id: randomUUID(),
      at,
      agentId,
      ...(agent ? { agentName: agent.name } : {}),
      provider,
      ...(model ? { model, modelSource } : {}),
      ...(task ? { taskId: task.id, taskTitle: taskTitleOf(task), channel: "task" as const } : { channel: turn.tag?.startsWith("chat:") ? ("chat" as const) : ("other" as const) }),
      ...(task?.projectId ? { parentTaskId: task.projectId } : {}),
      ...(root ? { rootTaskId: root.id } : {}),
      ...(state.sessionId ? { sessionId: state.sessionId } : {}),
      source: "live",
      ...(turn.turns === 0 ? { turns: 0 as const } : {}),
      measured: tokens !== undefined,
      ...(suspect ? { suspect } : {}),
      ...(tokens ? { tokens } : {}),
      ...(turn.usage?.speed ? { speed: turn.usage.speed } : {}),
      ...(turn.usage?.webSearches ? { webSearches: turn.usage.webSearches } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(turn.usage?.reportedCostUsd ? { reportedCostUsd: turn.usage.reportedCostUsd } : {}),
      costUsd: cost.usd,
      priceVersion: PRICE_TABLE.version,
    };
  }
}

/**
 * Modelo do turno: o que a CLI relatou no turno (um só = ele; vários, ex.: agente + subagentes =
 * o da sessão, se estiver entre eles, senão o primeiro), senão o da sessão (init), senão o
 * configurado no agente.
 */
export function pickModel(
  reported: readonly string[] | undefined,
  sessionModel: string | undefined,
  configured: string | undefined,
): { model?: string; modelSource?: "cli" | "config" } {
  if (reported && reported.length > 0) {
    const session = resolveModel(sessionModel)?.id;
    const match = session ? reported.find((model) => resolveModel(model)?.id === session) : undefined;
    return { model: match ?? reported[0]!, modelSource: "cli" };
  }
  if (sessionModel) return { model: sessionModel, modelSource: "cli" };
  if (configured) return { model: configured, modelSource: "config" };
  return {};
}
