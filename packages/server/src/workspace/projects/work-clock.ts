import { nextWorkDayStart, pruneWorked, workClock, workDayStart, type Project, type Task } from "@cyno/shared";

export type WorkClockDeps = {
  /** Projetos do workspace (a mesma lista em memória do ProjectService). */
  projects: () => readonly Project[];
  /** Grava os projetos que ganharam horas (e publica `project:upserted`). */
  save: (changed: Project[]) => void;
  now: () => number;
};

/** Fatia aberta: a tarefa está `in_progress`; `since` = até onde as horas já foram somadas. */
type Slice = { projectId: string; since: number };

/**
 * Relógio de horas dos projetos: soma em `project.worked[dia local]` (milissegundos, dia no fuso
 * America/Sao_Paulo) o tempo em que as etapas do projeto estiveram `in_progress`.
 * - Abre uma fatia quando a Task entra em `in_progress` e fecha quando ela sai (esperar aprovação,
 *   voltar para a fila, terminar, falhar ou ser cancelada): esperar o usuário NÃO conta.
 * - Uma fatia que atravessa a meia-noite é partida entre os dois dias.
 * - `tick` (a cada minuto) soma o parcial das fatias abertas, para o contador "0,5/1 h hoje" andar ao vivo.
 * - Poda `worked` em 90 dias.
 * Só as Tasks de etapa (`work`) contam; o registro do pedido do Maestro não.
 */
export class WorkClock {
  private readonly open = new Map<string, Slice>();

  constructor(private readonly deps: WorkClockDeps) {}

  /** Boot: abre uma fatia para cada etapa que já está em andamento. */
  start(tasks: readonly Task[]): void {
    for (const task of tasks) this.observe(task);
  }

  /** Uma Task mudou (evento `task:upserted`). */
  observe(task: Pick<Task, "id" | "status" | "work">): void {
    if (!task.work) return;
    if (task.status === "in_progress") {
      if (!this.open.has(task.id)) this.open.set(task.id, { projectId: task.work.projectId, since: this.deps.now() });
      return;
    }
    if (this.open.has(task.id)) this.close(task.id);
  }

  /** Soma o parcial de todas as fatias abertas (o tick de 1 minuto). */
  tick(): void {
    const changed = new Set<Project>();
    for (const slice of this.open.values()) {
      const project = this.flush(slice);
      if (project) changed.add(project);
    }
    if (changed.size > 0) this.deps.save([...changed]);
  }

  /** Quantas fatias estão abertas agora (por projeto, se informado). */
  openCount(projectId?: string): number {
    let count = 0;
    for (const slice of this.open.values()) if (!projectId || slice.projectId === projectId) count += 1;
    return count;
  }

  /** Milissegundos de HOJE já corridos nas fatias abertas do projeto e ainda não somados em `worked`. */
  pending(projectId: string): number {
    const now = this.deps.now();
    const today = workDayStart(now);
    let ms = 0;
    for (const slice of this.open.values()) if (slice.projectId === projectId) ms += Math.max(0, now - Math.max(slice.since, today));
    return ms;
  }

  private close(taskId: string): void {
    const slice = this.open.get(taskId);
    if (!slice) return;
    const project = this.flush(slice);
    this.open.delete(taskId);
    if (project) this.deps.save([project]);
  }

  /** Soma `since -> agora` em `worked` (partindo à meia-noite); devolve o projeto se mudou. */
  private flush(slice: Slice): Project | undefined {
    const now = this.deps.now();
    const project = this.deps.projects().find((candidate) => candidate.id === slice.projectId);
    let cursor = slice.since;
    slice.since = Math.max(slice.since, now);
    if (!project || now <= cursor) return undefined;
    let added = 0;
    while (cursor < now) {
      const end = Math.min(now, nextWorkDayStart(cursor));
      const day = workClock(cursor).day;
      project.worked[day] = (project.worked[day] ?? 0) + (end - cursor);
      added += end - cursor;
      cursor = end;
    }
    pruneWorked(project.worked, now);
    if (added > 0) project.updatedAt = new Date(now).toISOString();
    return added > 0 ? project : undefined;
  }
}
