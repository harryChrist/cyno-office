import {
  activeSprint,
  assigneesOf,
  childrenOf,
  isActiveTaskStatus,
  sprintDayOf,
  sprintProgress,
  sprintsInOrder,
  statusOf,
  treeProgress,
  pendingForYou,
  projectProgress,
  SENT_REQUEST_STATE_LABELS,
  type ForYouItem,
  type MediaItem,
  type Project,
  type SentRequest,
  type SentRequestState,
  type SentRequestView,
  type Task,
} from "@cyno/shared";
import { shorten } from "../../util/text";
import { closingSprints } from "../../workspace/projects/sprint-service";

/** O que o estado de um pedido enviado lê do workspace dele (tirado dos serviços na hora; nada acorda). */
export type RequestSnapshot = {
  workspaceName: string;
  project: Project | undefined;
  /** A tarefa do Maestro (o pedido) e as subtarefas dele. */
  tasks: Task[];
  forYou: ForYouItem[];
  media: MediaItem[];
  agentName: (agentId: string) => string | undefined;
};

/** Ids de tarefa que pertencem ao projeto (o pedido e as subtarefas das etapas). */
function taskIdsOf(project: Project | undefined, requestId: string): Set<string> {
  const ids = new Set<string>([requestId]);
  for (const task of project?.tasks ?? []) for (const step of task.steps) if (step.taskId) ids.add(step.taskId);
  return ids;
}

/** Itens do "Para você" que ESTE pedido segura (o plano, uma aprovação, uma pergunta). */
export function waitingItemsOf(record: Pick<SentRequest, "projectId">, snap: Pick<RequestSnapshot, "project" | "forYou">): ForYouItem[] {
  const ids = taskIdsOf(snap.project, record.projectId);
  return pendingForYou(snap.forYou).filter((item) => item.projectId === record.projectId || (item.taskId !== undefined && ids.has(item.taskId)));
}

/** O estado do pedido, como o dono lê. */
export function requestState(record: Pick<SentRequest, "projectId">, snap: Pick<RequestSnapshot, "project" | "tasks" | "forYou">): SentRequestState {
  const request = snap.tasks.find((task) => task.id === record.projectId);
  const project = snap.project;
  if (request && !isActiveTaskStatus(request.status)) {
    if (request.status === "done") return "concluido";
    return request.outcome === "cancelled" ? "cancelado" : "falhou";
  }
  if (project?.status === "concluido") return "concluido";
  if (project?.status === "cancelado") return "cancelado";
  if (waitingItemsOf(record, { project, forYou: snap.forYou }).length > 0 || request?.status === "waiting_approval") return "esperando_voce";
  if (project?.status === "pausado") return "pausado";
  if (!project || project.tasks.length === 0) return "enviado";
  return "andando";
}

/** A etapa atual em texto curto ("T2 Revisão · Crivo"), quando há. */
function stageOf(project: Project | undefined, agentName: RequestSnapshot["agentName"]): string | undefined {
  const task = project?.tasks.find((candidate) => candidate.status === "em_andamento" || candidate.status === "esperando_voce") ?? project?.tasks.find((candidate) => candidate.status === "a_fazer");
  if (!task) return undefined;
  const step = task.steps[task.current];
  const who = step ? agentName(step.agentId) : undefined;
  return `${shorten(task.title, 60)}${who ? ` · ${who}` : ""}`;
}

/** "Sprint 2 · day 3 of 7" da sprint ativa do projeto (o relógio é o de agora). */
function sprintLabel(project: Project | undefined, nowMs: number): string | undefined {
  const sprint = project ? activeSprint(project) : undefined;
  if (!sprint) return undefined;
  const { day, days } = sprintDayOf(sprint, nowMs);
  return `${sprint.name} · day ${day} of ${days}`;
}

export function requestView(record: SentRequest, snap: RequestSnapshot, nowMs: number = Date.now()): SentRequestView {
  const state = requestState(record, snap);
  const progress = projectProgress(snap.project ?? { tasks: [] });
  const closed = snap.project?.finishedAt ?? snap.tasks.find((task) => task.id === record.projectId && !isActiveTaskStatus(task.status))?.updatedAt;
  const stage = stageOf(snap.project, snap.agentName);
  const sprint = sprintLabel(snap.project, nowMs);
  const delivery = snap.project ? closingSprints(snap.project)[0]?.name : undefined;
  return {
    projectId: record.projectId,
    workspace: record.workspace,
    workspaceName: snap.workspaceName,
    title: snap.project?.title ?? record.title,
    address: record.address,
    sentAt: record.sentAt,
    state,
    tasksDone: progress.done,
    tasksTotal: progress.total,
    waitingForYou: waitingItemsOf(record, snap).length,
    ...(sprint && state !== "concluido" && state !== "cancelado" && state !== "falhou" ? { sprint } : {}),
    ...(delivery ? { deliveryWaiting: delivery } : {}),
    ...(stage && state !== "concluido" && state !== "cancelado" && state !== "falhou" ? { stage } : {}),
    ...(snap.project?.dueAt ? { dueAt: snap.project.dueAt } : {}),
    ...(closed && (state === "concluido" || state === "cancelado" || state === "falhou") ? { closedAt: closed } : {}),
  };
}

/** Uma linha por pedido (para `list_sent_requests` e o delta do contexto do Cyno). */
export function requestLine(view: SentRequestView): string {
  const tasks = view.tasksTotal > 0 ? ` · ${view.tasksDone}/${view.tasksTotal} tasks` : "";
  const waiting = view.waitingForYou > 0 ? ` · waiting for the owner (${view.waitingForYou})` : "";
  return `- ${view.projectId} → ${view.workspace}: "${shorten(view.title, 80)}" — ${SENT_REQUEST_STATE_LABELS[view.state]}${tasks}${waiting}${view.stage ? ` · now: ${view.stage}` : ""}${view.sprint ? ` · ${view.sprint}` : ""}${view.deliveryWaiting ? ` · ${view.deliveryWaiting} delivery waits for the owner's OK` : ""}`;
}

const TASK_STATUS_EN: Record<string, string> = { a_fazer: "to do", em_andamento: "in progress", esperando_voce: "waiting for the owner", concluida: "done", falhou: "failed", cancelada: "cancelled", bloqueada: "blocked" };

/** O detalhe de um pedido para o Cyno (`get_request_status`): projeto, tarefas, bloqueios, o que espera o dono e as entregas. */
export function requestDetail(view: SentRequestView, snap: RequestSnapshot): string {
  const { project } = snap;
  const lines = [
    `Request ${view.projectId} "${view.title}" → workspace ${view.workspace} (${view.workspaceName}): ${SENT_REQUEST_STATE_LABELS[view.state]}${view.tasksTotal > 0 ? `, ${view.tasksDone}/${view.tasksTotal} tasks done` : ""}.`,
    `Sent ${view.sentAt.slice(0, 16).replace("T", " ")}${view.dueAt ? ` · due ${view.dueAt.slice(0, 10)}` : ""}${project && project.priority !== "normal" ? ` · priority ${project.priority}` : ""}${project?.status ? ` · project status: ${project.status}` : ""}.`,
  ];
  if (!project || project.tasks.length === 0) {
    lines.push("The Maestro has not split the work into tasks yet (it receives the brief and only distributes).");
  } else {
    const sprints = sprintsInOrder(project);
    if (sprints.length > 0) {
      lines.push("Sprints:");
      for (const sprint of sprints) {
        const progress = sprintProgress(project, sprint.id);
        const summary = sprint.status === "fechando" && sprint.summary ? `; delivery waits for the owner's OK (${sprint.summary.done.length} done, ${sprint.summary.carried.length} carried over)` : "";
        lines.push(`- ${sprint.name} [${sprint.status}] ${sprint.startAt.slice(0, 10)} → ${sprint.endAt.slice(0, 10)}; ${progress.done}/${progress.total} done${sprint.goal ? `; goal: ${shorten(sprint.goal, 100)}` : ""}${summary}`);
      }
    }
    lines.push("Tasks:");
    const walk = (task: Project["tasks"][number], depth: number) => {
      const pad = "  ".repeat(depth);
      const kids = childrenOf(project, task.ref);
      if (task.group || kids.length > 0) {
        const progress = treeProgress(project, task.ref);
        const state = statusOf(project, task);
        lines.push(`${pad}- ${task.ref} «${shorten(task.title, 80)}»${task.group ? " (deliverable)" : ""} [${TASK_STATUS_EN[state] ?? state}] ${progress.done}/${progress.total}; ${assigneesOf(project, task).map((id) => snap.agentName(id) ?? id).join(", ")}`);
        for (const child of kids) walk(child, depth + 1);
        return;
      }
      const chain = task.steps.map((step, index) => `${snap.agentName(step.agentId) ?? step.agentId}${step.status === "feita" ? " ✓" : step.status === "falhou" ? " ✗" : index === task.current && step.status === "em_andamento" ? " …" : ""}`).join(" → ");
      const extra = task.failure ? ` — failure: ${shorten(task.failure, 160)}` : task.blocked ? ` — blocked (${task.blocked.type}): ${shorten(task.blocked.note ?? "", 120)}` : task.note ? ` — ${shorten(task.note, 120)}` : "";
      const sprint = task.sprintId ? `; ${sprints.find((candidate) => candidate.id === task.sprintId)?.name ?? task.sprintId}` : "";
      lines.push(`${pad}- ${task.ref} «${shorten(task.title, 80)}» [${task.skipped ? "skipped" : (TASK_STATUS_EN[task.status] ?? task.status)}] ${chain}${task.dependsOn.length > 0 ? `; depends on ${task.dependsOn.join(", ")}` : ""}${sprint}${extra}`);
    };
    for (const top of childrenOf(project)) walk(top, 0);
  }
  const waiting = waitingItemsOf(view, snap);
  const request = snap.tasks.find((task) => task.id === view.projectId);
  if (waiting.length > 0) {
    lines.push("Waiting for the owner (they decide in the Para você page of that workspace):");
    for (const item of waiting) lines.push(`- ${item.id} [${item.type}] ${shorten(item.title ?? item.where ?? item.type, 100)}${item.why ? ` — ${shorten(item.why, 120)}` : ""}`);
  } else if (request?.status === "waiting_approval" && request.waiting) {
    lines.push(`Waiting for the owner: ${request.waiting}.`);
  }
  const done = (project?.tasks ?? []).filter((task) => task.status === "concluida" && !task.skipped);
  const deliveries: string[] = [];
  for (const task of done) {
    const result = snap.tasks.find((candidate) => candidate.id === task.steps.at(-1)?.taskId)?.result;
    if (result) deliveries.push(`- ${task.ref} «${shorten(task.title, 60)}»: ${shorten(result.replace(/\s+/g, " "), 900)}`);
  }
  for (const item of snap.media) deliveries.push(`- media ${item.id} (${item.kind}) "${shorten(item.title, 60)}" [${item.status}]${item.publishedUrl ? ` ${item.publishedUrl}` : ` /api/w/${view.workspace}/media/${item.id}/file`}`);
  if (deliveries.length > 0) lines.push("Deliveries:", ...deliveries);
  if (request && !isActiveTaskStatus(request.status) && request.result) lines.push(`Final answer of the Maestro (what the owner reads): ${shorten(request.result.replace(/\s+/g, " "), 1800)}`);
  lines.push(`Where the owner sees it: Trabalho page of ${view.workspace} (#/${view.workspace}/trabalho, project ${view.projectId}).`);
  return lines.join("\n");
}
