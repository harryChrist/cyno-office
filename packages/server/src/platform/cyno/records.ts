import { readFile } from "node:fs/promises";
import { writeJsonAtomic } from "../../store/atomic-write";
import type { WriteQueue } from "../../store/write-queue";

/**
 * Uma lista pequena de registros da plataforma num arquivo JSON (`{ items: [...] }`), lida uma vez e
 * gravada pela fila atômica a cada mudança. Registro que não passa em `parse` é ignorado ao ler.
 */
export class JsonRecords<T> {
  private items: T[] = [];

  private constructor(
    private readonly file: string,
    private readonly queue: WriteQueue,
    private readonly onError: (error: unknown) => void,
  ) {}

  static async open<T>(file: string, queue: WriteQueue, parse: (raw: unknown) => T | undefined, onError: (error: unknown) => void = () => undefined): Promise<JsonRecords<T>> {
    const records = new JsonRecords<T>(file, queue, onError);
    try {
      const raw = JSON.parse(await readFile(file, "utf8")) as { items?: unknown };
      if (Array.isArray(raw.items)) records.items = raw.items.flatMap((item) => parse(item) ?? []);
    } catch {
      // Sem arquivo (ou quebrado): lista vazia.
    }
    return records;
  }

  /** Os registros (a lista viva: quem muda um objeto chama `save`). */
  all(): T[] {
    return this.items;
  }

  add(item: T): void {
    this.items.push(item);
    this.save();
  }

  /** Grava na fila (sem esperar); um erro de disco vai para `onError` e não derruba quem chamou. */
  save(): void {
    const snapshot = structuredClone({ items: this.items });
    void this.queue.enqueue(() => writeJsonAtomic(this.file, snapshot)).catch((error: unknown) => this.onError(error));
  }
}
