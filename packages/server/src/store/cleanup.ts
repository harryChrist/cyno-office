import { lstat, readdir, realpath, rm, unlink } from "node:fs/promises";
import path from "node:path";
import { conversationLogPrefix, GLOBAL_BRAIN_ID, isConversationLogId, isSafeId } from "@cyno/shared";
import type { FastifyBaseLogger } from "fastify";
import { isPathInside } from "../platform/os";
import { listNoteFiles } from "../workspace/brain/notes";
import type { DataPaths } from "./paths";
import type { WriteQueue } from "./write-queue";

/** Arquivo de log de tarefa (`<taskId>.jsonl`, mesmo padrão de dataPaths.taskLogFile). */
const TASK_LOG_FILE = /^([a-z0-9][a-z0-9-]{0,63})\.jsonl$/i;

export type DataCleanupDeps = {
  paths: DataPaths;
  /** Fila de escrita do workspace: as remoções entram depois das gravações pendentes. */
  queue: WriteQueue;
  log: Pick<FastifyBaseLogger, "info" | "warn" | "error">;
  /** Para o terminal de CLI do agente (e revoga o token); resolve quando o processo parou. */
  stopTerminal: (agentId: string) => Promise<void>;
  /** Apaga as pastas de motor (HERMES_HOME, configuração do OpenClaw) do agente: o token do MCP não fica em disco. */
  removeEngineData?: (agentId: string) => Promise<void>;
  /** Esquece o que o log de trabalho guarda em memória sobre essas tarefas e agentes. */
  forgetLogs?: (taskIds: readonly string[], agentIds: readonly string[]) => void;
};

/** O que ainda existe no workspace (tudo fora disso no disco é sobra). */
export type LiveIds = { roomIds: Iterable<string>; agentIds: Iterable<string>; taskIds: Iterable<string> };

/** O que some junto com um quarto, time ou agente. */
export type Leftovers = { taskIds?: readonly string[]; agentIds?: readonly string[]; brainId?: string };

/**
 * Apaga do disco o que pertencia a coisas removidas: logs de tarefas (`logs/<taskId>.jsonl`),
 * pastas dos agentes (`agents/<id>/`, com session.json e mcp.json) e Cérebros de quartos
 * (`brains/<roomId>/`). Tudo passa pela fila de escrita do workspace e só acontece dentro da
 * pasta do workspace: o alvo precisa estar nela (conferido com realpath, então uma pasta-mãe que é
 * link simbólico para fora é recusada) e um alvo que é link simbólico nunca é seguido. Arquivo que
 * já não existe não é erro. As falhas vão para o log: nenhum método rejeita.
 */
export class DataCleanup {
  constructor(private readonly deps: DataCleanupDeps) {}

  /** Apaga o que sobrou de quartos/times/agentes removidos (terminais param antes das pastas sumirem). */
  async removeLeftovers({ taskIds = [], agentIds = [], brainId }: Leftovers): Promise<void> {
    // Primeiro os terminais param (o processo pode gravar session.json até o fim).
    await Promise.all(
      agentIds.map((agentId) =>
        this.deps.stopTerminal(agentId).catch((error: unknown) => this.deps.log.error({ err: error, agentId }, "falha ao parar o terminal")),
      ),
    );
    this.deps.forgetLogs?.(taskIds, agentIds);
    await this.removeEngineData(agentIds);
    const targets = [
      ...taskIds.flatMap((taskId) => this.safePath(() => this.deps.paths.taskLogFile(taskId))),
      ...agentIds.flatMap((agentId) => this.safePath(() => this.deps.paths.agentDir(agentId))),
      ...(brainId === undefined || brainId === GLOBAL_BRAIN_ID ? [] : this.safePath(() => this.deps.paths.brainDir(brainId))),
    ];
    if (targets.length === 0) return;
    await this.deps.queue
      .enqueue(async () => {
        for (const target of targets) await this.remove(target, "unlink", "removido em cascata");
      })
      .catch((error: unknown) => this.deps.log.error({ err: error }, "falha ao apagar dados em cascata"));
  }

  /** As pastas de motor do agente (agente removido ou que trocou de motor); falha vai para o log. */
  async removeEngineData(agentIds: readonly string[]): Promise<void> {
    await Promise.all(agentIds.map((agentId) => this.deps.removeEngineData?.(agentId).catch((error: unknown) => this.deps.log.error({ err: error, agentId }, "falha ao apagar a pasta de motor do agente"))));
  }

  /**
   * Sobras no disco (uma vez ao abrir o workspace): Cérebros de quartos que não existem mais
   * (fora o "global"), pastas de agentes que não existem mais e logs de tarefas que não existem
   * mais. Conservador: só entradas com nome no padrão dos ids, nunca links simbólicos. Devolve os
   * caminhos apagados (cada um também vai para o log).
   */
  async removeOrphans(live: LiveIds): Promise<string[]> {
    const rooms = new Set([GLOBAL_BRAIN_ID, ...live.roomIds]);
    const agents = new Set(live.agentIds);
    const tasks = new Set(live.taskIds);
    const removed: string[] = [];
    await this.deps.queue
      .enqueue(async () => {
        const { paths } = this.deps;
        const candidates = [
          ...(await this.entries(paths.brainsDir, "dir")).filter((name) => isSafeId(name) && !rooms.has(name)).map((name) => path.join(paths.brainsDir, name)),
          ...(await this.entries(paths.agentsDir, "dir")).filter((name) => isSafeId(name) && !agents.has(name)).map((name) => path.join(paths.agentsDir, name)),
          ...(await this.entries(paths.logsDir, "file"))
            .filter((name) => {
              const match = TASK_LOG_FILE.exec(name);
              // Log da conversa com o Maestro: fica enquanto o agente existir (a retenção apaga os velhos).
              if (match && isConversationLogId(match[1]!)) return ![...agents].some((agentId) => match[1]!.startsWith(conversationLogPrefix(agentId)));
              return match !== null && !tasks.has(match[1]!);
            })
            .map((name) => path.join(paths.logsDir, name)),
        ];
        for (const target of candidates) {
          if (await this.remove(target, "skip", "sobra apagada (dono não existe mais)")) removed.push(target);
        }
        // O agente que não existe mais também deixa pasta de motor (HERMES_HOME, configuração do OpenClaw).
        for (const name of (await this.entries(paths.agentsDir, "dir")).filter((entry) => isSafeId(entry) && !agents.has(entry))) await this.removeEngineData([name]);
      })
      .catch((error: unknown) => this.deps.log.error({ err: error }, "falha ao apagar sobras do workspace"));
    return removed;
  }

  /** Quantas notas .md o Cérebro tem no disco. */
  async countBrainNotes(brainId: string): Promise<number> {
    return (await listNoteFiles(this.deps.paths.brainDir(brainId))).length;
  }

  /** Quantas dessas tarefas têm arquivo de log no disco. */
  async countTaskLogs(taskIds: readonly string[]): Promise<number> {
    if (taskIds.length === 0) return 0;
    const files = new Set(await this.entries(this.deps.paths.logsDir, "file"));
    return taskIds.filter((taskId) => files.has(`${taskId}.jsonl`)).length;
  }

  // ---------- Infra ----------

  /** Caminho de dataPaths (que recusa ids fora do padrão); id inválido = nada a apagar. */
  private safePath(build: () => string): string[] {
    try {
      return [build()];
    } catch {
      return [];
    }
  }

  /** Nomes das entradas de um tipo (sem seguir links simbólicos); pasta ausente = nenhuma. */
  private async entries(dir: string, kind: "dir" | "file"): Promise<string[]> {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      return entries.filter((entry) => (kind === "dir" ? entry.isDirectory() : entry.isFile())).map((entry) => entry.name);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return [];
      throw error;
    }
  }

  /**
   * Apaga `target` se ele estiver mesmo dentro da pasta do workspace. Link simbólico: "unlink"
   * tira só o link (o destino fica intacto); "skip" deixa como está. Devolve se apagou.
   */
  private async remove(target: string, symlinks: "unlink" | "skip", reason: string): Promise<boolean> {
    try {
      if (!(await this.isInsideWorkspace(target))) {
        this.deps.log.warn({ target }, "remoção recusada: fora da pasta do workspace");
        return false;
      }
      const info = await lstat(target);
      if (info.isSymbolicLink()) {
        if (symlinks === "skip") {
          this.deps.log.warn({ target }, "sobra ignorada: é um link simbólico");
          return false;
        }
        await unlink(target);
      } else if (info.isDirectory()) {
        // rm recursivo não segue links simbólicos de dentro (apaga só os links).
        await rm(target, { recursive: true, force: true });
      } else {
        await unlink(target);
      }
      this.deps.log.info({ target }, reason);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      this.deps.log.error({ err: error, target }, "falha ao apagar");
      return false;
    }
  }

  /** O alvo fica numa subpasta real da pasta do workspace (resolvendo links da pasta-mãe)? */
  private async isInsideWorkspace(target: string): Promise<boolean> {
    const root = await realpath(this.deps.paths.root);
    const parent = await realpath(path.dirname(path.resolve(target)));
    const resolved = path.join(parent, path.basename(target));
    return isPathInside(resolved, root, { strict: true }) && path.basename(target) !== "..";
  }
}
