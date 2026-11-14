import {
  blockedLeaves,
  blockedText,
  isDeadlineAtRisk,
  isMaestroTask,
  isProjectTaskFinished,
  localDayKey,
  pendingForYou,
  workClock,
  type AgendaEvent,
  type ForYouItem,
  type MediaItem,
  type OfficeState,
  type PlatformToday,
  type Project,
  type ProjectTask,
  type Routine,
  type RoutinesToday,
  type Task,
  type TaskProgressInfo,
  type TodayAgendaItem,
  headlineAndSummary,
  maskSecrets,
  type TodayDone,
  type TodayNow,
  type TodayProject,
  type TodayRoutineSkipped,
  type TodayView,
  type TodayWaiting,
} from "@cyno/shared";

/**
 * O painel "Hoje" de um workspace, só com código (sem IA, sem token). Função pura: recebe tudo o que
 * lê (estado, projetos, o `RoutinesToday` já montado, o Para você, a agenda e a mídia) e devolve a
 * `TodayView`. As rotas, o painel e a ferramenta `get_today` usam esta mesma conta.
 */
export type TodayInput = {
  workspaceId: string;
  workspaceName?: string;
  now: Date;
  state: OfficeState;
  progress: Readonly<Record<string, TaskProgressInfo>>;
  projects: readonly Project[];
  /** O que as rotinas fizeram e farão hoje (`buildRoutinesToday`). */
  routines: RoutinesToday;
  /** As rotinas do workspace (só para as execuções puladas, que o `RoutinesToday` não lista). */
  routineList?: readonly Routine[];
  forYou: readonly ForYouItem[];
  /** Compromissos de hoje (já filtrados para o que interessa a este workspace). */
  agenda?: readonly AgendaEvent[];
  media?: readonly MediaItem[];
};

const MAX_NOW = 12;
const MAX_QUEUED = 5;
const MAX_DONE = 20;
const MAX_WAITING_OLDEST = 3;

const oneLine = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

const sameDay = (iso: string | undefined, dayKey: string): boolean => iso !== undefined && Number.isFinite(Date.parse(iso)) && localDayKey(new Date(iso)) === dayKey;

/** Compromissos "marcados" de hoje, em ordem de início. */
export function todayAgenda(events: readonly AgendaEvent[], names?: (workspace: string) => string | undefined): TodayAgendaItem[] {
  return events
    .filter((event) => event.status === "marcado")
    .sort((a, b) => a.start.localeCompare(b.start) || a.id.localeCompare(b.id))
    .map((event) => {
      const name = event.workspace ? names?.(event.workspace) : undefined;
      return {
        id: event.id,
        title: event.title,
        start: event.start,
        end: event.end,
        kind: event.kind,
        ...(event.workspace ? { workspace: event.workspace } : {}),
        ...(name ? { workspaceName: name } : {}),
        ...(event.link ? { link: event.link } : {}),
        ...(event.location ? { location: event.location } : {}),
      };
    });
}

/** O "Esperando você": a contagem e os mais antigos. */
export function todayWaiting(items: readonly ForYouItem[], agentName: (agentId: string) => string | undefined, projects: readonly Project[] = []): TodayWaiting {
  const pending = pendingForYou(items).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const rows = pending.map((item) => {
    const agent = agentName(item.agentId);
    return { id: item.id, type: item.type, title: item.title ?? ([item.where, item.to].filter(Boolean).join(" · ") || item.type), at: item.createdAt, ...(agent ? { agent } : {}) };
  });
  // Subtarefas travadas (a que elas esperam foi cancelada ou falhou) também esperam o dono (revisão 2, M5).
  for (const project of projects) {
    if (project.status !== "ativo" && project.status !== "pausado" && project.status !== "proposto") continue;
    for (const leaf of blockedLeaves(project)) {
      const agent = leaf.ownerId ? agentName(leaf.ownerId) : undefined;
      rows.push({ id: `${project.id}/${leaf.ref}`, type: "travada", title: `${leaf.title} (${project.title}): ${blockedText(project, leaf)}`, at: leaf.updatedAt, ...(agent ? { agent } : {}) });
    }
  }
  rows.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  return { count: rows.length, oldest: rows.slice(0, MAX_WAITING_OLDEST) };
}

/** A etapa atual (N de M), o próximo passo e o bloqueio de um projeto. */
function projectLine(project: Project, nowMs: number, day: string, agentName: (agentId: string) => string | undefined): TodayProject {
  const tasks = project.tasks.filter((task) => task.status !== "cancelada");
  const finished = tasks.filter(isProjectTaskFinished).length;
  const open = tasks.filter((task) => !isProjectTaskFinished(task));
  const rank = (task: ProjectTask): number => (task.status === "em_andamento" ? 0 : task.status === "esperando_voce" ? 1 : task.status === "falhou" ? 2 : task.status === "a_fazer" ? 3 : 4);
  const current = [...open].sort((a, b) => rank(a) - rank(b))[0];
  const workedMs = project.worked[day] ?? 0;
  const limitMs = project.pace?.hoursPerDay ? Math.round(project.pace.hoursPerDay * 3_600_000) : undefined;

  let stage: TodayProject["stage"];
  let next: string | undefined;
  let blocked: TodayProject["blocked"];
  if (current) {
    const step = current.steps[Math.min(current.current, current.steps.length - 1)];
    const agent = step ? agentName(step.agentId) : undefined;
    stage = { index: Math.min(finished + 1, tasks.length), total: tasks.length, title: current.title, ...(agent ? { agent } : {}) };
    const nextStep = current.steps[current.current + 1];
    if (nextStep) next = oneLine(`${nextStep.what}${agentName(nextStep.agentId) ? ` (${agentName(nextStep.agentId)})` : ""}`, 80);
    else next = open.find((task) => task !== current)?.title;
    if (current.blocked) blocked = { type: current.blocked.type, note: oneLine(current.blocked.note, 100) };
    else if (current.status === "esperando_voce") blocked = { type: "voce", note: current.note ? oneLine(current.note, 100) : "esperando você" };
    else if (current.status === "falhou") blocked = { type: "falha", note: oneLine(current.failure ?? "a etapa falhou", 100) };
  }
  const closing = (project.sprints ?? []).find((sprint) => sprint.status === "fechando");
  const movedToday = workedMs > 0 || sameDay(project.updatedAt, day);
  return {
    id: project.id,
    title: project.title,
    status: project.status,
    ...(stage ? { stage } : {}),
    ...(next ? { next } : {}),
    ...(blocked ? { blocked } : {}),
    ...(isDeadlineAtRisk(project, nowMs) ? { atRisk: true } : {}),
    ...(closing ? { deliveryWaiting: closing.name } : {}),
    ...(project.dueAt ? { dueAt: project.dueAt } : {}),
    workedMs,
    ...(limitMs !== undefined ? { limitMs } : {}),
    movedToday,
  };
}

/** A manchete e o resumo da entrega para o cartão de "Feito hoje" (vazio quando não há texto). */
function deliveryParts(text: string | undefined): { headline?: string; summary?: string } {
  const parts = headlineAndSummary(text);
  // O texto do agente pode ter segredo: a manchete e o resumo saem mascarados.
  return parts ? { headline: maskSecrets(parts.headline), ...(parts.summary ? { summary: maskSecrets(parts.summary) } : {}) } : {};
}

export function buildToday(input: TodayInput): TodayView {
  const { now, state, progress, routines } = input;
  const nowMs = now.getTime();
  const day = workClock(nowMs).day;
  const agentName = (agentId: string): string | undefined => state.agents.find((agent) => agent.id === agentId)?.name;
  const projectOf = (id: string | undefined): Project | undefined => (id ? input.projects.find((project) => project.id === id) : undefined);

  // Agora: o que está fazendo (e o que espera a vez, até 5).
  const rowOf = (task: Task, queued: boolean): TodayNow => {
    // A tarefa de uma rotina aparece com o nome da rotina (o projeto avulso dela é só um detalhe interno).
    const routine = task.routineId ? input.routineList?.find((candidate) => candidate.id === task.routineId) : undefined;
    const project = task.routineId ? undefined : projectOf(task.projectId ?? task.work?.projectId);
    const planTask = project && task.work ? project.tasks.find((candidate) => candidate.ref === task.work!.ref) : undefined;
    const info = progress[task.id];
    const agent = task.agentId ? agentName(task.agentId) : undefined;
    return {
      taskId: task.id,
      title: oneLine(routine?.title ?? planTask?.title ?? task.prompt.split("\n")[0] ?? task.id, 120),
      ...(agent ? { agent, agentId: task.agentId! } : {}),
      ...(!queued && info ? { progress: Math.min(1, Math.max(0, info.progress)), ...(info.message ? { message: oneLine(info.message, 140) } : {}) } : {}),
      since: task.updatedAt,
      queued,
      ...(project ? { projectId: project.id, projectTitle: project.title } : {}),
      ...(task.routineId ? { routineId: task.routineId } : {}),
    };
  };
  const real = state.tasks.filter((task) => !isMaestroTask(state, task));
  const doing = real.filter((task) => task.status === "in_progress").sort((a, b) => a.updatedAt.localeCompare(b.updatedAt)).slice(0, MAX_NOW).map((task) => rowOf(task, false));
  const queued = real.filter((task) => task.status === "queued").sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(0, MAX_QUEUED).map((task) => rowOf(task, true));
  const nowRows = [...doing, ...queued];
  const nowTaskIds = new Set(nowRows.map((row) => row.taskId));

  // Projetos que andam: abertos (ativos ou pausados) de verdade, e os que andaram hoje.
  const projects = input.projects
    .filter((project) => project.kind === "projeto" && project.origin !== "rotina" && (project.status === "ativo" || project.status === "pausado" || project.status === "ajustando"))
    .map((project) => projectLine(project, nowMs, day, agentName))
    .sort((a, b) => Number(b.movedToday) - Number(a.movedToday) || Number(!!b.blocked) - Number(!!a.blocked) || a.title.localeCompare(b.title));

  // Rotinas: sem repetir o que já está em "Agora".
  const skipped: TodayRoutineSkipped[] = [];
  for (const routine of input.routineList ?? []) {
    for (const run of routine.lastRuns) {
      if (run.outcome !== "pulada" || !sameDay(run.startedAt, day)) continue;
      const schedule = routine.schedules.find((candidate) => candidate.id === run.scheduleId);
      skipped.push({ routineId: routine.id, title: routine.title, at: run.startedAt, ...(schedule?.label ? { scheduleLabel: schedule.label } : {}), reason: run.skipReason ?? "pulada" });
    }
  }
  skipped.sort((a, b) => a.at.localeCompare(b.at));

  const waiting = todayWaiting(input.forYou, agentName, input.projects);

  // Feito hoje: projetos concluídos, etapas concluídas de projetos ainda abertos, tarefas avulsas e mídia.
  const done: TodayDone[] = [];
  for (const project of input.projects) {
    if (project.origin === "rotina") continue;
    if (project.status === "concluido" && sameDay(project.finishedAt, day)) {
      const last = [...project.tasks].reverse().find((task) => task.status === "concluida" && !task.skipped && task.result?.trim());
      done.push({ kind: project.kind === "projeto" ? "projeto" : "tarefa", id: project.id, title: project.title, at: project.finishedAt!, ...deliveryParts(last?.result ?? project.summary) });
      continue;
    }
    if (project.kind !== "projeto") continue;
    for (const task of project.tasks) {
      if (task.status === "concluida" && !task.skipped && sameDay(task.finishedAt, day)) done.push({ kind: "etapa", id: `${project.id}/${task.ref}`, title: task.title, at: task.finishedAt!, projectId: project.id, projectTitle: project.title, ...deliveryParts(task.result) });
    }
  }
  for (const media of input.media ?? []) {
    if (sameDay(media.createdAt, day) && (media.origin === "html" || media.origin === "arquivo")) done.push({ kind: "midia", id: media.id, title: media.title || media.fileName, at: media.createdAt, mediaId: media.id });
  }
  done.sort((a, b) => b.at.localeCompare(a.at));

  return {
    workspace: input.workspaceId,
    ...(input.workspaceName ? { workspaceName: input.workspaceName } : {}),
    day,
    now: nowRows,
    projects,
    routines: {
      ran: routines.ran.filter((run) => run.outcome !== "pulada").map((run) => ({ routineId: run.routineId, title: run.title, at: run.at, ...(run.summary ? { summary: run.summary } : {}), ...(run.scheduleLabel ? { scheduleLabel: run.scheduleLabel } : {}), ...(run.agent ? { agent: run.agent } : {}), ...(run.endedAt ? { endedAt: run.endedAt } : {}), outcome: run.outcome as "ok" | "falhou" })),
      running: routines.running.filter((run) => !run.taskId || !nowTaskIds.has(run.taskId)).map((run) => ({ routineId: run.routineId, title: run.title, startedAt: run.startedAt, ...(run.scheduleLabel ? { scheduleLabel: run.scheduleLabel } : {}), ...(run.agent ? { agent: run.agent } : {}), ...(run.taskId ? { taskId: run.taskId } : {}) })),
      upcoming: routines.upcoming.map((slot) => ({ routineId: slot.routineId, title: slot.title, at: slot.at, label: slot.label, ...(slot.agent ? { agent: slot.agent } : {}) })),
      skipped,
    },
    changes: routines.changes.map((change) => ({ routineId: change.routineId, title: change.title, item: change.item, ...(change.from ? { from: change.from } : {}), to: change.to, text: change.text, at: change.at, ...(change.alert ? { alert: true } : {}) })),
    goals: routines.goals.map((goal) => ({ routineId: goal.routineId, title: goal.title, done: goal.done, target: goal.target, period: goal.period, pace: goal.pace, ...(goal.blocked ? { blocked: goal.blocked } : {}) })),
    agenda: todayAgenda(input.agenda ?? []),
    waiting,
    waitingForYou: waiting.count,
    done: done.slice(0, MAX_DONE),
    at: now.toISOString(),
  };
}

/** A plataforma: os blocos por workspace, os compromissos do dono (todos) e a soma do que espera você. */
export function buildPlatformToday(views: readonly TodayView[], agenda: readonly TodayAgendaItem[], now: Date): PlatformToday {
  const oldest = views
    .flatMap((view) => view.waiting.oldest.map((item) => ({ ...item, workspace: view.workspace, ...(view.workspaceName ? { workspaceName: view.workspaceName } : {}) })))
    .sort((a, b) => a.at.localeCompare(b.at))
    .slice(0, MAX_WAITING_OLDEST);
  return {
    day: workClock(now.getTime()).day,
    at: now.toISOString(),
    workspaces: [...views],
    agenda: [...agenda],
    waiting: { count: views.reduce((sum, view) => sum + view.waiting.count, 0), oldest },
  };
}
