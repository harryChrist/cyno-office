import { lstat, readdir, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_RETENTION,
  isSafeId,
  retentionSettingsSchema,
  type DiskUsage,
  type RetentionCleanupResult,
  type RetentionResponse,
  type RetentionSettings,
  type UpdateRetentionBody,
} from "@cyno/shared";
import type { FastifyBaseLogger } from "fastify";
import { z } from "zod";
import { activityDay } from "../../workspace/activity/time";
import { writeJsonAtomic } from "../../store/atomic-write";
import { errorMessage } from "../../util/text";

const DAY_MS = 86_400_000;
/** A Atividade (o que foi feito) fica 180 dias; as métricas por hora do servidor, 60. */
export const ACTIVITY_RETENTION_DAYS = 180;
export const METRICS_RETENTION_DAYS = 60;
const ACTIVITY_DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;
const METRICS_FILE = /^metrics-(\d{4}-\d{2})\.jsonl$/;
/** Limpeza automática: uma vez por dia (e uma no boot). */
export const RETENTION_INTERVAL_MS = DAY_MS;
/** Nome de pasta mais longo que o Claude Code usa sem cortar e pôr um hash (aí não dá para saber o nome: não mexemos). */
const MAX_PROJECT_DIR_NAME = 200;
/** Log de tarefa (mesmo padrão de dataPaths.taskLogFile). */
const TASK_LOG_FILE = /^([a-z0-9][a-z0-9-]{0,63})\.jsonl$/i;
/** Conversa do Claude Code: `<uuid>.jsonl` (e a pasta `<uuid>/` com subagentes e anexos). */
const SESSION_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
const SESSION_DIR = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Nome da pasta em que o Claude Code guarda as conversas de um cwd (`~/.claude/projects/<nome>/`):
 * o caminho absoluto com toda letra que não é [a-zA-Z0-9] trocada por "-" (conferido com as pastas
 * reais, ex.: /home/usuario/cyno/data/workspaces/laboratorio/agents/maestro ->
 * -home-usuario-cyno-data-workspaces-laboratorio-agents-maestro). Nome comprido demais = o Claude
 * Code corta e põe um hash: devolve undefined e nada é tocado.
 */
export function claudeProjectDirName(cwd: string): string | undefined {
  const name = path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, "-");
  return name.length <= MAX_PROJECT_DIR_NAME ? name : undefined;
}

const settingsFileSchema = z.object({
  retention: retentionSettingsSchema.partial().optional(),
  lastCleanup: z
    .object({ at: z.string(), transcripts: z.object({ bytes: z.number(), files: z.number() }), logs: z.object({ bytes: z.number(), files: z.number() }) })
    .optional(),
});

export type RetentionDeps = {
  /** DATA_DIR (workspaces/<ws>/agents e logs; settings.json fica na raiz). */
  dataDir: string;
  /**
   * Pasta de projetos do Claude Code (`~/.claude/projects`, ou `$CLAUDE_CONFIG_DIR/projects`).
   * Sem ela, as conversas das CLIs não são gerenciadas (nada é apagado lá).
   */
  claudeProjectsDir?: string;
  /** Tarefas ativas de um workspace (o log delas nunca é apagado). */
  activeTaskIds: (workspaceId: string) => ReadonlySet<string>;
  /** Avisa o workspace que esses logs saíram (o log de trabalho esquece o que guardava). */
  forgetLogs?: (workspaceId: string, taskIds: string[]) => void;
  now: () => Date;
  log: Pick<FastifyBaseLogger, "info" | "warn" | "error">;
};

const empty = (): DiskUsage => ({ bytes: 0, files: 0 });

async function lstatOrNull(target: string) {
  try {
    return await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function entriesOf(dir: string) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    throw error;
  }
}

/** Tamanho de uma árvore (sem seguir links simbólicos) e a modificação mais recente dentro dela. */
async function treeInfo(target: string): Promise<{ bytes: number; files: number; newestMs: number }> {
  const info = await lstatOrNull(target);
  if (!info || info.isSymbolicLink()) return { bytes: 0, files: 0, newestMs: 0 };
  if (!info.isDirectory()) return { bytes: info.size, files: 1, newestMs: info.mtimeMs };
  const out = { bytes: 0, files: 0, newestMs: info.mtimeMs };
  for (const entry of await entriesOf(target)) {
    const child = await treeInfo(path.join(target, entry.name));
    out.bytes += child.bytes;
    out.files += child.files;
    out.newestMs = Math.max(out.newestMs, child.newestMs);
  }
  return out;
}

const add = (into: DiskUsage, more: { bytes: number; files: number }) => {
  into.bytes += more.bytes;
  into.files += more.files;
};

/**
 * Retenção do histórico em disco (configuração da instalação, em DATA_DIR/settings.json):
 * - conversas internas do Claude Code dos NOSSOS agentes: só dentro de
 *   `<claudeProjectsDir>/<nome da pasta do agente>` (nome calculado do cwd de cada agente que existe
 *   em DATA_DIR/workspaces/<ws>/agents/<id>/), só `<uuid>.jsonl` e `<uuid>/` mais velhos que o
 *   limite e nunca a sessão atual do agente (session.json). Nenhuma outra pasta é tocada, links
 *   simbólicos nunca são seguidos;
 * - logs de trabalho das tarefas (`workspaces/<ws>/logs/<taskId>.jsonl`) mais velhos que o limite,
 *   nunca de tarefa ativa.
 * Tarefas, resultados e o Cérebro ficam para sempre. O Antigravity guarda as conversas fora da
 * pasta do agente (~/.gemini/antigravity-cli/conversations, junto com as do usuário): não mexemos.
 */
export class RetentionService {
  private current: RetentionSettings = { ...DEFAULT_RETENTION };
  private last: RetentionCleanupResult | null = null;
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<RetentionCleanupResult> | undefined;
  private readonly file: string;
  private readonly listeners = new Set<(settings: RetentionSettings, before: RetentionSettings) => void>();

  constructor(private readonly deps: RetentionDeps) {
    this.file = path.join(deps.dataDir, "settings.json");
  }

  /** Lê settings.json (ausente ou inválido = padrões). */
  async load(): Promise<void> {
    try {
      const parsed = settingsFileSchema.safeParse(JSON.parse(await readFile(this.file, "utf8")));
      if (!parsed.success) return;
      this.current = { ...DEFAULT_RETENTION, ...parsed.data.retention };
      this.last = parsed.data.lastCleanup ?? null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.deps.log.warn({ err: error }, "settings.json ilegível: usando os padrões");
    }
  }

  settings(): RetentionSettings {
    return { ...this.current };
  }

  /** Avisa quando a configuração muda (o prazo das aprovações dispara a varredura do arquivo em cada workspace). Devolve quem cancela. */
  onChange(listener: (settings: RetentionSettings, before: RetentionSettings) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async update(change: UpdateRetentionBody): Promise<RetentionSettings> {
    const before = this.settings();
    this.current = retentionSettingsSchema.parse({ ...this.current, ...Object.fromEntries(Object.entries(change).filter(([, value]) => value !== undefined)) });
    await this.save();
    const after = this.settings();
    for (const listener of this.listeners) {
      try {
        listener(after, before);
      } catch (error) {
        this.deps.log.warn({ err: error }, "falha ao avisar a mudança da retenção");
      }
    }
    return after;
  }

  /** Configuração, uso de disco e última limpeza (GET /api/settings/retention). */
  async snapshot(): Promise<RetentionResponse> {
    return { settings: this.settings(), usage: await this.usage(), transcriptsManaged: this.deps.claudeProjectsDir !== undefined, lastCleanup: this.last };
  }

  /** Limpa agora (uma de cada vez: chamadas no meio esperam a que está rodando). */
  cleanup(): Promise<RetentionCleanupResult> {
    if (!this.running) {
      this.running = this.run().finally(() => {
        this.running = undefined;
      });
    }
    return this.running;
  }

  /** Limpeza no boot e depois uma vez por dia. */
  start(intervalMs = RETENTION_INTERVAL_MS): void {
    const tick = () => void this.cleanup().catch((error: unknown) => this.deps.log.error({ err: error }, "falha na limpeza do histórico"));
    tick();
    this.timer = setInterval(tick, intervalMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.running?.catch(() => undefined);
  }

  // ---------- Onde mora cada coisa ----------

  private async workspaceDirs(): Promise<{ id: string; dir: string }[]> {
    const root = path.join(this.deps.dataDir, "workspaces");
    return (await entriesOf(root)).filter((entry) => entry.isDirectory() && isSafeId(entry.name)).map((entry) => ({ id: entry.name, dir: path.join(root, entry.name) }));
  }

  /** Pastas das conversas do Claude Code dos nossos agentes (só as que existem e são pastas de verdade), com a sessão atual de cada um. */
  private async transcriptDirs(): Promise<{ dir: string; activeSession?: string }[]> {
    const projects = this.deps.claudeProjectsDir;
    if (!projects) return [];
    const out: { dir: string; activeSession?: string }[] = [];
    for (const workspace of await this.workspaceDirs()) {
      const agentsDir = path.join(workspace.dir, "agents");
      for (const entry of await entriesOf(agentsDir)) {
        if (!entry.isDirectory() || !isSafeId(entry.name)) continue;
        const agentDir = path.join(agentsDir, entry.name);
        const name = claudeProjectDirName(agentDir);
        if (!name) continue;
        const root = path.resolve(projects);
        const dir = path.join(root, name);
        // Precisa ser filha direta da pasta de projetos e uma pasta comum (link simbólico: não mexe).
        if (path.dirname(dir) !== root) continue;
        const info = await lstatOrNull(dir);
        if (!info?.isDirectory()) continue;
        out.push({ dir, activeSession: await this.activeSession(agentDir) });
      }
    }
    return out;
  }

  private async activeSession(agentDir: string): Promise<string | undefined> {
    try {
      const data = JSON.parse(await readFile(path.join(agentDir, "session.json"), "utf8")) as { sessionId?: unknown };
      return typeof data.sessionId === "string" ? data.sessionId : undefined;
    } catch {
      return undefined;
    }
  }

  private async usage(): Promise<RetentionResponse["usage"]> {
    const usage = { transcripts: empty(), logs: empty(), brains: empty(), tasks: empty() };
    for (const { dir } of await this.transcriptDirs()) add(usage.transcripts, await treeInfo(dir));
    for (const workspace of await this.workspaceDirs()) {
      add(usage.logs, await treeInfo(path.join(workspace.dir, "logs")));
      add(usage.brains, await treeInfo(path.join(workspace.dir, "brains")));
      add(usage.tasks, await treeInfo(path.join(workspace.dir, "tasks")));
      add(usage.tasks, await treeInfo(path.join(workspace.dir, "tasks.json")));
      add(usage.tasks, await treeInfo(path.join(workspace.dir, "tasks.legacy.json")));
    }
    return usage;
  }

  // ---------- Limpeza ----------

  private async run(): Promise<RetentionCleanupResult> {
    const nowMs = this.deps.now().getTime();
    const result: RetentionCleanupResult = { at: new Date(nowMs).toISOString(), transcripts: empty(), logs: empty() };
    const { transcriptsDays, logsDays } = this.current;
    if (transcriptsDays > 0) await this.cleanTranscripts(nowMs - transcriptsDays * DAY_MS, result.transcripts);
    if (logsDays > 0) await this.cleanLogs(nowMs - logsDays * DAY_MS, result.logs);
    // A Atividade tem retenção própria (fixa): não depende dos ajustes acima.
    await this.cleanActivity(nowMs).catch((error: unknown) => this.deps.log.warn({ err: errorMessage(error) }, "não foi possível limpar a Atividade antiga"));
    this.last = result;
    await this.save().catch((error: unknown) => this.deps.log.warn({ err: error }, "não foi possível gravar settings.json"));
    if (result.transcripts.files + result.logs.files > 0) this.deps.log.info({ ...result }, "limpeza do histórico");
    return result;
  }

  private async cleanTranscripts(cutoffMs: number, removed: DiskUsage): Promise<void> {
    for (const { dir, activeSession } of await this.transcriptDirs()) {
      for (const entry of await entriesOf(dir)) {
        const target = path.join(dir, entry.name);
        const file = SESSION_FILE.exec(entry.name);
        const session = file?.[1] ?? (SESSION_DIR.test(entry.name) ? entry.name : undefined);
        // Só conversas (`<uuid>.jsonl` e `<uuid>/`), nunca a sessão atual do agente.
        if (!session || session === activeSession) continue;
        if (file ? !entry.isFile() : !entry.isDirectory()) continue;
        const info = await treeInfo(target);
        if (info.newestMs >= cutoffMs) continue;
        try {
          if (file) await unlink(target);
          else await rm(target, { recursive: true });
          add(removed, info);
        } catch (error) {
          this.deps.log.warn({ err: errorMessage(error), target }, "não foi possível apagar a conversa antiga");
        }
      }
    }
  }

  private async cleanLogs(cutoffMs: number, removed: DiskUsage): Promise<void> {
    for (const workspace of await this.workspaceDirs()) {
      const logsDir = path.join(workspace.dir, "logs");
      const active = this.deps.activeTaskIds(workspace.id);
      const gone: string[] = [];
      for (const entry of await entriesOf(logsDir)) {
        const match = TASK_LOG_FILE.exec(entry.name);
        if (!match || !entry.isFile() || active.has(match[1]!)) continue;
        const target = path.join(logsDir, entry.name);
        try {
          const info = await stat(target);
          if (info.mtimeMs >= cutoffMs) continue;
          await unlink(target);
          add(removed, { bytes: info.size, files: 1 });
          gone.push(match[1]!);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.deps.log.warn({ err: errorMessage(error), target }, "não foi possível apagar o log antigo");
        }
      }
      if (gone.length > 0) this.deps.forgetLogs?.(workspace.id, gone);
    }
  }

  /**
   * Atividade: arquivos do dia (`workspaces/<ws>/activity` e `activity`) com mais de 180 dias e as
   * métricas por hora (`activity/metrics-AAAA-MM.jsonl`) com mais de 60. Nunca toca em outros arquivos
   * (heartbeat.json, marcador da migração).
   */
  async cleanActivity(nowMs: number): Promise<{ files: number; metricLines: number }> {
    const removed = { files: 0, metricLines: 0 };
    const activityCutoff = activityDay(nowMs - ACTIVITY_RETENTION_DAYS * DAY_MS);
    const dirs = [path.join(this.deps.dataDir, "activity"), ...(await this.workspaceDirs()).map((workspace) => path.join(workspace.dir, "activity"))];
    for (const dir of dirs) {
      for (const entry of await entriesOf(dir)) {
        const day = ACTIVITY_DAY_FILE.exec(entry.name)?.[1];
        if (!day || !entry.isFile() || day >= activityCutoff) continue;
        try {
          await unlink(path.join(dir, entry.name));
          removed.files += 1;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.deps.log.warn({ err: errorMessage(error), file: entry.name }, "não foi possível apagar a Atividade antiga");
        }
      }
    }
    const metricsCutoffMs = nowMs - METRICS_RETENTION_DAYS * DAY_MS;
    const metricsCutoffMonth = activityDay(metricsCutoffMs).slice(0, 7);
    const metricsDir = path.join(this.deps.dataDir, "activity");
    for (const entry of await entriesOf(metricsDir)) {
      const month = METRICS_FILE.exec(entry.name)?.[1];
      if (!month || !entry.isFile() || month > metricsCutoffMonth) continue;
      const file = path.join(metricsDir, entry.name);
      try {
        if (month < metricsCutoffMonth) {
          await unlink(file);
          removed.files += 1;
          continue;
        }
        // Mês do corte: tira só as linhas mais velhas que 60 dias.
        const lines = (await readFile(file, "utf8")).split("\n").filter(Boolean);
        const kept = lines.filter((line) => {
          const hour = (JSON.parse(line) as { hour?: string }).hour;
          return !hour || !(Date.parse(hour) < metricsCutoffMs);
        });
        if (kept.length === lines.length) continue;
        removed.metricLines += lines.length - kept.length;
        if (kept.length === 0) await unlink(file);
        else await writeFile(file, `${kept.join("\n")}\n`, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.deps.log.warn({ err: errorMessage(error), file: entry.name }, "não foi possível limpar as métricas antigas");
      }
    }
    return removed;
  }

  private save(): Promise<void> {
    return writeJsonAtomic(this.file, { retention: this.current, ...(this.last ? { lastCleanup: this.last } : {}) });
  }
}
