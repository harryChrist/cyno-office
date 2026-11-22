import { activeSprint, buildSprintSummary, hasSprints, leavesOf, nextSprintAfter, PROJECT_LIMITS, sprintDay, sprintsInOrder, type Project, type ProjectTask, type Sprint } from "@cyno/shared";
import { HttpError } from "../../platform/http/errors";

/**
 * Ciclo das sprints de um projeto: funções que mexem no `Project` em memória (o `ProjectService` grava,
 * publica, registra na Atividade e põe a fila para andar). A sprint é só a dimensão de TEMPO: quem anda
 * é a folha da sprint ativa. Erros em português (a tela mostra).
 *
 * Estados: planejada -> ativa -> fechando -> fechada. O fechamento tem duas fases: na hora, por código,
 * a sobra vai para a sprint seguinte (a rotina não para se o dono demorar), o resumo de entrega é montado
 * (`buildSprintSummary`) e a sprint fica "fechando"; quando o dono aprova o resumo (ou o Automático
 * aprova), vira "fechada". Devolver a entrega também fecha, e cria tarefas de retrabalho na sprint ativa.
 */

const WEEK_MS = 7 * 86_400_000;

/** O que aconteceu (vira uma linha da Atividade). */
export type SprintEvent = { action: string; summary: string; data: Record<string, unknown> };

const iso = (ms: number) => new Date(ms).toISOString();

export function requireSprint(project: Pick<Project, "sprints">, id: string): Sprint {
  const sprint = project.sprints?.find((candidate) => candidate.id === id);
  if (!sprint) throw new HttpError(404, `A sprint "${id}" não existe neste projeto`);
  return sprint;
}

function nextSprintId(project: Pick<Project, "sprints">): string {
  let max = 0;
  for (const sprint of project.sprints ?? []) {
    const match = /^S(\d+)$/.exec(sprint.id);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `S${max + 1}`;
}

/** Cria uma sprint planejada no fim. Sem datas: começa onde a última acaba (ou agora) e dura uma semana. */
export function addSprint(project: Project, input: { name?: string; goal?: string; startAt?: string; endAt?: string }, nowMs: number): Sprint {
  const sprints = (project.sprints ??= []);
  if (sprints.length >= PROJECT_LIMITS.sprints) throw new HttpError(400, `O projeto aceita até ${PROJECT_LIMITS.sprints} sprints`);
  const last = sprintsInOrder(project).at(-1);
  const lastEnd = last ? Date.parse(last.endAt) : NaN;
  const start = input.startAt ? Date.parse(input.startAt) : Number.isNaN(lastEnd) ? nowMs : lastEnd;
  const end = input.endAt ? Date.parse(input.endAt) : start + WEEK_MS;
  if (Number.isNaN(start) || Number.isNaN(end)) throw new HttpError(400, "Data inválida");
  if (end <= start) throw new HttpError(400, "O fim da sprint precisa ser depois do começo");
  const id = nextSprintId(project);
  const sprint: Sprint = {
    id,
    name: input.name?.trim().replace(/\s+/g, " ") || `Sprint ${id.slice(1)}`,
    ...(input.goal?.trim() ? { goal: input.goal.trim() } : {}),
    startAt: iso(start),
    endAt: iso(end),
    order: (last?.order ?? 0) + 1,
    status: "planejada",
  };
  sprints.push(sprint);
  return sprint;
}

/** Muda nome, objetivo (`null` limpa) e datas de uma sprint que ainda não fechou. */
export function editSprint(project: Project, id: string, patch: { name?: string; goal?: string | null; startAt?: string; endAt?: string }): Sprint {
  const sprint = requireSprint(project, id);
  if (sprint.status === "fechada" || sprint.status === "fechando") throw new HttpError(409, "A sprint já fechou: não dá para mudar");
  const start = patch.startAt !== undefined ? Date.parse(patch.startAt) : Date.parse(sprint.startAt);
  const end = patch.endAt !== undefined ? Date.parse(patch.endAt) : Date.parse(sprint.endAt);
  if (Number.isNaN(start) || Number.isNaN(end)) throw new HttpError(400, "Data inválida");
  if (end <= start) throw new HttpError(400, "O fim da sprint precisa ser depois do começo");
  if (patch.name !== undefined) sprint.name = patch.name.trim().replace(/\s+/g, " ");
  if (patch.goal !== undefined) {
    if (patch.goal?.trim()) sprint.goal = patch.goal.trim();
    else delete sprint.goal;
  }
  sprint.startAt = iso(start);
  sprint.endAt = iso(end);
  return sprint;
}

/** Folhas que apontam para a sprint (o que "vazia" significa). */
function tasksIn(project: Project, id: string) {
  return leavesOf(project).filter((task) => task.sprintId === id);
}

/** Apaga a sprint planejada ou vazia; as folhas dela voltam para "sem sprint". */
export function removeSprint(project: Project, id: string): { freed: number } {
  const sprint = requireSprint(project, id);
  const inside = tasksIn(project, id);
  if (sprint.status === "fechando") throw new HttpError(409, "A sprint fechou e o resumo espera o seu OK em Aprovações: decida antes de apagar");
  if (sprint.status !== "planejada" && inside.length > 0) throw new HttpError(409, sprint.status === "ativa" ? "A sprint ativa tem tarefas: feche-a antes de apagar" : "A sprint já fechou e guarda o histórico das tarefas: não dá para apagar");
  for (const task of inside) delete task.sprintId;
  project.sprints = project.sprints!.filter((candidate) => candidate.id !== id);
  return { freed: inside.length };
}

/** Reordena: `ids` é a lista completa na ordem nova (a sobra de uma sprint que fecha vai para a seguinte nessa ordem). */
export function reorderSprints(project: Project, ids: string[]): void {
  const have = (project.sprints ?? []).map((sprint) => sprint.id);
  if (ids.length !== have.length || new Set(ids).size !== ids.length || !ids.every((id) => have.includes(id))) throw new HttpError(400, "A lista precisa trazer todas as sprints do projeto, uma vez cada");
  ids.forEach((id, index) => {
    requireSprint(project, id).order = index + 1;
  });
}

/** A sprint nova que uma tarefa criada agora herda: a preferida (se ainda aberta) ou a ativa; sem sprints no projeto, nenhuma. */
export function inheritSprint(project: Pick<Project, "sprints">, preferredId?: string): string | undefined {
  if (!hasSprints(project)) return undefined;
  const preferred = preferredId ? project.sprints!.find((sprint) => sprint.id === preferredId) : undefined;
  if (preferred && (preferred.status === "planejada" || preferred.status === "ativa")) return preferred.id;
  return activeSprint(project)?.id;
}

function open(sprint: Sprint, nowMs: number): SprintEvent {
  sprint.status = "ativa";
  sprint.openedAt = iso(nowMs);
  return { action: "sprint-aberta", summary: `${sprint.name} começou (até ${sprintDay(sprint.endAt)})`, data: { sprint: sprint.id } };
}

/**
 * Fecha a sprint e passa o que sobrou (backlog, a fazer, falhou) para `to` (ou "sem sprint"), com
 * `carriedFrom` e `carryCount`. O que está em andamento ou esperando o dono fica e termina onde está.
 */
function close(project: Project, sprint: Sprint, nowMs: number, to: Sprint | undefined): SprintEvent {
  const carried = tasksIn(project, sprint.id).filter((task) => task.status === "backlog" || task.status === "a_fazer" || task.status === "falhou");
  for (const task of carried) {
    if (to) task.sprintId = to.id;
    else delete task.sprintId;
    task.carriedFrom = sprint.id;
    task.carryCount = (task.carryCount ?? 0) + 1;
    task.updatedAt = iso(nowMs);
  }
  // Fechada antes da hora: `endAt` continua sendo o fim PLANEJADO (a tela mostra "planejada até 17/11 · fechada em 11/11");
  // quando ela de fato fechou está em `closedAt`.
  // Fase 1: o resumo já sai calculado; a sprint só vira "fechada" quando o dono aprova (`approveSprint`).
  sprint.status = "fechando";
  sprint.closedAt = iso(nowMs);
  sprint.summary = buildSprintSummary(project, sprint.id, nowMs);
  delete sprint.forYouId;
  const where = carried.length === 0 ? "" : to ? `; ${carried.length} ${carried.length === 1 ? "sobrou e foi" : "sobraram e foram"} para ${to.name}` : `; ${carried.length} ${carried.length === 1 ? "sobrou e ficou" : "sobraram e ficaram"} sem sprint`;
  return { action: "sprint-fechada", summary: `${sprint.name} fechou${where}; o resumo espera o OK do dono`, data: { sprint: sprint.id, carried: carried.map((task) => task.ref), to: to?.id ?? null } };
}

/** "Começar agora": fecha a ativa (a sobra vem para esta) e abre esta com começo = agora. */
export function startSprintNow(project: Project, id: string, nowMs: number): SprintEvent[] {
  const sprint = requireSprint(project, id);
  if (sprint.status !== "planejada") throw new HttpError(409, "Só dá para começar uma sprint planejada");
  const events: SprintEvent[] = [];
  const active = activeSprint(project);
  if (active) events.push(close(project, active, nowMs, sprint));
  if (Date.parse(sprint.startAt) > nowMs) sprint.startAt = iso(nowMs);
  if (Date.parse(sprint.endAt) <= nowMs) sprint.endAt = iso(nowMs + WEEK_MS);
  events.push(open(sprint, nowMs));
  return events;
}

/** "Fechar agora": a sobra vai para a próxima sprint (ou fica sem sprint); a próxima abre na data dela. */
export function closeSprintNow(project: Project, id: string, nowMs: number): SprintEvent[] {
  const sprint = requireSprint(project, id);
  if (sprint.status !== "ativa") throw new HttpError(409, sprint.status === "fechando" ? "Essa sprint já fechou e espera o seu OK na entrega (Aprovações)" : "Só dá para fechar a sprint ativa");
  return [close(project, sprint, nowMs, nextSprintAfter(project, sprint))];
}

/**
 * O tick: abre a planejada cuja hora chegou (se não há outra ativa) e fecha a ativa cujo fim passou.
 * Projeto que não está `ativo` (pausado, esperando plano) não abre nem fecha. Repete até estabilizar
 * (uma sprint vencida que nunca abriu abre e fecha na hora, passando a sobra adiante).
 */
export function advanceSprints(project: Project, nowMs: number): SprintEvent[] {
  const events: SprintEvent[] = [];
  if (project.status !== "ativo" || !hasSprints(project)) return events;
  for (let guard = 0; guard <= (project.sprints?.length ?? 0) * 2; guard += 1) {
    const active = activeSprint(project);
    if (active) {
      if (nowMs < Date.parse(active.endAt)) break;
      events.push(close(project, active, nowMs, nextSprintAfter(project, active)));
      continue;
    }
    const due = sprintsInOrder(project).find((sprint) => sprint.status === "planejada" && nowMs >= Date.parse(sprint.startAt));
    if (!due) break;
    events.push(open(due, nowMs));
  }
  return events;
}

/** Retomar um projeto pausado: as sprints que não fecharam andam o tempo que ele ficou parado. */
export function shiftSprints(project: Project, ms: number): void {
  if (ms <= 0) return;
  for (const sprint of project.sprints ?? []) {
    if (sprint.status !== "planejada" && sprint.status !== "ativa") continue;
    sprint.startAt = iso(Date.parse(sprint.startAt) + ms);
    sprint.endAt = iso(Date.parse(sprint.endAt) + ms);
  }
}

/** As sprints que fecharam e ainda esperam o OK do resumo. */
export function closingSprints(project: Pick<Project, "sprints">): Sprint[] {
  return sprintsInOrder(project).filter((sprint) => sprint.status === "fechando");
}

/** "Sprint 2 fechou: 8 entregues, 2 sobraram" (o título do cartão em Aprovações). */
export function closingTitle(sprint: Pick<Sprint, "name" | "summary">): string {
  const done = sprint.summary?.done.length ?? 0;
  const carried = sprint.summary?.carried.length ?? 0;
  const failed = sprint.summary?.failed.length ?? 0;
  const left = `${carried} ${carried === 1 ? "sobrou" : "sobraram"}${failed > 0 ? ` (${failed} ${failed === 1 ? "falhou" : "falharam"})` : ""}`;
  return `${sprint.name} fechou: ${done} ${done === 1 ? "entregue" : "entregues"}, ${left}`;
}

/** O resumo em texto (o `text` do item: lido pelo Maestro e mostrado onde não há o cartão completo). */
export function summaryText(sprint: Sprint): string {
  const summary = sprint.summary;
  if (!summary) return sprint.name;
  const lines: string[] = [];
  if (sprint.goal) lines.push(`Objetivo: ${sprint.goal}`);
  if (summary.done.length > 0) lines.push("", "## Entregue", ...summary.done.map((entry) => `- ${entry.ref} ${entry.title}${entry.links?.length ? ` (${entry.links.join(", ")})` : ""}`));
  if (summary.carried.length > 0) lines.push("", "## Sobrou", ...summary.carried.map((entry) => `- ${entry.ref} ${entry.title} (${entry.to ? `foi para ${entry.to}` : "ficou sem sprint"})`));
  if (summary.failed.length > 0) lines.push("", "## Falhou", ...summary.failed.map((entry) => `- ${entry.ref} ${entry.title}${entry.reason ? `: ${entry.reason}` : ""}`));
  if (summary.cancelled?.length) lines.push("", "## Canceladas", ...summary.cancelled.map((entry) => `- ${entry.ref} ${entry.title}`));
  return lines.join("\n").trim() || closingTitle(sprint);
}

/** Aprovar o resumo: a sprint vira "fechada" (`closedAt` segue sendo quando ela fechou; a decisão fica em `summary.decidedAt`). */
export function approveSprint(project: Project, id: string, nowMs: number, by: "usuario" | "automatico", returned?: { reason: string; refs: string[] }): SprintEvent {
  const sprint = requireSprint(project, id);
  if (sprint.status !== "fechando") throw new HttpError(409, sprint.status === "fechada" ? "A entrega desta sprint já foi decidida" : "A sprint ainda não fechou");
  sprint.status = "fechada";
  sprint.summary = { ...(sprint.summary ?? buildSprintSummary(project, id, nowMs)), decidedBy: by, decidedAt: iso(nowMs), ...(returned ? { returned } : {}) };
  const how = returned ? `devolvida com ${returned.refs.length} ${returned.refs.length === 1 ? "tarefa" : "tarefas"} de retrabalho` : by === "automatico" ? "aprovada sozinha" : "aprovada";
  return { action: returned ? "sprint-devolvida" : "sprint-aprovada", summary: `A entrega de ${sprint.name} foi ${how}`, data: { sprint: id, by, ...(returned ? { reason: returned.reason, refs: returned.refs } : {}) } };
}

/** Onde o retrabalho entra: a sprint ativa, senão a próxima planejada; nenhuma = sem sprint. */
function reworkSprint(project: Project, from: Sprint): string | undefined {
  return activeSprint(project)?.id ?? nextSprintAfter(project, from)?.id ?? sprintsInOrder(project).find((sprint) => sprint.status === "planejada")?.id;
}

/**
 * Devolver a entrega: cada tarefa marcada (entregue na sprint) ganha uma tarefa irmã de retrabalho, com o
 * motivo no briefing, na sprint ativa. Devolve as tarefas novas.
 */
export function createReworkTasks(project: Project, sprint: Sprint, refs: string[], reason: string, nowMs: number, addNode: (project: Project, input: { title: string; parent?: string; briefing: string; assignee?: string; priority?: ProjectTask["priority"]; released?: boolean }, at: string) => ProjectTask): ProjectTask[] {
  const delivered = new Set((sprint.summary?.done ?? []).map((entry) => entry.ref));
  const created: ProjectTask[] = [];
  for (const ref of [...new Set(refs)]) {
    if (!delivered.has(ref)) throw new HttpError(400, `A tarefa ${ref} não está entre as entregues de ${sprint.name}`);
    const original = project.tasks.find((task) => task.ref === ref);
    if (!original) continue;
    const parent = original.parent && project.tasks.find((task) => task.ref === original.parent)?.group ? original.parent : undefined;
    const briefing = [`Retrabalho de ${original.ref} (${original.title}), devolvido na entrega de ${sprint.name}.`, `Motivo: ${reason}`, "", "Briefing original:", original.briefing, ...(original.result ? ["", "Resultado anterior:", original.result.slice(0, 1500)] : [])].join("\n");
    const task = addNode(project, { title: `Retrabalho: ${original.title}`.slice(0, 200), ...(parent ? { parent } : {}), briefing, ...(original.ownerId ? { assignee: original.ownerId } : {}), priority: original.priority, released: true }, iso(nowMs));
    const sprintId = reworkSprint(project, sprint);
    if (sprintId) task.sprintId = sprintId;
    else delete task.sprintId;
    created.push(task);
  }
  return created;
}
