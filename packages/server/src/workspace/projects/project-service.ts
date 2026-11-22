import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  agentAddress,
  clearBlocked,
  setBlocked,
  AVULSAS_ID,
  autoVerdict,
  autoUsedToday,
  ACTIVITY_MAESTRO,
  ACTIVITY_SYSTEM,
  ACTIVITY_USER,
  activeSprint,
  assigneesOf,
  buildProjectPlan,
  childrenOf,
  deliveryLeaves,
  effectiveDeps,
  receivedBy,
  sprintProgress,
  sprintsInOrder,
  statusOf,
  moduleProgress,
  projectUnitProgress,
  projectTreeMarkdown,
  type LabelInput,
  blockedLeaves,
  completedRefs,
  deadDependencies,
  DEFAULT_PLAN_APPROVAL,
  hasSprints,
  isLeaf,
  effectivePriority,
  emptyAvulsas,
  expandAvulsas,
  findAgentByRef,
  handoffLabel,
  isMaestroAgent,
  parseAddress,
  findMaestroAgent,
  findMaestroRoom,
  isActiveTaskStatus,
  isArchivable,
  isAvulsas,
  isCleanable,
  isDeletable,
  leafFinishedMs,
  isDeadlineAtRisk,
  isPlanProject,
  isProjectOpen,
  isProjectTaskFinished,
  isSeedProject,
  isSeedTask,
  isoFromInput,
  subtreeRefs,
  leafRequestId,
  leafTasks,
  leavesOf,
  legacyViewOf,
  MAX_REWORK,
  paceFromInput,
  PROJECT_BRIEF_MAX,
  PROJECT_INPUT_PRIORITIES,
  PROJECT_SAFETY,
  progressLabel,
  parseClock,
  plannedLeafCount,
  isParked,
  isReleased,
  releaseHold,
  releaseState,
  requestIdOf,
  prerequisiteClosure,
  projectDefaults,
  projectProgress,
  takeAvulsasRef,
  taskRankInput,
  workClock,
  type Agent,
  type AvulsasCleanupBody,
  type AvulsasCleanupPreview,
  type AvulsasCleanupResult,
  type ForYouItem,
  type HandoffIntent,
  type HelpKind,
  type AutoGrant,
  type OfficeState,
  type ProjectDeleteResult,
  type ProjectModeBody,
  type ProjectCreateBody,
  type SprintCreateBody,
  type SprintPatchBody,
  type TaskCreateBody,
  type TaskMoveBody,
  type TaskPatchBody,
  type TaskReassignBody,
  type Pace,
  type PlanApprovalRule,
  type ProjectApproval,
  type ProjectMode,
  type Project,
  type ProjectInputApproval,
  type ProjectInputPriority,
  type ProjectInputRelease,
  type ProjectJointRef,
  type ProjectPaceInput,
  type ProjectPriority,
  type ProjectTask,
  type ProjectTaskInput,
  type RankInput,
  type ReleasePace,
  type ServerEvent,
  type Task,
} from "@cyno/shared";
import type { AgentLogService } from "../agent-log/service";
import { HttpError } from "../../platform/http/errors";
import { activeActivity } from "../activity/log";
import { dropForYouItems } from "../for-you/service";
import { persist, persistOrThrow } from "../../util/persist";
import { shorten } from "../../util/text";
import { doneWhenBlock, dueLine, flowLine, motherNote, receiverLine } from "./work-scheduler";
import { HANDOFF_TITLES, handoffBriefing, handoffFamily, handoffRefusal, nextHandoffRef, NOTHING_HANDED_OFF, originAgent } from "./handoff";
import { addNode, assertValidTree, becomeMother, duplicateNode, ensureLabel, hasStarted, idleStatus, moveNode, moveToSprint, refreshIdle, requireTask, restoreEmptyParent, setDependsOn, singleStep } from "./project-edit";
import { applyReleasePace, holdNodes, normalizeReleasePace, releaseNodes } from "./release-service";
import { addSprint, advanceSprints, approveSprint, closeSprintNow, closingSprints, closingTitle, createReworkTasks, summaryText, editSprint, inheritSprint, removeSprint, reorderSprints, requireSprint, shiftSprints, startSprintNow, type SprintEvent } from "./sprint-service";
import { WorkClock } from "./work-clock";
import { WorkScheduler } from "./work-scheduler";
import { CHECK_EVERY_MS, hasLifecycle, PLAN_STALL_MS, PLAN_STEP_MAX_MS, requestTitle, shorten2, TEXT, type ProjectServiceDeps } from "./project-types";

// Quem importava daqui continua importando daqui (os tipos e as constantes moram em plan-types).
export { PLAN_STALL_MS, PLAN_STEP_MAX_MS, type ProjectHost, type ProjectServiceDeps, type ProjectWakeKind } from "./project-types";

/** Resposta de `autoReserve`: liberada (com "3 de 8 hoje") ou não (com o motivo, quando há). */
export type AutoVerdict = { ok: true; projectId: string; label: string } | { ok: false; note?: string };

const quoteName = (title: string) => `“${title}”`;

/** `ref` de todos os descendentes de `ref` (sem ele). */
function subtreeOf(project: Pick<Project, "tasks">, ref: string): Set<string> {
  return new Set(subtreeRefs(project, ref).slice(1));
}

/** O que `updateProject` aceita mudar (mesmo corpo do `PATCH /projects/:id`; `null` limpa). */
export type ProjectUpdate = {
  title?: string;
  priority?: ProjectPriority;
  startAt?: string | null;
  dueAt?: string | null;
  pace?: Pace | null;
  /** Liberação diária (objeto liga, `null` desliga; a conta do dia, `given`, é do servidor). */
  releasePace?: { perDay: number; unit: ReleasePace["unit"]; startsOn?: string | undefined } | null;
  status?: "ativo" | "pausado";
  /** "Isso primeiro": true fixa no topo da fila (`pinnedAt` agora), false solta. */
  pinned?: boolean;
  summary?: string | null;
  doneWhen?: string[];
};


/** Título digitado: sem espaços repetidos, não vazio, até 120 caracteres. */
function titleOf(value: string): string {
  const title = value.trim().replace(/\s+/g, " ");
  if (!title) throw new HttpError(400, "O título não pode ficar vazio");
  return shorten(title, 120);
}

/** Data digitada -> ISO (`null` limpa; ausente = não mexe). */
function instantOf(value: string | null | undefined, label: string): string | null | undefined {
  if (value === undefined || value === null) return value;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new HttpError(400, `${label} inválido`);
  return new Date(ms).toISOString();
}

/** O que o Maestro manda em `create_project` (contrato MCP, em inglês). */
export type ProposeInput = {
  tasks: ProjectTaskInput[];
  /** Liberação padrão da chamada ("now" = entra na fila, "later" = Planejada); cada item pode sobrescrever. */
  release?: ProjectInputRelease;
  /** Escolha de aprovação do Maestro ("ask" = pedir OK, "skip" = começar sem pedir); a regra do workspace vence quando é "always" ou "never". */
  approval?: ProjectInputApproval;
  /** true = cria um projeto adicional no mesmo pedido (com id UUID próprio e `requestId` apontando para o pedido). */
  new_project?: boolean;
  summary?: string;
  title?: string;
  priority?: ProjectInputPriority;
  start_at?: string;
  due_at?: string;
  pace?: ProjectPaceInput;
  labels?: LabelInput[];
  /** Só preenche `modeProposal`; o Automático só vale com o OK do usuário (fatia 7). */
  suggested_mode?: "auto";
  auto_scope?: { actions: string[]; sites?: string[]; connectors?: string[]; daily_cap?: number };
};

/** Como uma ferramenta do Maestro aponta o projeto: pelo `project_id` direto, pelo `request_id` do pedido (ou string legada). */
export type ProjectTarget = string | { projectId: string } | { requestId: string };

/** O que `deleteTask` devolve: o projeto atualizado, os refs apagados e as referências limpas de `dependsOn`. */
export type TaskDeleteResult = { project: Project; deleted: string[]; cleanedDependsOn: { ref: string; removed: string[] }[] };

/** Limites do `describe` resumido: projetos pequenos saem inteiros; árvores grandes mostram módulos + folhas abertas com teto. */
const DESCRIBE_SMALL_MAX = 40;
const DESCRIBE_MODULE_MAX = 40;
const DESCRIBE_TOTAL_MAX = 300;

/** Mudança de um projeto (o `update_project` do Maestro e a rota PATCH). `null` apaga o campo. */


/** Extras de uma tarefa avulsa (`delegate_task`). */
export type AdoptExtras = { dueAt?: string; priority?: ProjectInputPriority; doneWhen?: string[]; approvalType?: string };

/**
 * Planos dos pedidos (plans.json) e a distribuição deles. Regras:
 * - Nada roda antes de o usuário aprovar (item "plano" no "Para você": aprovar / ajustar / cancelar).
 * - Aprovado, uma tarefa começa quando as dependências terminaram, há vaga no workspace
 *   (`maxRunning`, sem contar as que esperam o usuário) e o agente da etapa tem vaga (`perAgent`) e
 *   motor disponível (sem cota = espera; nunca troca de motor).
 * - Cada etapa é uma subtarefa do pedido (`plan`), executada pelo orquestrador. Quando ela termina,
 *   o resultado e o contexto passam sozinhos para a etapa seguinte; a última fecha a tarefa.
 * - O Maestro só é acordado quando o plano inteiro termina (uma mensagem com o resumo), quando uma
 *   tarefa falha, quando um agente pede ajuda, quando algo fica parado demais ou quando o usuário
 *   pede ajuste. As entregas do meio não acordam ninguém.
 */
export class ProjectService {
  private stopped = false;
  private timer: NodeJS.Timeout | undefined;
  /** Agendador: decide e começa as etapas, concilia no boot, avisa das paradas. */
  private readonly scheduler: WorkScheduler;
  /** Relógio de horas: soma em `worked` o tempo das etapas em andamento. */
  private readonly clock: WorkClock;
  private readonly stallMs: number;
  private readonly stepMaxMs: number;
  /** Projetos cujo Maestro já foi avisado de um repasse barrado (uma vez por projeto). */
  private readonly handoffWarned = new Set<string>();

  constructor(
    private plans: Project[],
    private readonly deps: ProjectServiceDeps,
  ) {
    this.stallMs = deps.stallMs ?? PLAN_STALL_MS;
    this.stepMaxMs = deps.stepMaxMs ?? PLAN_STEP_MAX_MS;
    this.clock = new WorkClock({ projects: () => this.plans, save: (changed) => void this.save(changed), now: () => this.deps.now().getTime() });
    this.scheduler = new WorkScheduler(
      {
        plans: this.plans,
        deps,
        isStopped: () => this.stopped,
        limits: () => ({ stallMs: this.stallMs, stepMaxMs: this.stepMaxMs }),
        at: () => this.at(),
        save: (changed) => this.save(changed),
        commitTasks: (tasks, events) => this.commitTasks(tasks, events),
        logRequest: (request, body) => this.logRequest(request, body),
        progress: (plan) => this.progress(plan),
        agentName: (state, id) => this.agentName(state, id),
        nowMs: () => this.deps.now().getTime(),
        workedToday: (project) => (project.worked[workClock(this.deps.now().getTime()).day] ?? 0) + this.clock.pending(project.id),
        avgTaskMs: () => this.averageTaskMs(),
      },
      {
        onStepTask: (sub) => this.onStepTask(sub),
        cancelPlan: (plan, reason) => this.cancelPlan(plan, reason),
        failTask: (plan, task, reason) => this.failTask(plan, task, reason),
        advanceSprints: () => this.advanceAllSprints(),
        advanceRelease: () => this.advanceAllRelease(),
      },
    );
    const every = deps.checkEveryMs ?? CHECK_EVERY_MS;
    if (every > 0) {
      this.timer = setInterval(() => this.tick(), every);
      this.timer.unref();
    }
  }

  list(): Project[] {
    return structuredClone(this.plans);
  }

  get(id: string): Project {
    const plan = this.plans.find((candidate) => candidate.id === id) ?? this.leavesView(id);
    if (!plan) throw new HttpError(404, `Plano "${id}" não encontrado`);
    return structuredClone(plan);
  }

  /** O plano principal do pedido (ou qualquer projeto dele) ou, se o pedido virou folha do "Avulsas", a vista de projeto; undefined se não há. */
  forRequest(requestId: string): Project | undefined {
    const plan =
      this.plans.find((candidate) => candidate.id === requestId && !isAvulsas(candidate) && isPlanProject(candidate)) ??
      this.plans.find((candidate) => !isAvulsas(candidate) && requestIdOf(candidate) === requestId && isPlanProject(candidate));
    return plan ? structuredClone(plan) : this.leavesView(requestId);
  }

  /** Todos os projetos (com ciclo ou casca, exceto Avulsas) ligados a um pedido do Maestro. */
  private plansForRequest(requestId: string): Project[] {
    return this.plans.filter((candidate) => !isAvulsas(candidate) && requestIdOf(candidate) === requestId);
  }

  /** Todos os projetos ABERTOS com ciclo de plano ligados a um pedido do Maestro. */
  private openPlansForRequest(requestId: string): Project[] {
    return this.plans.filter((plan) => !isAvulsas(plan) && requestIdOf(plan) === requestId && isProjectOpen(plan) && hasLifecycle(plan));
  }

  /** O projeto fixo "Avulsas" (undefined só em workspace que ainda não passou pela migração). */
  private avulsas(): Project | undefined {
    return this.plans.find(isAvulsas);
  }

  /** O "Avulsas", criado se faltar (um workspace antigo aberto sem a migração, ou apagado à mão). */
  private ensureAvulsas(): Project {
    const found = this.avulsas();
    if (found) return found;
    const created = emptyAvulsas(this.at());
    this.plans.push(created);
    return created;
  }

  /** As folhas abertas ou não do "Avulsas" que vieram de um pedido. */
  private leavesOfRequest(requestId: string): ProjectTask[] {
    return this.avulsas()?.tasks.filter((task) => leafRequestId(task) === requestId) ?? [];
  }

  /** Como o pedido simples era antes do Avulsas: um projeto `kind: "tarefa"` com as folhas dele (vista, nunca gravada). */
  private leavesView(requestId: string): Project | undefined {
    const leaves = this.leavesOfRequest(requestId);
    return leaves.length > 0 ? structuredClone(legacyViewOf(requestId, leaves)) : undefined;
  }

  /**
   * A folha de `ref` no "Avulsas": no arquivo vivo ou, se já foi para o arquivo mensal (finalizada há mais de
   * 14 dias), lá (o "Para você" e a Atividade continuam achando tarefa antiga por `projectId/ref`). Outro
   * projeto: a tarefa dele.
   */
  async findTask(projectId: string, ref: string): Promise<ProjectTask | undefined> {
    const project = this.plans.find((candidate) => candidate.id === projectId);
    const live = project?.tasks.find((task) => task.ref === ref);
    if (live) return structuredClone(live);
    if (projectId !== AVULSAS_ID) return undefined;
    return this.deps.archive?.find(ref);
  }

  /** Dia local do último arquivamento (roda uma vez por dia). */
  private archivedOn: string | undefined;

  /**
   * Passa para o arquivo mensal (somente leitura) as folhas do "Avulsas" finalizadas há mais de 14 dias, e só
   * elas: nunca as abertas nem as que ainda têm Task rodando. Grava o arquivo ANTES de tirar do vivo (uma queda
   * no meio deixa a folha nos dois lugares; o vivo vence e o próximo arquivamento só tira). Devolve quantas.
   */
  async archiveDone(): Promise<number> {
    const avulsas = this.avulsas();
    if (!avulsas || !this.deps.archive) return 0;
    const now = this.deps.now().getTime();
    const state = this.deps.state.read();
    const busy = new Set(state.tasks.filter((task) => isActiveTaskStatus(task.status)).map((task) => task.id));
    const due = avulsas.tasks.filter((task) => isArchivable(task, now) && !task.steps.some((step) => step.taskId && busy.has(step.taskId)));
    if (due.length === 0) return 0;
    await this.deps.archive.append(structuredClone(due));
    const gone = new Set(due.map((task) => task.ref));
    avulsas.tasks = avulsas.tasks.filter((task) => !gone.has(task.ref));
    avulsas.updatedAt = this.at();
    await this.save([avulsas]);
    this.deps.log.info({ archived: due.length }, "folhas do Avulsas arquivadas");
    return due.length;
  }

  /** A Task executa uma etapa de um plano em andamento (e não uma tarefa avulsa)? */
  isPlanStep(task: Pick<Task, "work">): boolean {
    return this.locate(task) !== undefined;
  }

  /**
   * Recusa com motivo: conta um retrabalho na tarefa do projeto (`rework.count`, `rework.last`).
   * Devolve false se a tarefa não é de um projeto ou se os MAX_REWORK retrabalhos já foram usados
   * (aí o fluxo antigo vale: a tarefa falha como "Recusado" e o Maestro decide).
   */
  registerRework(task: Task, input: { reason: string; itemId: string }): boolean {
    const found = this.locateAny(task);
    if (!found || found.planTask.rework.count >= MAX_REWORK) return false;
    const at = this.at();
    found.planTask.rework = { count: found.planTask.rework.count + 1, last: { reason: input.reason, at, itemId: input.itemId } };
    found.planTask.updatedAt = at;
    found.plan.updatedAt = at;
    this.save([found.plan]);
    return true;
  }

  /** Quantos retrabalhos a tarefa do projeto já usou (0 se não é de um projeto). */
  reworkCount(task: Task): number {
    return this.locateAny(task)?.planTask.rework.count ?? 0;
  }

  /** O pedido tem algum projeto aberto segurando o pedido (esperando aprovação, sendo ajustado ou com trabalho liberado)? Projeto estacionado (só Planejado) não segura. */
  holds(requestId: string): boolean {
    return this.openPlansForRequest(requestId).some((plan) => !isParked(plan));
  }

  /** O pedido pode ser concluído agora? (qualquer projeto rodando/pausado com trabalho liberado por terminar = não; projeto estacionado não bloqueia) */
  blocksConclusion(requestId: string): string | undefined {
    const open = this.openPlansForRequest(requestId).filter((plan) => (plan.status === "ativo" || plan.status === "pausado") && !isParked(plan));
    for (const plan of open) {
      const left = leafTasks(plan.tasks).filter((task) => !isProjectTaskFinished(task));
      if (left.length === 0) continue;
      return `The project ${plan.id} («${plan.title}») of this request still has ${left.length} task(s) to finish (${left.map((task) => task.ref).join(", ")}). Wait for the final message, or use set_project_status(project_id: "${plan.id}", status: "canceled") / resolve_task(action: "cancel_project") before completing.`;
    }
    return undefined;
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.scheduler.stop();
  }

  /** O tick de 1 minuto: soma o parcial do relógio de horas, reavalia o ritmo (janela, limite, "começa em") e confere as paradas. */
  tick(): void {
    if (this.stopped) return;
    this.clock.tick();
    this.pump();
    this.deps.orchestrator.retryWaiting();
    this.checkStalls();
    const today = workClock(this.deps.now().getTime()).day;
    if (this.archivedOn !== today) {
      this.archivedOn = today;
      void this.archiveDone().catch((error: unknown) => this.deps.log.error({ err: error }, "falha ao arquivar as folhas do Avulsas"));
    }
  }

  // ---------- Ritmo e prioridade (usuário e Maestro) ----------

  /**
   * Muda título, prioridade, "começa em", prazo, ritmo ou pausa de um projeto (`PATCH /projects/:id`
   * e a ferramenta `update_project` do Maestro). `null` limpa `startAt`, `dueAt` e `pace`; o ritmo
   * informado SUBSTITUI o anterior. Pausar não interrompe a etapa em andamento: só não começa outra;
   * retomar põe a fila para andar. Projeto que ainda espera aprovação do plano não pausa/retoma.
   */
  async updateProject(id: string, patch: ProjectUpdate, by?: "maestro"): Promise<Project> {
    const project = this.plans.find((candidate) => candidate.id === id);
    // Pedido simples (folha do Avulsas): título, prioridade, começo e prazo valem para a tarefa.
    if (!project) return this.updateRequestLeaves(id, patch);
    if (isAvulsas(project)) throw new HttpError(409, "O projeto Avulsas é fixo: ele não muda de título, não pausa nem termina. Mude a tarefa.");
    if (!isProjectOpen(project)) throw new HttpError(409, "O projeto já terminou");
    if (patch.pinned !== undefined && isSeedProject(project)) throw new HttpError(409, "Projeto de demonstração: ele não roda, então não há o que fixar");
    const at = this.at();
    const next: Partial<Project> = {};
    if (patch.title !== undefined) next.title = titleOf(patch.title);
    if (patch.priority !== undefined) next.priority = patch.priority;
    if (patch.summary !== undefined) {
      const text = patch.summary?.trim();
      if (text) next.summary = text;
      else delete project.summary;
    }
    if (patch.doneWhen !== undefined) next.doneWhen = patch.doneWhen.map((text, index) => ({ id: `d${index + 1}`, text: text.trim() })).filter((item) => item.text);
    const startAt = instantOf(patch.startAt, "O começo");
    const dueAt = instantOf(patch.dueAt, "O prazo");
    const pace = patch.pace === undefined ? undefined : patch.pace === null ? null : this.normalizePace(patch.pace);
    const releasePace = patch.releasePace === undefined ? undefined : patch.releasePace === null ? null : normalizeReleasePace(patch.releasePace, project.releasePace);
    if (patch.status !== undefined && patch.status !== project.status) {
      if (project.status !== "ativo" && project.status !== "pausado") throw new HttpError(409, "O plano ainda não foi aprovado: não dá para pausar ou retomar");
      next.status = patch.status;
    }
    Object.assign(project, next);
    let pinChange: "fixado" | "solto" | undefined;
    if (patch.pinned === true && !project.pinnedAt) {
      project.pinnedAt = at;
      pinChange = "fixado";
    } else if (patch.pinned === false && project.pinnedAt) {
      delete project.pinnedAt;
      pinChange = "solto";
    }
    if (next.status === "pausado") project.pausedAt = at;
    else if (next.status === "ativo" && project.pausedAt) {
      // Retomar: as sprints que não fecharam andam o tempo que o projeto ficou parado.
      shiftSprints(project, Date.parse(at) - Date.parse(project.pausedAt));
      delete project.pausedAt;
    }
    for (const [key, value] of [["startAt", startAt], ["dueAt", dueAt]] as const) {
      if (value === undefined) continue;
      if (value === null) delete project[key];
      else project[key] = value;
    }
    if (pace === null || (pace && Object.keys(pace).length === 0)) delete project.pace;
    else if (pace) project.pace = pace;
    const hadReleasePace = project.releasePace !== undefined;
    if (releasePace === null) delete project.releasePace;
    else if (releasePace) project.releasePace = releasePace;
    project.updatedAt = at;
    const saved = this.save([project]);
    this.deps.log.info({ projectId: id, patch: Object.keys(patch) }, "projeto atualizado");
    if (pinChange) this.recordPin(project.id, project.title, pinChange);
    if (releasePace) this.recordReleasePace(project, "ligada", by);
    else if (releasePace === null && hadReleasePace) this.recordReleasePace(project, "desligada", by);
    // Prioridade, começo, prazo, ritmo e retomada mudam quem pode começar: a fila reavalia.
    if (patch.status !== "pausado") {
      this.pump();
      this.deps.orchestrator.retryWaiting();
    }
    await saved;
    return structuredClone(project);
  }

  /**
   * Muda o status do projeto (`set_project_status` do Maestro e rotas `reopen`/`complete` do dono):
   * - `ativo`: reabre concluído/cancelado (limpa `finishedAt`/`doneNotified`; tarefas canceladas ficam canceladas) ou retoma pausado (empurra sprints).
   * - `pausado`: pausa um projeto ativo.
   * - `concluido`: conclui (recusa se houver folha em andamento ou esperando você; tarefas abertas ficam como estão; `finishedAt`, `doneNotified: true`).
   * - `cancelado`: cancela o projeto e suas tarefas abertas (como `cancelPlan`, sem mexer em outros projetos do mesmo pedido).
   * O projeto `system: "avulsas"` nunca muda de status.
   */
  async setProjectStatus(projectId: string, status: "ativo" | "pausado" | "concluido" | "cancelado", by: "usuario" | "maestro" = "usuario"): Promise<Project> {
    const project = this.plans.find((candidate) => candidate.id === projectId);
    if (!project) throw new HttpError(404, `Projeto "${projectId}" não encontrado`);
    if (isAvulsas(project)) throw new HttpError(409, "O projeto Avulsas é fixo e nunca muda de status");
    if (project.status === status) return structuredClone(project);
    const at = this.at();
    const before = structuredClone(project);
    const who = by === "maestro" ? "O Maestro" : "Você";
    const actor = by === "maestro" ? ACTIVITY_MAESTRO : ACTIVITY_USER;
    const title = quoteName(shorten(project.title, 60));
    if (status === "cancelado") {
      await this.cancelPlan(project, by === "maestro" ? "Cancelado pelo Maestro" : "Cancelado pelo usuário", true);
      activeActivity()?.record({ workspaceId: this.deps.workspaceId, category: "plano", action: "projeto-cancelado", actor, summary: `${who} cancelou o projeto ${title}`, refs: { planId: project.id } });
      return structuredClone(project);
    }
    if (status === "ativo") {
      if (project.status === "proposto" || project.status === "ajustando") {
        throw new HttpError(409, by === "maestro" ? "Project is still waiting for approval: it cannot be activated directly." : "O plano ainda não foi aprovado: aprove o plano em vez de reabrir");
      }
      const wasPaused = project.status === "pausado";
      if (wasPaused && project.pausedAt) {
        shiftSprints(project, Date.parse(at) - Date.parse(project.pausedAt));
      }
      delete project.pausedAt;
      if (!wasPaused) {
        delete project.finishedAt;
        delete project.doneNotified;
      }
      project.status = "ativo";
      project.updatedAt = at;
      await this.saveUser(project, before);
      activeActivity()?.record({
        workspaceId: this.deps.workspaceId,
        category: "plano",
        action: wasPaused ? "projeto-retomado" : "projeto-reaberto",
        actor,
        summary: wasPaused ? `${who} retomou o projeto ${title}` : `${who} reabriu o projeto ${title}`,
        refs: { planId: project.id },
      });
      this.pump();
      this.deps.orchestrator.retryWaiting();
      return structuredClone(project);
    }
    if (status === "pausado") {
      if (project.status !== "ativo") {
        throw new HttpError(409, by === "maestro" ? `Only an active project can be paused (current status: ${project.status}).` : "Só dá para pausar um projeto em execução");
      }
      project.status = "pausado";
      project.pausedAt = at;
      project.updatedAt = at;
      await this.saveUser(project, before);
      activeActivity()?.record({ workspaceId: this.deps.workspaceId, category: "plano", action: "projeto-pausado", actor, summary: `${who} pausou o projeto ${title}`, refs: { planId: project.id } });
      return structuredClone(project);
    }
    // status === "concluido"
    if (project.status === "proposto" || project.status === "ajustando") {
      throw new HttpError(409, by === "maestro" ? "Project has not been approved yet." : "O plano ainda não foi aprovado");
    }
    if (project.status === "cancelado") {
      throw new HttpError(409, by === "maestro" ? "Project is canceled: reopen it first with status \"active\"." : "O projeto foi cancelado: reabra antes de concluir");
    }
    const state = this.deps.state.read();
    const busyLeaf = leavesOf(project).find((leaf) => leaf.status === "em_andamento" || leaf.status === "esperando_voce");
    const busyTask = state.tasks.find((task) => task.role !== "request" && task.work?.projectId === project.id && (task.status === "in_progress" || task.status === "waiting_approval"));
    if (busyLeaf || busyTask) {
      throw new HttpError(
        409,
        by === "maestro"
          ? `Cannot complete project: task ${busyLeaf?.ref ?? busyTask?.work?.ref ?? ""} is still running or waiting for the owner. Cancel it or wait for it to finish first.`
          : "Não dá para concluir o projeto enquanto houver tarefa em andamento ou esperando você",
      );
    }
    project.status = "concluido";
    project.finishedAt = at;
    project.doneNotified = true;
    delete project.pausedAt;
    project.updatedAt = at;
    await this.saveUser(project, before);
    activeActivity()?.record({ workspaceId: this.deps.workspaceId, category: "plano", action: "projeto-concluido", actor, summary: `${who} concluiu o projeto ${title}`, refs: { planId: project.id } });
    this.pump();
    return structuredClone(project);
  }

  /** Atividade da liberação diária: o dono ou o Maestro ligou (com o ritmo) ou desligou. */
  private recordReleasePace(project: Project, change: "ligada" | "desligada", by?: "maestro"): void {
    const pace = project.releasePace;
    const who = by ? "O Maestro" : "Você";
    const what = pace ? `${pace.perDay} ${pace.unit === "modulos" ? (pace.perDay === 1 ? "módulo" : "módulos") : pace.perDay === 1 ? "tarefa" : "tarefas"} por dia${pace.startsOn ? `, a partir de ${pace.startsOn.slice(8, 10)}/${pace.startsOn.slice(5, 7)}` : ""}` : "";
    const summary = change === "ligada" ? `${who} ligou a liberação diária (${what}) em ${quoteName(shorten(project.title, 60))}` : `${who} desligou a liberação diária em ${quoteName(shorten(project.title, 60))}`;
    activeActivity()?.record({ workspaceId: this.deps.workspaceId, category: "plano", action: change === "ligada" ? "liberacao-diaria-ligada" : "liberacao-diaria-desligada", actor: by ? ACTIVITY_MAESTRO : ACTIVITY_USER, summary, refs: { planId: project.id } });
  }

  /** Atividade de "Isso primeiro": fixou ou soltou. */
  private recordPin(projectId: string, title: string, change: "fixado" | "solto"): void {
    const summary = change === "fixado" ? `Você pôs ${quoteName(shorten(title, 60))} na frente da fila (Isso primeiro)` : `Você soltou ${quoteName(shorten(title, 60))} da frente da fila`;
    activeActivity()?.record({ workspaceId: this.deps.workspaceId, category: "plano", action: change, actor: ACTIVITY_USER, summary, refs: { planId: projectId } });
  }

  /** `updateProject` de um pedido simples: muda a(s) tarefa(s) aberta(s) dele no Avulsas (não há pausa nem ritmo próprio aqui). */
  private async updateRequestLeaves(requestId: string, patch: ProjectUpdate): Promise<Project> {
    const avulsas = this.avulsas();
    const leaves = this.leavesOfRequest(requestId);
    if (!avulsas || leaves.length === 0) throw new HttpError(404, `Projeto "${requestId}" não encontrado`);
    const open = leaves.filter((leaf) => !isProjectTaskFinished(leaf));
    if (open.length === 0) throw new HttpError(409, "A tarefa já terminou");
    if (patch.pinned !== undefined && open.some((leaf) => isSeedTask(leaf))) throw new HttpError(409, "Tarefa de demonstração: ela não roda, então não há o que fixar");
    if (patch.pace !== undefined || patch.releasePace !== undefined) throw new HttpError(409, "Tarefa avulsa não tem ritmo próprio: crie um projeto para isso");
    if (patch.status === "pausado") throw new HttpError(409, "Tarefa avulsa não pausa: cancele-a, ou crie um projeto");
    const title = patch.title !== undefined ? titleOf(patch.title) : undefined;
    const startAt = instantOf(patch.startAt, "O começo");
    const dueAt = instantOf(patch.dueAt, "O prazo");
    const at = this.at();
    let pinChange: "fixado" | "solto" | undefined;
    for (const leaf of open) {
      if (title !== undefined) leaf.title = title;
      if (patch.priority !== undefined) leaf.priority = patch.priority;
      if (patch.pinned === true && !leaf.pinnedAt) {
        leaf.pinnedAt = at;
        pinChange = "fixado";
      } else if (patch.pinned === false && leaf.pinnedAt) {
        delete leaf.pinnedAt;
        pinChange = "solto";
      }
      for (const [key, value] of [["startAt", startAt], ["dueAt", dueAt]] as const) {
        if (value === undefined) continue;
        if (value === null) delete leaf[key];
        else leaf[key] = value;
      }
      leaf.updatedAt = at;
    }
    avulsas.updatedAt = at;
    const saved = this.save([avulsas]);
    this.deps.log.info({ requestId, patch: Object.keys(patch) }, "tarefa avulsa atualizada");
    if (pinChange) this.recordPin(requestId, open[0]!.title, pinChange);
    this.pump();
    this.deps.orchestrator.retryWaiting();
    await saved;
    return structuredClone(legacyViewOf(requestId, this.leavesOfRequest(requestId)));
  }

  // ---------- Árvore de tarefas: o dono cria e edita pela tela ----------

  /** O projeto que a tela/Maestro pode mexer: existe, não está sendo refeito e não foi cancelado (concluído de QUALQUER origem reabre ao ganhar item). */
  private editable(id: string, creating = false): Project {
    const project = this.plans.find((candidate) => candidate.id === id);
    if (!project) throw new HttpError(404, `Projeto "${id}" não encontrado`);
    if (project.status === "ajustando") throw new HttpError(409, "O Maestro está ajustando o plano: espere ele terminar");
    if (project.status === "cancelado") throw new HttpError(409, "O projeto foi cancelado");
    if (project.status === "concluido" && !creating) throw new HttpError(409, "O projeto já terminou");
    return project;
  }

  /** Agente que pode receber tarefa (qualquer um, menos o Maestro), pelo id ou pelo nome. */
  private assignable(assignee: string): Agent {
    const state = this.deps.state.read();
    const pool = this.pool(state);
    const agent = findAgentByRef(pool.agents, assignee);
    if (!agent || pool.forbidden.has(agent.id)) throw new HttpError(400, `O agente "${assignee}" não existe (ou não recebe tarefas)`);
    return agent;
  }

  /** Grava a mudança do dono, registra na Atividade e põe a fila para andar. `before`: o projeto como estava (volta se o disco falhar). */
  private async finishEdit(project: Project, before: Project, action: string, summary: string, data: Record<string, unknown> = {}, by?: "maestro"): Promise<Project> {
    project.updatedAt = this.at();
    await this.saveUser(project, before);
    activeActivity()?.record({ workspaceId: this.deps.workspaceId, category: "plano", action, actor: by ? ACTIVITY_MAESTRO : ACTIVITY_USER, summary: by ? summary.replace(/^Você /, "O Maestro ") : summary, refs: { planId: project.id }, data });
    this.deps.log.info({ projectId: project.id, action }, "projeto editado pela tela");
    if (project.status === "ativo") {
      this.pump();
      this.deps.orchestrator.retryWaiting();
    }
    return structuredClone(project);
  }

  /** Desfaz em memória uma edição que falhou na validação (o projeto volta ao que era). */
  private restore(project: Project, before: Project): void {
    const index = this.plans.indexOf(project);
    if (index >= 0) this.plans[index] = before;
  }

  /** `POST /projects`: o dono cria um projeto à mão (origem "usuario", já ativo e sem plano para aprovar; as tarefas ele cria na tela). */
  async createProject(input: ProjectCreateBody): Promise<Project> {
    const at = this.at();
    const dueAt = instantOf(input.dueAt, "O prazo");
    const project: Project = {
      ...projectDefaults(),
      origin: "usuario",
      id: randomUUID(),
      kind: "projeto",
      title: titleOf(input.title),
      ...(input.summary?.trim() ? { summary: input.summary.trim() } : {}),
      status: "ativo",
      version: 1,
      priority: input.priority ?? "normal",
      ...(dueAt ? { dueAt } : {}),
      ...(input.doneWhen?.length ? { doneWhen: input.doneWhen.map((text, index) => ({ id: `d${index + 1}`, text: text.trim() })) } : {}),
      labels: [],
      sprints: [],
      tasks: [],
      createdAt: at,
      updatedAt: at,
      approvedAt: at,
    };
    this.plans.push(project);
    try {
      await this.saveStrict([project]);
    } catch (error) {
      this.plans.splice(this.plans.indexOf(project), 1);
      throw error;
    }
    activeActivity()?.record({ workspaceId: this.deps.workspaceId, category: "plano", action: "projeto-criado", actor: ACTIVITY_USER, summary: `Você criou o projeto ${quoteName(shorten(project.title, 60))}`, refs: { planId: project.id } });
    return structuredClone(project);
  }

  /** `POST /projects/:id/tasks`: entregável, tarefa ou subtarefa no fim do nível; sem responsável fica no backlog. */
  async createTask(projectId: string, body: TaskCreateBody): Promise<{ project: Project; ref: string }> {
    const project = this.editable(projectId, true);
    if (isAvulsas(project)) throw new HttpError(409, "As tarefas avulsas chegam pelo Maestro. Para criar à mão, crie um projeto.");
    const before = structuredClone(project);
    const agent = body.assignee ? this.assignable(body.assignee) : undefined;
    const startAt = instantOf(body.startAt, "O começo") ?? undefined;
    const dueAt = instantOf(body.dueAt, "O prazo") ?? undefined;
    const reopen = project.status === "concluido";
    let task: ProjectTask;
    try {
      const { dependsOn, ...rest } = body;
      task = addNode(project, { ...rest, ...(agent ? { assignee: agent.id } : {}), ...(startAt ? { startAt } : {}), ...(dueAt ? { dueAt } : {}) }, this.at());
      if (dependsOn && dependsOn.length > 0) {
        setDependsOn(project, task, dependsOn, this.at());
        // Com responsável e tudo o que espera pronto, entra na fila; senão fica no backlog.
        task.status = idleStatus(project, task);
        if (task.status === "a_fazer") task.waitingSince = this.at();
        else delete task.waitingSince;
      }
      assertValidTree(project);
    } catch (error) {
      this.restore(project, before);
      throw error;
    }
    if (reopen) {
      project.status = "ativo";
      delete project.finishedAt;
      delete project.doneNotified;
    }
    const kind = task.group ? "o módulo" : task.parent ? "a subtarefa" : "a tarefa";
    const saved = await this.finishEdit(project, before, "tarefa-criada", `Você criou ${kind} ${quoteName(shorten(task.title, 60))} em ${quoteName(shorten(project.title, 60))}`, { ref: task.ref });
    if (reopen) {
      activeActivity()?.record({ workspaceId: this.deps.workspaceId, category: "plano", action: "projeto-reaberto", actor: ACTIVITY_USER, summary: `Você reabriu o projeto ${quoteName(shorten(project.title, 60))} ao adicionar ${kind}`, refs: { planId: project.id } });
    }
    return { project: saved, ref: task.ref };
  }

  /** `PATCH /projects/:id/tasks/:ref` (e `update_task` do Maestro): edita na linha (nome, briefing, responsável, datas, prioridade, etiquetas, "pronto quando", dependências) ou cancela. */
  async updateTask(projectId: string, ref: string, patch: TaskPatchBody, by?: "maestro"): Promise<Project> {
    const project = this.editable(projectId);
    const before = structuredClone(project);
    const task = requireTask(project, ref);
    const at = this.at();
    const parent = project.tasks.some((candidate) => candidate.parent === ref) || task.group === true;
    try {
      if (patch.title !== undefined) task.title = titleOf(patch.title);
      if (patch.briefing !== undefined) task.briefing = patch.briefing;
      if (patch.priority !== undefined) task.priority = patch.priority;
      for (const [key, value] of [["startAt", instantOf(patch.startAt, "O começo")], ["dueAt", instantOf(patch.dueAt, "O prazo")]] as const) {
        if (value === undefined) continue;
        if (value === null) delete task[key];
        else task[key] = value;
      }
      if (task.startAt && task.dueAt && task.startAt > task.dueAt) throw new HttpError(400, "O começo não pode ser depois do prazo");
      if (patch.labels !== undefined) {
        if (patch.labels.length > 0) task.labels = [...new Set(patch.labels)];
        else delete task.labels;
      }
      if (patch.doneWhen !== undefined) {
        if (parent) throw new HttpError(400, by === "maestro" ? "done_when only applies to leaf tasks, not modules or parent tasks" : "O \"pronto quando\" fica nas tarefas que executam");
        task.doneWhen = patch.doneWhen.map((text, index) => ({ id: `d${index + 1}`, text: text.trim() }));
      }
      if (patch.dependsOn !== undefined) {
        setDependsOn(project, task, patch.dependsOn, at);
        refreshIdle(project, at);
      }
      if (patch.assignee !== undefined) {
        if (by === "maestro" && parent) throw new HttpError(400, "A module or parent task has no owner: set owner on the leaf tasks inside it");
        this.assign(project, task, patch.assignee, at);
      }
      if (patch.status === "cancelada") return await this.cancelTask(project, before, task);
      if (patch.status === "refazer") return await this.redoTask(project, before, task);
      task.updatedAt = at;
      assertValidTree(project);
    } catch (error) {
      this.restore(project, before);
      throw error;
    }
    const what = Object.keys(patch).join(", ");
    return this.finishEdit(project, before, "tarefa-editada", `Você mudou ${quoteName(shorten(task.title, 60))} em ${quoteName(shorten(project.title, 60))} (${what})`, { ref }, by);
  }

  /** Muda o responsável de uma folha que ainda não começou (`null` tira); o primeiro passo passa a ser dele. */
  private assign(project: Project, task: ProjectTask, assignee: string | null, at: string): void {
    if (task.group || project.tasks.some((candidate) => candidate.parent === task.ref)) throw new HttpError(400, "O responsável vem das tarefas de dentro: mude nelas");
    if (isAvulsas(project)) throw new HttpError(409, "A tarefa avulsa já tem agente: crie um projeto para mudar");
    if (hasStarted(task)) throw new HttpError(409, "A tarefa já começou: não dá para trocar o responsável");
    const agentId = assignee === null ? "" : this.assignable(assignee).id;
    task.ownerId = agentId;
    if (task.steps.length === 0) task.steps = singleStep(agentId, task.briefing || task.title);
    else task.steps[0]!.agentId = agentId;
    delete task.steps[0]!.address;
    task.status = idleStatus(project, task);
    if (task.status === "a_fazer") task.waitingSince = at;
    else delete task.waitingSince;
    task.updatedAt = at;
  }

  /** "Refazer" pela tela (revisão 2, M5): a tarefa que falhou ou foi cancelada volta para a fila; quem dependia dela deixa de estar travado. */
  private async redoTask(project: Project, before: Project, task: ProjectTask): Promise<Project> {
    if (isAvulsas(project)) throw new HttpError(409, "A tarefa avulsa não se refaz: crie uma nova");
    if (task.group || project.tasks.some((candidate) => candidate.parent === task.ref)) throw new HttpError(400, "Refaça as subtarefas de dentro");
    if (task.status !== "falhou" && task.status !== "cancelada") throw new HttpError(409, "Só uma tarefa que falhou ou foi cancelada pode ser refeita");
    const at = this.at();
    const step = task.steps[task.current] ?? task.steps[0];
    if (step) {
      Object.assign(step, { status: "pendente" });
      for (const key of ["taskId", "result", "startedAt", "finishedAt"] as const) delete step[key];
    }
    for (const key of ["failure", "finishedAt", "note", "blocked"] as const) delete task[key];
    task.status = task.current > 0 ? "em_andamento" : task.ownerId ? idleStatus(project, task) : "backlog";
    if (task.status === "a_fazer" || task.status === "em_andamento") task.waitingSince = at;
    else delete task.waitingSince;
    Object.assign(task, { stallWarned: false, updatedAt: at });
    refreshIdle(project, at);
    assertValidTree(project);
    const saved = await this.finishEdit(project, before, "tarefa-refeita", `Você mandou refazer ${quoteName(shorten(task.title, 60))} em ${quoteName(shorten(project.title, 60))}`, { ref: task.ref });
    this.afterChange(project);
    return saved;
  }

  /** Cancelar a tarefa pela tela: a etapa em curso para (como cancelar o pedido) e o resto da fila anda. */
  private async cancelTask(project: Project, before: Project, task: ProjectTask): Promise<Project> {
    if (task.group || project.tasks.some((candidate) => candidate.parent === task.ref)) {
      // Pai e entregável: cancela as filhas abertas.
      const open = project.tasks.filter((candidate) => candidate.parent === task.ref && !isProjectTaskFinished(candidate));
      for (const child of open) await this.cancelTask(project, before, child);
      return structuredClone(project);
    }
    if (isProjectTaskFinished(task)) throw new HttpError(409, "A tarefa já terminou");
    if (isAvulsas(project)) {
      this.restore(project, before);
      return this.cancelRequestLeaves(leafRequestId(task), "Cancelada pelo usuário");
    }
    const at = this.at();
    const running = task.steps[task.current];
    if (running?.status === "em_andamento" && running.taskId) this.deps.orchestrator.cancelTask(running.taskId, "Cancelada pelo usuário");
    Object.assign(task, { status: "cancelada", finishedAt: at, updatedAt: at });
    delete task.note;
    clearBlocked(task, at);
    delete task.waitingSince;
    const saved = await this.finishEdit(project, before, "tarefa-cancelada", `Você cancelou ${quoteName(shorten(task.title, 60))} em ${quoteName(shorten(project.title, 60))}`, { ref: task.ref });
    if (hasLifecycle(project)) this.afterChange(project);
    this.warnBlocked(project, task);
    return saved;
  }

  /** `POST .../move`: outro pai, outra posição ou um passo para cima/baixo. */
  async moveTask(projectId: string, ref: string, body: TaskMoveBody, by?: "maestro"): Promise<Project> {
    const project = this.editable(projectId);
    if (isAvulsas(project)) throw new HttpError(409, "As tarefas avulsas não se movem: converta em projeto");
    if (body.sprintId !== undefined && !hasSprints(project)) {
      throw new HttpError(409, by === "maestro" ? "This project does not use sprints (sprints are retired for new projects: use modules and release_work/set_release_pace)" : "Este projeto não usa sprints");
    }
    const before = structuredClone(project);
    const sprintOnly = body.sprintId !== undefined && body.parent === undefined && body.before === undefined && !body.step;
    try {
      if (!sprintOnly) moveNode(project, ref, { ...(body.parent !== undefined ? { parent: body.parent } : {}), ...(body.before !== undefined ? { before: body.before } : {}), ...(body.step ? { step: body.step } : {}) }, this.at());
      if (body.sprintId !== undefined) moveToSprint(project, ref, body.sprintId, this.at());
    } catch (error) {
      this.restore(project, before);
      throw error;
    }
    const moved = requireTask(project, ref);
    if (body.sprintId !== undefined) {
      const sprint = body.sprintId === null ? undefined : requireSprint(project, body.sprintId);
      return this.finishEdit(project, before, "tarefa-movida-de-sprint", `Você mandou ${quoteName(shorten(moved.title, 60))} ${sprint ? `para a ${quoteName(sprint.name)}` : "para sem sprint"} em ${quoteName(shorten(project.title, 60))}`, { ref, sprint: body.sprintId }, by);
    }
    return this.finishEdit(project, before, "tarefa-movida", `Você moveu ${quoteName(shorten(moved.title, 60))} em ${quoteName(shorten(project.title, 60))}`, { ref }, by);
  }

  /** `POST .../duplicate`: copia a tarefa (com as filhas) sem estado; em projeto concluído, reabre o projeto. */
  async duplicateTask(projectId: string, ref: string): Promise<{ project: Project; ref: string }> {
    const project = this.editable(projectId, true);
    if (isAvulsas(project)) throw new HttpError(409, "As tarefas avulsas não se duplicam: peça de novo ao Maestro");
    const before = structuredClone(project);
    const reopen = project.status === "concluido";
    let copy: ProjectTask;
    try {
      copy = duplicateNode(project, ref, this.at());
    } catch (error) {
      this.restore(project, before);
      throw error;
    }
    if (reopen) {
      project.status = "ativo";
      delete project.finishedAt;
      delete project.doneNotified;
    }
    const saved = await this.finishEdit(project, before, "tarefa-duplicada", `Você duplicou ${quoteName(shorten(requireTask(project, ref).title, 60))} em ${quoteName(shorten(project.title, 60))}`, { ref, copy: copy.ref });
    if (reopen) {
      activeActivity()?.record({ workspaceId: this.deps.workspaceId, category: "plano", action: "projeto-reaberto", actor: ACTIVITY_USER, summary: `Você reabriu o projeto ${quoteName(shorten(project.title, 60))} ao duplicar uma tarefa`, refs: { planId: project.id } });
    }
    return { project: saved, ref: copy.ref };
  }

  /** `POST .../archive`: esconde a tarefa terminada (concluída ou cancelada) e as filhas dela. */
  async archiveTask(projectId: string, ref: string): Promise<Project> {
    const project = this.plans.find((candidate) => candidate.id === projectId);
    if (!project) throw new HttpError(404, `Projeto "${projectId}" não encontrado`);
    const before = structuredClone(project);
    const task = requireTask(project, ref);
    const below = subtreeOf(project, ref);
    const subtree = project.tasks.filter((candidate) => candidate.ref === ref || below.has(candidate.ref));
    const leaves = subtree.filter((node) => !node.group && !project.tasks.some((child) => child.parent === node.ref));
    if (leaves.length === 0 ? !isProjectTaskFinished(task) : !leaves.every(isProjectTaskFinished)) throw new HttpError(409, "Só dá para arquivar o que já terminou (concluído ou cancelado)");
    for (const node of subtree) node.archived = true;
    return this.finishEdit(project, before, "tarefa-arquivada", `Você arquivou ${quoteName(shorten(task.title, 60))} em ${quoteName(shorten(project.title, 60))}`, { ref });
  }

  /** `POST .../label`: liga uma etiqueta do projeto (cria se não existir) a uma tarefa. */
  async labelTask(projectId: string, ref: string, name: string): Promise<Project> {
    const project = this.editable(projectId);
    const before = structuredClone(project);
    const task = requireTask(project, ref);
    try {
      const label = ensureLabel(project, name);
      if ((task.labels ?? []).includes(label.id)) return structuredClone(project);
      task.labels = [...(task.labels ?? []), label.id];
      task.updatedAt = this.at();
      assertValidTree(project);
    } catch (error) {
      this.restore(project, before);
      throw error;
    }
    return this.finishEdit(project, before, "tarefa-editada", `Você pôs a etiqueta ${quoteName(name)} em ${quoteName(shorten(task.title, 60))}`, { ref });
  }

  // ---------- Liberação: criar não executa; só entra na fila o que for liberado ----------

  /** O projeto que aceita liberar ou segurar: o que a tela pode mexer, menos o Avulsas (as tarefas dele nascem liberadas, sempre). */
  private releasable(id: string): Project {
    const project = this.editable(id);
    if (isAvulsas(project)) throw new HttpError(409, "As tarefas avulsas já nascem liberadas: não há o que liberar ou segurar");
    return project;
  }

  /**
   * `POST /projects/:id/release` (e a ferramenta do Maestro): libera tarefas ou módulos (`refs`; módulo = as folhas dele) ou o projeto inteiro
   * (`all`). `withPrerequisites` leva junto as Planejadas de que elas dependem. Quem já terminou, roda ou está liberado fica como está; sem
   * nada para liberar, devolve o projeto sem mudança. A fila anda na hora.
   */
  async releaseWork(projectId: string, input: { refs?: string[]; all?: boolean; withPrerequisites?: boolean }, by?: "maestro"): Promise<Project> {
    const project = this.releasable(projectId);
    const refs = [...new Set((input.refs ?? []).map((ref) => ref.trim()).filter(Boolean))];
    if (input.all !== true && refs.length === 0) throw new HttpError(400, "Diga o que liberar: tarefas ou módulos (refs), ou o projeto inteiro (all)");
    const before = structuredClone(project);
    const withPrerequisites = input.withPrerequisites === true;
    let released: string[];
    let prerequisites: Set<string>;
    try {
      prerequisites = new Set(withPrerequisites && input.all !== true ? prerequisiteClosure(project, refs) : []);
      released = releaseNodes(project, input.all === true ? "all" : refs, { withPrerequisites }, this.at());
    } catch (error) {
      this.restore(project, before);
      throw error;
    }
    if (isDeepStrictEqual(project.tasks, before.tasks)) return structuredClone(project);
    const title = quoteName(shorten(project.title, 60));
    const count = `${released.length} ${released.length === 1 ? "tarefa" : "tarefas"}`;
    const extra = [...prerequisites].filter((ref) => released.includes(ref)).length;
    const only = refs.length === 1 && input.all !== true ? requireTask(project, refs[0]!) : undefined;
    const what = input.all === true ? `todo o projeto (${count})` : only && !isLeaf(project, only) ? `o módulo ${quoteName(shorten(only.title, 60))}${released.length > 0 ? ` (${count})` : ""}` : `${count}${extra > 0 ? ` (${extra} como pré-requisito)` : ""}`;
    return this.finishEdit(project, before, "tarefas-liberadas", `Você liberou ${what} em ${title}`, { refs: released, ...(withPrerequisites ? { withPrerequisites: true } : {}) }, by);
  }

  /**
   * `POST /projects/:id/hold`: volta a Planejada o que ainda não começou (módulo = as folhas dele). Quem já roda, espera o dono, falhou ou
   * terminou fica como está; se NADA pôde ser segurado por isso, é 409 com o motivo. A folha que estava na fila sai dela.
   */
  async holdWork(projectId: string, input: { refs: string[] }, by?: "maestro"): Promise<Project> {
    const project = this.releasable(projectId);
    const refs = [...new Set(input.refs.map((ref) => ref.trim()).filter(Boolean))];
    if (refs.length === 0) throw new HttpError(400, "Diga o que segurar (refs)");
    const before = structuredClone(project);
    let result: ReturnType<typeof holdNodes>;
    try {
      result = holdNodes(project, refs, this.at());
    } catch (error) {
      this.restore(project, before);
      throw error;
    }
    if (result.held.length === 0 && result.ignored.length > 0) {
      this.restore(project, before);
      throw new HttpError(409, `Não dá para segurar: ${result.ignored.slice(0, 3).map((item) => `${quoteName(shorten(item.title, 40))} ${item.reason}`).join("; ")}`);
    }
    if (isDeepStrictEqual(project.tasks, before.tasks)) return structuredClone(project);
    const count = `${result.held.length} ${result.held.length === 1 ? "tarefa" : "tarefas"}`;
    const skipped = result.ignored.length > 0 ? `; ${result.ignored.length} já ${result.ignored.length === 1 ? "tinha começado" : "tinham começado"} e ${result.ignored.length === 1 ? "ficou" : "ficaram"} como estava` : "";
    return this.finishEdit(project, before, "tarefas-seguradas", `Você segurou ${count} em ${quoteName(shorten(project.title, 60))} (voltaram a Planejada${skipped})`, { refs: result.held, ignored: result.ignored.map((item) => item.ref) }, by);
  }

  /** Liga (objeto) ou desliga (`null`) a liberação diária do projeto; o mesmo que `PATCH /projects/:id` com `releasePace`. */
  async setReleasePace(projectId: string, pace: ProjectUpdate["releasePace"], by?: "maestro"): Promise<Project> {
    return this.updateProject(projectId, { releasePace: pace ?? null }, by);
  }

  /**
   * A liberação diária (agendador, a cada pump): para cada projeto ativo com `releasePace`, solta o lote do dia (código, sem acordar o
   * Maestro), grava, registra na Atividade e devolve quando acordar de novo (virada do dia, janela, "começa em").
   */
  private advanceAllRelease(): { projectId: string; wakeAt: number }[] {
    const now = this.deps.now().getTime();
    const changed: Project[] = [];
    const wakes: { projectId: string; wakeAt: number }[] = [];
    for (const plan of this.plans) {
      if (!plan.releasePace || plan.status !== "ativo" || !hasLifecycle(plan) || isSeedProject(plan)) continue;
      const run = applyReleasePace(plan, now, this.at());
      if (run.wakeAt !== undefined) wakes.push({ projectId: plan.id, wakeAt: run.wakeAt });
      if (run.released.length === 0) continue;
      plan.updatedAt = this.at();
      changed.push(plan);
      const unit = plan.releasePace.unit === "modulos" ? (run.units === 1 ? "módulo" : "módulos") : run.units === 1 ? "tarefa" : "tarefas";
      const leaves = `${run.released.length} ${run.released.length === 1 ? "tarefa" : "tarefas"}`;
      const summary = plan.releasePace.unit === "modulos" ? `A liberação diária liberou ${run.units} ${unit} (${leaves}) em ${quoteName(shorten(plan.title, 60))}` : `A liberação diária liberou ${leaves} em ${quoteName(shorten(plan.title, 60))}`;
      activeActivity()?.record({ workspaceId: this.deps.workspaceId, category: "plano", action: "liberacao-diaria", actor: ACTIVITY_SYSTEM, summary, refs: { planId: plan.id }, data: { refs: run.released, units: run.units, unit: plan.releasePace.unit } });
      this.deps.log.info({ projectId: plan.id, released: run.released.length, units: run.units }, "liberação diária");
    }
    if (changed.length > 0) void this.save(changed);
    return wakes;
  }

  // ---------- Sprints: o dono cria e conduz pela tela; as datas abrem e fecham no tick ----------

  /** O projeto que aceita sprints: o que a tela pode mexer, menos o Avulsas (fixo, sem sprints). */
  private sprintable(id: string): Project {
    const project = this.editable(id);
    if (isAvulsas(project)) throw new HttpError(409, "O projeto Avulsas não tem sprints: crie um projeto");
    return project;
  }

  /** Registra na Atividade o que o ciclo da sprint fez (o dono, ou o sistema quando foi a data). */
  private recordSprintEvents(project: Project, events: SprintEvent[], actor: string): void {
    for (const event of events) activeActivity()?.record({ workspaceId: this.deps.workspaceId, category: "plano", action: event.action, actor, summary: `${event.summary} em ${quoteName(shorten(project.title, 60))}`, refs: { planId: project.id }, data: event.data });
  }

  /** O tick e o agendador: abre e fecha as sprints cuja data chegou (projeto pausado não abre nem fecha). */
  private advanceAllSprints(): void {
    const now = this.deps.now().getTime();
    const changed: Project[] = [];
    for (const plan of this.plans) {
      if (!plan.sprints?.length) continue;
      const events = plan.status === "ativo" ? advanceSprints(plan, now) : [];
      // Cartão do resumo de toda sprint que fechou e ainda não tem (inclui o que ficou pendente num reinício do servidor).
      const cards = plan.status === "cancelado" ? false : this.syncSprintCards(plan);
      if (events.length === 0 && !cards) continue;
      plan.updatedAt = this.at();
      changed.push(plan);
      this.recordSprintEvents(plan, events, ACTIVITY_SYSTEM);
      if (events.length > 0) this.deps.log.info({ projectId: plan.id, events: events.map((event) => event.action) }, "sprints avançaram pela data");
    }
    if (changed.length > 0) void this.save(changed);
  }

  /**
   * Fecha a segunda fase do fechamento: cada sprint "fechando" sem cartão ganha o item `kind: "sprint"` em
   * Aprovações (nunca duplica: `forYouId` é gravado na hora, e um cartão sumido ou cancelado é refeito). No
   * Automático com o tipo "sprint" liberado (e dentro do teto do dia), o resumo é aprovado sozinho.
   * Devolve true se mudou o projeto (o chamador grava).
   */
  private syncSprintCards(project: Project): boolean {
    let changed = false;
    for (const sprint of closingSprints(project)) {
      const existing = sprint.forYouId ? this.deps.state.readForYou().find((item) => item.id === sprint.forYouId) : undefined;
      if (existing && existing.status !== "cancelado") continue;
      // Cartão decidido que já foi para o arquivo: o cartão existiu e foi decidido, não se cria outro (cartão de sprint cancelado nunca é arquivado: veja dueForArchive).
      if (!existing && sprint.forYouId && this.deps.forYou.isArchived(sprint.forYouId)) continue;
      const state = this.deps.state.read();
      const request = state.tasks.find((task) => task.id === requestIdOf(project));
      const verdict = this.autoReserve({ work: { projectId: project.id, ref: "", step: 0 } }, { type: "sprint" });
      const item = this.deps.forYou.openSpecial({
        kind: "sprint",
        agentId: findMaestroAgent(state)?.id ?? request?.agentId ?? "",
        roomId: request?.roomId ?? findMaestroRoom(state)?.id ?? "",
        projectId: project.id,
        sprintId: sprint.id,
        title: closingTitle(sprint),
        why: verdict.ok ? undefined : verdict.note,
        text: summaryText(sprint),
      });
      sprint.forYouId = item.id;
      changed = true;
      if (!verdict.ok) continue;
      try {
        const event = approveSprint(project, sprint.id, this.deps.now().getTime(), "automatico");
        activeActivity()?.record({ workspaceId: this.deps.workspaceId, category: "plano", action: event.action, actor: ACTIVITY_SYSTEM, summary: `Decidido sozinho: ${event.summary} em ${quoteName(shorten(project.title, 60))} (Automático · ${verdict.label})`, refs: { planId: project.id }, data: event.data });
        void this.deps.forYou.close(item.id, "aprovado", undefined, { decidedBy: "automatico" }).catch((error: unknown) => this.deps.log.error({ err: error }, "falha ao fechar o cartão da sprint aprovada sozinha"));
      } catch (error) {
        this.deps.log.error({ err: error, projectId: project.id }, "falha ao aprovar a sprint sozinha");
      }
    }
    return changed;
  }

  /**
   * Decisão do dono (ou da API) no cartão da sprint: aprovar a entrega fecha a sprint; devolver (com o motivo
   * e as tarefas marcadas) cria tarefas de retrabalho na sprint ativa e fecha mesmo assim.
   */
  async decideSprintItem(item: ForYouItem, decision: { status: "aprovado" | "rejeitado" | "respondido"; reason?: string; returnRefs?: string[] }): Promise<void> {
    const project = item.projectId ? this.plans.find((candidate) => candidate.id === item.projectId) : undefined;
    const sprint = project && item.sprintId ? project.sprints?.find((candidate) => candidate.id === item.sprintId) : undefined;
    if (!project || !sprint || sprint.status !== "fechando") {
      await this.deps.forYou.close(item.id, decision.status === "aprovado" ? "aprovado" : "rejeitado", decision.reason, { decidedBy: "usuario" });
      return;
    }
    const returning = decision.status !== "aprovado";
    const reason = decision.reason?.trim();
    if (returning && !reason) throw new HttpError(400, "Diga o motivo para devolver a entrega");
    if (!returning && decision.returnRefs?.length) throw new HttpError(400, "Só dá para marcar tarefas de retrabalho ao devolver a entrega");
    const before = structuredClone(project);
    const now = this.deps.now().getTime();
    let events: SprintEvent[];
    try {
      const refs = returning ? (decision.returnRefs ?? []) : [];
      const created = returning && refs.length > 0 ? createReworkTasks(project, sprint, refs, reason!, now, addNode) : [];
      events = [approveSprint(project, sprint.id, now, "usuario", returning ? { reason: reason!, refs: created.map((task) => task.ref) } : undefined)];
    } catch (error) {
      this.restore(project, before);
      throw error;
    }
    project.updatedAt = this.at();
    await this.saveUser(project, before);
    await this.deps.forYou.close(item.id, returning ? "rejeitado" : "aprovado", undefined, { decidedBy: "usuario", ...(returning ? { reason: reason! } : {}) });
    const event = events[0]!;
    activeActivity()?.record({ workspaceId: this.deps.workspaceId, category: "plano", action: event.action, actor: ACTIVITY_USER, summary: `Você decidiu: ${event.summary} em ${quoteName(shorten(project.title, 60))}`, refs: { planId: project.id }, data: event.data });
    if (project.status === "ativo") {
      this.pump();
      this.deps.orchestrator.retryWaiting();
    }
  }

  /** `POST /projects/:id/sprints`: nova sprint no fim (só em projeto que já tem sprints; projetos novos não usam sprints). */
  async createSprint(projectId: string, body: SprintCreateBody, by?: "maestro"): Promise<{ project: Project; sprintId: string }> {
    const project = this.sprintable(projectId);
    if (!hasSprints(project)) {
      throw new HttpError(409, by === "maestro" ? "Sprints are retired for new projects: use modules and release_work/set_release_pace" : "Projetos novos não usam sprints: use módulos e a liberação.");
    }
    const before = structuredClone(project);
    let sprintId: string;
    try {
      const sprint = addSprint(project, body, this.deps.now().getTime());
      sprintId = sprint.id;
      if (body.adoptOpen) for (const leaf of leavesOf(project)) if (!leaf.sprintId && !isProjectTaskFinished(leaf)) leaf.sprintId = sprint.id;
      assertValidTree(project);
    } catch (error) {
      this.restore(project, before);
      throw error;
    }
    const name = project.sprints!.find((sprint) => sprint.id === sprintId)!.name;
    const saved = await this.finishEdit(project, before, "sprint-criada", `Você criou a sprint ${quoteName(name)} em ${quoteName(shorten(project.title, 60))}`, { sprint: sprintId }, by);
    return { project: saved, sprintId };
  }

  /** `PATCH /projects/:id/sprints/:sid`: nome, objetivo e datas (inclusive estender o fim da ativa). */
  async updateSprint(projectId: string, sprintId: string, patch: SprintPatchBody, by?: "maestro"): Promise<Project> {
    const project = this.sprintable(projectId);
    if (!hasSprints(project)) {
      throw new HttpError(409, by === "maestro" ? "This project does not use sprints (sprints are retired for new projects: use modules and release_work/set_release_pace)" : "Este projeto não usa sprints");
    }
    const before = structuredClone(project);
    try {
      editSprint(project, sprintId, patch);
    } catch (error) {
      this.restore(project, before);
      throw error;
    }
    const sprint = requireSprint(project, sprintId);
    return this.finishEdit(project, before, "sprint-editada", `Você mudou a sprint ${quoteName(sprint.name)} em ${quoteName(shorten(project.title, 60))} (${Object.keys(patch).join(", ")})`, { sprint: sprintId }, by);
  }

  /** `DELETE /projects/:id/sprints/:sid`: só a planejada ou a vazia; as tarefas dela voltam para "sem sprint". */
  async deleteSprint(projectId: string, sprintId: string): Promise<Project> {
    const project = this.sprintable(projectId);
    const before = structuredClone(project);
    const name = requireSprint(project, sprintId).name;
    let freed: number;
    try {
      freed = removeSprint(project, sprintId).freed;
    } catch (error) {
      this.restore(project, before);
      throw error;
    }
    return this.finishEdit(project, before, "sprint-apagada", `Você apagou a sprint ${quoteName(name)} de ${quoteName(shorten(project.title, 60))}${freed > 0 ? ` (${freed} tarefa(s) ficaram sem sprint)` : ""}`, { sprint: sprintId, freed });
  }

  /** `POST /projects/:id/sprints/reorder`: a ordem das sprints (a sobra de uma que fecha vai para a seguinte nessa ordem). */
  async reorderSprints(projectId: string, ids: string[]): Promise<Project> {
    const project = this.sprintable(projectId);
    const before = structuredClone(project);
    try {
      reorderSprints(project, ids);
    } catch (error) {
      this.restore(project, before);
      throw error;
    }
    return this.finishEdit(project, before, "sprints-reordenadas", `Você reordenou as sprints de ${quoteName(shorten(project.title, 60))}`, { ids });
  }

  /** `POST .../sprints/:sid/start`: "Começar agora" (a ativa fecha e a sobra vem para esta). */
  async startSprint(projectId: string, sprintId: string): Promise<Project> {
    const project = this.sprintable(projectId);
    const before = structuredClone(project);
    let events: SprintEvent[];
    try {
      events = startSprintNow(project, sprintId, this.deps.now().getTime());
      assertValidTree(project);
    } catch (error) {
      this.restore(project, before);
      throw error;
    }
    this.syncSprintCards(project);
    this.recordSprintEvents(project, events.slice(0, -1), ACTIVITY_USER);
    return this.finishEdit(project, before, events.at(-1)!.action, `Você começou a sprint ${quoteName(requireSprint(project, sprintId).name)} agora em ${quoteName(shorten(project.title, 60))}`, events.at(-1)!.data);
  }

  /** `POST .../sprints/:sid/close`: "Fechar agora" (a sobra vai para a seguinte, por código). */
  async closeSprint(projectId: string, sprintId: string, by?: "maestro"): Promise<Project> {
    const project = this.sprintable(projectId);
    if (!hasSprints(project)) {
      throw new HttpError(409, by === "maestro" ? "This project does not use sprints (sprints are retired for new projects: use modules and release_work/set_release_pace)" : "Este projeto não usa sprints");
    }
    const before = structuredClone(project);
    let events: SprintEvent[];
    try {
      events = closeSprintNow(project, sprintId, this.deps.now().getTime());
    } catch (error) {
      this.restore(project, before);
      throw error;
    }
    this.syncSprintCards(project);
    const event = events[0]!;
    return this.finishEdit(project, before, event.action, `Você fechou agora: ${event.summary} em ${quoteName(shorten(project.title, 60))}`, event.data, by);
  }

  /** O id da sprint pelo id ("S2"), pelo número ou pelo nome (as ferramentas do Maestro aceitam qualquer um). */
  sprintIdOf(projectId: string, wanted: string): string {
    const project = this.require(projectId);
    if (!hasSprints(project)) {
      throw new Error("This project does not use sprints (sprints are retired for new projects: use modules and release_work/set_release_pace)");
    }
    const key = wanted.trim().toLowerCase();
    const found = (project.sprints ?? []).find((sprint) => sprint.id.toLowerCase() === key || sprint.id.slice(1) === key || sprint.name.trim().toLowerCase() === key);
    if (!found) throw new Error(`Sprint "${wanted}" does not exist in this project (sprints: ${(project.sprints ?? []).map((sprint) => `${sprint.id} ${sprint.name}`).join(", ") || "none"})`);
    return found.id;
  }

  /**
   * `assign_task` do Maestro: troca ou soma responsáveis de uma folha que ainda não começou. Um só: troca o dono.
   * `chain` (padrão): a folha vira mãe, com uma subtarefa por agente, cada uma depois da anterior (a entrega passa de mão em mão).
   * `parallel`: a mãe com uma subtarefa por agente, todas ao mesmo tempo. `sequence`: o formato antigo, etapas dentro de uma tarefa só.
   */
  async assignTask(projectId: string, ref: string, assignees: string[], mode: "chain" | "sequence" | "parallel" = "chain", by?: "maestro"): Promise<Project> {
    const project = this.editable(projectId);
    if (isAvulsas(project)) throw new HttpError(409, "As tarefas avulsas já têm agente: crie um projeto");
    const before = structuredClone(project);
    const task = requireTask(project, ref);
    const at = this.at();
    const ids = [...new Set(assignees.map((assignee) => this.assignable(assignee).id))];
    try {
      if (ids.length === 0) throw new HttpError(400, "Diga ao menos um responsável");
      if (ids.length > PROJECT_SAFETY.perCall) throw new HttpError(400, `No máximo ${PROJECT_SAFETY.perCall} responsáveis por vez (rede de segurança)`);
      if (task.group || project.tasks.some((candidate) => candidate.parent === task.ref)) throw new HttpError(400, "Task has subtasks: assign the subtasks (the parent's assignees come from them)");
      if (hasStarted(task)) throw new HttpError(409, "Task already started: its assignees can no longer change");
      if (ids.length === 1) this.assign(project, task, ids[0]!, at);
      else if (mode === "sequence") {
        const what = task.steps[0]?.what?.trim() || task.briefing || task.title;
        task.steps = ids.map((agentId, index) => ({ agentId, what: index === 0 ? what : `Continue from the previous step's result: ${task.briefing || task.title}`, status: "pendente" as const }));
        task.ownerId = ids[0]!;
        task.current = 0;
        task.status = idleStatus(project, task);
        if (task.status === "a_fazer") task.waitingSince = at;
        else delete task.waitingSince;
        task.updatedAt = at;
      } else {
        const { sprintId, dependsOn, doneWhen, briefing, title } = task;
        const inheritedReleased = isReleased(task);
        let previous: string | undefined;
        for (const agentId of ids) {
          const child = addNode(project, { title: `${title} · ${this.deps.state.read().agents.find((agent) => agent.id === agentId)?.name ?? agentId}`, parent: ref, briefing, assignee: agentId, priority: task.priority, released: inheritedReleased }, at);
          if (sprintId) child.sprintId = sprintId;
          // Em cadeia, cada subtarefa espera a anterior (e herda o que a mãe esperava só na primeira).
          child.dependsOn = mode === "chain" && previous ? [previous] : [...dependsOn];
          previous = child.ref;
          child.doneWhen = doneWhen.map((item) => ({ id: item.id, text: item.text }));
          child.status = idleStatus(project, child);
          if (child.status === "a_fazer") child.waitingSince = at;
          else delete child.waitingSince;
        }
        task.dependsOn = [];
        task.doneWhen = [];
      }
      assertValidTree(project);
    } catch (error) {
      this.restore(project, before);
      throw error;
    }
    return this.finishEdit(project, before, "tarefa-atribuida", `Você atribuiu ${quoteName(shorten(task.title, 60))} a ${ids.length} agente(s) (${mode}) em ${quoteName(shorten(project.title, 60))}`, { ref, assignees: ids, mode }, by);
  }

  // ---------- Apagar de vez: tarefas avulsas terminadas e projetos inteiros ----------

  /** A folha tem alguma Task do runner ainda na fila, rodando ou esperando o dono (as das etapas e as que `Task.work` aponta para ela)? */
  private leafBusy(state: OfficeState, leaf: ProjectTask, busy: ReadonlySet<string>): boolean {
    return leaf.steps.some((step) => step.taskId !== undefined && busy.has(step.taskId)) || state.tasks.some((task) => busy.has(task.id) && task.work?.projectId === AVULSAS_ID && task.work.ref === leaf.ref);
  }

  private activeTaskIds(state: OfficeState): Set<string> {
    return new Set(state.tasks.filter((task) => isActiveTaskStatus(task.status)).map((task) => task.id));
  }

  /** Ids das Tasks que a folha usou: as das etapas (`steps[].taskId`) e as que `Task.work` aponta para ela. */
  private leafTaskIds(state: OfficeState, leaf: ProjectTask): string[] {
    const fromSteps = leaf.steps.flatMap((step) => (step.taskId ? [step.taskId] : []));
    const fromWork = state.tasks.filter((task) => task.work?.projectId === AVULSAS_ID && task.work.ref === leaf.ref).map((task) => task.id);
    return [...new Set([...fromSteps, ...fromWork])];
  }

  /** As folhas (vivas e do arquivo mensal) que a limpeza apagaria agora: concluídas ou canceladas há mais de N dias, sem Task ativa. */
  private async cleanupCandidates(olderThanDays: number, includeArchive: boolean): Promise<{ live: ProjectTask[]; archived: ProjectTask[] }> {
    const now = this.deps.now().getTime();
    const state = this.deps.state.read();
    const busy = this.activeTaskIds(state);
    const deletable = (leaf: ProjectTask) => isDeletable(leaf, olderThanDays, now) && !this.leafBusy(state, leaf, busy);
    const live = this.avulsas()?.tasks.filter(deletable) ?? [];
    const archived = includeArchive && this.deps.archive ? await this.deps.archive.matching(deletable) : [];
    return { live: structuredClone(live), archived };
  }

  /** `GET /projects/avulsas/cleanup`: quantas folhas a limpeza apagaria agora (só lê). */
  async avulsasCleanupPreview(olderThanDays: number): Promise<AvulsasCleanupPreview> {
    const { live, archived } = await this.cleanupCandidates(olderThanDays, true);
    const oldest = [...live, ...archived].sort((a, b) => leafFinishedMs(a) - leafFinishedMs(b))[0];
    return { count: live.length, archivedCount: archived.length, ...(oldest ? { oldestAt: oldest.finishedAt ?? oldest.updatedAt } : {}) };
  }

  /**
   * `POST /projects/avulsas/cleanup`: apaga de vez as folhas concluídas ou canceladas há mais de N dias (e, com
   * `includeArchive`, as do arquivo mensal). Nunca apaga folha aberta, em andamento, esperando o dono ou com Task
   * ativa. `by: "sistema"` é a limpeza diária da retenção.
   */
  async cleanupAvulsas(body: AvulsasCleanupBody, by: "usuario" | "sistema" = "usuario"): Promise<AvulsasCleanupResult> {
    const { live, archived } = await this.cleanupCandidates(body.olderThanDays, body.includeArchive === true);
    if (live.length === 0 && archived.length === 0) return { deleted: 0, archivedDeleted: 0 };
    const done = await this.dropLeaves(new Set(live.map((leaf) => leaf.ref)), new Set(archived.map((leaf) => leaf.ref)));
    const total = done.live.length + done.archived.length;
    if (total > 0) {
      const one = total === 1;
      const summary = by === "usuario" ? `Você apagou ${total} ${one ? "tarefa avulsa" : "tarefas avulsas"}` : `${total} ${one ? "tarefa avulsa terminada" : "tarefas avulsas terminadas"} há mais de ${body.olderThanDays} dias ${one ? "foi apagada" : "foram apagadas"}`;
      activeActivity()?.record({ workspaceId: this.deps.workspaceId, category: "plano", action: "avulsas-apagadas", actor: by === "usuario" ? ACTIVITY_USER : ACTIVITY_SYSTEM, summary, refs: { planId: AVULSAS_ID }, data: { deleted: done.live.length, archivedDeleted: done.archived.length, olderThanDays: body.olderThanDays } });
    }
    return { deleted: done.live.length, archivedDeleted: done.archived.length };
  }

  /**
   * `DELETE /projects/:id/tasks/:ref` (e `delete_task` do Maestro): apaga o item e toda a subárvore (tarefa, subtarefa ou módulo) de
   * qualquer projeto. No Avulsas mantém o comportamento das folhas terminadas (`deleteAvulsasTask`). Recusa se alguma folha da subárvore
   * está `em_andamento` ou `esperando_voce`; limpa Tasks das etapas, itens do "Para você", logs e referências em `dependsOn` dos outros;
   * recalcula o estado ocioso e grava snapshot na Atividade.
   */
  async deleteTask(projectId: string, ref: string, options: { by?: "usuario" | "maestro"; reason?: string } = {}): Promise<TaskDeleteResult> {
    if (projectId === AVULSAS_ID) {
      const project = await this.deleteAvulsasTask(projectId, ref, options.by);
      return { project, deleted: [ref], cleanedDependsOn: [] };
    }
    const project = this.editable(projectId);
    const target = requireTask(project, ref);
    const removedRefs = subtreeRefs(project, ref);
    const removedSet = new Set(removedRefs);
    const removedNodes = project.tasks.filter((task) => removedSet.has(task.ref));
    const removedLeaves = leavesOf(project, ref);
    const state = this.deps.state.read();
    const stepIds = new Set(removedNodes.flatMap((task) => task.steps.flatMap((step) => (step.taskId ? [step.taskId] : []))));
    const owned = state.tasks.filter((task) => task.role !== "request" && ((task.work?.projectId === projectId && removedSet.has(task.work.ref)) || stepIds.has(task.id)));
    const busyLeaf =
      removedLeaves.find((leaf) => leaf.status === "em_andamento" || leaf.status === "esperando_voce") ??
      removedNodes.find((node) => node.status === "em_andamento" || node.status === "esperando_voce");
    const busyTask = owned.find((task) => task.status === "in_progress" || task.status === "waiting_approval");
    if (busyLeaf || busyTask) {
      throw new HttpError(
        409,
        options.by === "maestro"
          ? `Cannot delete ${ref}: "${busyLeaf?.title ?? ref}" is currently running or waiting for the owner. Cancel it or wait for it to finish first.`
          : "Não dá para apagar enquanto houver tarefa em andamento ou esperando você: cancele ou espere terminar antes",
      );
    }
    const before = structuredClone(project);
    const at = this.at();
    const cleanedDependsOn: { ref: string; removed: string[] }[] = [];
    try {
      project.tasks = project.tasks.filter((task) => !removedSet.has(task.ref));
      if (target.parent && !removedSet.has(target.parent)) restoreEmptyParent(project, target.parent, at);
      for (const task of project.tasks) {
        const dropped = task.dependsOn.filter((dep) => removedSet.has(dep));
        if (dropped.length === 0) continue;
        task.dependsOn = task.dependsOn.filter((dep) => !removedSet.has(dep));
        task.updatedAt = at;
        cleanedDependsOn.push({ ref: task.ref, removed: dropped });
      }
      refreshIdle(project, at);
      project.updatedAt = at;
      assertValidTree(project);
    } catch (error) {
      this.restore(project, before);
      throw error;
    }
    const cancelReason = options.by === "maestro" ? "Tarefa apagada pelo Maestro" : "Tarefa apagada pelo usuário";
    for (const task of owned) if (task.status === "queued") this.deps.orchestrator.cancelTask(task.id, cancelReason);
    const fresh = this.deps.state.read();
    const ownedIds = new Set(owned.map((task) => task.id));
    const tasks = fresh.tasks.filter((task) => !ownedIds.has(task.id));
    const removedTaskIds = fresh.tasks.filter((task) => ownedIds.has(task.id)).map((task) => task.id);
    const items = this.deps.state.readForYou();
    const forYou = dropForYouItems(items, (item) => (item.projectId === projectId && item.taskRef !== undefined && removedSet.has(item.taskRef)) || (item.taskId !== undefined && ownedIds.has(item.taskId)));
    const copies = this.copies([project]);
    const events: ServerEvent[] = [
      ...forYou.events,
      ...(removedTaskIds.length > 0 ? [{ type: "office:snapshot" as const, office: { ...fresh, tasks } }] : []),
      { type: "project:upserted", project: structuredClone(copies[0]!) },
    ];
    try {
      await persistOrThrow(
        (attempt) => this.deps.state.commit({ projects: copies, ...(removedTaskIds.length > 0 ? { tasks } : {}), ...(forYou.forYou ? { forYou: forYou.forYou } : {}), events: attempt === 0 ? events : [] }),
        { ...this.persistOptions("a exclusão do item"), fail: (error) => new HttpError(500, `Não consegui gravar no disco: ${error instanceof Error ? error.message : String(error)}`) },
      );
    } catch (error) {
      this.restore(project, before);
      void this.deps.state.commit({ projects: [structuredClone(before)], tasks: fresh.tasks, forYou: items, events: [{ type: "project:upserted", project: structuredClone(before) }] }).catch(() => undefined);
      throw error;
    }
    if (removedTaskIds.length > 0) await this.deps.cleanup?.removeLeftovers({ taskIds: removedTaskIds });
    const who = options.by === "maestro" ? "O Maestro" : "Você";
    const actor = options.by === "maestro" ? ACTIVITY_MAESTRO : ACTIVITY_USER;
    const itemsNote = removedRefs.length > 1 ? ` (${removedRefs.length} itens)` : "";
    activeActivity()?.record({
      workspaceId: this.deps.workspaceId,
      category: "plano",
      action: "tarefa-apagada",
      actor,
      summary: `${who} apagou ${quoteName(shorten(target.title, 60))}${itemsNote} em ${quoteName(shorten(project.title, 60))}`,
      refs: { planId: project.id },
      data: {
        ref: target.ref,
        title: target.title,
        briefing: target.briefing,
        ...(target.parent ? { parent: target.parent } : {}),
        deletedRefs: removedRefs,
        ...(cleanedDependsOn.length > 0 ? { cleanedDependsOn } : {}),
        ...(options.reason ? { reason: options.reason } : {}),
      },
    });
    this.deps.log.info({ projectId, ref, deleted: removedRefs.length, cleanedDeps: cleanedDependsOn.length }, "item do projeto apagado");
    if (project.status === "ativo") {
      this.pump();
      this.deps.orchestrator.retryWaiting();
    }
    return { project: structuredClone(project), deleted: removedRefs, cleanedDependsOn };
  }

  /** `DELETE /projects/avulsas/tasks/:ref`: apaga UMA folha do Avulsas já terminada (no arquivo vivo ou no mensal). */
  async deleteAvulsasTask(projectId: string, ref: string, by: "usuario" | "maestro" = "usuario"): Promise<Project> {
    if (projectId !== AVULSAS_ID) {
      if (!this.plans.some((candidate) => candidate.id === projectId)) throw new HttpError(404, `Projeto "${projectId}" não encontrado`);
      throw new HttpError(409, "Só dá para apagar tarefas do projeto Avulsas por este método");
    }
    const live = this.avulsas()?.tasks.find((candidate) => candidate.ref === ref);
    const leaf = live ?? (await this.deps.archive?.find(ref));
    if (!leaf) throw new HttpError(404, `A tarefa avulsa "${ref}" não existe`);
    if (!isCleanable(leaf)) throw new HttpError(409, "A tarefa ainda não terminou: só dá para apagar o que já foi concluído ou cancelado");
    const state = this.deps.state.read();
    if (this.leafBusy(state, leaf, this.activeTaskIds(state))) throw new HttpError(409, "A tarefa ainda tem uma execução em andamento: pare antes de apagar");
    const done = await this.dropLeaves(new Set(live ? [ref] : []), new Set(live ? [] : [ref]));
    if (done.live.length + done.archived.length > 0) {
      const who = by === "maestro" ? "O Maestro" : "Você";
      activeActivity()?.record({ workspaceId: this.deps.workspaceId, category: "plano", action: "avulsa-apagada", actor: by === "maestro" ? ACTIVITY_MAESTRO : ACTIVITY_USER, summary: `${who} apagou a tarefa avulsa ${quoteName(shorten(leaf.title, 60))}`, refs: { planId: AVULSAS_ID }, data: { ref } });
    }
    return structuredClone(this.avulsas() ?? emptyAvulsas(this.at()));
  }

  /**
   * Tira de vez as folhas dadas (por `ref`) do arquivo mensal e do vivo, com as Tasks que elas usaram, os itens do
   * "Para você" ligados a elas e os logs. Ordem: o arquivo mensal (escrita atômica) primeiro; depois o estado vivo (projeto,
   * Tasks e "Para você") num commit só, sem `await` no meio, conferindo de novo que a folha segue terminada e sem Task
   * ativa; por último os logs (o pesado). Uma queda no meio deixa, no pior caso, uma sobra sem dono (log ou Task), nunca
   * folha sem arquivo. Idempotente: o que já saiu não conta.
   */
  private async dropLeaves(liveRefs: ReadonlySet<string>, archivedRefs: ReadonlySet<string>): Promise<{ live: ProjectTask[]; archived: ProjectTask[] }> {
    const archived = archivedRefs.size > 0 && this.deps.archive ? await this.deps.archive.remove((leaf) => archivedRefs.has(leaf.ref) && isCleanable(leaf)) : [];
    const avulsas = this.avulsas();
    const state = this.deps.state.read();
    const busy = this.activeTaskIds(state);
    const live = avulsas ? avulsas.tasks.filter((leaf) => liveRefs.has(leaf.ref) && isCleanable(leaf) && !this.leafBusy(state, leaf, busy)) : [];
    if (live.length === 0 && archived.length === 0) return { live: [], archived: [] };
    const goneRefs = new Set(live.map((leaf) => leaf.ref));
    const keptLeaves = avulsas ? avulsas.tasks.filter((leaf) => !goneRefs.has(leaf.ref)) : [];
    // As Tasks que alguma folha que fica ainda usa nunca saem.
    const inUse = new Set(keptLeaves.flatMap((leaf) => this.leafTaskIds(state, leaf)));
    const dropIds = new Set([...live, ...archived].flatMap((leaf) => this.leafTaskIds(state, leaf)).filter((id) => !inUse.has(id) && !busy.has(id)));
    const tasks = state.tasks.filter((task) => !(dropIds.has(task.id) && task.role !== "request"));
    const removedIds = state.tasks.filter((task) => !tasks.includes(task)).map((task) => task.id);
    const droppedIds = new Set(removedIds);
    const items = this.deps.state.readForYou();
    const forYou = dropForYouItems(items, (item) => item.taskId !== undefined && droppedIds.has(item.taskId));
    const taskEvents: ServerEvent[] = removedIds.length > 0 ? [{ type: "office:snapshot", office: { ...state, tasks } }] : [];
    const fail = (error: unknown) => new HttpError(500, `Não consegui gravar no disco: ${error instanceof Error ? error.message : String(error)}`);
    if (avulsas && live.length > 0) {
      const before = structuredClone(avulsas);
      avulsas.tasks = keptLeaves;
      avulsas.updatedAt = this.at();
      const copies = this.copies([avulsas]);
      const events: ServerEvent[] = [...forYou.events, ...taskEvents, { type: "project:upserted", project: structuredClone(copies[0]!) }];
      try {
        await persistOrThrow((attempt) => this.deps.state.commit({ projects: copies, ...(removedIds.length > 0 ? { tasks } : {}), ...(forYou.forYou ? { forYou: forYou.forYou } : {}), events: attempt === 0 ? events : [] }), { ...this.persistOptions("a limpeza das tarefas avulsas"), fail });
      } catch (error) {
        const index = this.plans.indexOf(avulsas);
        if (index >= 0) this.plans[index] = before;
        void this.deps.state.commit({ projects: [before], tasks: state.tasks, forYou: items, events: [{ type: "project:upserted", project: structuredClone(before) }] }).catch(() => undefined);
        throw error;
      }
    } else if (removedIds.length > 0 || forYou.forYou) {
      // Só folhas do arquivo mensal: as Tasks e os itens delas saem sem mexer no projeto vivo.
      const events: ServerEvent[] = [...forYou.events, ...taskEvents];
      await persistOrThrow((attempt) => this.deps.state.commit({ ...(removedIds.length > 0 ? { tasks } : {}), ...(forYou.forYou ? { forYou: forYou.forYou } : {}), events: attempt === 0 ? events : [] }), { ...this.persistOptions("a limpeza das tarefas avulsas"), fail });
    }
    // O estado novo já está no disco: só agora os logs (uma queda aqui deixa log sem dono; a varredura do boot apaga).
    await this.deps.cleanup?.removeLeftovers({ taskIds: removedIds });
    this.deps.log.info({ deleted: live.length, archivedDeleted: archived.length }, "tarefas avulsas apagadas");
    return { live, archived };
  }

  /**
   * `DELETE /projects/:id`: apaga um projeto comum inteiro (arquivo do projeto, tarefas, sprints, as Tasks das etapas, os
   * itens do "Para você" e os logs). 409 no Avulsas e com tarefa rodando ou esperando o dono. As tarefas que ainda não
   * começaram saem junto: o projeto sai da lista do agendador antes de qualquer outra coisa, então nada dispara depois.
   */
  async deleteProject(id: string): Promise<ProjectDeleteResult> {
    if (id === AVULSAS_ID) throw new HttpError(409, "O projeto Avulsas nunca é apagado: apague as tarefas dele");
    const index = this.plans.findIndex((candidate) => candidate.id === id && !isAvulsas(candidate));
    const project = this.plans[index];
    if (!project) {
      if (this.leavesOfRequest(id).length > 0) throw new HttpError(409, "Este pedido é uma tarefa avulsa: apague a tarefa no projeto Avulsas");
      throw new HttpError(404, `Projeto "${id}" não encontrado`);
    }
    const state = this.deps.state.read();
    const stepIds = new Set(project.tasks.flatMap((task) => task.steps.flatMap((step) => (step.taskId ? [step.taskId] : []))));
    const owned = state.tasks.filter((task) => task.role !== "request" && (task.work?.projectId === id || stepIds.has(task.id)));
    const holding = project.tasks.some((task) => task.status === "em_andamento" || task.status === "esperando_voce") || owned.some((task) => task.status === "in_progress" || task.status === "waiting_approval");
    if (holding) throw new HttpError(409, "Pare as tarefas em andamento antes de apagar o projeto");
    const wasOpen = isProjectOpen(project) && hasLifecycle(project);
    const items = this.deps.state.readForYou();
    const attached = new Set([project.forYouId, ...(project.sprints ?? []).map((sprint) => sprint.forYouId)].filter((value): value is string => value !== undefined));
    const ownedIds = new Set(owned.map((task) => task.id));
    // Daqui até o commit não há `await`: o agendador nunca vê o projeto pela metade.
    this.plans.splice(index, 1);
    for (const task of owned) if (task.status === "queued") this.deps.orchestrator.cancelTask(task.id, "Projeto apagado pelo usuário");
    const fresh = this.deps.state.read();
    const tasks = fresh.tasks.filter((task) => !ownedIds.has(task.id));
    const forYou = dropForYouItems(items, (item) => item.projectId === id || attached.has(item.id) || (item.taskId !== undefined && ownedIds.has(item.taskId)));
    const events: ServerEvent[] = [...forYou.events, ...(tasks.length !== fresh.tasks.length ? [{ type: "office:snapshot" as const, office: { ...fresh, tasks } }] : []), { type: "project:deleted", id }, { type: "project:removed", id }];
    try {
      await persistOrThrow((attempt) => this.deps.state.commit({ deletedProjects: [id], tasks, ...(forYou.forYou ? { forYou: forYou.forYou } : {}), events: attempt === 0 ? events : [] }), {
        ...this.persistOptions("a exclusão do projeto"),
        fail: (error) => new HttpError(500, `Não consegui gravar no disco: ${error instanceof Error ? error.message : String(error)}`),
      });
    } catch (error) {
      this.plans.splice(Math.min(index, this.plans.length), 0, project);
      void this.deps.state.commit({ projects: [structuredClone(project)], tasks: fresh.tasks, forYou: items, events: [{ type: "project:upserted", project: structuredClone(project) }] }).catch(() => undefined);
      throw error;
    }
    this.handoffWarned.delete(id);
    // O estado novo já está no disco: só agora os logs.
    const taskIds = [...ownedIds];
    const logs = (await this.deps.cleanup?.countTaskLogs(taskIds)) ?? 0;
    await this.deps.cleanup?.removeLeftovers({ taskIds });
    const reqId = requestIdOf(project);
    if (wasOpen && !this.holds(reqId)) this.deps.host(reqId)?.close(reqId, "Projeto apagado pelo usuário");
    activeActivity()?.record({ workspaceId: this.deps.workspaceId, category: "plano", action: "projeto-apagado", actor: ACTIVITY_USER, summary: `Você apagou o projeto ${quoteName(shorten(project.title, 60))}`, refs: { planId: id }, data: { tasks: project.tasks.length, logs } });
    this.deps.log.info({ projectId: id, tasks: project.tasks.length, logs }, "projeto apagado");
    this.pump();
    this.deps.orchestrator.retryWaiting();
    return { deleted: { tasks: project.tasks.length, logs } };
  }

  // ---------- Converter: tarefa avulsa <-> projeto ----------

  /** As Tasks do runner que executam as etapas da folha (as que `Task.work` aponta para ela). */
  private runnerTasksOf(state: OfficeState, projectId: string, ref: string): Task[] {
    return state.tasks.filter((task) => task.work?.projectId === projectId && task.work.ref === ref);
  }

  /** Aponta as Tasks, os itens do Para você e as rotinas para a tarefa nova (`to`) e grava tudo junto com os projetos. `state`: a cópia do estado onde o chamador já pôs Tasks novas. */
  private async rewire(from: { projectId: string; ref: string }, to: { projectId: string; ref: string }, changed: Project[], deletedProjects: string[], state: OfficeState = this.deps.state.read()): Promise<void> {
    const mine = this.runnerTasksOf(state, from.projectId, from.ref);
    const ids = new Set(mine.map((task) => task.id));
    const events: ServerEvent[] = [];
    for (const task of mine) {
      task.work = { projectId: to.projectId, ref: to.ref, step: task.work?.step ?? 0 };
      events.push({ type: "task:upserted", task: structuredClone(task) });
    }
    const items = this.deps.state.readForYou();
    const movedItems = items.filter((item) => (item.taskId && ids.has(item.taskId)) || (item.projectId === from.projectId && item.taskRef === from.ref));
    for (const item of movedItems) {
      item.projectId = to.projectId;
      item.taskRef = to.ref;
      events.push({ type: "foryou:upserted", item: structuredClone(item) });
    }
    const copies = this.copies(changed);
    for (const project of copies) events.push({ type: "project:upserted", project: structuredClone(project) });
    for (const id of deletedProjects) events.push({ type: "project:deleted", id });
    await persistOrThrow(
      (attempt) => this.deps.state.commit({ projects: copies, ...(deletedProjects.length ? { deletedProjects } : {}), ...(mine.length ? { tasks: state.tasks } : {}), ...(movedItems.length ? { forYou: items } : {}), events: attempt === 0 ? events : [] }),
      { ...this.persistOptions("a conversão"), fail: (error) => new HttpError(500, `Não consegui gravar no disco: ${error instanceof Error ? error.message : String(error)}`) },
    );
    this.deps.remapRoutineRuns?.(ids, to.projectId);
  }

  /** `POST /projects/avulsas/tasks/:ref/convert`: a tarefa avulsa vira um projeto próprio (com ritmo, pausa e modo Automático). */
  async convertTaskToProject(ref: string): Promise<Project> {
    const avulsas = this.avulsas();
    if (!avulsas) throw new HttpError(404, "O projeto Avulsas não existe neste workspace");
    const leaf = avulsas.tasks.find((candidate) => candidate.ref === ref);
    if (!leaf) throw new HttpError(404, `A tarefa avulsa "${ref}" não existe`);
    if (isProjectTaskFinished(leaf) || leaf.status === "falhou") throw new HttpError(409, "A tarefa já terminou: só dá para converter o que está aberto");
    const at = this.at();
    const projectId = randomUUID();
    const mine = structuredClone(leaf);
    delete mine.meta;
    delete mine.parent;
    mine.ref = "T1";
    mine.order = 1000;
    const step = mine.steps[0];
    if (step?.taskId) {
      // Já foi entregue ao agente: a etapa fica "em andamento" (é assim que o agendador do projeto enxerga uma etapa entregue).
      if (step.status !== "feita") step.status = "em_andamento";
      if (mine.status === "a_fazer" || mine.status === "backlog") mine.status = "em_andamento";
    }
    const brief = leaf.meta?.brief;
    const project: Project = {
      ...projectDefaults(),
      origin: "usuario",
      id: projectId,
      kind: "projeto",
      title: leaf.title,
      status: "ativo",
      version: 1,
      priority: leaf.priority,
      ...(leaf.dueAt ? { dueAt: leaf.dueAt } : {}),
      ...(leaf.startAt ? { startAt: leaf.startAt } : {}),
      ...(brief ? { brief } : {}),
      ...(leaf.meta?.routineRef ? { routineRef: structuredClone(leaf.meta.routineRef) } : {}),
      ...(leaf.doneWhen.length ? { doneWhen: structuredClone(leaf.doneWhen) } : {}),
      labels: [],
      sprints: [],
      tasks: [mine],
      createdAt: leaf.meta?.createdAt ?? at,
      updatedAt: at,
      approvedAt: at,
    };
    const beforeAvulsas = structuredClone(avulsas);
    avulsas.tasks = avulsas.tasks.filter((candidate) => candidate.ref !== ref);
    avulsas.updatedAt = at;
    this.plans.push(project);
    try {
      await this.rewire({ projectId: AVULSAS_ID, ref }, { projectId, ref: "T1" }, [avulsas, project], []);
    } catch (error) {
      this.plans.splice(this.plans.indexOf(project), 1);
      this.plans[this.plans.indexOf(avulsas)] = beforeAvulsas;
      throw error;
    }
    activeActivity()?.record({ workspaceId: this.deps.workspaceId, category: "plano", action: "convertida-em-projeto", actor: ACTIVITY_USER, summary: `Você transformou a tarefa ${quoteName(shorten(leaf.title, 60))} em projeto`, refs: { planId: projectId }, data: { from: ref } });
    this.pump();
    this.deps.orchestrator.retryWaiting();
    return structuredClone(project);
  }

  /** `POST /projects/:id/convert`: o projeto de uma tarefa só vira tarefa avulsa (some o projeto, nasce a folha no Avulsas). */
  async convertProjectToTask(projectId: string): Promise<Project> {
    const project = this.plans.find((candidate) => candidate.id === projectId);
    if (!project) throw new HttpError(404, `Projeto "${projectId}" não encontrado`);
    if (isAvulsas(project)) throw new HttpError(409, "O projeto Avulsas é fixo: não se converte");
    if (hasLifecycle(project) && project.origin !== "usuario") throw new HttpError(409, "Este projeto veio de um plano do Maestro: ele continua projeto até terminar");
    if (project.status !== "ativo") throw new HttpError(409, project.status === "pausado" ? "Retome o projeto antes de converter: a tarefa avulsa não pausa" : "Só dá para converter um projeto em andamento");
    const live = project.tasks.filter((task) => !task.archived);
    const only = live[0];
    if (live.length !== 1 || !only || only.group || only.steps.length !== 1) throw new HttpError(409, "Só dá para virar tarefa avulsa um projeto com uma tarefa só, de um passo só");
    if (isProjectTaskFinished(only) || only.status === "falhou") throw new HttpError(409, "A tarefa já terminou");
    if (project.mode.kind === "automatico" || project.pace || project.joint) throw new HttpError(409, "O projeto tem modo Automático, ritmo ou parte conjunta: a tarefa avulsa não tem isso. Desligue antes, ou fique com o projeto.");
    if (!only.ownerId) throw new HttpError(409, "Escolha um responsável antes de converter");
    const state = this.deps.state.read();
    const avulsas = this.ensureAvulsas();
    const beforeAvulsas = structuredClone(avulsas);
    const at = this.at();
    const leaf = structuredClone(only);
    const ref = takeAvulsasRef(avulsas);
    leaf.ref = ref;
    delete leaf.parent;
    delete leaf.archived;
    leaf.order = (avulsas.tasks.reduce((max, task) => Math.max(max, task.order ?? 0), 0) || 0) + 1000;
    if (!leaf.dueAt && project.dueAt) leaf.dueAt = project.dueAt;
    if (!leaf.startAt && project.startAt) leaf.startAt = project.startAt;
    if (leaf.priority === "normal") leaf.priority = project.priority;
    if (leaf.doneWhen.length === 0 && project.doneWhen?.length) leaf.doneWhen = structuredClone(project.doneWhen);
    leaf.meta = { requestId: project.id, origin: "usuario", ...(project.brief ? { brief: project.brief } : {}), createdAt: project.createdAt };
    // A tarefa avulsa nasce liberada, sempre (o Avulsas não tem Planejada).
    delete leaf.released;
    const step = leaf.steps[0]!;
    if (!step.taskId) {
      // Nunca foi entregue: a folha do Avulsas só anda com uma Task na fila do agente (como o delegate_task cria).
      const agent = state.agents.find((candidate) => candidate.id === step.agentId);
      if (!agent) throw new HttpError(409, "O agente da tarefa não existe mais");
      const team = state.teams.find((candidate) => candidate.id === agent.teamId);
      const sub: Task = {
        id: randomUUID(),
        roomId: team?.roomId ?? "",
        teamId: agent.teamId,
        agentId: agent.id,
        projectId: project.id,
        routeReason: shorten(`Tarefa avulsa · ${leaf.title}`, 300),
        prompt: shorten2([leaf.title, leaf.briefing !== leaf.title ? leaf.briefing : ""].filter(Boolean).join("\n\n"), 3900),
        status: "queued",
        work: { projectId: project.id, ref: only.ref, step: 0 },
        createdAt: at,
        updatedAt: at,
      };
      state.tasks.push(sub);
      step.taskId = sub.id;
      leaf.status = "a_fazer";
    }
    if (step.status !== "feita") step.status = "pendente";
    avulsas.tasks.push(leaf);
    avulsas.updatedAt = at;
    const index = this.plans.indexOf(project);
    this.plans.splice(index, 1);
    try {
      await this.rewire({ projectId: project.id, ref: only.ref }, { projectId: AVULSAS_ID, ref }, [avulsas], [project.id], state);
    } catch (error) {
      this.plans.splice(index, 0, project);
      this.plans[this.plans.indexOf(avulsas)] = beforeAvulsas;
      throw error;
    }
    activeActivity()?.record({ workspaceId: this.deps.workspaceId, category: "plano", action: "convertido-em-tarefa", actor: ACTIVITY_USER, summary: `Você transformou o projeto ${quoteName(shorten(project.title, 60))} em tarefa avulsa`, refs: { planId: AVULSAS_ID }, data: { from: project.id } });
    this.deps.orchestrator.enqueue(leaf.steps[0]!.agentId);
    return structuredClone(avulsas);
  }

  // ---------- Modo Automático ----------

  /**
   * `POST /projects/:id/mode` (só o usuário chama; nenhuma ferramenta MCP chega aqui): liga o
   * Automático com a permissão, volta para "Pede OK" ou aceita/recusa a sugestão do Maestro. É o único
   * lugar que grava `grant.approvedAt`.
   */
  async setMode(id: string, body: ProjectModeBody): Promise<Project> {
    const project = this.plans.find((candidate) => candidate.id === id);
    if (!project && this.leavesOfRequest(id).length > 0) throw new HttpError(409, "O modo Automático vale para projeto, não para tarefa avulsa");
    if (!project) throw new HttpError(404, `Projeto "${id}" não encontrado`);
    if (isAvulsas(project)) throw new HttpError(409, "O modo Automático vale para projeto, não para tarefa avulsa");
    if (!isProjectOpen(project)) throw new HttpError(409, "O projeto já terminou");
    const at = this.at();
    const before = structuredClone(project);
    let grant: AutoGrant | undefined;
    if (body.kind === "automatico") {
      grant = { actions: [...new Set(body.actions)], dailyCap: body.dailyCap, ...(body.sites?.length ? { sites: [...new Set(body.sites)] } : {}), ...(body.connectors?.length ? { connectors: [...new Set(body.connectors)] } : {}), approvedAt: at };
    } else if (body.kind === "proposta") {
      if (!project.modeProposal) throw new HttpError(409, "Não há sugestão de modo neste projeto");
      if (body.accept) grant = { ...project.modeProposal.grant, approvedAt: at };
    }
    if (grant) {
      project.mode = { kind: "automatico", grant };
      delete project.modeProposal;
    } else {
      if (body.kind === "pede-ok") project.mode = { kind: "pede-ok" };
      else delete project.modeProposal;
    }
    project.updatedAt = at;
    await this.saveUser(project, before);
    const label = (list: string[]) => list.join(", ");
    const summary = grant
      ? `Você ligou o Automático em ${quoteName(shorten(project.title, 60))}: ${label(grant.actions)}${grant.dailyCap !== undefined ? `, até ${grant.dailyCap} por dia` : ""}${grant.sites?.length ? ` (sites: ${label(grant.sites)})` : ""}`
      : body.kind === "pede-ok"
        ? `Você voltou ${quoteName(shorten(project.title, 60))} para Pede OK`
        : `Você recusou a sugestão de rodar ${quoteName(shorten(project.title, 60))} no automático`;
    activeActivity()?.record({ workspaceId: this.deps.workspaceId, category: "plano", action: grant ? "automatico-ligado" : body.kind === "pede-ok" ? "automatico-desligado" : "automatico-recusado", actor: ACTIVITY_USER, summary, refs: { planId: id }, data: grant ? { actions: grant.actions, ...(grant.dailyCap !== undefined ? { dailyCap: grant.dailyCap } : {}) } : {} });
    this.deps.log.info({ projectId: id, mode: project.mode.kind, proposal: body.kind === "proposta" ? (body.accept ? "aceita" : "recusada") : undefined }, "modo do projeto mudou");
    return structuredClone(project);
  }

  /** Tipo de aprovação da tarefa de projeto (o do entregável): é o "tipo de ação" do clique sensível no Automático. */
  typeOf(task: Pick<Task, "work">): string | undefined {
    if (!task.work) return undefined;
    const project = this.plans.find((candidate) => candidate.id === task.work!.projectId);
    return project?.tasks.find((candidate) => candidate.ref === task.work!.ref)?.approvalType;
  }

  /**
   * Pede ao Modo Automático para liberar UMA ação (aprovação de um tipo ou clique sensível no
   * navegador) da tarefa de um projeto. Libera só se o projeto está em Automático, ativo (não pausado),
   * a ação está no `grant` e o teto do dia (America/Sao_Paulo) não acabou; nesse caso já conta o uso.
   * Quando não libera, `note` diz por quê (vai no cartão normal de "Pede OK").
   */
  autoReserve(task: Pick<Task, "work">, input: { type?: string; host?: string }): AutoVerdict {
    const project = task.work ? this.plans.find((candidate) => candidate.id === task.work!.projectId) : undefined;
    if (!project) return { ok: false };
    // Tarefa de rotina (projeto próprio ou folha do Avulsas): o modo e o teto do dia são DA ROTINA (soma das execuções do dia), lidos na hora.
    const leaf = isAvulsas(project) ? project.tasks.find((candidate) => candidate.ref === task.work!.ref) : undefined;
    const routineRef = leaf ? leaf.meta?.routineRef : project.origin === "rotina" ? project.routineRef : undefined;
    if (routineRef && this.deps.routineAuto) {
      if (project.status === "pausado") return { ok: false, note: "Projeto pausado: nada é aprovado sozinho" };
      if (project.status !== "ativo") return { ok: false };
      const verdict = this.deps.routineAuto(routineRef.routineId, input);
      return verdict.ok ? { ok: true, projectId: project.id, label: verdict.label } : verdict;
    }
    if (project.mode.kind !== "automatico") return { ok: false };
    const grant = project.mode.grant;
    if (project.status === "pausado") return { ok: false, note: "Projeto pausado: nada é aprovado sozinho" };
    if (project.status !== "ativo") return { ok: false };
    const now = this.deps.now().getTime();
    const used = autoUsedToday(project, now);
    const verdict = autoVerdict(grant, used, input);
    if (!verdict.ok) return verdict;
    project.autoUsage = { day: workClock(now).day, count: used + 1 };
    void this.save([project]);
    return { ok: true, projectId: project.id, label: verdict.label };
  }

  /** Ritmo validado (horas, janela HH:MM, paralelismo), sem campos vazios. */
  private normalizePace(input: Pace): Pace {
    const out: Pace = {};
    if (input.hoursPerDay !== undefined) {
      if (!Number.isFinite(input.hoursPerDay) || input.hoursPerDay <= 0 || input.hoursPerDay > 24) throw new HttpError(400, "Horas por dia: use um número entre 0 e 24");
      out.hoursPerDay = input.hoursPerDay;
    }
    if (input.window !== undefined) {
      if (parseClock(input.window.from) === undefined || parseClock(input.window.to) === undefined) throw new HttpError(400, "Janela de horário: use HH:MM");
      out.window = { from: input.window.from, to: input.window.to };
    }
    if (input.maxParallel !== undefined) {
      if (!Number.isInteger(input.maxParallel) || input.maxParallel < 1 || input.maxParallel > 10) throw new HttpError(400, "Em paralelo: use um inteiro de 1 a 10");
      out.maxParallel = input.maxParallel;
    }
    return out;
  }

  // ---------- Agendador: ordem e admissão das tarefas na fila dos agentes ----------

  /** Entrada da ordem de urgência de uma Task de projeto (prioridade, prazo, aprovado há mais tempo); undefined = não é de projeto ou ainda Planejada. */
  rankOf(task: Task): RankInput | undefined {
    const found = this.locateAny(task);
    if (!found || releaseHold(found.planTask)) return undefined;
    return taskRankInput(found.plan, found.planTask, found.plan.tasks.indexOf(found.planTask));
  }

  /**
   * O orquestrador pergunta antes de começar uma Task que está na fila do agente: false = o projeto
   * está pausado ou fora do ritmo (começa em, janela, limite de horas, em paralelo). Tarefas sem
   * projeto, e etapas de plano (já admitidas pelo agendador), passam.
   */
  admit(task: Task): boolean {
    const found = this.locateAny(task);
    if (!found || !isProjectOpen(found.plan) || this.stopped) return true;
    return this.scheduler.admitTask(found.plan, found.planTask);
  }

  /** Motor do agente sem cota (ou fora do ar) com a Task do projeto avulso esperando: vira bloqueio `cota`/`acesso`. */
  markEngineBlock(task: Task, block: { reason: string }, agentName: string): void {
    const found = this.locateAny(task);
    if (!found || hasLifecycle(found.plan) || this.stopped) return;
    const quota = block.reason === "quota" || block.reason === "paused";
    const note = `${agentName} indisponível (${block.reason === "paused" ? "pausado no limite do plano" : quota ? "sem cota" : "motor fora do ar"}): espera voltar`;
    const { planTask, plan } = found;
    if (planTask.blocked?.note === note) return;
    const at = this.at();
    setBlocked(planTask, { type: quota ? "cota" : "acesso", by: agentAddress(this.deps.workspaceId, task.agentId ?? ""), note, since: at }, at);
    Object.assign(planTask, { note, waitingSince: at, updatedAt: at });
    plan.updatedAt = at;
    void this.save([plan]);
  }

  /** Tempo médio das etapas já concluídas (começo -> fim), com no mínimo 3 de amostra; alimenta a urgência extra da ordem. */
  averageTaskMs(): number | undefined {
    let total = 0;
    let count = 0;
    for (const project of this.plans) {
      for (const task of project.tasks) {
        if (task.status !== "concluida" || !task.startedAt || !task.finishedAt) continue;
        const span = Date.parse(task.finishedAt) - Date.parse(task.startedAt);
        if (span > 0) {
          total += span;
          count += 1;
        }
      }
    }
    return count >= 3 ? total / count : undefined;
  }

  /** Quantos projetos abertos (com trabalho liberado) têm prazo atrasado ou em menos de 24 h (o dado do resumo da Gestão). */
  atRiskCount(): number {
    const now = this.deps.now().getTime();
    return expandAvulsas(this.plans).filter((project) => {
      if (!isDeadlineAtRisk(project, now)) return false;
      const open = leavesOf(project).filter((leaf) => !isProjectTaskFinished(leaf) && !leaf.archived);
      return open.length === 0 || open.some((leaf) => !releaseHold(leaf));
    }).length;
  }

  // ---------- Maestro ----------

  /** Resolve se o plano novo pede aprovação ou começa direto: a regra do workspace vence sobre a escolha do Maestro. */
  private resolvePlanApproval(requested: ProjectInputApproval | undefined): { effective: ProjectInputApproval; rule: PlanApprovalRule; by?: "regra" | "maestro"; quote?: string } {
    const settings = this.deps.planApproval?.() ?? { rule: DEFAULT_PLAN_APPROVAL };
    if (settings.rule === "always") return { effective: "ask", rule: "always" };
    if (settings.rule === "never") return { effective: "skip", rule: "never", by: "regra", ...(settings.note?.quote ? { quote: settings.note.quote } : {}) };
    const effective = requested ?? "ask";
    return effective === "skip" ? { effective: "skip", rule: "maestro", by: "maestro" } : { effective: "ask", rule: "maestro" };
  }

  /**
   * Aplica a ativação de um plano aprovado (seja pelo dono no cartão, pela regra "never" do workspace
   * ou pela escolha "skip" do Maestro): muda status para `ativo`, grava `approvedAt`/`approval`, ajusta
   * `released` (preservando o do Maestro quando `releaseOverride` é omitido), marca `waitingSince` e
   * avança sprints se o projeto legado tiver.
   */
  private applyApprovalState(plan: Project, at: string, approval: ProjectApproval, releaseOverride?: "all" | "none"): { sprintEvents: SprintEvent[]; effectiveRelease: "all" | "none" | "mixed"; count: number; releasedCount: number; plannedCount: number } {
    Object.assign(plan, { status: "ativo", approvedAt: at, approval, updatedAt: at });
    if (releaseOverride === "all") {
      for (const task of plan.tasks) task.released = true;
    } else if (releaseOverride === "none") {
      for (const task of plan.tasks) task.released = false;
    } else {
      // Sem escolha explícita do dono: mantém o `released` do Maestro (plano legado sem o campo nasce liberado).
      for (const task of plan.tasks) if (task.released === undefined) task.released = true;
    }
    for (const task of plan.tasks) if (task.status === "a_fazer" && task.released !== false) task.waitingSince = at;
    // A primeira sprint começa na data dela, ou agora se a data já passou (as datas andam juntas, na mesma duração).
    const firstSprint = sprintsInOrder(plan).find((sprint) => sprint.status === "planejada");
    if (firstSprint && Date.parse(firstSprint.endAt) <= Date.parse(at)) shiftSprints(plan, Date.parse(at) - Date.parse(firstSprint.startAt));
    const sprintEvents = advanceSprints(plan, Date.parse(at));
    const leaves = leafTasks(plan.tasks);
    const count = leaves.length;
    const plannedCount = leaves.filter((leaf) => leaf.released === false).length;
    const releasedCount = count - plannedCount;
    const effectiveRelease: "all" | "none" | "mixed" = releaseOverride ?? (plannedCount === 0 ? "all" : releasedCount === 0 ? "none" : "mixed");
    return { sprintEvents, effectiveRelease, count, releasedCount, plannedCount };
  }

  /**
   * `create_project` (`create_plan`): projeto novo para o pedido (ou a versão nova de um que ainda
   * não foi aprovado). Com `new_project: true`, cria um projeto ADICIONAL no mesmo pedido (UUID próprio
   * e `requestId` apontando para o pedido). Dependendo de `approval` e da regra do workspace, ou abre
   * o cartão em "Para você" (caminho "ask") ou já nasce aprovado e começa a distribuir as folhas
   * liberadas sem abrir cartão (caminho "skip"). Ordem: monta, GRAVA, e só então fecha item antigo /
   * abre cartão / dispara fila; se a gravação falhar, nada muda.
   */
  async propose(requestId: string, input: ProposeInput): Promise<Project> {
    const state = this.deps.state.read();
    const request = this.requireRequest(state, requestId);
    const sameIdIndex = this.plans.findIndex((candidate) => candidate.id === requestId && !isAvulsas(candidate));
    const sameId = sameIdIndex >= 0 ? this.plans[sameIdIndex] : undefined;
    let current: Project | undefined;
    let planId: string;
    let extraRequestId: string | undefined;
    if (input.new_project === true) {
      // Primeiro projeto do pedido mantém o id do pedido (compatibilidade); os extras ganham UUID próprio + `requestId`.
      if (!sameId) {
        planId = requestId;
      } else {
        planId = randomUUID();
        extraRequestId = requestId;
      }
    } else {
      // Se há um projeto do pedido em "ajustando" (inclusive um extra), a nova versão vai nele.
      const adjusting = this.plansForRequest(requestId).find((candidate) => candidate.status === "ajustando");
      const target = adjusting ?? sameId;
      if (target) {
        const isCynoShell = target.origin === "cyno" && !hasLifecycle(target) && target.tasks.length === 0;
        if (target.status === "proposto" || target.status === "ajustando") {
          current = target;
          planId = target.id;
        } else if (isCynoShell) {
          planId = target.id;
        } else if (target.status === "concluido" || target.status === "cancelado") {
          const stateLabel = target.status === "concluido" ? "completed" : "canceled";
          throw new Error(
            `This request already has a ${stateLabel} project (${target.id}). Do not overwrite it: use add_project_tasks or set_project_status(project_id: "${target.id}", status: "active") to reopen it, or call create_project with new_project: true to create another project.`,
          );
        } else {
          throw new Error(
            `This request already has an open project (${target.id}). To add work, use add_project_tasks; to create another project in this request, call create_project with new_project: true; to stop it, use set_project_status(project_id: "${target.id}", status: "canceled").`,
          );
        }
      } else {
        planId = requestId;
      }
    }
    if (input.tasks.some((task) => task.sprint?.trim())) {
      throw new Error("Sprints are retired for new projects: use modules and release_work/set_release_pace");
    }
    const at = this.at();
    const fields = this.projectFields(input, at);
    const built = buildProjectPlan({ tasks: input.tasks, labels: input.labels }, this.pool(state), at, this.deps.now().getTime(), fields.set.startAt);
    if (!built.ok) throw new Error(`Project rejected (fix these and call create_project again):\n- ${built.errors.join("\n- ")}`);
    applyInputRelease(built.tasks, input.tasks, input.release);
    const treeFields = { tasks: built.tasks, sprints: built.sprints, labels: built.labels };
    const title = input.title?.trim() || requestTitle(request) || "Plano";
    const summary = input.summary?.trim() || undefined;
    const oldItemId = current?.forYouId;
    const index = current ? this.plans.indexOf(current) : extraRequestId ? -1 : sameIdIndex;
    const previous = index >= 0 ? structuredClone(this.plans[index]!) : undefined;
    let plan: Project;
    if (current) {
      Object.assign(current, { title, ...treeFields, status: "proposto", version: current.version + 1, updatedAt: at, ...fields.set });
      for (const key of fields.clear) delete current[key];
      if (summary) current.summary = summary;
      else delete current.summary;
      plan = current;
    } else {
      // Um projeto-casca (pedido do Cyno: briefing, prioridade e prazos já gravados) passa o que tem para o projeto de verdade.
      const carried = !extraRequestId && previous?.origin === "cyno" ? carriedFromShell(previous) : {};
      plan = {
        ...projectDefaults(),
        ...carried,
        id: planId,
        ...(extraRequestId ? { requestId: extraRequestId } : {}),
        title,
        ...(summary ? { summary } : {}),
        status: "proposto",
        version: 1,
        ...treeFields,
        createdAt: previous?.createdAt ?? at,
        updatedAt: at,
        ...fields.set,
      };
      if (index >= 0) this.plans[index] = plan;
      else this.plans.push(plan);
    }
    const decision = this.resolvePlanApproval(input.approval);
    if (decision.effective === "skip") {
      delete plan.forYouId;
      const approval: ProjectApproval = { by: decision.by!, at, ...(decision.quote ? { quote: decision.quote } : {}) };
      const { sprintEvents, effectiveRelease } = this.applyApprovalState(plan, at, approval);
      try {
        await this.saveStrict([plan]);
      } catch (error) {
        if (previous && index >= 0) this.plans[index] = previous;
        else this.plans.splice(this.plans.indexOf(plan), 1);
        if (previous) void this.deps.state.commit({ projects: [previous], events: [] }).catch(() => undefined);
        throw error;
      }
      if (oldItemId) await this.deps.forYou.close(oldItemId, "respondido", `Substituído pela versão ${plan.version}`).catch((error: unknown) => this.deps.log.error({ err: error }, "falha ao fechar o item antigo do plano"));
      this.recordSprintEvents(plan, sprintEvents, ACTIVITY_SYSTEM);
      const whyLabel = decision.by === "regra" ? "regra do workspace" : "escolha do Maestro";
      activeActivity()?.record({
        workspaceId: this.deps.workspaceId,
        category: "plano",
        action: "plano-aprovado",
        actor: decision.by === "regra" ? ACTIVITY_SYSTEM : ACTIVITY_MAESTRO,
        summary: `Plano de «${shorten(plan.title, 60)}» começou sem pedir aprovação (${whyLabel})`,
        refs: { planId: plan.id },
        data: { release: effectiveRelease, approvalBy: decision.by },
      });
      this.logRequest(request, { kind: "status", status: "resumed", message: `Plano começou sem pedir aprovação (${whyLabel}): o servidor distribui as tarefas` });
      this.progress(plan);
      this.deps.log.info({ requestId, planId: plan.id, tasks: plan.tasks.length, version: plan.version, approvalBy: decision.by }, "plano aprovado sem pedir confirmação");
      this.pump();
      return structuredClone(plan);
    }
    try {
      // Sem evento ainda: o projeto só aparece para os clientes quando o item do "Para você" já existe (a gravação abaixo publica).
      await this.saveStrict([plan], true);
    } catch (error) {
      // Nada mudou de verdade: a memória volta ao que estava e o item antigo segue aberto.
      if (previous && index >= 0) this.plans[index] = previous;
      else this.plans.splice(this.plans.indexOf(plan), 1);
      if (previous) void this.deps.state.commit({ projects: [previous], events: [] }).catch(() => undefined);
      throw error;
    }
    if (oldItemId) await this.deps.forYou.close(oldItemId, "respondido", `Substituído pela versão ${plan.version}`).catch((error: unknown) => this.deps.log.error({ err: error }, "falha ao fechar o item antigo do plano"));
    const maestro = findMaestroAgent(state);
    const item = this.deps.forYou.openSpecial({
      kind: "plano",
      agentId: maestro?.id ?? request.agentId ?? "",
      roomId: request.roomId,
      taskId: request.id,
      projectId: plan.id,
      title: `Plano: ${title}`,
      why: `${leavesOf(plan).length} tarefa(s)${plan.sprints?.length ? ` em ${plan.sprints.length} sprint(s)` : ""} para aprovar antes de começar${plan.version > 1 ? ` (versão ${plan.version})` : ""}`,
      text: projectTreeMarkdown(plan, (id) => this.agentName(state, id)),
    });
    plan.forYouId = item.id;
    await this.save([plan]);
    this.logRequest(request, { kind: "text", text: `Plano ${plan.version > 1 ? `(versão ${plan.version}) ` : ""}com ${leavesOf(plan).length} tarefa(s) enviado para a sua aprovação.` });
    this.deps.host(requestId)?.awaitUser(requestId, "Plano esperando sua aprovação");
    this.deps.log.info({ requestId, planId: plan.id, tasks: plan.tasks.length, sprints: plan.sprints?.length ?? 0, version: plan.version }, "plano proposto");
    return structuredClone(plan);
  }

  /** Os campos de projeto que vêm do `create_project` (prazo, prioridade, ritmo, sugestão de modo), já validados. */
  private projectFields(input: ProposeInput, at: string): { set: Partial<Project>; clear: ("startAt" | "dueAt" | "pace" | "modeProposal")[] } {
    const set: Partial<Project> = {};
    const clear: ("startAt" | "dueAt" | "pace" | "modeProposal")[] = [];
    if (input.priority) {
      if (!PROJECT_INPUT_PRIORITIES.includes(input.priority)) throw new Error(`priority must be one of ${PROJECT_INPUT_PRIORITIES.join(", ")}`);
      set.priority = ({ high: "alta", normal: "normal", low: "baixa" } as const)[input.priority];
    }
    const startAt = isoFromInput(input.start_at);
    const dueAt = isoFromInput(input.due_at);
    if (input.start_at && !startAt) throw new Error(`start_at "${input.start_at}" is not a valid date (use ISO 8601)`);
    if (input.due_at && !dueAt) throw new Error(`due_at "${input.due_at}" is not a valid date (use ISO 8601)`);
    if (startAt && dueAt && startAt > dueAt) throw new Error("start_at is after due_at");
    if (startAt) set.startAt = startAt;
    else clear.push("startAt");
    if (dueAt) set.dueAt = dueAt;
    else clear.push("dueAt");
    const pace = paceFromInput(input.pace);
    if (pace) set.pace = pace;
    else clear.push("pace");
    if (input.suggested_mode === "auto") {
      const actions = (input.auto_scope?.actions ?? []).map((action) => action.trim()).filter(Boolean);
      if (actions.length === 0) throw new Error("suggested_mode \"auto\" needs auto_scope.actions (approval type ids the user would let run without asking)");
      // Só uma sugestão: o `mode` segue "pede-ok" até o usuário dar o OK (fatia 7 grava o `approvedAt` de verdade).
      set.modeProposal = {
        by: "maestro",
        at,
        grant: {
          actions,
          ...(input.auto_scope?.sites?.length ? { sites: input.auto_scope.sites } : {}),
          ...(input.auto_scope?.connectors?.length ? { connectors: input.auto_scope.connectors } : {}),
          ...(input.auto_scope?.daily_cap !== undefined ? { dailyCap: input.auto_scope.daily_cap } : {}),
          approvedAt: at,
        },
      };
    } else clear.push("modeProposal");
    return { set, clear };
  }

  /** Localiza o projeto para ferramentas do Maestro (`project_id` direto ou `request_id` do pedido; erro se o pedido tem vários). */
  private resolveTarget(target: ProjectTarget, options: { allowCompleted?: boolean; actionName: string }): Project {
    if (typeof target === "object" && "projectId" in target) {
      const plan = this.plans.find((candidate) => candidate.id === target.projectId && !isAvulsas(candidate));
      if (!plan) throw new Error(`Project "${target.projectId}" not found. Use list_projects.`);
      if (plan.status === "ajustando") throw new Error(`Project ${plan.id} is waiting for adjustments: send the new version with create_project.`);
      if (plan.status === "cancelado") throw new Error(`Project ${plan.id} is canceled: reopen it first with set_project_status(project_id: "${plan.id}", status: "active").`);
      if (plan.status === "concluido" && !options.allowCompleted) throw new Error(`Project ${plan.id} is completed: reopen it first with set_project_status(project_id: "${plan.id}", status: "active").`);
      return plan;
    }
    const id = typeof target === "string" ? target : target.requestId;
    const all = this.plansForRequest(id).filter((plan) => hasLifecycle(plan));
    const candidates = options.allowCompleted ? all.filter((plan) => isProjectOpen(plan) || plan.status === "concluido") : all.filter(isProjectOpen);
    if (candidates.length > 1) {
      const list = candidates.map((plan) => `${plan.id} («${plan.title}», ${plan.status})`).join("; ");
      throw new Error(`Request "${id}" has ${candidates.length} projects (${list}). Pass project_id instead of request_id to ${options.actionName}.`);
    }
    if (candidates.length === 1) return candidates[0]!;
    // Compatibilidade: chamadas internas que passam diretamente o `project.id` de um projeto manual (sem request).
    if (typeof target === "string") {
      const direct = this.plans.find((candidate) => candidate.id === id && !isAvulsas(candidate));
      if (direct && (isProjectOpen(direct) || (options.allowCompleted && direct.status === "concluido"))) return direct;
    }
    const canceled = all.find((plan) => plan.status === "cancelado");
    if (canceled) throw new Error(`Project ${canceled.id} is canceled: reopen it first with set_project_status(project_id: "${canceled.id}", status: "active").`);
    throw new Error(options.actionName === "add_project_tasks" ? "This request has no open project: use create_project" : "This request has no open project");
  }

  /**
   * `add_project_tasks`: mais tarefas num projeto (por `project_id` ou `request_id`, sem nova aprovação), na árvore
   * (`parent`, `kind: "module" | "group"`) e nas sprints que já existem (`sprint`; sem ele a tarefa herda a sprint ativa).
   * Dar filhas a uma folha que ainda não começou a transforma em tarefa-mãe. Em projeto `concluido`, reabre-o sozinho.
   */
  addTasks(target: ProjectTarget, tasks: ProjectTaskInput[], options: { release?: ProjectInputRelease } = {}): Project {
    const state = this.deps.state.read();
    if (typeof target === "object" && "requestId" in target) this.requireRequest(state, target.requestId);
    const plan = this.resolveTarget(target, { allowCompleted: true, actionName: "add_project_tasks" });
    const at = this.at();
    const base = structuredClone(plan.tasks);
    for (const parentRef of new Set(tasks.flatMap((task) => (task.parent?.trim() ? [task.parent.trim()] : [])))) {
      const parent = base.find((candidate) => candidate.ref === parentRef);
      if (!parent || parent.group || base.some((candidate) => candidate.parent === parentRef)) continue;
      if (hasStarted(parent)) throw new Error(`Tasks rejected:\n- Task ${parentRef} already started, so it cannot become a parent. Put the new tasks beside it or under a module`);
      becomeMother(parent, at);
    }
    const built = buildProjectPlan({ tasks }, this.pool(state), at, this.deps.now().getTime(), undefined, { tasks: base, sprints: plan.sprints, labels: plan.labels });
    if (!built.ok) throw new Error(`Tasks rejected (fix these and call add_project_tasks again):\n- ${built.errors.join("\n- ")}`);
    plan.tasks = [...base, ...built.tasks];
    plan.labels = built.labels;
    applyInputRelease(built.tasks, tasks, options.release ?? "now", base);
    // Tarefa nova num projeto com sprint ativa herda essa sprint (sem sprint ativa, fica "sem sprint").
    const inherited = inheritSprint(plan);
    if (inherited) for (const task of built.tasks) if (isLeaf(plan, task) && !task.sprintId) task.sprintId = inherited;
    const reopened = plan.status === "concluido";
    if (reopened) {
      plan.status = "ativo";
      delete plan.finishedAt;
      delete plan.doneNotified;
    }
    plan.updatedAt = this.at();
    if (plan.status === "ativo") for (const task of built.tasks) if (task.status === "a_fazer" && !releaseHold(task)) task.waitingSince = this.at();
    this.save([plan]);
    if (reopened) {
      activeActivity()?.record({
        workspaceId: this.deps.workspaceId,
        category: "plano",
        action: "projeto-reaberto",
        actor: ACTIVITY_MAESTRO,
        summary: `O Maestro reabriu o projeto ${quoteName(shorten(plan.title, 60))} ao adicionar tarefas`,
        refs: { planId: plan.id },
      });
    }
    const request = state.tasks.find((task) => task.id === requestIdOf(plan));
    if (request) this.logRequest(request, { kind: "text", text: `O Maestro incluiu ${built.tasks.length} tarefa(s) no plano: ${built.tasks.map((task) => `${task.ref} «${task.title}»`).join(", ")}` });
    this.pump();
    return structuredClone(plan);
  }

  /** `resolve_task` (`resolve_plan_task`): o Maestro resolve uma tarefa que falhou (retry, skip) ou cancela o projeto (`cancel_plan` é o nome antigo). */
  decideTask(target: ProjectTarget, ref: string, action: "retry" | "skip" | "cancel_project" | "cancel_plan", instruction?: string): string {
    const plan = this.resolveTarget(target, { allowCompleted: false, actionName: "resolve_task" });
    if (action === "cancel_project" || action === "cancel_plan") {
      this.cancelPlan(plan, `Cancelado pelo Maestro${instruction ? `: ${instruction}` : ""}`);
      return "Project canceled (the running tasks stopped). Close the request with complete_request explaining to the user what was done.";
    }
    const task = plan.tasks.find((candidate) => candidate.ref === ref);
    if (!task) throw new Error(`Task "${ref}" is not in the plan (refs: ${plan.tasks.map((candidate) => candidate.ref).join(", ")})`);
    if (isProjectTaskFinished(task)) throw new Error(`Task ${ref} already finished`);
    const at = this.at();
    if (action === "retry") {
      if (task.status !== "falhou") throw new Error(`Task ${ref} did not fail (status: ${task.status}); only a failed task can be retried`);
      this.requeueFailed(task, at, instruction);
      plan.updatedAt = at;
      this.save([plan]);
      this.pump();
      return `Task ${ref} goes back to the queue at step ${task.current + 1}. End the turn: you are notified at the end of the plan.`;
    }
    const running = task.steps[task.current]?.taskId;
    if (running) this.deps.orchestrator.cancelTask(running, "Pulada pelo Maestro");
    // "Pulada" fica "concluida" (as dependentes destravam), mas com o selo `skipped`: não conta como feita.
    Object.assign(task, { status: "concluida", skipped: true, result: `(Pulada pelo Maestro${instruction ? `: ${instruction}` : ""})`, finishedAt: at, updatedAt: at });
    delete task.failure;
    this.unlockDependents(plan);
    plan.updatedAt = at;
    this.save([plan]);
    this.afterChange(plan);
    return `Task ${ref} skipped: the tasks that depend on it proceed. End the turn.`;
  }

  /** A etapa atual de uma tarefa que falhou volta a pendente e a tarefa à fila (o "retry"; `decideTask` e a reatribuição usam o mesmo caminho). */
  private requeueFailed(task: ProjectTask, at: string, instruction?: string): void {
    const step = task.steps[task.current]!;
    Object.assign(step, { status: "pendente" });
    for (const key of ["taskId", "result", "startedAt", "finishedAt"] as const) delete step[key];
    if (instruction?.trim()) step.what = `${step.what}\n\nInstrução do Maestro para a nova tentativa: ${instruction.trim()}`;
    task.status = task.current > 0 ? "em_andamento" : "a_fazer";
    if (task.status === "a_fazer" && !releaseHold(task)) task.queuedAt = at;
    delete task.failure;
    Object.assign(task, { waitingSince: at, stallWarned: false, updatedAt: at });
  }

  /**
   * `POST /projects/:id/tasks/:ref/reassign` (e a ferramenta `reassign_task` do Maestro): troca o agente da etapa de uma tarefa
   * travada e a devolve à fila. Só com a tarefa parada: no backlog, a fazer, que falhou, ou travada (cota, acesso…) sem etapa
   * rodando. Com a etapa rodando, ou esperando você, é 409: cancele a etapa antes. `projectId` também pode ser o id do pedido de
   * uma tarefa avulsa (a folha do Avulsas). `step` = índice da etapa (padrão: a atual); só etapa que ainda não foi feita.
   */
  async reassignTask(projectId: string, ref: string, body: TaskReassignBody, by?: "maestro"): Promise<Project> {
    const viaRequest = !this.plans.some((candidate) => candidate.id === projectId) && this.leavesOfRequest(projectId).some((leaf) => leaf.ref === ref);
    const project = this.editable(viaRequest ? AVULSAS_ID : projectId);
    if (isSeedProject(project)) throw new HttpError(409, "Projeto de demonstração: ele não roda, então não há o que reatribuir");
    const before = structuredClone(project);
    const task = requireTask(project, ref);
    const at = this.at();
    try {
      if (task.group || project.tasks.some((candidate) => candidate.parent === task.ref)) throw new HttpError(400, "Reatribua as subtarefas de dentro");
      if (isSeedTask(task)) throw new HttpError(409, "Tarefa de demonstração: ela não roda, então não há o que reatribuir");
      if (isProjectTaskFinished(task)) throw new HttpError(409, "A tarefa já terminou");
      const index = body.step ?? task.current;
      const step = task.steps[index];
      const running = task.steps.some((candidate) => candidate.status === "em_andamento");
      if (running) throw new HttpError(409, "Uma etapa desta tarefa está rodando: cancele a etapa antes de reatribuir");
      if (task.status === "esperando_voce") throw new HttpError(409, "A tarefa espera você: decida o item no Para você antes de reatribuir");
      const stuck = task.status === "backlog" || task.status === "a_fazer" || task.status === "falhou" || task.blocked !== undefined;
      if (!stuck) throw new HttpError(409, "Só dá para reatribuir uma tarefa travada, parada na fila ou que falhou");
      if (task.steps.length > 0 && !step) throw new HttpError(400, `A tarefa não tem a etapa ${index + 1}`);
      if (step && step.status === "feita") throw new HttpError(409, "Essa etapa já foi feita: reatribua uma que ainda não rodou");
      const agent = this.assignable(body.agentId);
      const state = this.deps.state.read();
      const from = step?.agentId ? this.agentName(state, step.agentId) : "ninguém";
      if (step) {
        if (step.agentId === agent.id && task.status !== "falhou" && !task.blocked) throw new HttpError(409, `${agent.name} já é o responsável: nada a trocar`);
        step.agentId = agent.id;
        delete step.address;
      } else task.steps = singleStep(agent.id, task.briefing || task.title);
      if (index === 0) task.ownerId = agent.id;
      if (task.status === "falhou") this.requeueFailed(task, at);
      else {
        clearBlocked(task, at);
        delete task.note;
        if (task.status === "backlog" || task.status === "a_fazer") task.status = idleStatus(project, task);
        if (task.status === "a_fazer" && !releaseHold(task)) task.queuedAt = at;
        if (task.status === "a_fazer" || task.status === "em_andamento") task.waitingSince = at;
        Object.assign(task, { stallWarned: false, updatedAt: at });
      }
      refreshIdle(project, at);
      assertValidTree(project);
      const saved = await this.finishEdit(project, before, "reatribuida", `Você passou ${quoteName(shorten(task.title, 60))} de ${from} para ${agent.name} em ${quoteName(shorten(project.title, 60))}`, { ref, agentId: agent.id, from: step?.agentId ?? null, step: index }, by);
      return viaRequest ? structuredClone(legacyViewOf(projectId, this.leavesOfRequest(projectId))) : saved;
    } catch (error) {
      this.restore(project, before);
      throw error;
    }
  }

  /**
   * `get_project` (`get_plan`): o quadro do projeto em texto para o Maestro. Aceita `project_id` ou `request_id` (se o pedido
   * tem vários projetos, lista todos e pede `project_id`). Projetos pequenos (<= 40 itens) saem inteiros; árvores grandes mostram
   * o cabeçalho + módulos de primeiro nível + só folhas abertas até o teto (40 por módulo, 300 no total). `ref` expande a subárvore
   * inteira daquele item (com o mesmo teto de 300 linhas por chamada).
   */
  describe(target: ProjectTarget, options: { ref?: string } = {}): string {
    let plan: Project | undefined;
    if (typeof target === "object" && "projectId" in target) {
      plan = this.plans.find((candidate) => candidate.id === target.projectId && !isAvulsas(candidate)) ?? this.leavesView(target.projectId);
      if (!plan) throw new Error(`Project "${target.projectId}" not found. Use list_projects.`);
    } else {
      const reqId = typeof target === "string" ? target : target.requestId;
      const matching = this.plansForRequest(reqId).filter(isPlanProject);
      if (matching.length > 1) {
        return [
          `Request ${reqId} has ${matching.length} projects. Call get_project with project_id to see details:`,
          ...matching.map((candidate) => `- ${candidate.id} «${candidate.title}» [${candidate.status}] — ${progressLabel(projectUnitProgress(candidate))}`),
        ].join("\n");
      }
      plan = matching[0] ?? this.forRequest(reqId);
      if (!plan) return "This request has no plan.";
    }
    const state = this.deps.state.read();
    const name = (id: string) => this.agentName(state, id);
    const lines = [`Projeto ${plan.id}${plan.requestId ? ` (pedido ${plan.requestId})` : ""} «${plan.title}» (versão ${plan.version}) — ${plan.status}; ${progressLabel(projectUnitProgress(plan))}.`];
    const meta = [plan.priority !== "normal" ? `prioridade ${plan.priority}` : "", plan.startAt ? `começa ${plan.startAt}` : "", plan.dueAt ? `prazo ${plan.dueAt}` : "", plan.pace?.hoursPerDay ? `${plan.pace.hoursPerDay} h/dia` : ""].filter(Boolean);
    if (meta.length > 0) lines.push(meta.join(" · "));
    // Liberação: "X planned, Y released" e o ritmo diário (só aparece com algo Planejado ou com ritmo ligado; sem isso o texto é o de sempre).
    const plannedCount = plannedLeafCount(plan);
    if (plannedCount > 0 || plan.releasePace) {
      const open = leavesOf(plan).filter((leaf) => !isProjectTaskFinished(leaf) && !leaf.archived).length;
      const pace = plan.releasePace;
      const today = pace?.given?.day === workClock(this.deps.now().getTime()).day ? pace.given.count : 0;
      const paceText = pace ? `; daily release: ${pace.perDay} ${pace.unit === "modulos" ? "modules" : "tasks"}/day${pace.startsOn ? ` from ${pace.startsOn}` : ""} (${today} of ${pace.perDay} released today)` : "";
      lines.push(`Release: ${plannedCount} planned, ${Math.max(0, open - plannedCount)} released${paceText}.`);
    }
    if (plan.summary) lines.push(`Summary: ${shorten(plan.summary, 300)}`);
    const nested = plan.tasks.some((task) => task.parent || task.group);
    const sprints = sprintsInOrder(plan);
    if (sprints.length > 0) {
      lines.push("Sprints:");
      for (const sprint of sprints) {
        const progress = sprintProgress(plan, sprint.id);
        const delivery = sprint.status === "fechando" && sprint.summary ? `; delivery waiting for the owner's OK (${sprint.summary.done.length} done, ${sprint.summary.carried.length} carried over)` : "";
        lines.push(`- ${sprint.id} «${sprint.name}» [${sprint.status}] ${sprint.startAt.slice(0, 10)} → ${sprint.endAt.slice(0, 10)}; ${progress.done}/${progress.total} done${sprint.goal ? `; goal: ${shorten(sprint.goal, 120)}` : ""}${delivery}`);
      }
      if (plan.status === "ativo" && !activeSprint(plan)) {
        const next = sprints.find((sprint) => sprint.status === "planejada");
        lines.push(next ? `Warning: no sprint is active right now (the next, ${next.id}, starts ${next.startAt.slice(0, 10)}): the tasks wait for it. Use update_sprint to change its dates.` : "Warning: the project has sprints but none is active or planned: the open tasks are waiting. Add a sprint (add_sprint) and move the tasks into it (move_task), or tell the owner.");
      }
    }
    const waiting: string[] = [];
    if (plan.status === "proposto") waiting.push("approval of this project plan");
    for (const sprint of sprints) if (sprint.status === "fechando") waiting.push(`OK of the ${sprint.name} delivery summary (Aprovações)`);
    for (const leaf of leavesOf(plan)) if (leaf.status === "esperando_voce") waiting.push(`${leaf.ref} «${shorten(leaf.title, 50)}» waits for the owner`);
    for (const leaf of blockedLeaves(plan)) waiting.push(`${leaf.ref} «${shorten(leaf.title, 50)}» is blocked by a cancelled or failed dependency`);
    if (waiting.length > 0) lines.push(`Waiting for the owner: ${waiting.join("; ")}.`);
    const blockedSet = new Set(blockedLeaves(plan).map((leaf) => leaf.ref));
    const line = (task: ProjectTask, pad: string) => {
      const kids = plan.tasks.filter((candidate) => candidate.parent === task.ref);
      const rState = plannedCount > 0 ? releaseState(plan, task.ref) : undefined;
      const released = rState ? ({ planejada: "planned", liberada: "released", mista: "mixed" } as const)[rState] : undefined;
      const status = `${task.skipped ? "pulada" : statusOf(plan, task)}${released ? `, ${released}` : ""}`;
      if (task.group || kids.length > 0) {
        const progress = moduleProgress(plan, task.ref);
        const who = assigneesOf(plan, task).map(name).join(", ");
        const waits = task.dependsOn.length > 0 ? `; depends on ${task.dependsOn.join(", ")}` : "";
        return `${pad}- ${task.ref} «${task.title}» [${status}]${task.group ? " (module)" : ""} ${progress.done}/${progress.total}${who ? `; ${who}` : ""}${waits}`;
      }
      const chain = task.steps.map((step, index) => `${name(step.agentId)}${step.status === "feita" ? " ✓" : step.status === "falhou" ? " ✗" : index === task.current && step.status === "em_andamento" ? " …" : ""}`).join(" → ");
      const deps = task.dependsOn.length > 0 ? `; depende de ${task.dependsOn.join(", ")}` : "";
      const sprint = task.sprintId ? `; ${task.sprintId}` : sprints.length > 0 ? "; no sprint" : "";
      const stuck = blockedSet.has(task.ref) ? deadDependencies(plan, task) : [];
      const blocked = stuck.length > 0 ? ` — BLOCKED: ${stuck.map((dep) => `${dep.ref} was ${dep.status === "falhou" ? "failed" : "cancelled"}`).join(", ")} (it does not run on its own; retry that task, remove the dependency or cancel this one)` : "";
      const extra = task.failure ? ` — falha: ${shorten(task.failure, 200)}` : task.note ? ` — ${task.note}` : "";
      return `${pad}- ${task.ref} «${task.title}» [${status}] ${chain}${deps}${sprint}${extra}${blocked}`;
    };
    // Expansão de um item específico (`ref`): mostra toda a subárvore dele (inclusive concluídas) até o teto por chamada.
    if (options.ref) {
      const root = plan.tasks.find((task) => task.ref === options.ref);
      if (!root) throw new Error(`Item "${options.ref}" does not exist in project ${plan.id}.`);
      let emitted = 0;
      let hidden = 0;
      let nextExpandRef: string | undefined;
      const walkSub = (task: ProjectTask, depth: number) => {
        if (emitted >= DESCRIBE_TOTAL_MAX) {
          hidden += 1;
          if (!nextExpandRef && !isLeaf(plan, task)) nextExpandRef = task.ref;
          return;
        }
        lines.push(line(task, "  ".repeat(depth)));
        emitted += 1;
        for (const child of childrenOf(plan, task.ref)) walkSub(child, depth + 1);
      };
      walkSub(root, 0);
      if (hidden > 0) lines.push(`${hidden} more items hidden: call get_project with ref=${nextExpandRef ?? root.ref} to expand`);
      return lines.join("\n");
    }
    // Projeto pequeno (até 40 itens): mostra a árvore inteira como sempre.
    if (plan.tasks.length <= DESCRIBE_SMALL_MAX) {
      const walk = (task: ProjectTask, depth: number) => {
        lines.push(line(task, "  ".repeat(depth)));
        for (const child of plan.tasks.filter((candidate) => candidate.parent === task.ref)) walk(child, depth + 1);
      };
      if (nested) for (const top of plan.tasks.filter((task) => !task.parent)) walk(top, 0);
      else for (const task of plan.tasks) lines.push(line(task, ""));
      return lines.join("\n");
    }
    // Árvore grande (> 40 itens): cabeçalho dos módulos de primeiro nível + só folhas abertas até o teto (40 por módulo, 300 no total).
    let totalEmitted = 0;
    let totalHidden = 0;
    let firstTruncatedRef: string | undefined;
    const roots = childrenOf(plan).filter((task) => !task.archived);
    for (const top of roots) {
      if (isLeaf(plan, top)) {
        if (isProjectTaskFinished(top)) {
          totalHidden += 1;
          continue;
        }
        if (totalEmitted < DESCRIBE_TOTAL_MAX) {
          lines.push(line(top, ""));
          totalEmitted += 1;
        } else {
          totalHidden += 1;
        }
        continue;
      }
      const descendants = subtreeRefs(plan, top.ref).slice(1);
      const openLeaves = leavesOf(plan, top.ref).filter((leaf) => !isProjectTaskFinished(leaf) && !leaf.archived);
      if (totalEmitted >= DESCRIBE_TOTAL_MAX) {
        totalHidden += 1 + descendants.length;
        firstTruncatedRef ??= top.ref;
        continue;
      }
      lines.push(line(top, ""));
      totalEmitted += 1;
      const room = Math.min(DESCRIBE_MODULE_MAX, Math.max(0, DESCRIBE_TOTAL_MAX - totalEmitted));
      const shown = openLeaves.slice(0, room);
      for (const leaf of shown) {
        lines.push(line(leaf, "  "));
        totalEmitted += 1;
      }
      const hiddenHere = descendants.length - shown.length;
      if (hiddenHere > 0) {
        totalHidden += hiddenHere;
        firstTruncatedRef ??= top.ref;
        lines.push(`  (${hiddenHere} more items hidden: call get_project with ref=${top.ref} to expand)`);
      }
    }
    if (totalHidden > 0) {
      lines.push(`${totalHidden} more items hidden: call get_project with ref=${firstTruncatedRef ?? roots[0]?.ref ?? "T1"} to expand`);
    }
    return lines.join("\n");
  }

  // ---------- Usuário ----------

  /**
   * Aprovar o plano: a distribuição começa. Se `options.release` vier explícito ("all" ou "none"), ele vence; sem ele, mantém o
   * `released` que o Maestro definiu item a item (plano legado sem o campo => liberado).
   */
  async approve(planId: string, options: { release?: "all" | "none" } = {}): Promise<Project> {
    const plan = this.require(planId);
    if (plan.status !== "proposto") throw new HttpError(409, "O plano não está esperando aprovação");
    const state = this.deps.state.read();
    const reqId = requestIdOf(plan);
    const request = state.tasks.find((task) => task.id === reqId);
    if (!request || !isActiveTaskStatus(request.status)) throw new HttpError(409, "O pedido deste plano já foi fechado");
    const at = this.at();
    const previous = structuredClone(plan);
    const { sprintEvents, effectiveRelease, count, releasedCount, plannedCount } = this.applyApprovalState(plan, at, { by: "dono", at }, options.release);
    // Disparado pelo usuário: espera a gravação e devolve o erro de verdade (nada anda sem ela).
    await this.saveUser(plan, previous);
    this.recordSprintEvents(plan, sprintEvents, ACTIVITY_SYSTEM);
    const summary =
      effectiveRelease === "all"
        ? `Você aprovou o plano ${quoteName(shorten(plan.title, 60))} e liberou ${count === 1 ? "a tarefa" : `as ${count} tarefas`}`
        : effectiveRelease === "none"
          ? `Você aprovou o plano ${quoteName(shorten(plan.title, 60))} e deixou ${count === 1 ? "a tarefa" : `as ${count} tarefas`} Planejada${count === 1 ? "" : "s"}, para liberar depois`
          : `Você aprovou o plano ${quoteName(shorten(plan.title, 60))} (${releasedCount} liberada${releasedCount === 1 ? "" : "s"}, ${plannedCount} Planejada${plannedCount === 1 ? "" : "s"})`;
    activeActivity()?.record({
      workspaceId: this.deps.workspaceId,
      category: "plano",
      action: "plano-aprovado",
      actor: ACTIVITY_USER,
      summary,
      refs: { planId: plan.id },
      data: { release: effectiveRelease, approvalBy: "dono" },
    });
    if (plan.forYouId) await this.deps.forYou.close(plan.forYouId, "aprovado");
    this.logRequest(request, { kind: "status", status: "resumed", message: "Plano aprovado: o servidor distribui as tarefas" });
    this.progress(plan);
    this.deps.log.info({ planId, requestId: reqId }, "plano aprovado");
    this.pump();
    return structuredClone(plan);
  }

  /** Pedir ajustes: o plano volta para o Maestro (uma mensagem com o que o usuário quer). */
  async adjust(planId: string, feedback: string): Promise<Project> {
    const plan = this.require(planId);
    if (plan.status !== "proposto") throw new HttpError(409, "O plano não está esperando aprovação");
    const text = feedback.trim();
    if (!text) throw new HttpError(400, "Diga o que ajustar");
    const previous = structuredClone(plan);
    Object.assign(plan, { status: "ajustando", feedback: text, updatedAt: this.at() });
    await this.saveUser(plan, previous);
    if (plan.forYouId) await this.deps.forYou.close(plan.forYouId, "respondido", text);
    const version = plan.version;
    const reqId = requestIdOf(plan);
    // Texto montado quando o Maestro consome a mensagem (o plano de então, não o de agora).
    const message = () =>
      [
        `Pedido ${reqId}${plan.requestId ? ` (projeto ${plan.id})` : ""}: o usuário pediu ajustes no plano (versão ${version}) antes de aprovar:`,
        `“${text}”`,
        `Plano atual:\n${this.describe({ projectId: plan.id })}`,
        "Mande o plano corrigido com create_project (ele volta para a aprovação) e termine o turno.",
      ].join("\n\n");
    this.deps.host(reqId)?.wake(reqId, "adjust", message, () => this.get(plan.id));
    return structuredClone(plan);
  }

  /** Cancelar o plano (o usuário): as tarefas param e o pedido fecha se não houver outro projeto aberto nele. */
  async cancel(planId: string, reason = "Plano cancelado pelo usuário"): Promise<Project> {
    if (!this.plans.some((candidate) => candidate.id === planId) && this.leavesOfRequest(planId).length > 0) return this.cancelRequestLeaves(planId, reason);
    const plan = this.require(planId);
    if (isAvulsas(plan)) throw new HttpError(409, "O projeto Avulsas não se cancela: cancele a tarefa");
    if (!isProjectOpen(plan)) throw new HttpError(409, "O plano já terminou");
    const reqId = requestIdOf(plan);
    await this.cancelPlan(plan, reason, true);
    if (!this.holds(reqId)) this.deps.host(reqId)?.close(reqId, reason);
    return structuredClone(plan);
  }

  /** Cancelar um pedido simples (o usuário): a(s) tarefa(s) aberta(s) dele no Avulsas param e o pedido fecha. */
  private async cancelRequestLeaves(requestId: string, reason: string): Promise<Project> {
    const avulsas = this.avulsas()!;
    const open = this.leavesOfRequest(requestId).filter((leaf) => !isProjectTaskFinished(leaf));
    if (open.length === 0) throw new HttpError(409, "A tarefa já terminou");
    const at = this.at();
    for (const leaf of open) {
      const running = leaf.steps[leaf.current];
      if (running?.status === "em_andamento" && running.taskId) this.deps.orchestrator.cancelTask(running.taskId, reason);
      Object.assign(leaf, { status: "cancelada", finishedAt: at, updatedAt: at });
      delete leaf.note;
      clearBlocked(leaf, at);
      delete leaf.waitingSince;
    }
    avulsas.updatedAt = at;
    await this.saveStrict([avulsas]);
    this.deps.log.info({ requestId, reason }, "tarefa avulsa cancelada");
    this.deps.host(requestId)?.close(requestId, reason);
    this.pump();
    return structuredClone(legacyViewOf(requestId, this.leavesOfRequest(requestId)));
  }

  /** Decisão pelo card do "Para você" (aprovado / rejeitado = cancelar / respondido = ajustar). */
  async decideItem(item: ForYouItem, decision: { status: "aprovado" | "rejeitado" | "respondido"; response?: string; release?: "all" | "none" }): Promise<void> {
    const plan = item.kind === "plano" && item.projectId ? this.plans.find((candidate) => candidate.id === item.projectId) : undefined;
    if (!plan) {
      await this.deps.forYou.close(item.id, decision.status, decision.response);
      return;
    }
    if (decision.status === "aprovado") await this.approve(plan.id, decision.release ? { release: decision.release } : {});
    else if (decision.status === "respondido") await this.adjust(plan.id, decision.response ?? "");
    else {
      if (plan.forYouId) await this.deps.forYou.close(plan.forYouId, "rejeitado", decision.response);
      await this.cancel(plan.id, decision.response ? `Plano cancelado pelo usuário: ${decision.response}` : undefined);
    }
  }

  // ---------- Agentes ----------

  /** `get_task` de um agente: a tarefa dele no plano, a etapa e os resultados das anteriores. Fora de plano, só o pedido. */
  workerView(task: Task): string {
    const found = this.locate(task);
    if (!found) return [`Tarefa ${task.id} — status: ${task.status}`, "", task.prompt].join("\n");
    const { plan, planTask } = found;
    const state = this.deps.state.read();
    const request = state.tasks.find((candidate) => candidate.id === requestIdOf(plan));
    const index = task.work!.step;
    const lines = [
      `Pedido: ${requestTitle(request)}`,
      `Tarefa ${planTask.ref} do plano — ${planTask.title} (dono: ${this.agentName(state, planTask.ownerId)})${motherNote(plan, planTask)}`,
      `Briefing:\n${planTask.briefing}`,
      `Sua etapa (${index + 1} de ${planTask.steps.length}): ${planTask.steps[index]?.what ?? ""}`,
      ...[flowLine(plan, planTask, (id) => this.agentName(state, id)), doneWhenBlock(planTask), dueLine(planTask, plan)].filter(Boolean),
    ];
    const previous = planTask.steps.slice(0, index).filter((step) => step.result);
    if (previous.length > 0) {
      lines.push("## Resultados das etapas anteriores");
      for (const [stepIndex, step] of previous.entries()) lines.push(`### Etapa ${stepIndex + 1} — ${this.agentName(state, step.agentId)}\n${shorten2(step.result ?? "", TEXT.view)}`);
    }
    const deps = receivedBy(plan, planTask);
    if (deps.length > 0) {
      lines.push("## O que as subtarefas de que esta depende entregaram");
      for (const dep of deps) lines.push(`### ${dep.ref} — ${dep.title} (${dep.ownerId ? this.agentName(state, dep.ownerId) : "?"})\n${shorten2(dep.result ?? "", TEXT.view)}`);
    }
    const next = planTask.steps[index + 1];
    lines.push(next ? `Depois de você: ${this.agentName(state, next.agentId)} (${shorten(next.what, 200)}) recebe o seu resultado.` : receiverLine(plan, planTask, (id) => this.agentName(state, id)));
    return lines.join("\n\n");
  }

  /**
   * `request_help`: vira um pedido para o Maestro (acorda ele uma vez) e a tarefa do agente ESPERA a
   * resposta ("Esperando o Maestro"; quem segura o turno é o runner, veja `holdForHelp`). `access`
   * grava o bloqueio como `acesso`; `skill` como `agente`. A espera sai quando a resposta chega, o
   * tempo acaba ou a tarefa termina (`helpReleased`).
   */
  help(task: Task, what: string, suggestion?: string, kind: HelpKind = "skill"): string {
    const state = this.deps.state.read();
    const found = this.locateAny(task);
    const requestId = found ? requestIdOf(found.plan) : task.projectId;
    const host = requestId ? this.deps.host(requestId) : undefined;
    const request = requestId ? state.tasks.find((candidate) => candidate.id === requestId) : undefined;
    if (!requestId || !host || !request || !isActiveTaskStatus(request.status)) throw new Error("This task did not come from a Maestro request: there is no one to ask for help. Do what you can and explain it in submit_result.");
    const who = this.agentName(state, task.agentId);
    const suggested = suggestion ? (state.agents.find((agent) => agent.id === suggestion || agent.name.toLowerCase() === suggestion.toLowerCase())?.name ?? suggestion) : undefined;
    const where = found ? `na tarefa ${found.planTask.ref} («${found.planTask.title}», etapa ${task.work!.step + 1}/${found.planTask.steps.length})` : `na tarefa ${task.id}`;
    if (found) {
      const at = this.at();
      const maestro = findMaestroAgent(state);
      const note = kind === "access" ? "Esperando o Maestro (acesso)" : "Esperando o Maestro";
      (found.planTask.help ??= []).push({ agentId: task.agentId ?? "", what: what.trim(), ...(suggestion ? { suggestedAgentId: suggestion } : {}), kind, at });
      Object.assign(found.planTask, { note, waitingSince: at, stallWarned: false, updatedAt: at });
      setBlocked(found.planTask, { type: kind === "access" ? "acesso" : "agente", ...(maestro ? { by: agentAddress(this.deps.workspaceId, maestro.id) } : {}), note, since: at }, at);
      found.plan.updatedAt = at;
      this.save([found.plan]);
    }
    this.logRequest(request, { kind: "text", text: `${who} pediu ${kind === "access" ? "acesso" : "ajuda"} ${where}: “${shorten(what, 300)}”${suggested ? ` (sugere ${suggested})` : ""}` });
    const message = () =>
      [
        `Pedido ${requestId}${found?.plan.requestId ? ` (projeto ${found.plan.id})` : ""}: ${who} (agent id: ${task.agentId}) pediu ${kind === "access" ? "um ACESSO que não tem" : "ajuda"} ${where}:`,
        `“${what.trim()}”${suggested ? `\nSugestão de quem pode ajudar: ${suggested}.` : ""}`,
        `A tarefa dele está ESPERANDO você. Responda com message_agent(agent: "${task.agentId}", text): a resposta chega a ele como nota e ele segue. ${kind === "access" ? "Acesso você não concede sozinho (só o usuário, em Configurações): diga a ele o que fazer sem isso, ou fale com o usuário." : found ? "Se fizer sentido, inclua também uma tarefa com add_project_tasks (ou fale com o usuário)." : "Se fizer sentido, delegue a alguém (delegate_task) ou fale com o usuário."}`,
      ].join("\n\n");
    host.wake(requestId, "help", message, found ? () => this.get(found.plan.id) : undefined);
    return "Your help request went to the Maestro and your task now WAITS for the answer. End this turn now: the reply arrives in a later message (if it takes too long you are told to go on without it).";
  }

  /** O pedido de ajuda deixou de segurar a tarefa (resposta chegou, tempo acabou ou a tarefa terminou): tira o bloqueio "Esperando o Maestro". */
  helpReleased(task: Task): void {
    const found = this.locateAny(task);
    if (!found || !found.planTask.note?.startsWith("Esperando o Maestro")) return;
    const at = this.at();
    clearBlocked(found.planTask, at);
    delete found.planTask.note;
    delete found.planTask.waitingSince;
    found.planTask.updatedAt = at;
    found.plan.updatedAt = at;
    this.save([found.plan]);
  }

  // ---------- Passagem de bastão entre agentes (send_to_colleague) ----------

  /**
   * `send_to_colleague`: cria uma tarefa NOVA, do colega, no mesmo projeto (ref "H<n>", `origin`),
   * que o agendador admite como qualquer outra (prioridade, ritmo, cota, vagas). Os limites contra
   * laço (ver handoff.ts) barram com um motivo claro e acordam o Maestro uma vez.
   */
  handoff(task: Task, input: { to: string; message: string; intent: HandoffIntent; doneWhen?: string[] }): string {
    try {
      return this.handoffNow(task, input);
    } catch (error) {
      // O agente já escreveu "passei o trabalho" mesmo com erro: o texto diz com todas as letras que NADA foi repassado.
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`${reason} ${NOTHING_HANDED_OFF}`, { cause: error });
    }
  }

  private handoffNow(origin: Task, input: { to: string; message: string; intent: HandoffIntent; doneWhen?: string[] }): string {
    let task = origin;
    let found = this.locateAny(task);
    // Tarefa direta (atalho "mandar para um time", sem Maestro e sem projeto): vira folha do Avulsas na hora do repasse.
    if (!found && !task.work) {
      const adopted = this.adoptLoose(task);
      if (adopted) {
        task = adopted;
        found = this.locateAny(adopted);
      }
    }
    if (!found || (!hasLifecycle(found.plan) && !isAvulsas(found.plan))) throw new Error("send_to_colleague works only inside a project or a simple task of the workspace, and this task is not linked to one.");
    const { plan, planTask: sender } = found;
    if (plan.status !== "ativo") throw new Error(`The project is ${plan.status === "pausado" ? "paused" : "not running"}: you cannot hand off now. Finish with submit_result.`);
    const state = this.deps.state.read();
    const senderId = task.agentId ?? "";
    const target = this.resolveColleague(state, input.to);
    // No Avulsas (a lista de todas as tarefas simples) os limites valem por cadeia de repasses, não pelo projeto inteiro.
    const scope = isAvulsas(plan) ? { ...plan, tasks: handoffFamily(plan, sender) } : plan;
    const refusal = handoffRefusal({ plan: scope, plans: this.plans, sender, senderAgentId: senderId, targetAgentId: target.id, now: this.deps.now().getTime() });
    if (refusal) {
      this.warnHandoff(plan, state, `${this.agentName(state, senderId)} → ${target.name}`, refusal);
      throw new Error(refusal);
    }
    const created = this.createHandoffTask(plan, state, { sender, fromAgentId: senderId, target, message: input.message, intent: input.intent, ...(input.doneWhen ? { doneWhen: input.doneWhen } : {}) });
    this.save([plan]);
    this.pump();
    const verb = input.intent === "ask" ? "asked" : input.intent === "fyi" ? "notified" : "passed the baton to";
    return `You ${verb} ${target.name} (task ${created.ref}, created ${isAvulsas(plan) ? "in the task list" : "in this project"}; they start when the queue admits it). ${input.intent === "pass_on" ? "Now finish your own step with submit_result." : input.intent === "ask" ? "The answer comes back to you as a NEW task; deliver what you already have with submit_result, saying you await the answer." : "No reply is expected; go on."}`;
  }

  /** Tarefa direta e solta (sem projeto, sem rotina, sem `work`) em andamento: ganha a folha dela no Avulsas, para poder repassar. */
  private adoptLoose(task: Task): Task | undefined {
    const state = this.deps.state.read();
    const live = state.tasks.find((candidate) => candidate.id === task.id);
    if (!live || live.work || live.projectId || live.routineId || !live.agentId || !isActiveTaskStatus(live.status)) return undefined;
    this.adoptIntoAvulsas(live, live, {}, undefined);
    void this.deps.state.commit({ tasks: state.tasks, events: [{ type: "task:upserted", task: structuredClone(live) }] }).catch((error: unknown) => this.deps.log.error({ err: error }, "falha ao gravar a tarefa direta adotada"));
    return live;
  }

  /** `to` = id, nome ou "workspace/agente" de um colega do mesmo workspace (nunca o Maestro). */
  private resolveColleague(state: OfficeState, to: string): Agent {
    const query = to.trim();
    const address = parseAddress(query);
    if (address && address.workspace !== this.deps.workspaceId) throw new Error(`Only agents of this workspace ("${this.deps.workspaceId}") can be reached; "${query}" is in another.`);
    const key = (address?.agentId ?? query).toLowerCase();
    const agent = state.agents.find((candidate) => candidate.id.toLowerCase() === key || candidate.name.toLowerCase() === key);
    if (key === "maestro" || (agent && isMaestroAgent(state, agent))) throw new Error("The Maestro is not a destination for send_to_colleague. To reach the Maestro, use request_help.");
    if (!agent) throw new Error(`No colleague "${query}" in this workspace. Available: ${state.agents.filter((candidate) => !isMaestroAgent(state, candidate)).map((candidate) => `${agentAddress(this.deps.workspaceId, candidate.id)} (${candidate.name})`).join(", ")}.`);
    return agent;
  }

  /** Cria e registra a tarefa de repasse do colega (a_fazer; o agendador a admite). */
  private createHandoffTask(
    plan: Project,
    state: OfficeState,
    input: { sender: ProjectTask; fromAgentId: string; target: Agent; message: string; intent: HandoffIntent; doneWhen?: string[]; reply?: boolean; question?: string },
  ): ProjectTask {
    const { sender, fromAgentId, target, message, intent, reply } = input;
    const at = this.at();
    const fromName = this.agentName(state, fromAgentId);
    const avulsas = isAvulsas(plan);
    const ref = avulsas ? takeAvulsasRef(plan) : nextHandoffRef(plan);
    const first = shorten((message.split("\n").map((line) => line.replace(/^[\s#>*-]+/, "").trim()).find(Boolean) ?? message), 90);
    const origin = { fromAddress: agentAddress(this.deps.workspaceId, fromAgentId), fromRef: sender.ref, intent, hops: (sender.origin?.hops ?? 0) + 1, at, ...(reply ? { reply: true } : {}) };
    const created: ProjectTask = {
      ref,
      title: reply ? `Resposta de ${fromName}: ${first}` : `${HANDOFF_TITLES[intent]} (${fromName}): ${first}`,
      briefing: handoffBriefing({ fromName, message, intent, sender, ...(reply ? { reply } : {}), ...(input.question ? { question: input.question } : {}) }),
      ownerId: target.id,
      steps: [{ agentId: target.id, address: agentAddress(this.deps.workspaceId, target.id), what: shorten2(message, 1000), status: "pendente" }],
      current: 0,
      dependsOn: [],
      priority: effectivePriority(plan, sender),
      ...(sender.dueAt ? { dueAt: sender.dueAt } : {}),
      doneWhen: (input.doneWhen ?? [])
        .map((text) => text.trim())
        .filter(Boolean)
        .slice(0, 10)
        .map((text, index) => ({ id: `d${index + 1}`, text })),
      rework: { count: 0 },
      status: "a_fazer",
      origin,
      waitingSince: at,
      updatedAt: at,
    };
    // Irmã da origem na sprint dela (se ainda aberta) ou na ativa: o repasse não fica "sem sprint".
    const sprintId = inheritSprint(plan, sender.sprintId);
    if (sprintId) created.sprintId = sprintId;
    if (avulsas) this.attachAvulsasHandoff(plan, state, created, target, sender, at);
    plan.tasks.push(created);
    plan.updatedAt = at;
    const request = state.tasks.find((candidate) => candidate.id === requestIdOf(plan));
    if (request) this.logRequest(request, { kind: "text", text: `${handoffLabel(origin, fromName, target.name)} (${sender.ref} → ${ref} «${shorten(created.title, 100)}»).` });
    return created;
  }

  /**
   * Repasse a partir de uma folha do Avulsas: a folha nova (`A<n>`, ligada à origem por `origin`) nasce com a
   * sua Task na fila do colega (como a tarefa de uma rotina): não há agendador de etapas no Avulsas.
   */
  private attachAvulsasHandoff(plan: Project, state: OfficeState, leaf: ProjectTask, target: Agent, sender: ProjectTask, at: string): void {
    const team = state.teams.find((candidate) => candidate.id === target.teamId);
    if (!team) throw new Error(`${target.name} has no team, so it cannot receive work.`);
    const subtask: Task = { id: randomUUID(), roomId: team.roomId, teamId: team.id, agentId: target.id, prompt: `${leaf.title}\n\n${leaf.briefing}`, status: "queued", createdAt: at, updatedAt: at, work: { projectId: AVULSAS_ID, ref: leaf.ref, step: 0 } };
    leaf.steps[0]!.taskId = subtask.id;
    leaf.order = (plan.tasks.reduce((max, task) => Math.max(max, task.order ?? 0), 0) || 0) + 1000;
    leaf.meta = { requestId: subtask.id, origin: sender.meta?.origin ?? "usuario", createdAt: at };
    delete leaf.waitingSince;
    state.tasks.push(subtask);
    void this.deps.state
      .commit({ tasks: state.tasks, events: [{ type: "task:upserted", task: structuredClone(subtask) }] })
      .catch((error: unknown) => this.deps.log.error({ err: error }, "falha ao gravar a tarefa do repasse"));
    this.deps.orchestrator.enqueue(target.id);
  }

  /** Um `ask` terminou: a resposta volta como tarefa para quem perguntou (se o agente ainda existe). */
  private replyToAsk(plan: Project, answered: ProjectTask, answererId: string, answer: string): void {
    const askerId = originAgent(answered);
    const asker = plan.tasks.find((candidate) => candidate.ref === answered.origin?.fromRef);
    const state = this.deps.state.read();
    const target = askerId ? state.agents.find((candidate) => candidate.id === askerId) : undefined;
    if (!asker || !target || isMaestroAgent(state, target)) return;
    this.createHandoffTask(plan, state, { sender: answered, fromAgentId: answererId, target, message: answer || "(sem resposta)", intent: "fyi", reply: true, question: answered.steps[0]?.what ?? "" });
  }

  /** Repasse barrado: o Maestro é acordado UMA vez por projeto (o motivo vai na mensagem). */
  private warnHandoff(plan: Project, state: OfficeState, who: string, reason: string): void {
    const reqId = requestIdOf(plan);
    const request = state.tasks.find((candidate) => candidate.id === reqId);
    if (request) this.logRequest(request, { kind: "text", text: `Repasse barrado (${who}): ${shorten(reason, 300)}` });
    if (this.handoffWarned.has(plan.id)) return;
    this.handoffWarned.add(plan.id);
    const message = () =>
      [
        `Pedido ${reqId}${plan.requestId ? ` (projeto ${plan.id})` : ""}: um repasse entre agentes foi barrado pelo servidor (${who}):`,
        reason,
        "Provável laço ou excesso de repasses. Confira com get_project; se precisar, ajuste (resolve_task, add_project_tasks) ou fale com o usuário. Senão, só termine o turno. Você não será avisado de novo sobre isto neste projeto.",
      ].join("\n\n");
    this.deps.host(reqId)?.wake(reqId, "handoff", message, () => this.get(plan.id));
  }

  // ---------- Agendador (ProjectScheduler) ----------

  /** Boot: concilia as etapas com as subtarefas e distribui. */
  resume(): void {
    this.clock.start(this.deps.state.read().tasks);
    this.reconcileMirrors();
    this.scheduler.resume();
  }

  /** Começa as etapas que podem começar agora. */
  pump(): void {
    this.scheduler.pump();
  }

  /** Avisa o Maestro das tarefas paradas demais. */
  checkStalls(): void {
    this.scheduler.checkStalls();
  }

  // ---------- Eventos ----------

  /** Evento do hub do workspace: etapas que mudaram e pedidos fechados. */
  handleEvent(event: ServerEvent): void {
    if (event.type !== "task:upserted" || this.stopped) return;
    this.clock.observe(event.task);
    const task = structuredClone(event.task);
    queueMicrotask(() => {
      if (task.work) this.onStepTask(task);
      else if (!isActiveTaskStatus(task.status)) this.onRequestClosed(task);
    });
  }



  // ---------- Pedido vindo do Cyno ----------

  /**
   * O Cyno mandou um pedido a este workspace: o pedido (Task do Maestro) já existe e aqui nasce o
   * Projeto-casca com o MESMO id: `origin: "cyno"`, o briefing completo em `brief` e o que o dono pediu
   * (prioridade, prazos, "pronto quando"). Ainda sem tarefas: o Maestro só distribui (`create_project`
   * ou `delegate_task` adotam esta casca e herdam o briefing). Fecha sozinho quando o pedido fecha
   * (veja `closeMirror`). Chame antes de a mensagem sair para o Maestro.
   */
  openFromCyno(request: Task, input: { title: string; kind: "projeto" | "tarefa"; brief: string; priority?: Project["priority"]; startAt?: string; dueAt?: string; doneWhen?: string[]; joint?: ProjectJointRef }): Project {
    const at = this.at();
    const existing = this.plans.find((candidate) => candidate.id === request.id);
    if (existing) return structuredClone(existing);
    const project: Project = {
      ...projectDefaults(),
      id: request.id,
      kind: input.kind,
      title: shorten(input.title.trim().replace(/\s+/g, " ") || "Pedido do Cyno", 120),
      origin: "cyno",
      status: "ativo",
      version: 1,
      brief: input.brief.slice(0, PROJECT_BRIEF_MAX),
      ...(input.joint ? { joint: structuredClone(input.joint) } : {}),
      ...(input.priority ? { priority: input.priority } : {}),
      ...(input.startAt ? { startAt: input.startAt } : {}),
      ...(input.dueAt ? { dueAt: input.dueAt } : {}),
      ...(input.doneWhen?.length ? { doneWhen: input.doneWhen.map((text, index) => ({ id: `d${index + 1}`, text: text.trim() })).filter((item) => item.text) } : {}),
      tasks: [],
      createdAt: at,
      updatedAt: at,
    };
    this.plans.push(project);
    void this.save([project]);
    this.deps.log.info({ projectId: project.id }, "pedido do Cyno aberto");
    return structuredClone(project);
  }

  // ---------- Parte de um projeto conjunto que ainda espera ----------

  /**
   * A parte de um projeto conjunto que depende de outra: um Projeto PAUSADO, sem tarefas e sem pedido ao
   * Maestro (ninguém acorda, custo zero), só para a parte aparecer na tela Trabalho com o selo do conjunto.
   * Quando a parte é liberada o coordenador apaga este marcador e abre o pedido de verdade
   * (`openFromCyno`, com o mesmo `joint`). Idempotente pelo `joint`.
   */
  openJointPlaceholder(input: { title: string; brief: string; joint: ProjectJointRef; priority?: Project["priority"]; dueAt?: string; doneWhen?: string[] }): Project {
    const existing = this.plans.find((candidate) => candidate.joint?.id === input.joint.id && candidate.joint.part === input.joint.part && isProjectOpen(candidate));
    if (existing) return structuredClone(existing);
    const at = this.at();
    const project: Project = {
      ...projectDefaults(),
      id: randomUUID(),
      kind: "projeto",
      title: shorten(input.title.trim().replace(/\s+/g, " ") || "Parte de um projeto conjunto", 120),
      origin: "cyno",
      status: "pausado",
      version: 1,
      brief: input.brief.slice(0, PROJECT_BRIEF_MAX),
      joint: structuredClone(input.joint),
      ...(input.priority ? { priority: input.priority } : {}),
      ...(input.dueAt ? { dueAt: input.dueAt } : {}),
      ...(input.doneWhen?.length ? { doneWhen: input.doneWhen.map((text, index) => ({ id: `d${index + 1}`, text: text.trim() })).filter((item) => item.text) } : {}),
      tasks: [],
      createdAt: at,
      updatedAt: at,
    };
    this.plans.push(project);
    void this.save([project]);
    this.deps.log.info({ projectId: project.id, joint: input.joint.id }, "parte de projeto conjunto aguardando");
    return structuredClone(project);
  }

  /** Apaga o marcador de uma parte que foi liberada (o projeto de verdade nasce com o pedido). Não existe = nada. */
  dropJointPlaceholder(id: string): void {
    const index = this.plans.findIndex((candidate) => candidate.id === id && candidate.joint !== undefined && candidate.tasks.length === 0);
    if (index < 0) return;
    this.plans.splice(index, 1);
    void persist((attempt) => this.deps.state.commit({ deletedProjects: [id], events: attempt === 0 ? [{ type: "project:deleted", id }] : [] }), this.persistOptions("os projetos"));
  }

  /** O conjunto foi cancelado (ou a parte nunca será liberada): o marcador fecha como cancelado, com o motivo. */
  cancelJointPlaceholder(id: string, reason: string): void {
    const project = this.plans.find((candidate) => candidate.id === id && candidate.joint !== undefined && candidate.tasks.length === 0);
    if (!project || !isProjectOpen(project)) return;
    const at = this.at();
    Object.assign(project, { status: "cancelado" as const, summary: shorten2(reason, 1000), finishedAt: at, updatedAt: at });
    void this.save([project]);
  }

  // ---------- Tarefas avulsas (espelho) ----------

  /**
   * O Maestro delegou uma tarefa avulsa (sem plano): o pedido vira uma FOLHA do projeto fixo "Avulsas"
   * (`meta.requestId` = o pedido) e a Task nasce ligada a ela (`work`). Um projeto-casca do Cyno (sem tarefas
   * e sem projeto conjunto) é absorvido: o briefing, a prioridade e os prazos que ele guardava passam para a
   * folha. Um projeto próprio do pedido que já recebeu tarefas (ou o conjunto, o automático) segue o caminho
   * antigo: ganha uma tarefa a mais. Nenhum ciclo de plano roda aqui: quem decide e acorda o Maestro continua
   * sendo o fluxo do pedido; a folha só espelha. Chame antes de gravar a Task (ela recebe o `work`).
   */
  adopt(request: Task, subtask: Task, extras: AdoptExtras = {}): void {
    const own = this.plans.find((candidate) => candidate.id === request.id && !isAvulsas(candidate));
    if (own && hasLifecycle(own)) return;
    const shell = own && own.kind === "tarefa" && own.tasks.length === 0 && !own.joint && own.status === "ativo" ? own : undefined;
    if (!own || shell) {
      this.adoptIntoAvulsas(request, subtask, extras, shell);
      return;
    }
    const at = this.at();
    const project = own;
    const ref = `T${project.tasks.length + 1}`;
    const task = this.simpleTask(ref, subtask, extras, at);
    project.tasks.push(task);
    // Um projeto-casca do Cyno (ainda sem tarefa) mantém o tipo pedido na primeira tarefa.
    if (project.tasks.length > 1) project.kind = "projeto";
    project.status = "ativo";
    delete project.finishedAt;
    project.updatedAt = at;
    subtask.work = { projectId: request.id, ref, step: 0 };
    this.save([project]);
  }

  /** A tarefa de uma Task delegada: 1 tarefa, 1 etapa do agente dela, "a fazer". */
  private simpleTask(ref: string, subtask: Task, extras: AdoptExtras, at: string): ProjectTask {
    const agentId = subtask.agentId ?? "";
    return {
      ref,
      title: shorten(requestTitle(subtask) || ref, 120),
      briefing: subtask.prompt,
      ownerId: agentId,
      steps: [{ agentId, address: agentAddress(this.deps.workspaceId, agentId), what: shorten2(subtask.prompt, 1000), status: "pendente", taskId: subtask.id }],
      current: 0,
      dependsOn: [],
      priority: ({ high: "alta", normal: "normal", low: "baixa" } as const)[extras.priority ?? "normal"],
      ...(extras.dueAt ? { dueAt: extras.dueAt } : {}),
      doneWhen: (extras.doneWhen ?? []).map((text) => text.trim()).filter(Boolean).map((text, index) => ({ id: `d${index + 1}`, text })),
      ...(extras.approvalType ? { approvalType: extras.approvalType } : {}),
      rework: { count: 0 },
      status: "a_fazer",
      updatedAt: at,
    };
  }

  /** Pedido simples -> folha do Avulsas (`ref` A<n>), absorvendo o projeto-casca do Cyno quando há. */
  private adoptIntoAvulsas(request: Task, subtask: Task, extras: AdoptExtras, shell: Project | undefined): void {
    const avulsas = this.ensureAvulsas();
    const at = this.at();
    const ref = takeAvulsasRef(avulsas);
    const base = this.simpleTask(ref, subtask, extras, at);
    const priority = base.priority !== "normal" ? base.priority : (shell?.priority ?? "normal");
    const startAt = shell?.startAt;
    const dueAt = base.dueAt ?? shell?.dueAt;
    const doneWhen = base.doneWhen.length > 0 ? base.doneWhen : (shell?.doneWhen ?? []);
    const leaf: ProjectTask = {
      ...base,
      title: shell?.title ?? shorten(requestTitle(request) || "Pedido", 120),
      priority,
      doneWhen,
      ...(startAt ? { startAt } : {}),
      ...(dueAt ? { dueAt } : {}),
      order: (avulsas.tasks.reduce((max, task) => Math.max(max, task.order ?? 0), 0) || 0) + 1000,
      meta: {
        requestId: request.id,
        origin: shell?.origin ?? (request.routineId ? "rotina" : "usuario"),
        ...(shell?.brief ? { brief: shell.brief } : {}),
        createdAt: shell?.createdAt ?? at,
      },
    };
    avulsas.tasks.push(leaf);
    avulsas.updatedAt = at;
    subtask.work = { projectId: AVULSAS_ID, ref, step: 0 };
    this.save([avulsas]);
    if (shell) this.dropShell(shell.id);
  }

  /** O projeto-casca virou folha do Avulsas: apaga o projeto e avisa as telas. */
  private dropShell(id: string): void {
    const index = this.plans.findIndex((candidate) => candidate.id === id);
    if (index < 0) return;
    this.plans.splice(index, 1);
    void persist((attempt) => this.deps.state.commit({ deletedProjects: [id], events: attempt === 0 ? [{ type: "project:deleted", id }] : [] }), this.persistOptions("os projetos"));
  }

  /**
   * Um horário de rotina venceu: cria o trabalho dele direto para o agente do horário (sem passar pelo
   * Maestro). Em "Pede OK" o trabalho é uma FOLHA do Avulsas (`meta.origin: "rotina"` e `meta.routineRef`);
   * em Automático segue um Projeto `kind: "tarefa"`, `origin: "rotina"`, com `routineRef` e o modo da rotina
   * (teto próprio). A Task nasce ligada a ele (`work`) e na fila, e o agendador de trabalho (prioridade, ritmo,
   * cota) decide quando ela começa. O projeto fecha sozinho quando a Task termina (veja `mirror`).
   */
  async startRoutineTask(input: {
    routineId: string;
    routineTitle: string;
    mode: ProjectMode;
    /** Ausentes quando quem cobra é o vigia da Meta (não um horário). */
    scheduleId?: string;
    slotKey?: string;
    period: string;
    agentId: string;
    title: string;
    prompt: string;
  }): Promise<{ task: Task; project: Project }> {
    const state = this.deps.state.read();
    const agent = state.agents.find((candidate) => candidate.id === input.agentId);
    const team = agent ? state.teams.find((candidate) => candidate.id === agent.teamId) : undefined;
    if (!agent || !team) throw new HttpError(400, `O agente "${input.agentId}" não existe ou não tem time`);
    const at = this.at();
    const task: Task = { id: randomUUID(), roomId: team.roomId, teamId: team.id, agentId: agent.id, prompt: input.prompt, routineId: input.routineId, status: "queued", createdAt: at, updatedAt: at };
    const planTask: ProjectTask = {
      ref: "T1",
      title: shorten(input.title, 120),
      briefing: input.prompt,
      ownerId: agent.id,
      steps: [{ agentId: agent.id, address: agentAddress(this.deps.workspaceId, agent.id), what: shorten2(input.prompt, 1000), status: "pendente", taskId: task.id }],
      current: 0,
      dependsOn: [],
      priority: "normal",
      doneWhen: [],
      rework: { count: 0 },
      status: "a_fazer",
      updatedAt: at,
    };
    if (input.mode.kind !== "automatico") {
      // Modo "Pede OK": a execução é uma folha do Avulsas (o automático, com teto próprio, segue como projeto).
      const avulsas = this.ensureAvulsas();
      const ref = takeAvulsasRef(avulsas);
      const leaf: ProjectTask = {
        ...planTask,
        ref,
        title: shorten(`${input.routineTitle}: ${input.title}`, 120),
        order: (avulsas.tasks.reduce((max, candidate) => Math.max(max, candidate.order ?? 0), 0) || 0) + 1000,
        meta: {
          requestId: task.id,
          origin: "rotina",
          routineRef: { routineId: input.routineId, ...(input.scheduleId !== undefined ? { scheduleId: input.scheduleId } : {}), ...(input.slotKey !== undefined ? { slot: input.slotKey } : {}), period: input.period },
          createdAt: at,
        },
      };
      task.work = { projectId: AVULSAS_ID, ref, step: 0 };
      avulsas.tasks.push(leaf);
      avulsas.updatedAt = at;
      state.tasks.push(task);
      await this.deps.state
        .commit({ tasks: state.tasks, projects: this.copies([avulsas]), events: [{ type: "task:upserted", task: structuredClone(task) }, { type: "project:upserted", project: structuredClone(avulsas) }] })
        .catch((error: unknown) => this.deps.log.error({ err: error }, "falha ao gravar a tarefa da rotina"));
      this.deps.orchestrator.enqueue(agent.id);
      return { task, project: structuredClone(avulsas) };
    }
    task.work = { projectId: task.id, ref: "T1", step: 0 };
    const project: Project = {
      ...projectDefaults(),
      id: task.id,
      kind: "tarefa",
      title: shorten(`${input.routineTitle}: ${input.title}`, 120),
      origin: "rotina",
      routineRef: { routineId: input.routineId, ...(input.scheduleId !== undefined ? { scheduleId: input.scheduleId } : {}), ...(input.slotKey !== undefined ? { slot: input.slotKey } : {}), period: input.period },
      status: "ativo",
      version: 1,
      mode: structuredClone(input.mode),
      tasks: [planTask],
      createdAt: at,
      updatedAt: at,
    };
    this.plans.push(project);
    state.tasks.push(task);
    await this.deps.state
      .commit({ tasks: state.tasks, projects: [structuredClone(project)], events: [{ type: "task:upserted", task: structuredClone(task) }, { type: "project:upserted", project: structuredClone(project) }] })
      .catch((error: unknown) => this.deps.log.error({ err: error }, "falha ao gravar o projeto da rotina"));
    this.deps.orchestrator.enqueue(agent.id);
    return { task, project };
  }

  /** Projeto de rotina com a única tarefa terminada: o projeto fecha (concluído, ou cancelado se a tarefa falhou). */
  private settleRoutineProject(plan: Project): void {
    if (plan.origin !== "rotina" || !isProjectOpen(plan) || plan.tasks.length === 0) return;
    if (!plan.tasks.every((task) => task.status === "concluida" || task.status === "falhou")) return;
    const failed = plan.tasks.some((task) => task.status === "falhou");
    plan.status = failed ? "cancelado" : "concluido";
    plan.finishedAt = this.at();
  }

  /** A Task de um projeto sem ciclo de plano mudou: a tarefa do projeto só acompanha (sem avisos, sem distribuição). */
  private mirror(plan: Project, planTask: ProjectTask, sub: Task): void {
    const step = planTask.steps[0];
    if (!step || step.taskId !== sub.id) return;
    const at = this.at();
    switch (sub.status) {
      case "queued":
        // Voltou para a fila depois de decidida (a vaga do agente tinha sido liberada): deixa de esperar o usuário.
        if (planTask.status !== "esperando_voce") return;
        Object.assign(planTask, { status: "em_andamento", updatedAt: at });
        clearBlocked(planTask, at);
        delete planTask.note;
        break;
      case "in_progress":
        if (planTask.status === "em_andamento" && !planTask.blocked) return;
        Object.assign(step, { status: "em_andamento", startedAt: step.startedAt ?? at });
        Object.assign(planTask, { status: "em_andamento", startedAt: planTask.startedAt ?? at, updatedAt: at });
        delete planTask.failure;
        clearBlocked(planTask, at);
        delete planTask.note;
        delete planTask.waitingSince;
        break;
      case "waiting_approval":
        if (planTask.status === "esperando_voce") return;
        Object.assign(step, { status: "em_andamento", startedAt: step.startedAt ?? at });
        Object.assign(planTask, { status: "esperando_voce", startedAt: planTask.startedAt ?? at, updatedAt: at, waitingSince: at });
        setBlocked(planTask, { type: "voce", by: agentAddress(this.deps.workspaceId, sub.agentId ?? ""), note: "Esperando a sua decisão", since: at }, at);
        delete planTask.note;
        break;
      case "failed":
        if (sub.outcome === "cancelled") {
          // Cancelada por alguém (usuário, Maestro): não é falha do agente.
          if (planTask.status === "cancelada") return;
          Object.assign(step, { status: "falhou", result: sub.result, finishedAt: at });
          Object.assign(planTask, { status: "cancelada", finishedAt: at, updatedAt: at });
          delete planTask.failure;
          break;
        }
        if (planTask.status === "falhou") return;
        Object.assign(step, { status: "falhou", result: sub.result, finishedAt: at });
        Object.assign(planTask, { status: "falhou", failure: sub.result ?? "sem motivo informado", finishedAt: at, updatedAt: at });
        clearBlocked(planTask, at);
        break;
      case "done":
        if (planTask.status === "concluida") return;
        Object.assign(step, { status: "feita", result: sub.result ?? "", finishedAt: at });
        Object.assign(planTask, { status: "concluida", result: sub.result ?? "", finishedAt: at, updatedAt: at });
        delete planTask.failure;
        clearBlocked(planTask, at);
        delete planTask.note;
        if (isAvulsas(plan) && planTask.origin?.intent === "ask" && !planTask.origin.reply) this.replyToAsk(plan, planTask, step.agentId, sub.result ?? "");
        break;
    }
    this.settleRoutineProject(plan);
    plan.updatedAt = at;
    this.save([plan]);
  }

  /** Boot: alinha os projetos avulsos e as folhas do Avulsas com o que as Tasks fizeram enquanto o server estava fora. */
  private reconcileMirrors(): void {
    const state = this.deps.state.read();
    for (const plan of this.plans) {
      if (hasLifecycle(plan) || !isProjectOpen(plan)) continue;
      const leafWork = isAvulsas(plan);
      for (const planTask of plan.tasks) {
        if (leafWork && isProjectTaskFinished(planTask)) continue;
        const sub = state.tasks.find((task) => task.id === planTask.steps[0]?.taskId);
        if (sub) this.mirror(plan, planTask, sub);
      }
      if (leafWork) {
        for (const requestId of new Set(plan.tasks.filter((task) => !isProjectTaskFinished(task)).map(leafRequestId))) {
          const request = state.tasks.find((task) => task.id === requestId);
          if (request && !isActiveTaskStatus(request.status)) this.closeLeaves(requestId, request);
        }
        continue;
      }
      const request = state.tasks.find((task) => task.id === requestIdOf(plan));
      if (request && !isActiveTaskStatus(request.status)) this.closeMirror(plan, request);
    }
  }

  /**
   * O pedido fechou: as folhas dele no Avulsas ainda abertas são canceladas se o pedido falhou ou foi
   * cancelado (se concluiu, cada folha segue o estado da própria Task). Devolve se o pedido tem folhas.
   */
  private closeLeaves(requestId: string, request: Task): boolean {
    const avulsas = this.avulsas();
    const mine = this.leavesOfRequest(requestId);
    if (!avulsas || mine.length === 0) return false;
    if (request.status === "done") return true;
    const at = this.at();
    let changed = false;
    for (const leaf of mine) {
      if (isProjectTaskFinished(leaf) || leaf.status === "falhou") continue;
      Object.assign(leaf, { status: "cancelada", finishedAt: at, updatedAt: at, ...(request.result ? { failure: shorten2(request.result, 1000) } : {}) });
      delete leaf.note;
      clearBlocked(leaf, at);
      delete leaf.waitingSince;
      changed = true;
    }
    if (changed) {
      avulsas.updatedAt = at;
      this.save([avulsas]);
    }
    return true;
  }

  /** O pedido fechou: o projeto avulso fecha junto (concluído se o pedido concluiu, cancelado se falhou). */
  private closeMirror(plan: Project, request: Task): void {
    if (!isProjectOpen(plan)) return;
    const at = this.at();
    // O pedido fechou como "done" mas nenhuma tarefa deu certo e alguma falhou (ex.: erro da API do
    // modelo): o projeto reflete a falha. O modelo não tem estado "falhou" para projeto; `cancelado`
    // com o motivo em `summary` é o que já existe e a tela já mostra.
    const failedTask = plan.tasks.find((task) => task.status === "falhou");
    const onlyFailures = failedTask !== undefined && !plan.tasks.some((task) => task.status === "concluida");
    if (request.status === "done" && !onlyFailures) plan.status = "concluido";
    else {
      plan.status = "cancelado";
      const why = request.status === "done" ? `Não deu certo: ${failedTask?.failure ?? "a tarefa falhou"}` : request.result;
      if (why) plan.summary = shorten2(why, 1000);
    }
    Object.assign(plan, { finishedAt: at, updatedAt: at });
    this.save([plan]);
  }

  /** Uma subtarefa de etapa mudou: a tarefa do plano acompanha (e a etapa seguinte começa). */
  private onStepTask(sub: Task): void {
    if (this.stopped) return;
    const found = this.locate(sub);
    if (!found) {
      const loose = this.locateAny(sub);
      if (loose) this.mirror(loose.plan, loose.planTask, sub);
      return;
    }
    const { plan, planTask } = found;
    const index = sub.work!.step;
    const step = planTask.steps[index];
    // Tarefa já resolvida (pulada pelo Maestro, cancelada): a Task parada por isso não a reabre como falha.
    // Pausado só não começa etapa nova: a que estava rodando termina e é registrada normalmente.
    if (!step || step.taskId !== sub.id || (plan.status !== "ativo" && plan.status !== "pausado") || isProjectTaskFinished(planTask)) return;
    const at = this.at();
    const state = this.deps.state.read();
    const request = state.tasks.find((candidate) => candidate.id === requestIdOf(plan));
    switch (sub.status) {
      case "queued":
      case "in_progress":
        // Voltou ao trabalho (ou à fila do agente, depois de decidida): deixa de esperar o usuário.
        if (planTask.status !== "esperando_voce") return;
        Object.assign(planTask, { status: "em_andamento", updatedAt: at });
        delete planTask.note;
        clearBlocked(planTask, at);
        this.save([plan]);
        return;
      case "waiting_approval": {
        if (planTask.status === "esperando_voce") return;
        const note = `${this.agentName(state, sub.agentId)} espera você`;
        Object.assign(planTask, { status: "esperando_voce", note, updatedAt: at });
        setBlocked(planTask, { type: "voce", by: agentAddress(this.deps.workspaceId, sub.agentId ?? ""), note, since: at }, at);
        this.save([plan]);
        return;
      }
      case "failed":
        if (step.status !== "em_andamento") return;
        if (sub.outcome === "cancelled") {
          Object.assign(step, { status: "falhou", result: sub.result, finishedAt: at });
          Object.assign(planTask, { status: "cancelada", finishedAt: at, updatedAt: at });
          delete planTask.note;
          plan.updatedAt = at;
          this.save([plan]);
          this.afterChange(plan);
          return;
        }
        Object.assign(step, { status: "falhou", result: sub.result, finishedAt: at });
        this.failTask(plan, planTask, sub.result ?? "sem motivo informado");
        plan.updatedAt = at;
        this.save([plan]);
        this.pump();
        return;
      case "done": {
        if (step.status !== "em_andamento") return;
        Object.assign(step, { status: "feita", result: sub.result ?? "", finishedAt: at });
        clearBlocked(planTask, at);
        const next = planTask.steps[index + 1];
        if (next) {
          Object.assign(planTask, { current: index + 1, status: "em_andamento", waitingSince: at, updatedAt: at });
          if (request) this.logRequest(request, { kind: "text", text: `${planTask.ref}: ${this.agentName(state, step.agentId)} terminou a etapa ${index + 1} e passou para ${this.agentName(state, next.agentId)}.` });
        } else {
          Object.assign(planTask, { status: "concluida", result: sub.result ?? "", finishedAt: at, updatedAt: at });
          delete planTask.note;
          delete planTask.waitingSince;
          if (request) this.logRequest(request, { kind: "text", text: `${planTask.ref} «${planTask.title}» concluída (${this.agentName(state, step.agentId)}).` });
          if (planTask.origin?.intent === "ask" && !planTask.origin.reply) this.replyToAsk(plan, planTask, step.agentId, sub.result ?? "");
          this.unlockDependents(plan);
        }
        plan.updatedAt = at;
        this.save([plan]);
        this.afterChange(plan);
        return;
      }
    }
  }

  /** Depois de uma tarefa terminar: progresso, fim do plano (acorda o Maestro uma vez) e a fila anda. */
  private afterChange(plan: Project): void {
    this.progress(plan);
    if ((plan.status === "ativo" || plan.status === "pausado") && leafTasks(plan.tasks).every(isProjectTaskFinished)) void this.finishPlan(plan);
    this.pump();
  }

  /** Quem dependia da tarefa cancelada ficou travada: o Maestro é avisado (pode replanejar com add_project_tasks, resolve_task ou tirando a dependência). */
  private warnBlocked(plan: Project, cancelled: ProjectTask): void {
    const stuck = blockedLeaves(plan).filter((leaf) => deadDependencies(plan, leaf).some((dep) => dep.ref === cancelled.ref));
    if (stuck.length === 0) return;
    const reqId = requestIdOf(plan);
    const message = () =>
      [
        `Pedido ${reqId}${plan.requestId ? ` (projeto ${plan.id})` : ""}: o dono cancelou a tarefa ${cancelled.ref} («${cancelled.title}»). Ficaram TRAVADAS (não rodam sozinhas, o resultado de que precisam não existe): ${stuck.map((leaf) => `${leaf.ref} («${leaf.title}»)`).join(", ")}.`,
        "O dono também foi avisado. Replaneje se fizer sentido: tire a dependência, ponha outra tarefa no lugar (add_project_tasks) ou cancele as que não valem mais. Depois termine o turno.",
      ].join("\n\n");
    queueMicrotask(() => this.deps.host(reqId)?.wake(reqId, "failed", message, () => this.get(plan.id)));
  }

  private failTask(plan: Project, task: ProjectTask, reason: string): void {
    const at = this.at();
    Object.assign(task, { status: "falhou", failure: reason, updatedAt: at });
    delete task.note;
    clearBlocked(task, at);
    const state = this.deps.state.read();
    const step = task.steps[task.current];
    const reqId = requestIdOf(plan);
    const request = state.tasks.find((candidate) => candidate.id === reqId);
    if (request) this.logRequest(request, { kind: "text", text: `${task.ref} «${task.title}» falhou na etapa ${task.current + 1}: ${shorten(reason, 300)}` });
    const stepNumber = task.current + 1;
    // Montado quando o Maestro consome a mensagem: o estado de então (a tarefa pode ter sido refeita ou resolvida).
    const message = () => [
      `Pedido ${reqId}${plan.requestId ? ` (projeto ${plan.id})` : ""}: a tarefa ${task.ref} («${task.title}») falhou na etapa ${stepNumber}/${task.steps.length}${step ? ` (${this.agentName(this.deps.state.read(), step.agentId)})` : ""}:`,
      shorten2(task.failure ?? reason, 1500),
      task.status !== "falhou" ? `(Agora a tarefa está: ${task.skipped ? "pulada" : task.status}. Só confira com get_project antes de decidir.)` : "",
      `As outras tarefas seguem; as que dependem desta esperam. Decida com resolve_task(project_id: "${plan.id}", ref: "${task.ref}", action: "retry" (com instruction), "skip" ou "cancel_project") ou inclua trabalho com add_project_tasks. Depois termine o turno.`,
    ].filter(Boolean).join("\n\n");
    queueMicrotask(() => this.deps.host(reqId)?.wake(reqId, "failed", message, () => this.get(plan.id)));
  }

  /** Todas as tarefas terminaram: o plano fecha e o Maestro recebe UMA mensagem com o resumo. */
  private async finishPlan(plan: Project): Promise<void> {
    if (plan.doneNotified) return;
    const at = this.at();
    Object.assign(plan, { status: "concluido", finishedAt: at, updatedAt: at, doneNotified: true });
    this.save([plan]);
    const state = this.deps.state.read();
    const notes = await this.notePaths(state, plan);
    const reqId = requestIdOf(plan);
    // Montado quando o Maestro consome a mensagem (as notas de resultado já foram buscadas acima).
    const message = () => {
      const unit = projectUnitProgress(plan);
      const each = Math.max(300, Math.min(TEXT.summaryEach, Math.floor(TEXT.summaryTotal / Math.max(1, plan.tasks.length))));
      const sections = plan.tasks.map((task) => {
        const parentNode = !task.group && plan.tasks.some((candidate) => candidate.parent === task.ref);
        if (task.group) return `## ${task.ref} · ${task.title} (módulo)`;
        if (parentNode) {
          // Tarefa-mãe: a entrega é a da última subtarefa (ou o conjunto, se terminaram em paralelo): não repete o texto.
          const delivery = deliveryLeaves(plan, task.ref);
          return `## ${task.ref} · ${task.title} (tarefa com subtarefas) — a entrega é ${delivery.length > 0 ? delivery.map((leaf) => `a de ${leaf.ref} (${this.agentName(state, leaf.ownerId)})`).join(" e ") : "(sem resultado)"}`;
        }
        const chain = task.steps.map((step) => this.agentName(state, step.agentId)).join(" → ");
        const last = task.steps.at(-1)?.taskId;
        const note = last ? notes.get(last) : undefined;
        const heading = `## ${task.ref} · ${task.title}${task.skipped ? " [PULADA]" : task.status === "cancelada" ? " [CANCELADA]" : ""} — ${chain}`;
        const checklist = task.doneWhen.length > 0 ? `Done when: ${task.doneWhen.map((item) => `${item.met === true ? "✓" : item.met === false ? "✗" : "?"} ${item.text}${item.note ? ` (${item.note})` : ""}`).join("; ")}` : "";
        return [heading, shorten2(task.result ?? "(sem resultado)", each), checklist, [last ? `get_task("${last}")` : "", note ? `nota: ${note}` : ""].filter(Boolean).join(" · ")].filter(Boolean).join("\n");
      });
      const moreOpen = this.openPlansForRequest(reqId).filter((candidate) => !isParked(candidate)).length;
      return [
        `Pedido ${reqId}${plan.requestId ? ` (projeto ${plan.id} «${plan.title}»)` : ""}: o projeto terminou — ${progressLabel(unit)}.`,
        ...sections,
        moreOpen > 0
          ? `Ainda há ${moreOpen} projeto(s) aberto(s) neste pedido: aguarde os demais ou continue trabalhando antes de chamar complete_request(request_id: "${reqId}", text).`
          : `Agora sintetize o resultado para o usuário (a resposta aparece na conversa) e feche com complete_request(request_id: "${reqId}", text).`,
      ].join("\n\n");
    };
    this.deps.log.info({ planId: plan.id, requestId: reqId }, "plano concluído: Maestro avisado");
    this.deps.host(reqId)?.wake(reqId, "done", message, () => this.get(plan.id));
  }

  /** Caminho da nota de resultado (histórico do quarto) de cada subtarefa final (melhor esforço). */
  private async notePaths(state: OfficeState, plan: Project): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (!this.deps.brain) return out;
    const wanted = new Map<string, string>();
    for (const task of plan.tasks) {
      const id = task.steps.at(-1)?.taskId;
      const sub = id ? state.tasks.find((candidate) => candidate.id === id) : undefined;
      if (sub) wanted.set(sub.id, sub.roomId);
    }
    for (const roomId of new Set(wanted.values())) {
      const notes = await this.deps.brain.readHistory(roomId).catch(() => []);
      for (const [taskId, room] of wanted) {
        if (room !== roomId) continue;
        const note = notes.find((candidate) => candidate.content.includes(`task: ${JSON.stringify(taskId)}`));
        if (note) out.set(taskId, `${roomId}/${note.file}`);
      }
    }
    return out;
  }

  /**
   * O pedido fechou: se falhou/foi cancelado, todos os projetos abertos dele são cancelados;
   * se concluiu (`done`), projetos estacionados (só Planejados) permanecem abertos no backlog
   * para serem liberados depois pelo dono, pelo ritmo ou pelo Maestro. Como o pedido já está
   * fechado, avisos futuros (`wake`) desse projeto ao Maestro são ignorados.
   */
  private onRequestClosed(task: Task): void {
    this.closeLeaves(task.id, task);
    const loose = this.plans.find((candidate) => candidate.id === task.id && !isAvulsas(candidate));
    if (loose && !hasLifecycle(loose)) this.closeMirror(loose, task);
    for (const plan of this.openPlansForRequest(task.id)) {
      if (task.status === "done" && isParked(plan)) continue;
      this.cancelPlan(plan, "O pedido foi fechado");
    }
  }

  /** Cancela o projeto: as tarefas param. `strict` (caminho do usuário): espera a gravação e lança o erro de verdade. */
  private cancelPlan(plan: Project, reason: string, strict = false): Promise<void> {
    const at = this.at();
    for (const task of plan.tasks) {
      if (isProjectTaskFinished(task)) continue;
      const running = task.steps[task.current];
      if (running?.status === "em_andamento" && running.taskId) this.deps.orchestrator.cancelTask(running.taskId, reason);
      Object.assign(task, { status: "cancelada", updatedAt: at });
      delete task.note;
      clearBlocked(task, at);
    }
    Object.assign(plan, { status: "cancelado", finishedAt: at, updatedAt: at });
    if (plan.forYouId) void this.deps.forYou.close(plan.forYouId, "rejeitado", reason);
    for (const sprint of closingSprints(plan)) if (sprint.forYouId) void this.deps.forYou.close(sprint.forYouId, "rejeitado", reason);
    const saved = strict ? this.saveStrict([plan]) : this.save([plan]);
    this.deps.log.info({ planId: plan.id, reason }, "plano cancelado");
    this.pump();
    return saved;
  }

  /** Backlog com as dependências prontas vira "a fazer". */
  private unlockDependents(plan: Project): void {
    // Dependência em pai ou módulo = todas as folhas dele concluídas.
    const done = completedRefs(plan);
    const at = this.at();
    for (const task of plan.tasks) {
      if (task.status !== "backlog" || !isLeaf(plan, task) || !task.ownerId || !effectiveDeps(plan, task).every((ref) => done.has(ref))) continue;
      Object.assign(task, { status: "a_fazer", waitingSince: at, ...(releaseHold(task) ? {} : { queuedAt: at }), updatedAt: at });
    }
  }


  // ---------- Infra ----------

  private progress(plan: Project): void {
    if (plan.status !== "ativo") return;
    const { done, total } = projectProgress(plan);
    const reqId = requestIdOf(plan);
    this.deps.host(reqId)?.working(reqId, `Projeto: ${progressLabel(projectUnitProgress(plan))}`, 0.2 + (0.7 * done) / Math.max(1, total));
  }

  /** Tarefa e projeto (com ciclo de plano) a que a Task pertence; projeto de tarefa avulsa não conta (veja `mirror`). */
  private locate(task: Pick<Task, "work">): { plan: Project; planTask: ProjectTask } | undefined {
    const found = this.locateAny(task);
    return found && hasLifecycle(found.plan) ? found : undefined;
  }

  private locateAny(task: Pick<Task, "work">): { plan: Project; planTask: ProjectTask } | undefined {
    if (!task.work) return undefined;
    const plan = this.plans.find((candidate) => candidate.id === task.work!.projectId);
    const planTask = plan?.tasks.find((candidate) => candidate.ref === task.work!.ref);
    return plan && planTask ? { plan, planTask } : undefined;
  }

  private require(id: string): Project {
    const plan = this.plans.find((candidate) => candidate.id === id);
    if (!plan) throw new HttpError(404, `Plano "${id}" não encontrado`);
    return plan;
  }

  private requireRequest(state: OfficeState, requestId: string): Task {
    const request = state.tasks.find((task) => task.id === requestId);
    if (!request || !isActiveTaskStatus(request.status)) throw new Error(`Request "${requestId}" is not open`);
    return request;
  }

  /** Agentes que podem receber etapas: todos menos o Maestro. */
  private pool(state: OfficeState) {
    const maestro = findMaestroAgent(state);
    return { agents: state.agents.filter((agent) => agent.id !== maestro?.id), forbidden: new Set(maestro ? [maestro.id] : []) };
  }

  private agentName(state: OfficeState, id: string | undefined): string {
    return state.agents.find((agent) => agent.id === id)?.name ?? id ?? "?";
  }

  private logRequest(request: Task, body: Parameters<AgentLogService["append"]>[1]): void {
    this.deps.agentLog.append({ taskId: request.id, agentId: request.agentId ?? "" }, body);
  }

  private at(): string {
    return this.deps.now().toISOString();
  }

  /** Cópias dos projetos prontas para gravar (com o endereço das etapas). */
  private copies(changed: Project[]): Project[] {
    return [...new Set(changed)].map((plan) => {
      for (const task of plan.tasks) {
        for (const step of task.steps) step.address ??= agentAddress(this.deps.workspaceId, step.agentId);
        // Entrou na fila e ninguém marcou (tarefa nova): a hora da espera, ou agora. Quem volta à fila marca na hora (`queuedAt: at`).
        // A folha Planejada ainda não está na fila: a espera dela só começa quando for liberada (`releaseNodes`).
        if (task.status === "a_fazer" && task.queuedAt === undefined && !releaseHold(task)) task.queuedAt = task.waitingSince ?? this.at();
      }
      return structuredClone(plan);
    });
  }

  private persistOptions(label: string) {
    return { label, log: this.deps.log, publish: (event: ServerEvent) => this.deps.state.publish(event), now: this.deps.now, ...(this.deps.persistDelaysMs ? { delaysMs: this.deps.persistDelaysMs } : {}) };
  }

  /**
   * Grava os projetos que mudaram (projects/<id>.json) e publica project:upserted deles. Dispara do
   * servidor (agendador, eventos): 3 tentativas com espera crescente e, se não der, aviso visível
   * (`system:warning`); nunca lança.
   */
  private async save(changed: Project[]): Promise<void> {
    const copies = this.copies(changed);
    const events: ServerEvent[] = copies.map((project) => ({ type: "project:upserted" as const, project: structuredClone(project) }));
    await persist((attempt) => this.deps.state.commit({ projects: copies, events: attempt === 0 ? events : [] }), this.persistOptions("os projetos"));
  }

  /** Como `save`, mas lança um erro 500 de verdade (caminhos disparados pelo usuário: aprovar, ajustar, cancelar). */
  private async saveStrict(changed: Project[], quiet = false): Promise<void> {
    const copies = this.copies(changed);
    // `quiet`: grava sem publicar (o evento sai na próxima gravação, quando o resto já está pronto).
    const events: ServerEvent[] = quiet ? [] : copies.map((project) => ({ type: "project:upserted" as const, project: structuredClone(project) }));
    await persistOrThrow((attempt) => this.deps.state.commit({ projects: copies, events: attempt === 0 ? events : [] }), {
      ...this.persistOptions("os projetos"),
      fail: (error) => new HttpError(500, `Não consegui gravar o projeto no disco: ${error instanceof Error ? error.message : String(error)}`),
    });
  }

  /** Gravação do usuário que desfaz a mudança em memória se o disco falhar (o erro volta ao cliente). */
  private async saveUser(plan: Project, previous: Project): Promise<void> {
    try {
      await this.saveStrict([plan]);
    } catch (error) {
      const index = this.plans.indexOf(plan);
      if (index >= 0) this.plans[index] = previous;
      void this.deps.state.commit({ projects: [previous], events: [{ type: "project:upserted", project: previous }] }).catch(() => undefined);
      throw error;
    }
  }

  /** Grava a lista de tarefas (etapa nova) com novas tentativas e aviso visível (nunca lança). */
  private async commitTasks(tasks: Task[], events: ServerEvent[]): Promise<void> {
    await persist((attempt) => this.deps.state.commit({ tasks, events: attempt === 0 ? events : [] }), this.persistOptions("a etapa do plano"));
  }

  /**
   * O agente conferiu o "Done when" da tarefa e mandou `checklist` (junto de `submit_result` ou
   * `request_approval`): grava `met`/`note` em `doneWhen`. Só grava e mostra; não bloqueia. `index` é
   * o número mostrado no briefing (a partir de 1). Devolve avisos sobre itens que não existem.
   */
  recordChecklist(task: Task, checklist: { index: number; met: boolean; note?: string }[]): string | undefined {
    const found = this.locateAny(task);
    if (!found || checklist.length === 0) return undefined;
    const unknown: number[] = [];
    for (const entry of checklist) {
      const item = found.planTask.doneWhen[entry.index - 1];
      if (!item) {
        unknown.push(entry.index);
        continue;
      }
      item.met = entry.met;
      if (entry.note?.trim()) item.note = shorten(entry.note.trim(), 300);
      else delete item.note;
    }
    const at = this.at();
    found.planTask.updatedAt = at;
    found.plan.updatedAt = at;
    void this.save([found.plan]);
    return unknown.length > 0 ? `checklist index ${unknown.join(", ")} does not exist (Done when has ${found.planTask.doneWhen.length} item(s), numbered from 1)` : undefined;
  }
}

/**
 * Aplica `release` ("now" | "later") nas tarefas recém-montadas (`create_project` e `add_project_tasks`):
 * 1. `item.release` explícito sempre vence (inclusive filho "now" dentro de pai Planejado).
 * 2. Sem `item.release`, herda do pai recém-criado na mesma chamada (módulo/mãe propaga aos filhos).
 * 3. Se o pai já existe no projeto (`existing`) e está Planejado (`released === false`), herda `false`.
 * 4. Caso contrário, usa o `callRelease` da chamada (`undefined` em chamadas legadas = não preenche o campo).
 */
function applyInputRelease(built: readonly ProjectTask[], inputs: readonly ProjectTaskInput[], callRelease: ProjectInputRelease | undefined, existing: readonly ProjectTask[] = []): void {
  const inputByRef = new Map<string, ProjectTaskInput>();
  built.forEach((task, index) => inputByRef.set(task.ref, inputs[index]!));
  const freshByRef = new Map(built.map((task) => [task.ref, task]));
  const existingByRef = new Map(existing.map((task) => [task.ref, task]));
  const memo = new Map<string, boolean | undefined>();
  const compute = (ref: string, seen: Set<string>): boolean | undefined => {
    if (memo.has(ref)) return memo.get(ref);
    const input = inputByRef.get(ref);
    if (input?.release !== undefined) {
      const value = input.release === "now";
      memo.set(ref, value);
      return value;
    }
    const task = freshByRef.get(ref);
    if (!task || seen.has(ref)) return callRelease === undefined ? undefined : callRelease === "now";
    seen.add(ref);
    if (task.parent) {
      if (freshByRef.has(task.parent)) {
        const value = compute(task.parent, seen);
        memo.set(ref, value);
        return value;
      }
      const parent = existingByRef.get(task.parent);
      if (parent && parent.released === false) {
        memo.set(ref, false);
        return false;
      }
    }
    const value = callRelease === undefined ? undefined : callRelease === "now";
    memo.set(ref, value);
    return value;
  };
  for (const task of built) {
    const value = compute(task.ref, new Set());
    if (value !== undefined) task.released = value;
  }
}

/** O que um projeto-casca do Cyno passa ao projeto que o Maestro monta (origem, briefing, prioridade, prazos). */
function carriedFromShell(shell: Project): Partial<Project> {
  return {
    origin: shell.origin,
    ...(shell.brief ? { brief: shell.brief } : {}),
    priority: shell.priority,
    ...(shell.startAt ? { startAt: shell.startAt } : {}),
    ...(shell.dueAt ? { dueAt: shell.dueAt } : {}),
    ...(shell.doneWhen?.length ? { doneWhen: shell.doneWhen } : {}),
    ...(shell.joint ? { joint: shell.joint } : {}),
  };
}
