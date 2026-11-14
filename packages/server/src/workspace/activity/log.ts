import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { ACTIVITY_CATEGORIES, type ActivityCategory, type ActivityEntry, type ActivityRefs } from "@cyno/shared";
import { cleanString, sanitizeData } from "./sanitize";
import { activityDay, spIso } from "./time";

/** Pasta da Atividade do servidor inteiro (DATA_DIR/activity). */
export function systemActivityDir(dataDir: string): string {
  return path.join(dataDir, "activity");
}

/** Pasta da Atividade de um workspace (DATA_DIR/workspaces/<ws>/activity). */
export function workspaceActivityDir(dataDir: string, workspaceId: string): string {
  return path.join(dataDir, "workspaces", workspaceId, "activity");
}

export const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

/** O que quem registra passa (o `at` é agora, se faltar). */
export type ActivityInput = {
  at?: string | number | Date;
  workspaceId?: string;
  category: ActivityCategory;
  action: string;
  actor: string;
  summary: string;
  refs?: ActivityRefs;
  data?: Record<string, unknown>;
};

export type ActivityLogger = { warn: (obj: object, msg?: string) => void; error: (obj: object, msg?: string) => void };

/** Funções de disco (os testes trocam para simular falhas). */
export type ActivityFs = {
  appendFile: (file: string, data: string) => Promise<void>;
  mkdir: (dir: string) => Promise<unknown>;
};

export type ActivityLogOptions = {
  /** DATA_DIR. */
  dataDir: string;
  /** Intervalo entre gravações (ms). Padrão: 1 s. */
  flushMs?: number;
  /** Com tantas entradas na fila, grava já. Padrão: 200. */
  maxBatch?: number;
  /** Teto da fila em memória (disco falhando): as mais antigas saem. Padrão: 5000. */
  maxBuffer?: number;
  now?: () => Date;
  logger?: ActivityLogger;
  fs?: Partial<ActivityFs>;
};

const DEFAULT_FS: ActivityFs = {
  appendFile: (file, data) => appendFile(file, data, "utf8"),
  mkdir: (dir) => mkdir(dir, { recursive: true }),
};

type Pending = { dir: string; day: string; line: string };

const ID_MAX = 120;
const SUMMARY_MAX = 400;

/** Id curto e ordenável pelo tempo. */
export function newActivityId(ms: number): string {
  return `${ms.toString(36)}${randomBytes(3).toString("hex")}`;
}

/**
 * Atividade: só acrescenta, um JSONL por dia e por workspace. `record` nunca lança nem espera o disco:
 * a entrada entra numa fila em memória gravada a cada `flushMs` (ou quando junta `maxBatch`) e no
 * desligamento (`close`/`flushSync`). Quem escuta (`onAppend`) recebe cada entrada na hora (o
 * workspace a empurra pelo WebSocket).
 */
export class ActivityLog {
  readonly dataDir: string;
  private readonly flushMs: number;
  private readonly maxBatch: number;
  private readonly maxBuffer: number;
  private readonly now: () => Date;
  private readonly fs: ActivityFs;
  private logger: ActivityLogger | undefined;
  private buffer: Pending[] = [];
  private timer: NodeJS.Timeout | undefined;
  private writing: Promise<void> = Promise.resolve();
  private closed = false;
  /** Pastas de workspaces removidos: nada mais é gravado nelas (até o id voltar a existir). */
  private readonly retiredDirs = new Set<string>();
  private readonly listeners = new Set<(entry: ActivityEntry) => void>();
  private readonly throttled = new Map<string, number>();
  /** Entradas perdidas (fila cheia ou disco falhando). */
  dropped = 0;
  private writeErrorLogged = false;

  constructor(options: ActivityLogOptions) {
    this.dataDir = options.dataDir;
    this.flushMs = options.flushMs ?? 1000;
    this.maxBatch = options.maxBatch ?? 200;
    this.maxBuffer = options.maxBuffer ?? 5000;
    this.now = options.now ?? (() => new Date());
    this.fs = { ...DEFAULT_FS, ...options.fs };
    this.logger = options.logger;
  }

  setLogger(logger: ActivityLogger | undefined): void {
    this.logger = logger;
  }

  dirFor(workspaceId: string | undefined): string {
    return workspaceId ? workspaceActivityDir(this.dataDir, workspaceId) : systemActivityDir(this.dataDir);
  }

  onAppend(listener: (entry: ActivityEntry) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Registra uma entrada e a devolve (ou undefined se inválida/silenciada). Nunca lança.
   * `throttle`: no máximo uma entrada com a mesma chave a cada `ms` (alertas repetidos).
   */
  record(input: ActivityInput, options: { throttle?: { key: string; ms: number } } = {}): ActivityEntry | undefined {
    try {
      const entry = this.build(input);
      if (!entry) return undefined;
      if (this.retiredDirs.has(this.dirFor(entry.workspaceId))) return undefined;
      const at = Date.parse(entry.at);
      if (options.throttle) {
        const last = this.throttled.get(options.throttle.key);
        if (last !== undefined && at - last < options.throttle.ms) return undefined;
        this.throttled.set(options.throttle.key, at);
        if (this.throttled.size > 500) this.throttled.delete(this.throttled.keys().next().value!);
      }
      this.buffer.push({ dir: this.dirFor(entry.workspaceId), day: activityDay(at), line: JSON.stringify(entry) });
      if (this.buffer.length > this.maxBuffer) {
        const extra = this.buffer.length - this.maxBuffer;
        this.buffer.splice(0, extra);
        this.dropped += extra;
      }
      for (const listener of this.listeners) {
        try {
          listener(entry);
        } catch {
          // Ouvinte quebrado não derruba quem registra.
        }
      }
      if (!this.closed) {
        if (this.buffer.length >= this.maxBatch) void this.flush();
        else this.schedule();
      }
      return entry;
    } catch {
      return undefined;
    }
  }

  /**
   * Workspace removido: descarta o que ainda espera na fila para a pasta dele, espera a gravação em
   * andamento terminar e passa a recusar entradas dele, para a pasta de Atividade não ressurgir
   * depois de apagada (o que prenderia o id).
   */
  async retireWorkspace(workspaceId: string): Promise<void> {
    const dir = workspaceActivityDir(this.dataDir, workspaceId);
    this.retiredDirs.add(dir);
    this.buffer = this.buffer.filter((pending) => pending.dir !== dir);
    await this.writing.catch(() => undefined);
  }

  /** O id voltou a ser usado por um workspace novo: a Atividade dele grava de novo. */
  reopenWorkspace(workspaceId: string): void {
    this.retiredDirs.delete(workspaceActivityDir(this.dataDir, workspaceId));
  }

  /** Grava o que está na fila (as gravações são em série). Nunca rejeita. */
  flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.writing = this.writing.then(() => this.writeBatch()).catch(() => undefined);
    return this.writing;
  }

  /** Grava já, de forma síncrona (processo morrendo ou parando). Nunca lança. */
  flushSync(): void {
    try {
      const batch = this.buffer.splice(0);
      for (const [file, lines] of groupByFile(batch)) {
        mkdirSync(path.dirname(file), { recursive: true });
        appendFileSync(file, lines, "utf8");
      }
    } catch {
      // Sem disco: paciência.
    }
  }

  /** Desligamento: grava o resto e para o temporizador. */
  async close(): Promise<void> {
    this.closed = true;
    await this.flush();
  }

  build(input: ActivityInput): ActivityEntry | undefined {
    if (!input || typeof input.action !== "string" || !input.action || typeof input.summary !== "string" || !input.summary) return undefined;
    if (!ACTIVITY_CATEGORIES.includes(input.category)) return undefined;
    const raw = input.at === undefined ? this.now() : new Date(input.at);
    const ms = Number.isNaN(raw.getTime()) ? this.now().getTime() : raw.getTime();
    const entry: ActivityEntry = {
      id: newActivityId(ms),
      at: spIso(ms),
      category: input.category,
      action: cleanString(input.action, 60),
      actor: cleanString(input.actor || "sistema", ID_MAX),
      summary: cleanString(input.summary, SUMMARY_MAX),
    };
    if (typeof input.workspaceId === "string" && input.workspaceId) entry.workspaceId = cleanString(input.workspaceId, ID_MAX);
    if (input.refs) {
      const refs: ActivityRefs = {};
      for (const [key, value] of Object.entries(input.refs)) if (typeof value === "string" && value) refs[key as keyof ActivityRefs] = cleanString(value, 2000);
      if (Object.keys(refs).length > 0) entry.refs = refs;
    }
    const data = sanitizeData(input.data);
    if (data) entry.data = data;
    return entry;
  }

  private schedule(): void {
    if (this.timer || this.closed) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, this.flushMs);
    this.timer.unref?.();
  }

  private async writeBatch(): Promise<void> {
    const batch = this.buffer.splice(0);
    if (batch.length === 0) return;
    try {
      for (const [file, lines] of groupByFile(batch)) {
        await this.fs.mkdir(path.dirname(file));
        await this.fs.appendFile(file, lines);
      }
      this.writeErrorLogged = false;
    } catch (error) {
      this.dropped += batch.length;
      if (!this.writeErrorLogged) {
        this.writeErrorLogged = true;
        try {
          this.logger?.warn({ err: error, dir: this.dataDir }, "não foi possível gravar a Atividade");
        } catch {
          // nada
        }
      }
    }
  }
}

function groupByFile(batch: Pending[]): Map<string, string> {
  const byFile = new Map<string, string[]>();
  for (const { dir, day, line } of batch) {
    const file = path.join(dir, `${day}.jsonl`);
    const lines = byFile.get(file);
    if (lines) lines.push(line);
    else byFile.set(file, [line]);
  }
  return new Map([...byFile].map(([file, lines]) => [file, `${lines.join("\n")}\n`]));
}

// ---------- Atividade global do processo ----------

let active: ActivityLog | undefined;

/** Liga (ou desliga, com undefined) a Atividade do processo. Sem ela, `activity()` não faz nada (testes). */
export function setActivityLog(log: ActivityLog | undefined): void {
  active = log;
}

export function activeActivity(): ActivityLog | undefined {
  return active;
}

/** Registra na Atividade do processo (se houver). Nunca lança. */
export function activity(input: ActivityInput, options?: Parameters<ActivityLog["record"]>[1]): void {
  try {
    active?.record(input, options);
  } catch {
    // nunca lança
  }
}
