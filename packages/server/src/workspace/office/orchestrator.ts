import {
  agentEngine,
  approvalRefusedResult,
  compareWork,
  describeModelChoice,
  engineBlockLabel,
  isCliEngine,
  isMaestroAgent,
  isMaestroTask,
  isSeedId,
  type Agent,
  type AgentStatus,
  type EngineBlock,
  type FailureKind,
  type ModelChoice,
  type RankInput,
  type ServerEvent,
  type Task,
  type TaskProgressInfo,
  type TaskStatus,
} from "@cyno/shared";
import type { FastifyBaseLogger } from "fastify";
import { runnerLogHooks } from "../agent-log/hooks";
import type { AgentLogService } from "../agent-log/service";
import type { Brain } from "../brain/brain";
import { diaryEntry, type AgentDiary } from "../brain/diary";
import { HttpError } from "../../platform/http/errors";
import { cancelNote, type ApprovalInbox } from "../for-you/service";
import type { AgentRunner, ApprovalDecision, RunHooks, RunInput, RunOutcome } from "../../engines/runner/types";
import { officeStructure, type StateManager } from "../../store/state-manager";
import { buildResultNote } from "./task-note";
import { errorMessage, shorten } from "../../util/text";

/** Agente executando uma tarefa (com aprovação possivelmente pendente). */
type RunningSlot = {
  kind: "running";
  taskId: string;
  controller: AbortController;
  progress: number;
  /** Último task:progress publicado (vai no office:snapshot para quem conecta depois). */
  message?: string;
  resolveApproval?: (decision: ApprovalDecision) => void;
  /** Passado o tempo de espera, a vaga do agente é liberada para a próxima tarefa (veja `park`). */
  parkTimer?: NodeJS.Timeout;
  /**
   * A tarefa já foi aprovada antes de um restart: o próximo pedido de aprovação passa direto,
   * com esta decisão (o texto final e a resposta).
   */
  preApproved?: ApprovalDecision;
  /**
   * A tarefa recomeçou depois de um restart com uma decisão que NÃO encerra o pedido (recusa que
   * volta para refazer): o runner manda a decisão junto com a tarefa, mas o próximo pedido de
   * aprovação é de verdade (não passa direto).
   */
  resumed?: ApprovalDecision;
};
/** Agente "done" esperando DONE_LINGER_MS antes de ficar idle ou pegar a próxima tarefa. */
type LingerSlot = { kind: "lingering"; timer: NodeJS.Timeout };
type Slot = RunningSlot | LingerSlot;

/** Quanto uma tarefa espera o usuário antes de soltar a vaga do agente (padrão; os testes e o servidor ajustam). */
export const DEFAULT_APPROVAL_PARK_MS = 2 * 60_000;

/** O que uma tarefa de agente espera do usuário (vai no `waiting` dela e no log). */
const WAITING_APPROVAL = "Esperando sua aprovação";
const WAITING_ANSWERS = "Esperando suas respostas";

type TaskChange = { status: TaskStatus; result?: string; ranWith?: ModelChoice; waiting?: string; outcome?: "cancelled"; failureKind?: FailureKind; pendingDecision?: Record<string, unknown> };
/** Resultado de `apply`: a tarefa alterada e a promessa da gravação em disco. */
type Applied = { task: Task | undefined; saved: Promise<void> };

export type OrchestratorDeps = {
  state: StateManager;
  brain: Brain;
  runner: AgentRunner;
  /** Onde nasce o item do "Para você" de cada pedido de aprovação. */
  approvals: ApprovalInbox;
  /** Log de trabalho dos agentes (status, aprovações, resultado e o que o runner narra). */
  agentLog: AgentLogService;
  /** Diário dos agentes de CLI (uma entrada por tarefa terminada; as últimas vão na tarefa seguinte). */
  diary?: AgentDiary;
  log: Pick<FastifyBaseLogger, "info" | "error">;
  doneLingerMs: number;
  now?: () => Date;
  /**
   * O motor do agente está indisponível agora (cota esgotada, CLI ausente)? Então as tarefas dele
   * esperam na fila ("queued") e andam sozinhas quando o motor volta (`retryWaiting`). Nunca troca de motor.
   */
  availability?: (agent: Agent) => EngineBlock | undefined;
  /**
   * Quanto tempo uma tarefa que espera aprovação (ou respostas) segura a vaga do agente antes de soltá-la
   * (padrão 2 min). Antes disso a tarefa continua na mesma sessão; depois, o agente pega a próxima da fila
   * e a tarefa recomeça (já com a decisão) quando ele ficar livre. Se já há outra tarefa esperando na
   * fila do agente, a vaga é solta na hora. 0 = solta sempre na hora.
   */
  approvalParkMs?: number;
  /** Agendador de trabalho: ordem da fila (`workRank`) e admissão (ritmo, pausa) das tarefas de projeto. */
  scheduling?: OrchestratorScheduling;
};

/** O que o agendador de projetos informa à fila do orquestrador. */
export type OrchestratorScheduling = {
  /** Entrada da ordem de urgência da tarefa (prioridade, prazo, aprovado há mais tempo); undefined = sem projeto. */
  rank?: (task: Task) => RankInput | undefined;
  /** A tarefa pode começar agora? false = projeto pausado ou fora do ritmo (ela espera na fila). */
  admit?: (task: Task) => boolean;
  /** Tempo médio das tarefas já feitas (urgência extra da ordem). */
  avgTaskMs?: () => number | undefined;
  /** A fila do agente parou por falta de motor/cota (uma vez por espera). */
  onEngineBlock?: (task: Task, block: EngineBlock, agent: Agent) => void;
};

/**
 * Fila FIFO por agente, uma tarefa por vez. Transições (todas persistidas e emitidas):
 * queued -> in_progress (agente working) -> [waiting_approval -> in_progress] ->
 * done (agente "done" por doneLingerMs, depois idle ou próxima tarefa) | failed (agente idle).
 * Uma aprovação pendente sobrevive ao restart: a tarefa continua waiting_approval até a decisão.
 * As tarefas do Maestro (triagem/delegação) ficam de fora: veja MaestroCoordinator.
 * Salvar o resultado no Cérebro é responsabilidade daqui (vale para qualquer runner).
 * O log de trabalho de cada tarefa também: status (started/waiting/resumed/done/failed/canceled),
 * aprovações (pedida/decidida) e o resultado; o runner narra o resto pelos RunHooks.
 */
export class Orchestrator {
  private readonly slots = new Map<string, Slot>();
  private readonly now: () => Date;
  private stopped = false;
  /** Tarefas que já ganharam a linha "esperando a cota" no log (uma vez por espera). */
  private readonly waitingLogged = new Set<string>();
  /**
   * Tarefas esperando a decisão do usuário SEM ocupar o agente (tarefa -> agente): a espera passou de
   * `approvalParkMs`, havia outra tarefa na fila ou o servidor reiniciou. A tarefa segue `waiting_approval`.
   */
  private readonly parked = new Map<string, string>();
  /** Decisão já tomada de uma tarefa parada: ela volta à fila e recomeça com ela quando o agente ficar livre. */
  private readonly resumeWith = new Map<string, ApprovalDecision>();

  constructor(private readonly deps: OrchestratorDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * Boot: tarefas ativas de agentes que não existem mais viram failed; aprovações pendentes
   * continuam esperando a decisão do usuário (agente waiting_approval); as tarefas em andamento
   * voltam para a fila, os demais agentes voltam a idle e as filas andam.
   */
  async resume(): Promise<void> {
    const state = this.deps.state.read();
    const agentIds = new Set(state.agents.map((agent) => agent.id));
    const at = this.now().toISOString();
    const events: ServerEvent[] = [];
    for (const task of state.tasks) {
      // As tarefas do Maestro são retomadas pelo MaestroCoordinator.
      if (isMaestroTask(state, task)) continue;
      // Tarefa fabricada pela semente do app de teste: fica como está (voltar para a fila a faria rodar de verdade, com cota de verdade).
      if (isSeedId(task.id)) continue;
      const interrupted = task.status === "in_progress" || task.status === "waiting_approval";
      const active = interrupted || task.status === "queued";
      const agentId = task.agentId && agentIds.has(task.agentId) ? task.agentId : undefined;
      if (!active) continue;
      if (!agentId) {
        Object.assign(task, { status: "failed", result: "Cancelada: o agente não existe mais", failureKind: "outro" });
      } else if (task.status === "waiting_approval") {
        // Aprovação pendente: nada roda até o usuário decidir, e ela não segura a vaga do agente.
        this.parked.set(task.id, agentId);
        continue;
      } else if (interrupted) {
        task.status = "queued";
      } else {
        // Na fila com a decisão já tomada (o servidor reiniciou entre a aprovação e a retomada): recomeça com ela.
        if (task.pendingDecision) this.resumeWith.set(task.id, task.pendingDecision as unknown as ApprovalDecision);
        continue;
      }
      task.updatedAt = at;
      events.push({ type: "task:upserted", task });
    }
    for (const agent of state.agents) {
      const status = this.restingStatus(agent.id);
      if (agent.status === status) continue;
      agent.status = status;
      events.push({ type: "agent:upserted", agent });
    }
    if (events.length > 0) {
      await this.deps.state.commit({ office: officeStructure(state), tasks: state.tasks, events });
    }
    const waiting = new Set(state.tasks.filter((task) => task.status === "queued").map((task) => task.agentId!));
    for (const agentId of waiting) this.pump(agentId);
  }

  /** Avisa que o agente ganhou uma tarefa nova na fila. */
  enqueue(agentId: string): void {
    this.pump(agentId);
  }

  /** Um motor pode ter voltado (a cota zerou, uso novo, o usuário pediu): as filas paradas tentam andar. */
  retryWaiting(): void {
    if (this.stopped) return;
    const state = this.deps.state.read();
    const waiting = new Set(state.tasks.filter((task) => task.status === "queued" && task.agentId).map((task) => task.agentId!));
    for (const agentId of waiting) this.pump(agentId);
  }

  /**
   * Decide uma aprovação pendente. Aprovada: a tarefa segue (o runner recebe o texto final e a
   * resposta). Recusada: tarefa failed ("Recusado pelo usuário", com a nota como motivo).
   * Quem chama é o "Para você" (ForYouService), que guarda a decisão no item.
   */
  async approve(taskId: string, decision: ApprovalDecision): Promise<Task> {
    const task = this.deps.state.read().tasks.find((candidate) => candidate.id === taskId);
    if (!task) throw new HttpError(404, `Tarefa "${taskId}" não encontrada`);
    const agentId = task.agentId ?? "";
    const slot = this.slots.get(agentId);
    const owned = slot && slot.kind !== "lingering" && slot.taskId === taskId ? slot : undefined;
    const pending = owned?.resolveApproval;
    const parked = this.parked.has(taskId);
    if (task.status !== "waiting_approval" || (!parked && (!owned || !pending))) {
      throw new HttpError(409, "A tarefa não está aguardando aprovação");
    }
    if (owned) {
      owned.resolveApproval = undefined;
      clearTimeout(owned.parkTimer);
    }
    const ref = { taskId, agentId };
    const cancelled = decision.cancelled ? cancelNote(decision.cancelled) : undefined;
    this.deps.agentLog.append(ref, {
      kind: "approval",
      phase: "decided",
      approved: decision.approved && !decision.retry && !cancelled,
      ...(cancelled ? { note: cancelled } : decisionNote(decision) ? { note: decisionNote(decision)! } : {}),
    });
    if (decision.approved || decision.retry) {
      const resumed = decision.retry
        ? `Recusada com o motivo: a tarefa volta para o agente refazer (retrabalho ${decision.rework?.count ?? 1} de ${decision.rework?.max ?? 2})`
        : cancelled
          ? `${cancelled} (seguindo sem a resposta)`
          : task.waiting === WAITING_ANSWERS
            ? "Respondida: seguindo com a tarefa"
            : "Aprovada: seguindo com a tarefa";
      if (pending) {
        this.deps.agentLog.append(ref, { kind: "status", status: "resumed", message: resumed });
        const result = this.apply(taskId, agentId, { status: "in_progress" }, "working");
        pending(decision);
        await result.saved;
        return result.task!;
      }
      // A vaga do agente já foi liberada: a tarefa volta à fila (por prioridade) e recomeça já com a decisão.
      this.parked.delete(taskId);
      this.resumeWith.set(taskId, decision);
      this.deps.agentLog.append(ref, { kind: "status", status: "resumed", message: `${resumed}; recomeça quando o agente ficar livre` });
      const result = this.apply(taskId, agentId, { status: "queued", pendingDecision: structuredClone(decision) as unknown as Record<string, unknown> }, this.currentStatus(agentId));
      this.pump(agentId);
      await result.saved;
      return result.task!;
    }
    const refused = approvalRefusedResult(decision.response);
    if (parked) {
      this.parked.delete(taskId);
      this.endLog(taskId, agentId, "failed", refused);
      const result = this.apply(taskId, agentId, { status: "failed", result: refused, failureKind: "outro" }, this.restingStatusIfIdle(agentId));
      this.deps.log.info({ taskId, agentId }, "tarefa recusada pelo usuário");
      this.pump(agentId);
      await result.saved;
      return result.task!;
    }
    this.release(agentId);
    pending?.({ approved: false });
    this.endLog(taskId, agentId, "failed", refused);
    const result = this.apply(taskId, agentId, { status: "failed", result: refused, failureKind: "outro" }, "idle");
    this.deps.log.info({ taskId, agentId }, "tarefa recusada pelo usuário");
    this.pump(agentId);
    await result.saved;
    return result.task!;
  }

  /**
   * Solta agentes que vão ser removidos: aborta a execução, recusa a aprovação pendente e
   * cancela a espera "done" (no log, a tarefa em curso fica "canceled" com o motivo). Quem chama
   * grava o estado (tarefas failed, agentes removidos).
   */
  detachAgents(agentIds: Iterable<string>, reason = "Tarefa cancelada"): void {
    const removed = new Set(agentIds);
    for (const agentId of removed) {
      const slot = this.slots.get(agentId);
      this.release(agentId);
      if (slot && slot.kind !== "lingering") this.endLog(slot.taskId, agentId, "canceled", reason);
    }
    for (const [taskId, agentId] of [...this.parked]) {
      if (!removed.has(agentId)) continue;
      this.parked.delete(taskId);
      this.endLog(taskId, agentId, "canceled", reason);
    }
    for (const [taskId] of [...this.resumeWith]) {
      const owner = this.deps.state.read().tasks.find((task) => task.id === taskId)?.agentId;
      if (owner && removed.has(owner)) this.resumeWith.delete(taskId);
    }
  }

  /**
   * Cancela uma tarefa ativa (plano cancelado, pedido fechado pelo usuário): em execução, aborta (e
   * recusa a aprovação pendente); na fila, só sai. Fica failed com o motivo; a fila do agente anda.
   */
  cancelTask(taskId: string, reason: string): void {
    const task = this.deps.state.read().tasks.find((candidate) => candidate.id === taskId);
    if (!task || (task.status !== "queued" && task.status !== "in_progress" && task.status !== "waiting_approval")) return;
    const agentId = task.agentId ?? "";
    const slot = this.slots.get(agentId);
    const owned = slot !== undefined && slot.kind !== "lingering" && slot.taskId === taskId;
    if (owned) this.release(agentId);
    const wasParked = this.parked.delete(taskId);
    this.resumeWith.delete(taskId);
    this.endLog(taskId, agentId, "canceled", reason);
    this.apply(taskId, agentId, { status: "failed", result: reason, outcome: "cancelled", failureKind: "cancelada" }, owned ? "idle" : wasParked ? this.restingStatusIfIdle(agentId) : this.currentStatus(agentId));
    if (owned || wasParked) this.pump(agentId);
  }

  /**
   * Último progresso e mensagem de cada tarefa em execução (inclusive a pergunta de uma aprovação
   * pendente), por id da tarefa. Fica só em memória: uma aprovação restaurada no boot não tem.
   */
  progressSnapshot(): Record<string, TaskProgressInfo> {
    const out: Record<string, TaskProgressInfo> = {};
    for (const [agentId, slot] of this.slots) {
      if (slot.kind !== "running" || slot.message === undefined) continue;
      out[slot.taskId] = { agentId, progress: slot.progress, message: slot.message };
    }
    return out;
  }

  /** Shutdown: para tudo sem gravar nada (no próximo boot as tarefas voltam para a fila). */
  stop(): void {
    this.stopped = true;
    for (const agentId of [...this.slots.keys()]) this.release(agentId);
    this.parked.clear();
    this.resumeWith.clear();
  }

  private release(agentId: string): void {
    const slot = this.slots.get(agentId);
    if (!slot) return;
    this.slots.delete(agentId);
    if (slot.kind === "lingering") {
      clearTimeout(slot.timer);
      return;
    }
    clearTimeout(slot.parkTimer);
    slot.controller.abort(new Error("Tarefa cancelada"));
    slot.resolveApproval?.({ approved: false });
  }

  /**
   * Começa a próxima tarefa da fila do agente, se ele estiver livre; senão, nada. A escolha é por
   * `workRank` (atrasada, prazo em menos de 24 h, prioridade, prazo, projeto aprovado há mais tempo),
   * com a ordem de chegada (FIFO) de desempate; tarefa que o ritmo do projeto segura (pausa, começa em,
   * janela, limite de horas) fica de fora. Tarefa já aprovada que volta de uma espera vai na frente.
   */
  private pump(agentId: string): void {
    if (this.stopped) return;
    if (this.slots.has(agentId)) {
      this.parkIfBlocking(agentId);
      return;
    }
    const state = this.deps.state.read();
    const agent = state.agents.find((candidate) => candidate.id === agentId);
    // O Maestro não roda tarefas no runner: o status e as tarefas dele são do MaestroCoordinator.
    if (!agent || isMaestroAgent(state, agent)) return;
    // As tarefas fabricadas pela semente do app de teste ficam "na fila" só para as telas: nunca são escolhidas para rodar.
    const next = this.pick(state.tasks.filter((task) => task.agentId === agentId && task.status === "queued" && !isSeedId(task.id)));
    const block = next ? this.deps.availability?.(agent) : undefined;
    if (next && block) {
      // Sem cota (ou CLI ausente): a tarefa espera na fila; retryWaiting a solta quando o motor voltar.
      this.noteWaiting(next, agent, block);
      this.settle(agentId);
      return;
    }
    if (next) {
      const decision = this.resumeWith.get(next.id);
      this.resumeWith.delete(next.id);
      this.start(next.id, agentId, decision && !decision.retry ? decision : undefined, decision?.retry ? decision : undefined);
    } else this.settle(agentId);
  }

  /** A próxima tarefa da fila: admitida pelo agendador e a primeira na ordem do `workRank` (FIFO no empate). */
  private pick(queued: Task[]): Task | undefined {
    const scheduling = this.deps.scheduling;
    const now = this.now().getTime();
    const avgTaskMs = scheduling?.avgTaskMs?.();
    const candidates = queued
      .map((task, index) => ({ task, index, resumed: this.resumeWith.has(task.id) }))
      .filter(({ task, resumed }) => resumed || (scheduling?.admit?.(task) ?? true))
      .map((entry) => ({ ...entry, input: scheduling?.rank?.(entry.task) ?? { priority: "normal" as const, approvedAt: entry.task.createdAt } }));
    candidates.sort((a, b) => Number(b.resumed) - Number(a.resumed) || compareWork(a.input, b.input, now, { tieBreak: "approved", ...(avgTaskMs ? { avgTaskMs } : {}) }) || a.index - b.index);
    return candidates[0]?.task;
  }

  /**
   * O agente está ocupado com uma tarefa que só espera o usuário e há outra na fila para ele: solta a
   * vaga na hora (esperar uma pessoa não pode segurar o trabalho dos outros).
   */
  private parkIfBlocking(agentId: string): void {
    const slot = this.slots.get(agentId);
    if (slot?.kind !== "running" || !slot.resolveApproval) return;
    const state = this.deps.state.read();
    const agent = state.agents.find((candidate) => candidate.id === agentId);
    if (!agent || this.deps.availability?.(agent)) return;
    const queued = state.tasks.filter((task) => task.agentId === agentId && task.status === "queued" && !isSeedId(task.id));
    if (this.pick(queued)) this.park(agentId, slot);
  }

  /**
   * Solta a vaga do agente enquanto a tarefa espera o usuário: aborta a execução (a sessão da CLI fica
   * onde está), a tarefa continua `waiting_approval` e o agente pega a próxima da fila. Quando a decisão
   * chega, a tarefa volta à fila e recomeça com ela (a mesma conversa da CLI, se nada rodou nesse meio
   * tempo; senão uma conversa nova com a tarefa e a decisão).
   */
  private park(agentId: string, slot: RunningSlot): void {
    if (this.stopped || this.slots.get(agentId) !== slot || !slot.resolveApproval) return;
    clearTimeout(slot.parkTimer);
    this.slots.delete(agentId);
    this.parked.set(slot.taskId, agentId);
    this.deps.agentLog.append({ taskId: slot.taskId, agentId }, { kind: "status", status: "waiting", message: "Segue esperando a sua decisão; o agente ficou livre para outras tarefas e esta recomeça quando você decidir" });
    this.deps.log.info({ taskId: slot.taskId, agentId }, "vaga do agente liberada enquanto a tarefa espera o usuário");
    slot.controller.abort(new Error("Vaga liberada enquanto a tarefa espera o usuário"));
    const resolve = slot.resolveApproval;
    slot.resolveApproval = undefined;
    resolve({ approved: false });
    this.pump(agentId);
  }

  /** A tarefa está parada esperando o usuário (a vaga do agente foi solta, o cartão continua valendo)? */
  isParked(taskId: string): boolean {
    return this.parked.has(taskId);
  }

  /** Status do agente sem nenhuma tarefa rodando: esperando aprovação se há tarefa parada dele, senão idle. */
  private restingStatus(agentId: string): AgentStatus {
    for (const owner of this.parked.values()) if (owner === agentId) return "waiting_approval";
    return "idle";
  }

  /** O status que o agente já tem (para gravar uma tarefa sem mexer nele). */
  private currentStatus(agentId: string): AgentStatus {
    return this.deps.state.read().agents.find((agent) => agent.id === agentId)?.status ?? "idle";
  }

  /** Como `restingStatus`, mas só se o agente não está com tarefa rodando (senão mantém o status dele). */
  private restingStatusIfIdle(agentId: string): AgentStatus {
    return this.slots.has(agentId) ? this.currentStatus(agentId) : this.restingStatus(agentId);
  }

  /** O agente não tem o que fazer agora: idle (ou esperando a aprovação de uma tarefa parada). */
  private settle(agentId: string): void {
    const status = this.restingStatus(agentId);
    if (this.currentStatus(agentId) !== status) this.apply(undefined, agentId, undefined, status);
  }

  /** Linha "esperando" no log da tarefa parada pela cota (uma vez por espera). */
  private noteWaiting(task: Task, agent: Agent, block: EngineBlock): void {
    const { id: taskId } = task;
    const agentId = agent.id;
    if (this.waitingLogged.has(taskId)) return;
    this.waitingLogged.add(taskId);
    this.deps.scheduling?.onEngineBlock?.(task, block, agent);
    const why = engineBlockLabel(block, this.now().getTime());
    this.deps.agentLog.append({ taskId, agentId }, { kind: "status", status: "waiting", message: `Na fila: motor ${why}; começa sozinha quando ele voltar` });
    this.deps.log.info({ taskId, agentId, block }, "tarefa esperando o motor voltar");
  }

  /** Ocupa o agente com a tarefa (in_progress/working) e dispara a execução em segundo plano. */
  private start(taskId: string, agentId: string, preApproved?: ApprovalDecision, resumed?: ApprovalDecision): Applied {
    const slot: RunningSlot = { kind: "running", taskId, controller: new AbortController(), progress: 0, preApproved, resumed };
    this.slots.set(agentId, slot);
    this.waitingLogged.delete(taskId);
    const agent = this.deps.state.read().agents.find((candidate) => candidate.id === agentId);
    // Com que motor/modelo a tarefa roda (o do agente agora; a tarefa mostra depois).
    const ranWith: ModelChoice = { engine: agentEngine(agent ?? {}), ...(agent?.model ? { model: agent.model } : {}), ...(agent?.effort ? { effort: agent.effort } : {}) };
    const started = this.apply(taskId, agentId, { status: "in_progress", ranWith }, "working");
    const using = isCliEngine(ranWith.engine) ? ` (${describeModelChoice(ranWith)})` : "";
    const message = resumed
      ? `Recomeçou para refazer com o motivo da recusa${using}`
      : preApproved
      ? `Recomeçou com a decisão do usuário já tomada${using}`
      : `Começou${using}: ‘${shorten(started.task?.prompt ?? "", 160)}’`;
    this.deps.agentLog.append({ taskId, agentId }, { kind: "status", status: "started", message });
    void this.execute(slot, agentId);
    return started;
  }

  private async execute(slot: RunningSlot, agentId: string): Promise<void> {
    const { taskId } = slot;
    const isCurrent = () => !this.stopped && this.slots.get(agentId) === slot;

    let outcome: RunOutcome;
    try {
      const input = await this.runInput(taskId, agentId, slot.controller.signal, slot.preApproved ?? slot.resumed);
      if (!isCurrent()) return;
      outcome = await this.deps.runner.run(input, this.hooks(input, slot, isCurrent));
    } catch (error) {
      if (!isCurrent()) return;
      this.deps.log.error({ err: error, taskId }, "erro ao executar a tarefa");
      outcome = { status: "failed", result: `Erro ao executar a tarefa: ${errorMessage(error)}`, kind: "outro" };
    }
    if (!isCurrent()) return;
    if (outcome.status === "done") await this.saveNote(taskId, outcome.result);
    await this.writeDiary(taskId, agentId, outcome);
    if (!isCurrent()) return;
    this.finish(taskId, agentId, outcome);
  }

  private async runInput(taskId: string, agentId: string, signal: AbortSignal, resumedDecision?: ApprovalDecision): Promise<RunInput> {
    const state = this.deps.state.read();
    const task = state.tasks.find((candidate) => candidate.id === taskId);
    const agent = state.agents.find((candidate) => candidate.id === agentId);
    const team = state.teams.find((candidate) => candidate.id === task?.teamId);
    const room = state.rooms.find((candidate) => candidate.id === task?.roomId);
    if (!task || !agent || !team || !room) throw new Error("tarefa sem agente, time ou sala válida");
    // O texto da tarefa escolhe as notas curtas mais relevantes (o resto fica para search_notes).
    const context = await this.deps.brain.buildContext(room.id, task.prompt);
    const diary = this.deps.diary && isCliEngine(agentEngine(agent)) ? await this.deps.diary.recent(agent.id).catch(() => "") : "";
    return { task, agent, team, room, context, ...(diary ? { diary } : {}), ...(resumedDecision ? { resumedDecision } : {}), signal };
  }

  private hooks(input: RunInput, slot: RunningSlot, isCurrent: () => boolean): RunHooks {
    const agentId = input.agent.id;
    const publishProgress = (message: string) => {
      slot.message = message;
      this.deps.state.publish({ type: "task:progress", taskId: slot.taskId, agentId, progress: slot.progress, message });
    };
    const ref = { taskId: slot.taskId, agentId };
    const provider = this.deps.runner.providerFor ? this.deps.runner.providerFor(input.agent) : this.deps.runner.provider;
    return {
      ...runnerLogHooks(this.deps.agentLog, provider ? { ...ref, provider } : ref, isCurrent),
      onProgress: (progress, message) => {
        if (!isCurrent() || slot.resolveApproval) return;
        if (Number.isFinite(progress)) slot.progress = Math.min(1, Math.max(0, progress));
        publishProgress(message);
        this.deps.agentLog.progress(ref, slot.progress, message);
      },
      requestApproval: (request) => {
        if (!isCurrent() || slot.resolveApproval) return Promise.resolve({ approved: false });
        if (slot.preApproved) {
          const decision = slot.preApproved;
          slot.preApproved = undefined;
          return Promise.resolve(decision);
        }
        return new Promise<ApprovalDecision>((resolve) => {
          slot.resolveApproval = resolve;
          // Questionário (ask_user) espera respostas; o resto, uma aprovação: o texto diz qual.
          const questions = request.questions?.length ?? 0;
          const waiting = questions > 0 ? WAITING_ANSWERS : WAITING_APPROVAL;
          const { task } = this.apply(slot.taskId, agentId, { status: "waiting_approval", waiting }, "waiting_approval");
          // Lote: um item por rascunho (mesmo groupId); a tarefa espera todos e recebe UMA decisão.
          const opened = task ? (request.items && request.items.length > 0 ? this.deps.approvals.openMany(task, request) : [this.deps.approvals.open(task, request)]) : [];
          for (const item of opened) {
            this.deps.agentLog.append(ref, {
              kind: "approval",
              phase: "asked",
              question: opened.length > 1 ? (item.why ?? request.question) : request.question,
              forYouId: item.id,
              ...(questions > 0 ? { questions } : {}),
            });
          }
          if (opened.length === 0) this.deps.agentLog.append(ref, { kind: "approval", phase: "asked", question: request.question });
          // Modo Automático: tudo saiu decidido sozinho -> o agente segue já, como se o usuário tivesse aprovado.
          const auto = task ? this.deps.approvals.autoDecision?.(task, opened) : undefined;
          if (auto) {
            this.approve(slot.taskId, auto).catch((error: unknown) => this.deps.log.error({ err: error, taskId: slot.taskId }, "falha ao seguir com a decisão automática"));
            return;
          }
          this.deps.agentLog.append(ref, { kind: "status", status: "waiting", message: waiting });
          publishProgress(request.question);
          // Esperar o usuário não pode segurar o agente para sempre: passado o tempo (ou se chegar outra tarefa), a vaga é solta.
          const parkMs = this.deps.approvalParkMs ?? DEFAULT_APPROVAL_PARK_MS;
          slot.parkTimer = setTimeout(() => this.park(agentId, slot), parkMs);
          slot.parkTimer.unref();
          queueMicrotask(() => this.parkIfBlocking(agentId));
        });
      },
    };
  }

  private async saveNote(taskId: string, result: string): Promise<void> {
    const state = this.deps.state.read();
    const task = state.tasks.find((candidate) => candidate.id === taskId);
    if (!task) return;
    const agent = state.agents.find((candidate) => candidate.id === task.agentId);
    const team = state.teams.find((candidate) => candidate.id === task.teamId);
    try {
      const note = buildResultNote({ task, agent, team, result, date: this.now() });
      await this.deps.brain.writeHistoryNote(task.roomId, note);
    } catch (error) {
      this.deps.log.error({ err: error, taskId }, "não foi possível salvar o resultado no Cérebro");
    }
  }

  /** Entrada no diário do agente de CLI (o que fez; sem chamar modelo). Falhar aqui não muda a tarefa. */
  private async writeDiary(taskId: string, agentId: string, outcome: RunOutcome): Promise<void> {
    if (!this.deps.diary) return;
    const state = this.deps.state.read();
    const task = state.tasks.find((candidate) => candidate.id === taskId);
    const agent = state.agents.find((candidate) => candidate.id === agentId);
    if (!task || !agent || !isCliEngine(agentEngine(agent))) return;
    try {
      await this.deps.diary.append(agentId, diaryEntry(task, outcome, this.now()));
    } catch (error) {
      this.deps.log.error({ err: error, taskId, agentId }, "não foi possível escrever no diário do agente");
    }
  }

  private finish(taskId: string, agentId: string, outcome: RunOutcome): void {
    this.deps.log.info({ taskId, agentId, status: outcome.status }, "tarefa finalizada");
    const agent = this.deps.state.read().agents.find((candidate) => candidate.id === agentId);
    const block = outcome.status === "failed" && agent ? this.deps.availability?.(agent) : undefined;
    if (block) {
      // Falhou porque a cota acabou no meio: volta para a fila e recomeça quando o motor voltar.
      this.deps.agentLog.close({ taskId, agentId }, "Interrompida: a cota acabou", {
        kind: "status",
        status: "waiting",
        message: `A cota acabou no meio (motor ${engineBlockLabel(block, this.now().getTime())}): a tarefa volta para a fila e recomeça sozinha`,
      });
      this.waitingLogged.add(taskId);
      this.apply(taskId, agentId, { status: "queued" }, "idle");
      this.slots.delete(agentId);
      this.pump(agentId);
      return;
    }
    if (outcome.status === "failed") {
      this.endLog(taskId, agentId, outcome.cancelled ? "canceled" : "failed", outcome.result);
      this.apply(taskId, agentId, { status: "failed", result: outcome.result, failureKind: outcome.cancelled ? "cancelada" : (outcome.kind ?? "outro"), ...(outcome.cancelled ? { outcome: "cancelled" as const } : {}) }, "idle");
      this.slots.delete(agentId);
      this.pump(agentId);
      return;
    }
    this.deps.agentLog.append({ taskId, agentId }, { kind: "result", text: outcome.result });
    this.endLog(taskId, agentId, "done", "Concluída");
    this.apply(taskId, agentId, { status: "done", result: outcome.result }, "done");
    const linger: LingerSlot = {
      kind: "lingering",
      timer: setTimeout(() => {
        if (this.slots.get(agentId) !== linger) return;
        this.slots.delete(agentId);
        this.pump(agentId);
      }, this.deps.doneLingerMs),
    };
    linger.timer.unref();
    this.slots.set(agentId, linger);
  }

  /** Última entrada de status da tarefa no log; fecha ferramentas e subagentes abertos. */
  private endLog(taskId: string, agentId: string, status: "done" | "failed" | "canceled", message: string): void {
    const reason = status === "canceled" ? "Interrompida: tarefa cancelada" : "Interrompida";
    this.deps.agentLog.close({ taskId, agentId }, reason, { kind: "status", status, message });
  }

  /** Muda tarefa e/ou status do agente, persiste e emite os eventos. */
  private apply(
    taskId: string | undefined,
    agentId: string,
    taskChange: TaskChange | undefined,
    agentStatus: AgentStatus,
  ): Applied {
    const state = this.deps.state.read();
    const events: ServerEvent[] = [];
    const task = state.tasks.find((candidate) => candidate.id === taskId);
    if (task && taskChange) {
      Object.assign(task, taskChange, { updatedAt: this.now().toISOString() });
      // `outcome` ("cancelled") só vale com a tarefa falha: se ela anda de novo, some.
      if (task.status !== "failed") {
        delete task.outcome;
        delete task.failureKind;
      }
      // A decisão guardada só vale enquanto a tarefa espera na fila para recomeçar com ela.
      if (task.status !== "queued") delete task.pendingDecision;
      // `waiting` (o que a tarefa espera do usuário) só vale enquanto ela espera.
      if (task.status !== "waiting_approval" || taskChange.waiting === undefined) delete task.waiting;
      if (task.status === "waiting_approval" && taskChange.waiting) task.waiting = taskChange.waiting;
      events.push({ type: "task:upserted", task });
    }
    const agent = state.agents.find((candidate) => candidate.id === agentId);
    const agentChanged = agent !== undefined && agent.status !== agentStatus;
    if (agentChanged) {
      agent.status = agentStatus;
      events.push({ type: "agent:upserted", agent });
    }
    const saved = this.deps.state.commit({
      office: agentChanged ? officeStructure(state) : undefined,
      tasks: task && taskChange ? state.tasks : undefined,
      events,
    });
    saved.catch((error: unknown) => this.deps.log.error({ err: error }, "falha ao gravar o estado"));
    return { task, saved };
  }
}

/** Texto curto de uma decisão para o log da tarefa (a nota ou o motivo; num lote, um resumo). */
function decisionNote(decision: ApprovalDecision): string | undefined {
  if (decision.items && decision.items.length > 0) {
    const count = (status: string) => decision.items!.filter((item) => item.status === status).length;
    const parts = [`${count("approved")} aprovado(s)`, `${count("rejected")} recusado(s)`, `${count("cancelled")} cancelado(s)`].filter((part) => !part.startsWith("0 "));
    const reasons = decision.items.filter((item) => item.reason).map((item) => `${item.itemId}: ${item.reason}`);
    return [parts.join(", "), ...(reasons.length > 0 ? [`motivo(s): ${reasons.join(" | ")}`] : [])].join(" — ");
  }
  return decision.reason ?? decision.response;
}
