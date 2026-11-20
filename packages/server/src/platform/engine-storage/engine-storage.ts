import { mkdir, readFile, rm, unlink } from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_ENGINE_STORAGE,
  engineStorageSettingsSchema,
  isSafeId,
  type EngineStorageCleanupResult,
  type EngineStoragePreview,
  type EngineStorageRemoval,
  type EngineStorageResponse,
  type EngineStorageSettings,
  type EngineStorageUsage,
  type UpdateEngineStorageBody,
} from "@cyno/shared";
import type { FastifyBaseLogger } from "fastify";
import { z } from "zod";
import { freebuffFolderName } from "../../engines/freebuff/files";
import { engineDirs } from "../../engines/install/recipes";
import { writeJsonAtomic } from "../../store/atomic-write";
import { errorMessage } from "../../util/text";
import { claudeProjectDirName } from "../retention/retention";
import { emptyTree, entriesOf, lstatOrNull, mergeTree, toItem, treeInfo, type TreeInfo } from "./measure";

const DAY_MS = 86_400_000;
/** Limpeza automática: uma vez por dia (e uma no boot). */
export const ENGINE_STORAGE_INTERVAL_MS = DAY_MS;
/** Nada modificado nas últimas 24 h é apagado, qualquer que seja o prazo escolhido. */
const MIN_AGE_MS = DAY_MS;
/** Log do Antigravity: `cli-AAAAMMDD_HHMMSS.log` (o `cli.log` é um link para o atual e nunca casa). */
const ANTIGRAVITY_LOG = /^cli-\d{8}_\d{6}\.log$/;
/** Pasta de projeto do Freebuff que é do Cyno (ver `freebuffFolderName`): `fb-` e letras minúsculas, números e hífens. */
const FREEBUFF_PROJECT = /^fb-[a-z0-9-]{1,120}$/;
/** Chat do Freebuff: pasta com a data, ex.: `2026-11-20T15-50-08.298Z`. */
const FREEBUFF_CHAT = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:\.\d{1,6})?Z$/;

const removalSchema = z.object({ files: z.number(), bytes: z.number() });
const fileSchema = z.object({
  settings: engineStorageSettingsSchema.optional(),
  lastCleanup: z.object({ at: z.string(), antigravityLogs: removalSchema, freebuffChats: removalSchema }).optional(),
});

export type EngineStorageDeps = {
  /** DATA_DIR (a configuração fica em `platform/engine-storage.json`; também lê as pastas do Cyno dos agentes e do Hermes/OpenClaw). */
  dataDir: string;
  /** `~/.claude/projects`: sem ela, o Claude Code não é medido. */
  claudeProjectsDir?: string;
  /** Pasta do Antigravity (`~/.gemini/antigravity-cli`): sem ela, nada é medido nem apagado. */
  antigravityHome?: string;
  /** Pasta do Freebuff (`~/.config/manicode`): sem ela, nada é medido nem apagado. */
  freebuffHome?: string;
  now: () => Date;
  log: Pick<FastifyBaseLogger, "info" | "warn" | "error">;
  /** Registra na Atividade da plataforma quando a limpeza apagou algo. */
  record?: (entry: { auto: boolean; summary: string; data: Record<string, unknown> }) => void;
};

type Candidate = { kind: "antigravityLog" | "freebuffChat"; target: string; parent: string; bytes: number; files: number };

const none = (): EngineStorageRemoval => ({ files: 0, bytes: 0 });

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

/**
 * Armazenamento dos motores. SÓ mede (somente leitura, sem seguir links simbólicos) e limpa duas coisas
 * que são dos agentes do Cyno, por idade e só se o dono ligar (tudo desligado por padrão):
 * - Antigravity: arquivos `log/cli-AAAAMMDD_HHMMSS.log` (arquivo comum, nunca o `cli.log`);
 * - Freebuff: pastas de chat `projects/fb-NOME/chats/DATA`, nunca o chat que é a sessão atual de um agente
 *   (`session.json` do agente) e nunca nada fora dessas pastas.
 * Nada com menos de 24 h é apagado. As conversas do Antigravity (`conversations/`, `brain/`), o Hermes e o
 * OpenClaw só são medidos. As conversas do Claude Code são do Histórico (RetentionService).
 */
export class EngineStorage {
  private current: EngineStorageSettings = { ...DEFAULT_ENGINE_STORAGE };
  private last: EngineStorageCleanupResult | null = null;
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<EngineStorageCleanupResult> | undefined;
  private readonly file: string;

  constructor(private readonly deps: EngineStorageDeps) {
    this.file = path.join(deps.dataDir, "platform", "engine-storage.json");
  }

  /** Lê o arquivo (ausente ou inválido = tudo desligado). */
  async load(): Promise<void> {
    try {
      const parsed = fileSchema.safeParse(JSON.parse(await readFile(this.file, "utf8")));
      if (!parsed.success) return;
      this.current = { ...DEFAULT_ENGINE_STORAGE, ...parsed.data.settings };
      this.last = parsed.data.lastCleanup ?? null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.deps.log.warn({ err: errorMessage(error) }, "engine-storage.json ilegível: tudo desligado");
    }
  }

  settings(): EngineStorageSettings {
    return { ...this.current };
  }

  async update(change: UpdateEngineStorageBody): Promise<EngineStorageSettings> {
    this.current = engineStorageSettingsSchema.parse({ ...this.current, ...Object.fromEntries(Object.entries(change).filter(([, value]) => value !== undefined)) });
    await this.save();
    return this.settings();
  }

  /** Configuração, tamanhos por motor e última limpeza (GET /api/settings/engine-storage). */
  async snapshot(): Promise<EngineStorageResponse> {
    return { settings: this.settings(), usage: await this.usage(), lastCleanup: this.last };
  }

  /** O que sairia com esses ajustes (ausente = o valor salvo). Não apaga nada. */
  async preview(override: Partial<EngineStorageSettings> = {}): Promise<EngineStoragePreview> {
    const settings = { ...this.current, ...Object.fromEntries(Object.entries(override).filter(([, value]) => value !== undefined)) } as EngineStorageSettings;
    const found = await this.candidates(settings, this.deps.now().getTime());
    return summarize(found);
  }

  /** Limpa agora com os ajustes salvos (uma de cada vez: chamadas no meio esperam a que está rodando). */
  cleanup(auto = false): Promise<EngineStorageCleanupResult> {
    if (!this.running) {
      this.running = this.run(auto).finally(() => {
        this.running = undefined;
      });
    }
    return this.running;
  }

  /** Limpeza no boot e depois uma vez por dia (só faz algo para o que estiver ligado). */
  start(intervalMs = ENGINE_STORAGE_INTERVAL_MS): void {
    const tick = () => void this.cleanup(true).catch((error: unknown) => this.deps.log.error({ err: errorMessage(error) }, "falha na limpeza do armazenamento dos motores"));
    tick();
    this.timer = setInterval(tick, intervalMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.running?.catch(() => undefined);
  }

  // ---------- Medição ----------

  private async usage(): Promise<EngineStorageUsage> {
    const { dataDir, antigravityHome } = this.deps;
    const sum = async (targets: string[]): Promise<TreeInfo> => {
      const total = emptyTree();
      for (const target of targets) mergeTree(total, await treeInfo(target));
      return total;
    };
    const hermesHome = engineDirs(dataDir, "hermes").home;
    const [claude, agyLogs, agyConversations, freebuffChats, hermesTotal, hermesCache, openclaw] = await Promise.all([
      this.claudeTree(),
      sum(antigravityHome ? [path.join(antigravityHome, "log")] : []),
      sum(antigravityHome ? [path.join(antigravityHome, "conversations"), path.join(antigravityHome, "brain")] : []),
      this.freebuffChatsTree(),
      sum([hermesHome]),
      sum([path.join(hermesHome, "cache"), path.join(hermesHome, ".cache")]),
      sum([path.join(dataDir, "platform", "engines", "openclaw", "state")]),
    ]);
    return {
      claude: toItem(claude),
      antigravity: { logs: toItem(agyLogs), conversations: toItem(agyConversations) },
      freebuff: { chats: toItem(freebuffChats) },
      hermes: { total: toItem(hermesTotal), cache: toItem(hermesCache) },
      openclaw: toItem(openclaw),
    };
  }

  private async workspaceIds(): Promise<string[]> {
    const root = path.join(this.deps.dataDir, "workspaces");
    return (await entriesOf(root)).filter((entry) => entry.isDirectory() && isSafeId(entry.name)).map((entry) => entry.name);
  }

  private async agentDirs(): Promise<{ workspaceId: string; agentId: string; dir: string }[]> {
    const out: { workspaceId: string; agentId: string; dir: string }[] = [];
    for (const workspaceId of await this.workspaceIds()) {
      const agentsDir = path.join(this.deps.dataDir, "workspaces", workspaceId, "agents");
      for (const entry of await entriesOf(agentsDir)) {
        if (entry.isDirectory() && isSafeId(entry.name)) out.push({ workspaceId, agentId: entry.name, dir: path.join(agentsDir, entry.name) });
      }
    }
    return out;
  }

  /** Conversas do Claude Code dos agentes do Cyno (só LEITURA; a mesma regra de nome de pasta do Histórico). */
  private async claudeTree(): Promise<TreeInfo> {
    const total = emptyTree();
    const projects = this.deps.claudeProjectsDir;
    if (!projects) return total;
    const root = path.resolve(projects);
    for (const agent of await this.agentDirs()) {
      const name = claudeProjectDirName(agent.dir);
      if (!name) continue;
      const dir = path.join(root, name);
      if (path.dirname(dir) !== root) continue;
      mergeTree(total, await treeInfo(dir));
    }
    return total;
  }

  /** Pastas `projects/fb-NOME` reais (não link) do Freebuff. */
  private async freebuffProjects(): Promise<{ name: string; chatsDir: string }[]> {
    const home = this.deps.freebuffHome;
    if (!home) return [];
    const projects = path.join(path.resolve(home), "projects");
    const out: { name: string; chatsDir: string }[] = [];
    for (const entry of await entriesOf(projects)) {
      if (!entry.isDirectory() || !FREEBUFF_PROJECT.test(entry.name)) continue;
      const chatsDir = path.join(projects, entry.name, "chats");
      if ((await lstatOrNull(chatsDir))?.isDirectory()) out.push({ name: entry.name, chatsDir });
    }
    return out;
  }

  private async freebuffChatsTree(): Promise<TreeInfo> {
    const total = emptyTree();
    for (const project of await this.freebuffProjects()) mergeTree(total, await treeInfo(project.chatsDir));
    return total;
  }

  // ---------- Limpeza ----------

  /**
   * Chats do Freebuff que são a sessão ATUAL de um agente (`session.json` com `provider: "freebuff"`): o
   * mesmo vínculo do terminal do Freebuff (pasta `freebuffFolderName(workspace, agente)`, chat = sessionId).
   */
  private async protectedChats(): Promise<Set<string>> {
    const keep = new Set<string>();
    for (const agent of await this.agentDirs()) {
      try {
        const data = JSON.parse(await readFile(path.join(agent.dir, "session.json"), "utf8")) as { provider?: unknown; sessionId?: unknown };
        if (data.provider === "freebuff" && typeof data.sessionId === "string") keep.add(`${freebuffFolderName(agent.workspaceId, agent.agentId)}/${data.sessionId}`);
      } catch {
        // Sem session.json legível: nada a proteger por aqui (a regra das 24 h continua valendo).
      }
    }
    return keep;
  }

  /** Tudo que a limpeza apagaria com esses ajustes (a pré-visualização e a limpeza usam esta mesma lista). */
  private async candidates(settings: EngineStorageSettings, nowMs: number): Promise<Candidate[]> {
    const out: Candidate[] = [];
    const home = this.deps.antigravityHome;
    if (settings.antigravityLogsDays > 0 && home) {
      const cutoff = nowMs - Math.max(settings.antigravityLogsDays * DAY_MS, MIN_AGE_MS);
      const logDir = path.join(path.resolve(home), "log");
      for (const entry of await entriesOf(logDir)) {
        if (!ANTIGRAVITY_LOG.test(entry.name)) continue;
        const target = path.join(logDir, entry.name);
        const info = await lstatOrNull(target);
        // Só arquivo comum (link simbólico nunca) e velho.
        if (!info?.isFile() || info.mtimeMs >= cutoff) continue;
        out.push({ kind: "antigravityLog", target, parent: logDir, bytes: info.size, files: 1 });
      }
    }
    if (settings.freebuffChatsDays > 0 && this.deps.freebuffHome) {
      const cutoff = nowMs - Math.max(settings.freebuffChatsDays * DAY_MS, MIN_AGE_MS);
      const keep = await this.protectedChats();
      for (const project of await this.freebuffProjects()) {
        for (const entry of await entriesOf(project.chatsDir)) {
          if (!entry.isDirectory() || !FREEBUFF_CHAT.test(entry.name) || keep.has(`${project.name}/${entry.name}`)) continue;
          const target = path.join(project.chatsDir, entry.name);
          // Vale o arquivo mais novo dentro da pasta do chat.
          const info = await treeInfo(target);
          if (info.newestMs === 0 || info.newestMs >= cutoff) continue;
          out.push({ kind: "freebuffChat", target, parent: project.chatsDir, bytes: info.bytes, files: info.files });
        }
      }
    }
    return out;
  }

  private async run(auto: boolean): Promise<EngineStorageCleanupResult> {
    const nowMs = this.deps.now().getTime();
    const result: EngineStorageCleanupResult = { at: new Date(nowMs).toISOString(), antigravityLogs: none(), freebuffChats: none() };
    // Tudo desligado: não faz nada (nem sequer lista as pastas dos motores).
    if (this.current.antigravityLogsDays === 0 && this.current.freebuffChatsDays === 0) return result;
    for (const item of await this.candidates(this.current, nowMs)) {
      if (!(await this.remove(item))) continue;
      const into = item.kind === "antigravityLog" ? result.antigravityLogs : result.freebuffChats;
      into.files += item.files;
      into.bytes += item.bytes;
    }
    this.last = result;
    await this.save().catch((error: unknown) => this.deps.log.warn({ err: errorMessage(error) }, "não foi possível gravar engine-storage.json"));
    const files = result.antigravityLogs.files + result.freebuffChats.files;
    if (files > 0) {
      const bytes = result.antigravityLogs.bytes + result.freebuffChats.bytes;
      this.deps.log.info({ ...result }, "limpeza do armazenamento dos motores");
      try {
        this.deps.record?.({
          auto,
          summary: `Limpeza do armazenamento dos motores: ${files} ${files === 1 ? "arquivo apagado" : "arquivos apagados"} (${formatBytes(bytes)})`,
          data: { antigravityLogs: result.antigravityLogs, freebuffChats: result.freebuffChats },
        });
      } catch (error) {
        this.deps.log.warn({ err: errorMessage(error) }, "não foi possível registrar a limpeza na Atividade");
      }
    }
    return result;
  }

  /** Apaga um candidato, conferindo de novo que ele é filho direto da pasta esperada e do tipo certo (nunca link). */
  private async remove(item: Candidate): Promise<boolean> {
    try {
      if (path.dirname(item.target) !== item.parent) return false;
      const info = await lstatOrNull(item.target);
      if (!info || info.isSymbolicLink()) return false;
      if (item.kind === "antigravityLog") {
        if (!info.isFile() || !ANTIGRAVITY_LOG.test(path.basename(item.target))) return false;
        await unlink(item.target);
      } else {
        if (!info.isDirectory() || !FREEBUFF_CHAT.test(path.basename(item.target)) || path.basename(item.parent) !== "chats") return false;
        await rm(item.target, { recursive: true });
      }
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.deps.log.warn({ err: errorMessage(error), target: item.target }, "não foi possível apagar");
      return false;
    }
  }

  private async save(): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    await writeJsonAtomic(this.file, { settings: this.current, ...(this.last ? { lastCleanup: this.last } : {}) });
  }
}

function summarize(found: Candidate[]): EngineStoragePreview {
  const out: EngineStoragePreview = { antigravityLogs: none(), freebuffChats: none() };
  for (const item of found) {
    const into = item.kind === "antigravityLog" ? out.antigravityLogs : out.freebuffChats;
    into.files += item.files;
    into.bytes += item.bytes;
  }
  return out;
}
