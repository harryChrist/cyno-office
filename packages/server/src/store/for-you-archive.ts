import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { forYouArchiveMonth, FOR_YOU_ARCHIVE_MONTH_PATTERN, nextForYouId, type ForYouArchiveSummary, type ForYouItem } from "@cyno/shared";
import { writeJsonAtomic } from "./atomic-write";
import { DataFileError, forYouFileSchema, readJsonIfExists } from "./files";
import type { WriteQueue } from "./write-queue";

/**
 * Arquivo do "Para você" (`for-you/archive/AAAA-MM.json`): os itens decididos há mais tempo que o prazo
 * saem da lista viva (a que fica em memória e vai para a tela) e vêm para cá, pelo mês da decisão. Só se
 * acrescenta (nunca se apaga; `retype` é a única troca, quando um tipo some). Segue o modelo do
 * `AvulsasArchive`, mas guarda um índice leve em memória (ids, contagem por mês e o maior id) lido uma vez
 * no boot: o id novo nunca reaproveita um já arquivado e quem precisa saber "este id foi arquivado?" não
 * lê o disco. As escritas passam pela fila do workspace, junto das demais.
 */
const MONTH_FILE = /^(\d{4}-\d{2})\.json$/;
const ID_SEQ = /^A-(\d+)$/;

const seqOf = (id: string): number => {
  const match = ID_SEQ.exec(id);
  return match ? Number(match[1]) : 0;
};

export class ForYouArchive {
  private readonly ids = new Set<string>();
  private readonly counts = new Map<string, number>();
  /** Maior id já arquivado (a "marca d'água" do contador de ids). */
  private maxId: string | undefined;

  private constructor(
    private readonly dir: string,
    private readonly queue: WriteQueue,
  ) {}

  /** Lê o arquivo uma vez (pasta ausente = vazio) e monta o índice. */
  static async open(dir: string, queue: WriteQueue): Promise<ForYouArchive> {
    const archive = new ForYouArchive(dir, queue);
    for (const month of await archive.months()) archive.index(month, await archive.readFile(month));
    return archive;
  }

  private index(month: string, items: readonly ForYouItem[]): void {
    this.counts.set(month, items.length);
    for (const item of items) this.remember(item.id);
  }

  private remember(id: string): void {
    this.ids.add(id);
    if (!this.maxId || seqOf(id) > seqOf(this.maxId)) this.maxId = id;
  }

  /** Os meses que existem, em ordem. */
  private async months(): Promise<string[]> {
    const names = await readdir(this.dir).catch(() => [] as string[]);
    return names.flatMap((name) => MONTH_FILE.exec(name)?.[1] ?? []).sort();
  }

  private file(month: string): string {
    return path.join(this.dir, `${month}.json`);
  }

  private async readFile(month: string): Promise<ForYouItem[]> {
    const file = this.file(month);
    const parsed = forYouFileSchema.safeParse((await readJsonIfExists(file)) ?? []);
    if (!parsed.success) throw new DataFileError(file, parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`));
    return parsed.data;
  }

  /** Este id já foi para o arquivo? (em memória) */
  has(id: string): boolean {
    return this.ids.has(id);
  }

  /** Próximo id do workspace: um a mais que o maior entre a lista viva e o arquivo (nunca reusa um arquivado). */
  nextId(live: readonly Pick<ForYouItem, "id">[]): string {
    return nextForYouId(this.maxId ? [...live, { id: this.maxId }] : live);
  }

  /** Os meses do arquivo, do mais novo para o mais antigo, com quantos itens cada um tem. */
  summary(liveDays: number): ForYouArchiveSummary {
    const months = [...this.counts].filter(([, count]) => count > 0).map(([month, count]) => ({ month, count })).sort((a, b) => b.month.localeCompare(a.month));
    return { liveDays, months };
  }

  /** Itens de um mês, em ordem de decisão (mês sem arquivo ou mal escrito = nenhum). */
  async readMonth(month: string): Promise<ForYouItem[]> {
    if (!FOR_YOU_ARCHIVE_MONTH_PATTERN.test(month) || !this.counts.has(month)) return [];
    return this.readFile(month).then((items) => items.sort((a, b) => (a.decidedAt ?? a.createdAt).localeCompare(b.decidedAt ?? b.createdAt) || a.id.localeCompare(b.id)));
  }

  /** Os itens do arquivo daquela tarefa e/ou daquele id (do mês mais novo ao mais antigo; sem critério nenhum = nenhum). */
  async find(query: { taskId?: string; id?: string }): Promise<ForYouItem[]> {
    if (!query.taskId && !query.id) return [];
    const out: ForYouItem[] = [];
    for (const month of [...this.counts.keys()].sort().reverse()) {
      out.push(...(await this.readFile(month)).filter((item) => (query.id !== undefined && item.id === query.id) || (query.taskId !== undefined && item.taskId === query.taskId)));
    }
    return out;
  }

  /** Itens cuja decisão (ou criação) caiu em `fromMs` ou depois; só lê os meses que podem ter algum. */
  async since(fromMs: number): Promise<ForYouItem[]> {
    const firstMonth = new Date(fromMs).toISOString().slice(0, 7);
    const out: ForYouItem[] = [];
    for (const month of [...this.counts.keys()].sort()) {
      if (month < firstMonth) continue;
      out.push(...(await this.readFile(month)).filter((item) => Date.parse(item.decidedAt ?? item.createdAt) >= fromMs));
    }
    return out;
  }

  /**
   * Acrescenta os itens ao mês da decisão (um `id` que já está lá não se repete). Resolve quando gravou:
   * só depois disso a lista viva pode soltá-los.
   */
  append(items: readonly ForYouItem[]): Promise<void> {
    if (items.length === 0) return Promise.resolve();
    const copies = items.map((item) => structuredClone(item));
    return this.queue.enqueue(async () => {
      const byMonth = new Map<string, ForYouItem[]>();
      const seen = new Set<string>();
      for (const item of copies) {
        if (this.ids.has(item.id) || seen.has(item.id)) continue;
        seen.add(item.id);
        const month = forYouArchiveMonth(item);
        byMonth.set(month, [...(byMonth.get(month) ?? []), item]);
      }
      if (byMonth.size === 0) return;
      await mkdir(this.dir, { recursive: true });
      for (const [month, fresh] of byMonth) {
        const existing = this.counts.has(month) ? await this.readFile(month) : [];
        await writeJsonAtomic(this.file(month), [...existing, ...fresh]);
        this.counts.set(month, existing.length + fresh.length);
        for (const item of fresh) this.remember(item.id);
      }
    });
  }

  /** Um tipo foi excluído ou juntado a outro: os itens arquivados dele passam para o novo (devolve quantos). */
  retype(from: string, to: string): Promise<number> {
    let changed = 0;
    return this.queue
      .enqueue(async () => {
        for (const month of [...this.counts.keys()]) {
          const items = await this.readFile(month);
          if (!items.some((item) => item.type === from)) continue;
          const next = items.map((item) => (item.type === from ? { ...item, type: to } : item));
          changed += items.length - items.filter((item) => item.type !== from).length;
          await writeJsonAtomic(this.file(month), next);
        }
      })
      .then(() => changed);
  }
}
