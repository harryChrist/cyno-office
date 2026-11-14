import { mkdir, readFile, rm, rmdir } from "node:fs/promises";
import path from "node:path";
import { routineItemsFileSchema, type RoutineItemsFile, type TrackedItem } from "@cyno/shared";
import type { FastifyBaseLogger } from "fastify";
import { writeJsonAtomic } from "../../store/atomic-write";
import type { WriteQueue } from "../../store/write-queue";

export type RoutineItemsStoreDeps = {
  /** routines/<routineId>/items.json (veja `paths.routineItemsFile`). */
  fileOf: (routineId: string) => string;
  /** A mesma fila de escrita do workspace. */
  queue: WriteQueue;
  log: Pick<FastifyBaseLogger, "error">;
};

/**
 * Armazenamento dos itens acompanhados: um arquivo por rotina, fora do routines.json (que cresce com o
 * histórico). Só leitura e gravação do arquivo; a vida do item, as ferramentas MCP e as rotas são da R2.
 * Arquivo ausente = nenhum item; arquivo estragado não é apagado (o erro sobe).
 */
export class RoutineItemsStore {
  constructor(private readonly deps: RoutineItemsStoreDeps) {}

  /** Todos os itens da rotina (cópia). */
  async list(routineId: string): Promise<TrackedItem[]> {
    return structuredClone((await this.read(routineId)).items);
  }

  /** Grava a lista inteira de itens da rotina pela fila (resolve quando chegou ao disco). */
  async save(routineId: string, items: readonly TrackedItem[]): Promise<void> {
    const file = this.deps.fileOf(routineId);
    const snapshot: RoutineItemsFile = { version: 1, items: structuredClone([...items]) };
    await this.deps.queue
      .enqueue(async () => {
        await mkdir(path.dirname(file), { recursive: true });
        await writeJsonAtomic(file, snapshot);
      })
      .catch((error: unknown) => {
        this.deps.log.error({ err: error, routineId }, "falha ao gravar os itens da rotina");
        throw error;
      });
  }

  /** Apaga o arquivo de itens da rotina (e a pasta dela, se ficou vazia). Arquivo ausente não é erro. */
  async remove(routineId: string): Promise<void> {
    const file = this.deps.fileOf(routineId);
    await this.deps.queue.enqueue(async () => {
      await rm(file, { force: true });
      await rmdir(path.dirname(file)).catch(() => undefined);
    });
  }

  private async read(routineId: string): Promise<RoutineItemsFile> {
    let raw: string;
    try {
      raw = await readFile(this.deps.fileOf(routineId), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, items: [] };
      throw error;
    }
    return routineItemsFileSchema.parse(JSON.parse(raw));
  }
}

/** Próximo id de item ("I-0001"…), sequencial por rotina. */
export function nextItemId(items: readonly Pick<TrackedItem, "id">[]): string {
  let max = 0;
  for (const item of items) {
    const match = /^I-(\d{4,})$/.exec(item.id);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `I-${String(max + 1).padStart(4, "0")}`;
}
