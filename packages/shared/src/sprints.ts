/**
 * Sprint: a dimensão de TEMPO de um projeto (não de capacidade). O projeto guarda a lista em
 * `Project.sprints`; a tarefa-folha aponta para uma por `sprintId`. Esta fatia só define os tipos
 * (o serviço de sprints, o agendador por sprint e o resumo de fechamento vêm nas próximas).
 *
 * planejada = ainda não começou; ativa = é a sprint do momento (só uma por vez); fechando = passou
 * do fim, a sobra já foi para a próxima e o resumo espera o OK do dono; fechada = resumo aprovado.
 */
import type { Project, ProjectTask } from "./projects";
import { clockLabel, workClock } from "./projects";
import { assigneesOf, leavesOf } from "./task-tree";

export const SPRINT_STATUSES =["planejada", "ativa", "fechando", "fechada"] as const;
export type SprintStatus = (typeof SPRINT_STATUSES)[number];

/** O resumo de entrega de uma sprint (montado por código quando ela fecha). */
export type SprintSummary = {
  builtAt: string;
  /** `links`: endereços citados no resultado da tarefa; `taskIds`: as tarefas do runner das etapas (a tela acha a mídia por elas). */
  done: { ref: string; title: string; assignees: string[]; finishedAt: string; links?: string[]; taskIds?: string[] }[];
  /** `to` = id da sprint que recebeu a sobra, ou null = sem sprint. */
  carried: { ref: string; title: string; to: string | null }[];
  /** As que falharam na sprint (mesmo as que já passaram adiante e também estão em `carried`). */
  failed: { ref: string; title: string; reason?: string }[];
  skipped: string[];
  byAgent: Record<string, { done: number; total: number }>;
  workedMs: number;
  /** Canceladas na sprint (não contam como entrega nem como sobra). */
  cancelled?: { ref: string; title: string }[];
  /** Tarefas da sprint que o dono recusou ao menos uma vez (retrabalho), com o último motivo. */
  reworked?: { ref: string; title: string; count: number; reason?: string }[];
  /** Parágrafo opcional escrito por IA (padrão ausente). */
  text?: string;
  /** Quem aprovou o resumo (a sprint vira "fechada") e quando. */
  decidedBy?: "usuario" | "automatico";
  decidedAt?: string;
  /** O dono devolveu a entrega: o motivo e as tarefas (`ref`) que voltaram como retrabalho. */
  returned?: { reason: string; refs: string[] };
};

export type Sprint = {
  /** "S1", "S2"… (único no projeto). */
  id: string;
  /** "Sprint 1 · Login". */
  name: string;
  /** Objetivo, 1 ou 2 frases. */
  goal?: string;
  /** ISO, livres. */
  startAt: string;
  endAt: string;
  order: number;
  status: SprintStatus;
  openedAt?: string;
  closedAt?: string;
  summary?: SprintSummary;
  /** Cartão do resumo em Aprovações. */
  forYouId?: string;
};

// ---------- Regras de tempo (funções puras; o servidor e a tela usam as mesmas) ----------

type SprintHost = { sprints?: Sprint[] };

/** As sprints na ordem (`order`; empate pela posição na lista). */
export function sprintsInOrder(project: SprintHost): Sprint[] {
  return (project.sprints ?? [])
    .map((sprint, index) => ({ sprint, index }))
    .sort((a, b) => a.sprint.order - b.sprint.order || a.index - b.index)
    .map(({ sprint }) => sprint);
}

/** A sprint ativa (só pode haver uma). */
export function activeSprint(project: SprintHost): Sprint | undefined {
  return (project.sprints ?? []).find((sprint) => sprint.status === "ativa");
}

/** O projeto trabalha por sprints (tem ao menos uma)? Sem sprints, todas as tarefas são elegíveis. */
export function hasSprints(project: SprintHost): boolean {
  return (project.sprints ?? []).length > 0;
}

/** A sprint que recebe a sobra de `sprint`: a próxima planejada por `order` (nenhuma = sem sprint). */
export function nextSprintAfter(project: SprintHost, sprint: Pick<Sprint, "id" | "order">): Sprint | undefined {
  return sprintsInOrder(project).find((candidate) => candidate.id !== sprint.id && candidate.status === "planejada" && candidate.order > sprint.order);
}

/** Quando a sprint ativa acaba ou a próxima planejada começa (o agendador acorda aí); undefined = nada à vista. */
export function nextSprintBoundary(project: SprintHost): number | undefined {
  const times: number[] = [];
  for (const sprint of project.sprints ?? []) {
    if (sprint.status !== "ativa" && sprint.status !== "planejada") continue;
    const at = Date.parse(sprint.status === "ativa" ? sprint.endAt : sprint.startAt);
    if (!Number.isNaN(at)) times.push(at);
  }
  return times.length > 0 ? Math.min(...times) : undefined;
}

/** "18/11" a partir de um ISO (dia no fuso do trabalho, o mesmo do agendador). */
export function sprintDay(iso: string): string {
  const { day } = workClock(Date.parse(iso));
  return `${day.slice(8, 10)}/${day.slice(5, 7)}`;
}

/**
 * Por que uma folha não anda por causa da sprint (a nota que a tarefa mostra); undefined = liberada.
 * Projeto sem sprints: tudo liberado. Em projeto com sprints, só anda a folha da sprint ativa; quem já
 * começou (`em_andamento`) termina onde está, mesmo que a sprint tenha fechado (nada é interrompido).
 */
export function sprintHold(project: SprintHost, task: Pick<ProjectTask, "sprintId" | "status">): { note: string; wakeAt?: number } | undefined {
  if (!hasSprints(project)) return undefined;
  if (task.status === "em_andamento") return undefined;
  const sprint = task.sprintId ? project.sprints!.find((candidate) => candidate.id === task.sprintId) : undefined;
  if (!sprint) return { note: "Sem sprint (backlog): ponha numa sprint para começar" };
  if (sprint.status === "ativa") return undefined;
  if (sprint.status === "planejada") {
    const start = Date.parse(sprint.startAt);
    return { note: `${sprint.name} começa em ${sprintDay(sprint.startAt)} às ${clockLabel(workClock(start).minutes)}`, ...(Number.isNaN(start) ? {} : { wakeAt: start }) };
  }
  return { note: `${sprint.name} já fechou: mande a tarefa para outra sprint` };
}

/** Dia atual da sprint e o total ("dia 3 de 7"); fora do intervalo fica preso nas pontas. */
export function sprintDayOf(sprint: Pick<Sprint, "startAt" | "endAt">, now: number): { day: number; days: number } {
  const start = Date.parse(sprint.startAt);
  const end = Date.parse(sprint.endAt);
  const DAY = 86_400_000;
  const days = Math.max(1, Math.ceil((end - start) / DAY));
  const day = Math.min(days, Math.max(1, Math.floor((now - start) / DAY) + 1));
  return { day, days };
}

/** Os endereços (http/https) que o resultado de uma tarefa cita, sem repetir, no máximo 5. */
export function linksIn(text: string | undefined): string[] {
  const found = (text ?? "").match(/https?:\/\/[^\s<>"')\]]+/g) ?? [];
  return [...new Set(found.map((link) => link.replace(/[.,;:!?]+$/, "")))].slice(0, 5);
}

/**
 * O resumo de uma sprint, calculado por código a partir das folhas (o fechamento com OK do dono, na
 * fatia seguinte, usa isto; aqui só fica calculável). `carried`: o que saiu dela (`to` = sprint que
 * recebeu, null = sem sprint).
 */
export function buildSprintSummary(project: Pick<Project, "tasks" | "sprints"> & { worked?: Record<string, number> }, sprintId: string, now: number): SprintSummary {
  const sprint = (project.sprints ?? []).find((candidate) => candidate.id === sprintId);
  const byAgent: SprintSummary["byAgent"] = {};
  const done: SprintSummary["done"] = [];
  const carried: SprintSummary["carried"] = [];
  const failed: SprintSummary["failed"] = [];
  const skipped: string[] = [];
  const cancelled: NonNullable<SprintSummary["cancelled"]> = [];
  const reworked: NonNullable<SprintSummary["reworked"]> = [];
  for (const task of leavesOf(project)) {
    if (task.carriedFrom === sprintId && task.sprintId !== sprintId) {
      carried.push({ ref: task.ref, title: task.title, to: task.sprintId ?? null });
      // Falhou e passou adiante: continua contando como falha da sprint (o motivo some quando a tarefa recomeça).
      if (task.status === "falhou") failed.push({ ref: task.ref, title: task.title, ...(task.failure ? { reason: task.failure } : {}) });
      continue;
    }
    if (task.sprintId !== sprintId) continue;
    if (task.status === "concluida" && task.skipped) {
      skipped.push(task.ref);
      continue;
    }
    if (task.status === "cancelada") {
      cancelled.push({ ref: task.ref, title: task.title });
      continue;
    }
    const agents = assigneesOf(project, task);
    for (const agent of agents) {
      const entry = (byAgent[agent] ??= { done: 0, total: 0 });
      entry.total += 1;
      if (task.status === "concluida") entry.done += 1;
    }
    const reworks = task.rework?.count ?? 0;
    if (reworks > 0) reworked.push({ ref: task.ref, title: task.title, count: reworks, ...(task.rework?.last?.reason ? { reason: task.rework.last.reason } : {}) });
    if (task.status === "concluida") {
      const links = linksIn(task.result);
      const taskIds = task.steps.flatMap((step) => (step.taskId ? [step.taskId] : []));
      done.push({ ref: task.ref, title: task.title, assignees: agents, finishedAt: task.finishedAt ?? new Date(now).toISOString(), ...(links.length > 0 ? { links } : {}), ...(taskIds.length > 0 ? { taskIds } : {}) });
    }
    else if (task.status === "falhou") failed.push({ ref: task.ref, title: task.title, ...(task.failure ? { reason: task.failure } : {}) });
  }
  const first = sprint ? workClock(Date.parse(sprint.startAt)).day : "";
  const last = sprint ? workClock(Date.parse(sprint.endAt)).day : "";
  const workedMs = sprint ? Object.entries(project.worked ?? {}).reduce((sum, [day, ms]) => (day >= first && day <= last ? sum + ms : sum), 0) : 0;
  return { builtAt: new Date(now).toISOString(), done, carried, failed, skipped, byAgent, workedMs, ...(cancelled.length > 0 ? { cancelled } : {}), ...(reworked.length > 0 ? { reworked } : {}) };
}
