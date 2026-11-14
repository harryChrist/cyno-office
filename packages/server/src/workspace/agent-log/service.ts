import { appendFile, mkdir, readdir, readFile } from "node:fs/promises";
import {
  AGENT_LOG_LIMITS,
  AGENT_LOG_MAIN_THREAD,
  agentLogEntrySchema,
  boundAgentLogBody,
  clampLogText,
  conversationLogPrefix,
  type AgentLogBody,
  type AgentLogEntry,
  type AgentLogSummary,
  type AgentLogThread,
  type AgentProvider,
  type ServerEvent,
  type Task,
  type TaskLogResponse,
} from "@cyno/shared";
import type { FastifyBaseLogger } from "fastify";
import type { DataPaths } from "../../store/paths";
import type { WriteQueue } from "../../store/write-queue";

/** De quem é a entrada: tarefa, agente e, num subagente, a thread dele. */
export type LogRef = { taskId: string; agentId: string; thread?: string; provider?: AgentProvider };

export type AgentLogDeps = {
  paths: Pick<DataPaths, "logsDir" | "taskLogFile">;
  /** Fila de escrita do workspace (a mesma do store). */
  queue: WriteQueue;
  /** Publica o evento agent:log no hub do workspace. */
  publish: (event: ServerEvent) => void;
  /** Tarefas do workspace (para achar as tarefas de um agente e as que existem). */
  tasks: () => Task[];
  log: Pick<FastifyBaseLogger, "error">;
  now: () => Date;
};

/** Quantas entradas antes do limite ficam reservadas para status/aprovação/resultado. */
const ESSENTIAL_RESERVE = 25;
/** Tipos "falantes": param de ser gravados quando a tarefa chega perto do limite. */
const CHATTY = new Set<AgentLogBody["kind"]>(["text", "tool", "progress", "raw"]);
/** O progresso só vira entrada nova quando anda pelo menos isso (ou a mensagem muda). */
const PROGRESS_STEP = 0.1;

type OpenSubagent = { label: string };

/** Estado em memória de uma tarefa com log aberto neste processo. */
type TaskLogState = {
  agentId: string;
  /** Entradas novas aceitas neste processo (aproxima o limite; o exato é conferido no disco). */
  count: number;
  truncated: boolean;
  /** Ferramentas "running", por toolUseId (a atualização no lugar acha a entrada aqui). */
  openTools: Map<string, AgentLogEntry>;
  openSubagents: Map<string, OpenSubagent>;
  /** Último progresso registrado por thread ("" = o agente). */
  lastProgress: Map<string, { progress: number; message: string }>;
};

type AgentBuffer = { entries: AgentLogEntry[]; hydrated: boolean };

/**
 * Log de trabalho de um workspace (veja agent-log.ts no shared). Cada entrada é publicada na hora
 * (evento agent:log) e gravada em `logs/<taskId>.jsonl`, uma linha JSON por entrada, pela fila
 * do workspace. Uma ferramenta atualizada vira uma linha nova com o mesmo id (na leitura, a
 * última ganha). Até AGENT_LOG_LIMITS.perTask entradas por tarefa: perto do limite, só as
 * essenciais (status, aprovação, delegação, subagente, resultado) continuam entrando. Um buffer
 * em memória por agente (AGENT_LOG_LIMITS.perAgent) responde rápido o GET agents/:id/log.
 * Arquivo ausente = log vazio (tarefas antigas ou de antes do log).
 */
export class AgentLogService {
  private readonly tasks = new Map<string, TaskLogState>();
  private readonly agents = new Map<string, AgentBuffer>();
  /** Entradas distintas já no disco por tarefa (lido uma vez, dentro da fila). */
  private readonly diskIds = new Map<string, Set<string>>();
  private dirReady = false;
  private lastMs = 0;
  private counter = 0;

  constructor(private readonly deps: AgentLogDeps) {}

  /** Id único e ordenável (ordem lexicográfica = ordem de criação). */
  nextId(): string {
    const ms = Math.max(this.deps.now().getTime(), this.lastMs);
    this.counter = ms === this.lastMs ? this.counter + 1 : 0;
    this.lastMs = ms;
    return `${ms.toString(36).padStart(9, "0")}-${this.counter.toString(36).padStart(4, "0")}`;
  }

  /** Grava e publica uma entrada. Devolve a entrada, ou undefined se o limite da tarefa a barrou. */
  append(ref: LogRef, body: AgentLogBody): AgentLogEntry | undefined {
    const state = this.taskState(ref);
    const limit = CHATTY.has(body.kind) ? AGENT_LOG_LIMITS.perTask - ESSENTIAL_RESERVE : AGENT_LOG_LIMITS.perTask;
    if (state.count >= limit) {
      if (!CHATTY.has(body.kind) || state.truncated) return undefined;
      state.truncated = true;
      body = { kind: "text", text: `_Log cortado: o resto da narração desta tarefa passou do limite de ${AGENT_LOG_LIMITS.perTask} entradas._` };
    }
    state.count += 1;
    const entry = {
      id: this.nextId(),
      taskId: ref.taskId,
      agentId: ref.agentId,
      at: this.deps.now().toISOString(),
      ...(ref.thread === undefined ? {} : { thread: ref.thread }),
      ...(ref.provider === undefined ? {} : { provider: ref.provider }),
      ...boundAgentLogBody(body),
    } as AgentLogEntry;
    if (entry.kind === "tool" && entry.status === "running") state.openTools.set(entry.toolUseId, entry);
    if (entry.kind === "subagent") {
      if (entry.phase === "started") state.openSubagents.set(entry.subagentId, { label: entry.label });
      else state.openSubagents.delete(entry.subagentId);
    }
    this.emit(entry, true);
    return entry;
  }

  /**
   * Progresso no log, sem repetir: entra só se a mensagem mudou ou o progresso andou
   * PROGRESS_STEP (ou chegou a 1). O evento task:progress é à parte (orquestrador/Maestro).
   */
  progress(ref: LogRef, progress: number, message: string): AgentLogEntry | undefined {
    const state = this.taskState(ref);
    const key = ref.thread ?? "";
    const value = Math.min(1, Math.max(0, Number.isFinite(progress) ? progress : 0));
    const last = state.lastProgress.get(key);
    const moved = !last || last.message !== message || value - last.progress >= PROGRESS_STEP || (value === 1 && last.progress < 1);
    if (!moved) return undefined;
    state.lastProgress.set(key, { progress: value, message });
    return this.append(ref, { kind: "progress", progress: value, message });
  }

  /** Resultado de uma ferramenta: atualiza no lugar a entrada "running" com esse toolUseId. */
  toolResult(taskId: string, toolUseId: string, result: { status: "ok" | "error"; output?: string }): AgentLogEntry | undefined {
    const open = this.tasks.get(taskId)?.openTools.get(toolUseId);
    if (!open || open.kind !== "tool") return undefined;
    this.tasks.get(taskId)!.openTools.delete(toolUseId);
    const durationMs = Math.max(0, this.deps.now().getTime() - Date.parse(open.at));
    const entry: AgentLogEntry = { ...open, status: result.status, durationMs: Number.isFinite(durationMs) ? durationMs : 0 };
    if (result.output !== undefined) entry.output = clampLogText(result.output, AGENT_LOG_LIMITS.output);
    this.emit(entry, false);
    return entry;
  }

  /**
   * A tarefa acabou: ferramentas e subagentes ainda abertos fecham com erro (`reason`), entra a
   * última entrada (`final`, ex.: o status) e o estado da tarefa sai da memória.
   */
  close(ref: LogRef, reason: string, final?: AgentLogBody): void {
    const state = this.tasks.get(ref.taskId);
    if (state) {
      for (const toolUseId of [...state.openTools.keys()]) this.toolResult(ref.taskId, toolUseId, { status: "error", output: reason });
      for (const [subagentId, { label }] of [...state.openSubagents]) {
        this.append(ref, { kind: "subagent", phase: "finished", subagentId, label, status: "error", result: reason });
      }
    }
    if (final) this.append(ref, final);
    this.tasks.delete(ref.taskId);
  }

  /**
   * Boot: o que ficou "running" no arquivo de uma tarefa (ferramenta ou subagente de um processo que
   * morreu) fecha como interrompido, para não ficar rodando para sempre na tela. Só vale para tarefas
   * sem log aberto neste processo (rode antes de retomar as tarefas).
   */
  async closeInterrupted(taskIds: readonly string[], reason = "Interrompida: o servidor reiniciou"): Promise<void> {
    await this.deps.queue.idle();
    for (const taskId of taskIds) {
      if (this.tasks.has(taskId)) continue;
      try {
        const entries = (await this.readFile(taskId)) ?? [];
        const finished = new Set(entries.filter((entry) => entry.kind === "subagent" && entry.phase === "finished").map((entry) => entry.kind === "subagent" ? entry.subagentId : ""));
        for (const entry of entries) {
          if (entry.kind === "tool" && entry.status === "running") {
            const durationMs = Math.max(0, this.deps.now().getTime() - Date.parse(entry.at));
            this.emit({ ...entry, status: "error", durationMs: Number.isFinite(durationMs) ? durationMs : 0, output: reason }, false);
          } else if (entry.kind === "subagent" && entry.phase === "started" && !finished.has(entry.subagentId)) {
            this.append({ taskId, agentId: entry.agentId, ...(entry.thread === undefined ? {} : { thread: entry.thread }) }, { kind: "subagent", phase: "finished", subagentId: entry.subagentId, label: entry.label, status: "error", result: reason });
          }
        }
      } catch (error) {
        this.deps.log.error({ err: error, taskId }, "não foi possível fechar o que ficou aberto no log da tarefa");
      } finally {
        this.tasks.delete(taskId);
      }
    }
  }

  /** Tem log aberto (em memória) para a tarefa? */
  isOpen(taskId: string): boolean {
    return this.tasks.has(taskId);
  }

  /** O que o agente está fazendo agora: a tarefa aberta mais recente e quantos subagentes rodam. */
  summary(agentId: string): AgentLogSummary {
    let activeTaskId: string | undefined;
    let activeSubagents = 0;
    for (const [taskId, state] of this.tasks) {
      if (state.agentId !== agentId) continue;
      activeTaskId = taskId;
      activeSubagents += state.openSubagents.size;
    }
    return activeTaskId === undefined ? { activeSubagents } : { activeTaskId, activeSubagents };
  }

  /**
   * Log de uma tarefa (mais antigas primeiro) e as threads de subagentes dela. `thread`: só as
   * entradas desse subagente; "main": só as do próprio agente. Undefined = sem arquivo e a
   * tarefa não existe.
   */
  async readTask(taskId: string, thread?: string): Promise<TaskLogResponse | undefined> {
    await this.deps.queue.idle();
    const entries = await this.readFile(taskId);
    if (entries === undefined && !this.deps.tasks().some((task) => task.id === taskId)) return undefined;
    const all = entries ?? [];
    const filtered =
      thread === undefined ? all : all.filter((entry) => (thread === AGENT_LOG_MAIN_THREAD ? entry.thread === undefined : entry.thread === thread));
    return { taskId, entries: filtered, threads: threadsOf(all) };
  }

  /** Entradas recentes de todas as tarefas do agente, as mais novas por último. */
  async recentForAgent(agentId: string, limit: number): Promise<AgentLogEntry[]> {
    const buffer = this.agentBuffer(agentId);
    if (!buffer.hydrated) await this.hydrate(agentId, buffer);
    return buffer.entries.slice(-Math.max(1, limit));
  }

  /** Tarefas/agentes removidos (os arquivos são apagados à parte): sai o que está em memória. */
  forget(taskIds: readonly string[], agentIds: readonly string[]): void {
    for (const taskId of taskIds) {
      this.tasks.delete(taskId);
      this.diskIds.delete(taskId);
    }
    for (const agentId of agentIds) this.agents.delete(agentId);
  }

  // ---------- Infra ----------

  private taskState(ref: LogRef): TaskLogState {
    let state = this.tasks.get(ref.taskId);
    if (!state) {
      state = { agentId: ref.agentId, count: 0, truncated: false, openTools: new Map(), openSubagents: new Map(), lastProgress: new Map() };
      this.tasks.set(ref.taskId, state);
    }
    return state;
  }

  private conversationLogs(agentId: string): Promise<{ id: string; at: string }[]> {
    return listConversationLogs(this.deps.paths.logsDir, agentId);
  }

  private agentBuffer(agentId: string): AgentBuffer {
    let buffer = this.agents.get(agentId);
    if (!buffer) {
      buffer = { entries: [], hydrated: false };
      this.agents.set(agentId, buffer);
    }
    return buffer;
  }

  /** Publica, guarda no buffer do agente e grava no disco (pela fila). */
  private emit(entry: AgentLogEntry, isNew: boolean): void {
    this.deps.publish({ type: "agent:log", entry });
    remember(this.agentBuffer(entry.agentId).entries, entry);
    this.persist(entry, isNew);
  }

  private persist(entry: AgentLogEntry, isNew: boolean): void {
    let file: string;
    try {
      file = this.deps.paths.taskLogFile(entry.taskId);
    } catch (error) {
      this.deps.log.error({ err: error, taskId: entry.taskId }, "id de tarefa inválido para o log");
      return;
    }
    const line = `${JSON.stringify(entry)}\n`;
    this.deps.queue
      .enqueue(async () => {
        let ids = this.diskIds.get(entry.taskId);
        if (!ids) {
          ids = new Set((await this.readFile(entry.taskId))?.map((existing) => existing.id));
          this.diskIds.set(entry.taskId, ids);
        }
        // O limite exato vale no disco (num reinício, a contagem em memória recomeça do zero).
        if (isNew && !ids.has(entry.id) && ids.size >= AGENT_LOG_LIMITS.perTask) return;
        if (!this.dirReady) {
          await mkdir(this.deps.paths.logsDir, { recursive: true });
          this.dirReady = true;
        }
        await appendFile(file, line, "utf8");
        ids.add(entry.id);
      })
      .catch((error: unknown) => this.deps.log.error({ err: error, taskId: entry.taskId }, "falha ao gravar o log do agente"));
  }

  /** Lê o .jsonl (linhas inválidas são ignoradas; mesmo id = a última linha ganha). Undefined = sem arquivo. */
  private async readFile(taskId: string): Promise<AgentLogEntry[] | undefined> {
    let raw: string;
    try {
      raw = await readFile(this.deps.paths.taskLogFile(taskId), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    const byId = new Map<string, AgentLogEntry>();
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let data: unknown;
      try {
        data = JSON.parse(line);
      } catch {
        continue;
      }
      const parsed = agentLogEntrySchema.safeParse(data);
      if (parsed.success) byId.set(parsed.data.id, parsed.data as AgentLogEntry);
    }
    return [...byId.values()].sort(byIdOrder);
  }

  /**
   * Primeira leitura do agente neste processo: junta o disco (tarefas e dias de conversa, os mais
   * novos primeiro) com a memória.
   */
  private async hydrate(agentId: string, buffer: AgentBuffer): Promise<void> {
    await this.deps.queue.idle();
    const sources = [
      ...this.deps
        .tasks()
        .filter((task) => task.agentId === agentId)
        .map((task) => ({ id: task.id, at: task.createdAt })),
      ...(await this.conversationLogs(agentId)),
    ].sort((a, b) => b.at.localeCompare(a.at));
    const fromDisk: AgentLogEntry[] = [];
    for (const source of sources) {
      if (fromDisk.length >= AGENT_LOG_LIMITS.perAgent) break;
      try {
        fromDisk.push(...((await this.readFile(source.id)) ?? []).filter((entry) => entry.agentId === agentId));
      } catch (error) {
        this.deps.log.error({ err: error, taskId: source.id }, "não foi possível ler o log da tarefa");
      }
    }
    const merged = new Map<string, AgentLogEntry>();
    for (const entry of fromDisk) merged.set(entry.id, entry);
    // A memória ganha (pode ter uma atualização ainda não lida do disco).
    for (const entry of buffer.entries) merged.set(entry.id, entry);
    buffer.entries = [...merged.values()].sort(byIdOrder).slice(-AGENT_LOG_LIMITS.perAgent);
    buffer.hydrated = true;
  }
}

/** Logs de conversa do agente no disco ("conversa-<agente>-AAAAMMDD"), com a data como ISO (fim do dia, para vir antes das tarefas do mesmo dia). */
async function listConversationLogs(logsDir: string, agentId: string): Promise<{ id: string; at: string }[]> {
  const prefix = conversationLogPrefix(agentId);
  let names: string[];
  try {
    names = await readdir(logsDir);
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    const match = /^(.+-(\d{4})(\d{2})(\d{2}))\.jsonl$/.exec(name);
    if (!match || !name.startsWith(prefix) || match[1]!.length !== prefix.length + 8) return [];
    return [{ id: match[1]!, at: `${match[2]}-${match[3]}-${match[4]}T23:59:59.999Z` }];
  });
}

const byIdOrder = (a: AgentLogEntry, b: AgentLogEntry) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Guarda no buffer do agente: atualização substitui no lugar; entrada nova vai para o fim. */
function remember(entries: AgentLogEntry[], entry: AgentLogEntry): void {
  const index = entries.findIndex((existing) => existing.id === entry.id);
  if (index !== -1) {
    entries[index] = entry;
    return;
  }
  entries.push(entry);
  if (entries.length > AGENT_LOG_LIMITS.perAgent) entries.splice(0, entries.length - AGENT_LOG_LIMITS.perAgent);
}

/** Threads de subagentes a partir das entradas `subagent` (na ordem em que começaram). */
export function threadsOf(entries: readonly AgentLogEntry[]): AgentLogThread[] {
  const threads = new Map<string, AgentLogThread>();
  for (const entry of entries) {
    if (entry.kind !== "subagent") continue;
    if (entry.phase === "started") {
      threads.set(entry.subagentId, { id: entry.subagentId, label: entry.label, goal: entry.goal, status: "running", startedAt: entry.at, ...(entry.model ? { model: entry.model } : {}) });
    } else {
      const thread = threads.get(entry.subagentId);
      if (thread) Object.assign(thread, { status: entry.status, finishedAt: entry.at });
    }
  }
  return [...threads.values()];
}
