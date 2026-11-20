import { mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { isArchivable, leafRequestId, projectTaskSchema, type ProjectTask } from "@cyno/shared";
import { z } from "zod";
import { writeJsonAtomic } from "./atomic-write";
import { monthOf, readJsonIfExists } from "./files";

/**
 * Arquivo mensal do projeto "Avulsas" (`projects/avulsas.archive/AAAA-MM.json`): as folhas finalizadas
 * há mais de 14 dias saem do arquivo vivo (`projects/avulsas.json`) e vão para cá, pelo mês em que
 * terminaram. Só se acrescenta (nunca se edita nem se apaga); quem precisa de uma folha antiga (o "Para
 * você", a Atividade) acha por `ref` com `ProjectService.findTask`. A única exceção é a limpeza que o dono
 * pede (`remove`): reescreve só os meses que tinham folhas apagadas, de uma vez só (escrita atômica), e some
 * com o arquivo do mês que ficou vazio.
 */
const MONTH_FILE = /^\d{4}-\d{2}\.json$/;
const monthSchema = z.array(projectTaskSchema);

export class AvulsasArchive {
  /** Quem escreve (acrescentar e apagar) entra na fila: dois ler-alterar-gravar nunca se cruzam. */
  private writing: Promise<unknown> = Promise.resolve();

  constructor(private readonly dir: string) {}

  private locked<T>(work: () => Promise<T>): Promise<T> {
    const next = this.writing.then(work, work);
    this.writing = next.catch(() => undefined);
    return next;
  }

  /** Os meses que existem, em ordem. */
  private async months(): Promise<string[]> {
    return (await readdir(this.dir).catch(() => [] as string[])).filter((name) => MONTH_FILE.test(name)).sort();
  }

  private async read(name: string): Promise<ProjectTask[]> {
    const raw = await readJsonIfExists(path.join(this.dir, name));
    const parsed = monthSchema.safeParse(raw ?? []);
    if (!parsed.success) throw new Error(`Arquivo do Avulsas inválido (${name}): ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
    return parsed.data as ProjectTask[];
  }

  /** A folha de `ref` no arquivo (ou undefined). */
  async find(ref: string): Promise<ProjectTask | undefined> {
    for (const name of (await this.months()).reverse()) {
      const found = (await this.read(name)).find((task) => task.ref === ref);
      if (found) return found;
    }
    return undefined;
  }

  /** As folhas de um pedido que já foram para o arquivo. */
  async ofRequest(requestId: string): Promise<ProjectTask[]> {
    const out: ProjectTask[] = [];
    for (const name of await this.months()) out.push(...(await this.read(name)).filter((task) => leafRequestId(task) === requestId));
    return out;
  }

  /** As folhas do arquivo que casam com `match` (só lê). */
  async matching(match: (leaf: ProjectTask) => boolean): Promise<ProjectTask[]> {
    const out: ProjectTask[] = [];
    for (const name of await this.months()) out.push(...(await this.read(name)).filter(match));
    return out;
  }

  /**
   * Apaga de vez as folhas que casam com `match`. Reescreve cada mês que mudou com uma escrita atômica
   * (as outras folhas ficam intactas) e remove o arquivo do mês que esvaziou. Devolve as folhas apagadas.
   * Um mês ilegível lança antes de qualquer escrita desse mês.
   */
  remove(match: (leaf: ProjectTask) => boolean): Promise<ProjectTask[]> {
    return this.locked(async () => {
      const removed: ProjectTask[] = [];
      for (const name of await this.months()) {
        const list = await this.read(name);
        const kept = list.filter((leaf) => !match(leaf));
        if (kept.length === list.length) continue;
        removed.push(...list.filter(match));
        const file = path.join(this.dir, name);
        if (kept.length === 0) await rm(file, { force: true });
        else await writeJsonAtomic(file, kept);
      }
      return removed;
    });
  }

  /** Acrescenta as folhas ao mês em que terminaram (um `ref` que já está lá não se repete). */
  append(leaves: readonly ProjectTask[]): Promise<void> {
    return this.locked(() => this.appendNow(leaves));
  }

  private async appendNow(leaves: readonly ProjectTask[]): Promise<void> {
    const byMonth = new Map<string, ProjectTask[]>();
    for (const leaf of leaves) {
      const month = monthOf(leaf.finishedAt ?? leaf.updatedAt);
      byMonth.set(month, [...(byMonth.get(month) ?? []), leaf]);
    }
    if (byMonth.size === 0) return;
    await mkdir(this.dir, { recursive: true });
    for (const [month, list] of byMonth) {
      const name = `${month}.json`;
      const existing = (await this.months()).includes(name) ? await this.read(name) : [];
      const known = new Set(existing.map((task) => task.ref));
      await writeJsonAtomic(path.join(this.dir, name), [...existing, ...list.filter((task) => !known.has(task.ref))]);
    }
  }

  /** As folhas do arquivo vivo que já podem ir para cá. */
  static due(tasks: readonly ProjectTask[], now: number): ProjectTask[] {
    return tasks.filter((task) => isArchivable(task, now));
  }
}
