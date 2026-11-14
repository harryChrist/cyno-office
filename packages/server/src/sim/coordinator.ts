import { randomUUID } from "node:crypto";
import {
  APPROVAL_REFUSED_RESULT,
  findMaestroAgent,
  findMaestroRoom,
  GLOBAL_BRAIN_ID,
  isActiveTaskStatus,
  isMaestroAgent,
  isMaestroTask,
  MAESTRO_TEXTS,
  subtasksOf,
  type AgentLogBody,
  type AgentStatus,
  type MaestroMessageResponse,
  type OfficeState,
  type Plan,
  type PlanTaskInput,
  type ServerEvent,
  type Task,
  type TaskProgressInfo,
} from "@cyno/shared";
import type { FastifyBaseLogger } from "fastify";
import type { AgentLogService } from "../workspace/agent-log/service";
import type { Brain, NewNote } from "../workspace/brain/brain";
import type { EventHub } from "../platform/events/hub";
import { HttpError } from "../platform/http/errors";
import type { Orchestrator } from "../workspace/office/orchestrator";
import type { ProjectHost, ProjectService, ProjectWakeKind } from "../workspace/projects/project-service";
import { routeTask } from "../workspace/office/routing";
import { officeStructure, type StateManager } from "../store/state-manager";
import { errorMessage, shorten } from "../util/text";
import type { CliMaestro } from "../workspace/maestro/cli-maestro";
import { triage, type TriageResult } from "./triage";

/** Quanto o Maestro "pensa": triagem sorteada entre min e max; revisão fixa. */
export type MaestroTimings = { triageMinMs: number; triageMaxMs: number; reviewMs: number };

export const DEFAULT_MAESTRO_TIMINGS: MaestroTimings = { triageMinMs: 1000, triageMaxMs: 3000, reviewMs: 1000 };

export type MaestroDeps = {
  state: StateManager;
  /** Hub do workspace: o Maestro escuta as mudanças das subtarefas por ele. */
  hub: EventHub;
  brain: Brain;
  /** Log de trabalho: a tarefa do Maestro é a "tela principal" do workspace. */
  agentLog: AgentLogService;
  orchestrator: Pick<Orchestrator, "enqueue"> & Partial<Pick<Orchestrator, "cancelTask">>;
  /** Planos dos pedidos (o Maestro simulado faz um plano fixo quando o pedido tem "[plano]"). */
  plans?: () => ProjectService | undefined;
  /** Decide a aprovação de uma subtarefa (pelo item dela no "Para você"). */
  decideTask: (taskId: string, approved: boolean) => Promise<Task>;
  log: Pick<FastifyBaseLogger, "info" | "error">;
  timings: MaestroTimings;
  /** Quanto tempo o Maestro fica "done" depois de fechar uma tarefa. */
  doneLingerMs: number;
  now?: () => Date;
  /** Aleatoriedade da duração da triagem (número em [0, 1)). */
  random?: () => number;
  /**
   * Maestro com motor de CLI: quando o Maestro do workspace roda numa CLI, os pedidos vão para a
   * sessão dele (CliMaestro) em vez da triagem por palavras.
   */
  cli?: CliMaestro;
  /**
   * Modo simulado ligado (só testes; ausente = ligado). Falso: sem Maestro de CLI o pedido é
   * recusado (409) e as tarefas antigas do Maestro simulado falham com mensagem clara.
   */
  simulated?: boolean;
};

/** O Maestro está sem motor (dados antigos com `engine: "mock"`) e o modo simulado está desligado. */
export const MAESTRO_NO_ENGINE = "O Maestro está sem motor; escolha um (Claude Code ou Antigravity) em Configurações › Modelos padrão ou em Editar agente, e tente de novo.";

/** Progresso publicado em cada etapa da tarefa do Maestro. */
const STEP_PROGRESS = { triage: 0.1, delegated: 0.3, review: 0.9 } as const;

/**
 * O fluxo do Maestro. Todo pedido sem atalho de time vira uma tarefa dele:
 * queued -> in_progress (triagem, 1–3 s) -> cria a subtarefa (`projectId`) para o time escolhido
 * e fica in_progress ("Delegada ao time X") enquanto ela anda. Quando a subtarefa termina:
 * done -> revisão (1 s), nota no Cérebro global e done; failed -> failed com o motivo;
 * waiting_approval -> waiting_approval ("esperando você"). Sem time no workspace, a tarefa fica
 * waiting_approval com a pergunta em `routeReason`; aprovar refaz a triagem.
 *
 * As tarefas do Maestro não passam pelo runner nem pela fila do orquestrador. O estado de cada
 * uma é derivado das tarefas (sobrevive ao restart: veja `resume`), e o status do agente Maestro
 * também: working durante triagem/revisão, waiting_approval se precisa do usuário, done por um
 * instante depois de fechar, senão idle.
 *
 * Tudo isso vai para o log de trabalho do Maestro (a tela principal do workspace): leitura do
 * pedido, pontuação dos times e o porquê da escolha, a delegação, a espera pelo time, a revisão,
 * aprovações e o resultado.
 */
export class MaestroCoordinator implements ProjectHost {
  /** Triagens e revisões em curso, por id da tarefa do Maestro. */
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly progress = new Map<string, TaskProgressInfo>();
  /** Nome de cada time já visto: a mensagem sai certa mesmo se o time sumiu (quarto removido). */
  private readonly teamNames = new Map<string, string>();
  private linger: NodeJS.Timeout | undefined;
  private stopped = false;
  private readonly now: () => Date;
  private readonly random: () => number;
  private readonly unsubscribe: () => void;

  constructor(private readonly deps: MaestroDeps) {
    this.now = deps.now ?? (() => new Date());
    this.random = deps.random ?? Math.random;
    this.unsubscribe = deps.hub.subscribe((event) => {
      if (event.type !== "task:upserted" || event.task.projectId === undefined) return;
      // Depois do commit em curso (os eventos dele saem antes) e com a subtarefa como ela estava
      // no evento: num quarto removido ela já sumiu do estado quando chegamos aqui.
      const subtask = structuredClone(event.task);
      queueMicrotask(() => void this.onSubtask(subtask));
    });
  }

  /** Novo pedido do usuário: tarefa do Maestro (queued) que já entra em triagem. */
  async submit(prompt: string): Promise<Task> {
    const state = this.deps.state.read();
    const maestro = findMaestroAgent(state);
    const room = findMaestroRoom(state);
    if (!maestro || !room) throw new HttpError(409, "Este workspace ainda não tem o Maestro");
    if (this.deps.simulated === false && !this.deps.cli?.enabled(state)) throw new HttpError(409, MAESTRO_NO_ENGINE);
    const at = this.now().toISOString();
    const task: Task = { id: randomUUID(), roomId: room.id, teamId: maestro.teamId, agentId: maestro.id, role: "request", prompt, status: "queued", createdAt: at, updatedAt: at };
    state.tasks.push(task);
    await this.deps.state.commit({ tasks: state.tasks, events: [{ type: "task:upserted", task }] });
    if (this.deps.cli?.enabled(state)) {
      this.deps.cli.submit(task);
      return this.deps.state.read().tasks.find((candidate) => candidate.id === task.id) ?? task;
    }
    if (prompt.includes(MOCK_PLAN_MARKER) && this.deps.plans?.()) {
      this.startMockPlan(task.id);
      return this.deps.state.read().tasks.find((candidate) => candidate.id === task.id) ?? task;
    }
    void this.startTriage(task.id);
    return task;
  }

  /**
   * Mensagem da caixa "Fale com o Maestro". Maestro de CLI: conversa (vai para a sessão dele, sem
   * tarefa; ele abre o pedido quando for o caso). Maestro simulado: não conversa, então cada
   * mensagem ainda vira um pedido (triagem por palavras), como o POST /tasks.
   */
  async message(text: string): Promise<MaestroMessageResponse> {
    if (this.deps.cli?.enabled()) return { mode: "conversa", messageId: this.deps.cli.converse(text) };
    return { mode: "pedido", task: await this.submit(text) };
  }

  /**
   * Decisão do usuário numa tarefa do Maestro "esperando você": com a subtarefa pedindo
   * aprovação, a decisão vale para ela (e para o item dela no "Para você"); sem time (pergunta do Maestro), aprovar refaz a triagem
   * e recusar encerra a tarefa.
   */
  async approve(taskId: string, approved: boolean): Promise<Task> {
    const state = this.deps.state.read();
    const task = state.tasks.find((candidate) => candidate.id === taskId);
    if (!task) throw new HttpError(404, `Tarefa "${taskId}" não encontrada`);
    // Pedido do Maestro de CLI: a decisão vai pelo item dele no "Para você".
    if (this.deps.cli?.owns(state, task)) return this.deps.decideTask(taskId, approved);
    if (task.status !== "waiting_approval") throw new HttpError(409, "A tarefa não está aguardando aprovação");
    const plan = this.deps.plans?.()?.forRequest(taskId);
    if (plan?.status === "proposto") {
      if (approved) await this.deps.plans!()!.approve(plan.id);
      else await this.deps.plans!()!.cancel(plan.id);
      return this.deps.state.read().tasks.find((candidate) => candidate.id === taskId)!;
    }
    const subtask = subtasksOf(state.tasks, task.id).at(-1);
    this.logEntry(task, { kind: "approval", phase: "decided", approved });
    if (subtask) {
      const decided = await this.deps.decideTask(subtask.id, approved);
      await this.onSubtask(decided);
    } else if (approved) {
      await this.startTriage(task.id);
    } else {
      await this.fail(state, task, APPROVAL_REFUSED_RESULT);
    }
    return this.deps.state.read().tasks.find((candidate) => candidate.id === taskId)!;
  }

  /** Boot (depois do orquestrador): retoma cada tarefa ativa do Maestro do ponto em que parou. */
  resume(): void {
    const state = this.deps.state.read();
    for (const team of state.teams) this.teamNames.set(team.id, team.name);
    for (const task of state.tasks) {
      if (!isMaestroTask(state, task) || !isActiveTaskStatus(task.status)) continue;
      if (this.deps.cli?.owns(state, task)) continue;
      if (this.deps.plans?.()?.holds(task.id)) continue;
      if (this.deps.simulated === false) {
        void this.fail(state, task, MAESTRO_NO_ENGINE);
        continue;
      }
      const subtask = subtasksOf(state.tasks, task.id).at(-1);
      if (subtask) void this.onSubtask(subtask);
      else if (task.status === "waiting_approval") this.setProgress(task, 0, task.routeReason ?? MAESTRO_TEXTS.noTeam);
      else void this.startTriage(task.id);
    }
    this.deps.cli?.resume();
    void this.save(this.deps.state.read(), []);
  }

  /** Recalcula e grava o status do agente Maestro (o CliMaestro chama quando muda algo). */
  refreshAgentStatus(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    return this.save(this.deps.state.read(), []);
  }

  /** Último progresso das tarefas ativas do Maestro (entra no office:snapshot). */
  progressSnapshot(): Record<string, TaskProgressInfo> {
    const active = new Set(this.deps.state.read().tasks.filter((task) => isActiveTaskStatus(task.status)).map((task) => task.id));
    const own = Object.fromEntries([...this.progress].filter(([taskId]) => active.has(taskId)));
    return { ...own, ...this.deps.cli?.progressSnapshot() };
  }

  /** Shutdown: para os relógios sem gravar nada (o boot seguinte retoma). */
  stop(): void {
    this.stopped = true;
    this.unsubscribe();
    this.deps.cli?.stop();
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    if (this.linger) clearTimeout(this.linger);
    this.linger = undefined;
  }

  /**
   * O usuário fecha um pedido do Maestro (parado ou não): "concluir" fecha como está, "cancelar"
   * fecha como cancelado. As subtarefas ativas param (o plano aberto é cancelado pelo ProjectService).
   */
  async closeRequest(taskId: string, mode: "concluir" | "cancelar", note?: string): Promise<Task> {
    const state = this.deps.state.read();
    const task = state.tasks.find((candidate) => candidate.id === taskId);
    if (!task || !isMaestroTask(state, task)) throw new HttpError(404, `Pedido "${taskId}" não encontrado`);
    if (this.deps.cli?.owns(state, task)) return this.deps.cli.closeByUser(taskId, mode, note);
    if (!isActiveTaskStatus(task.status)) throw new HttpError(409, "O pedido já está fechado");
    const timer = this.timers.get(taskId);
    if (timer) clearTimeout(timer);
    this.timers.delete(taskId);
    for (const subtask of subtasksOf(state.tasks, task.id)) {
      if (isActiveTaskStatus(subtask.status)) this.deps.orchestrator.cancelTask?.(subtask.id, "Cancelada: o pedido foi fechado pelo usuário");
    }
    const clean = note?.trim();
    const fresh = this.deps.state.read();
    const current = fresh.tasks.find((candidate) => candidate.id === taskId)!;
    if (mode === "cancelar") await this.fail(fresh, current, `Cancelado pelo usuário${clean ? `: ${clean}` : ""}`);
    else await this.complete(fresh, current, clean || current.result || "Fechado pelo usuário");
    return this.deps.state.read().tasks.find((candidate) => candidate.id === taskId)!;
  }

  // ---------- ProjectHost (Maestro simulado) ----------

  awaitUser(requestId: string, why: string): void {
    const state = this.deps.state.read();
    const task = state.tasks.find((candidate) => candidate.id === requestId);
    if (task && isActiveTaskStatus(task.status)) void this.follow(state, task, "waiting_approval", why);
  }

  working(requestId: string, message: string, progress: number): void {
    const state = this.deps.state.read();
    const task = state.tasks.find((candidate) => candidate.id === requestId);
    if (!task || !isActiveTaskStatus(task.status)) return;
    void this.follow(state, task, "in_progress", message, progress);
  }

  /** O Maestro simulado decide sozinho: fim = junta os resultados; falha = o pedido falha; ajuste = refaz o plano. */
  wake(requestId: string, kind: ProjectWakeKind, build: () => string, planOf?: () => Plan | undefined): void {
    const state = this.deps.state.read();
    const task = state.tasks.find((candidate) => candidate.id === requestId);
    if (!task || !isActiveTaskStatus(task.status) || this.stopped) return;
    const message = build();
    const plan = planOf?.();
    this.logEntry(task, { kind: "text", text: shorten(message, 600) });
    if (kind === "adjust") return this.startMockPlan(requestId, plan?.feedback);
    if (kind === "failed") return void this.fail(state, task, `Uma tarefa do plano falhou: ${shorten(message, 400)}`);
    if (kind !== "done" || !plan) return;
    const sections = plan.tasks.map((planTask) => `## ${planTask.ref} · ${planTask.title}\n${planTask.result ?? "(sem resultado)"}`);
    void this.complete(state, task, [`Plano concluído (${plan.tasks.length} tarefas).`, ...sections].join("\n\n"));
  }

  close(requestId: string, reason: string): void {
    const state = this.deps.state.read();
    const task = state.tasks.find((candidate) => candidate.id === requestId);
    if (task && isActiveTaskStatus(task.status)) void this.fail(state, task, reason);
  }

  /** Plano fixo do Maestro simulado (pedido com "[plano]"): vai para a aprovação do usuário. */
  private startMockPlan(taskId: string, feedback?: string): void {
    const state = this.deps.state.read();
    const task = state.tasks.find((candidate) => candidate.id === taskId);
    const plans = this.deps.plans?.();
    if (!task || !plans) return;
    const agents = state.agents.filter((agent) => !isMaestroAgent(state, agent));
    if (agents.length === 0) return this.askUser(state, task, MAESTRO_TEXTS.noAgents);
    if (task.status === "queued") {
      this.logEntry(task, { kind: "status", status: "started", message: `Pedido recebido: ‘${shorten(task.prompt, 160)}’` });
      Object.assign(task, { status: "in_progress", updatedAt: this.now().toISOString() });
      void this.save(state, [task]);
    }
    plans
      .propose(taskId, { tasks: mockPlanTasks(agents, task.prompt, feedback), summary: "Plano do Maestro simulado: pesquisa, rascunho a quatro mãos, revisão e divulgação." })
      .catch((error: unknown) => void this.fail(this.deps.state.read(), this.deps.state.read().tasks.find((candidate) => candidate.id === taskId)!, errorMessage(error)));
  }

  // ---------- Etapas ----------

  private startTriage(taskId: string): Promise<void> {
    if (this.stopped || this.timers.has(taskId)) return Promise.resolve();
    const state = this.deps.state.read();
    const task = state.tasks.find((candidate) => candidate.id === taskId);
    if (!task || !isActiveTaskStatus(task.status)) return Promise.resolve();
    const { triageMinMs, triageMaxMs } = this.deps.timings;
    const status: AgentLogBody =
      task.status === "queued"
        ? { kind: "status", status: "started", message: `Pedido recebido: ‘${shorten(task.prompt, 160)}’` }
        : task.status === "waiting_approval"
          ? { kind: "status", status: "resumed", message: "Refazendo a triagem" }
          : { kind: "status", status: "started", message: "Retomando a triagem depois de um reinício" };
    this.logEntry(task, status);
    this.logEntry(task, { kind: "text", text: "Lendo o pedido…" });
    this.schedule(taskId, triageMinMs + this.random() * Math.max(0, triageMaxMs - triageMinMs), () => this.finishTriage(taskId));
    Object.assign(task, { status: "in_progress", routeReason: undefined, updatedAt: this.now().toISOString() });
    const saved = this.save(state, [task]);
    this.setProgress(task, STEP_PROGRESS.triage, MAESTRO_TEXTS.triage);
    return saved;
  }

  private finishTriage(taskId: string): void {
    this.timers.delete(taskId);
    const state = this.deps.state.read();
    const task = state.tasks.find((candidate) => candidate.id === taskId);
    if (!task || task.status !== "in_progress") {
      void this.save(state, []);
      return;
    }
    const choice = triage(state, task.prompt);
    this.logEntry(task, { kind: "text", text: triageText(choice) });
    if (choice.kind === "none") return this.askUser(state, task, choice.reason);
    let agentId: string;
    try {
      agentId = routeTask(state, { roomId: choice.room.id, teamId: choice.team.id });
    } catch (error) {
      return this.askUser(state, task, errorMessage(error));
    }
    const at = this.now().toISOString();
    const subtask: Task = {
      id: randomUUID(),
      roomId: choice.room.id,
      teamId: choice.team.id,
      agentId,
      projectId: task.id,
      routeReason: choice.reason,
      prompt: task.prompt,
      status: "queued",
      createdAt: at,
      updatedAt: at,
    };
    Object.assign(task, { routeReason: choice.reason, updatedAt: at });
    this.teamNames.set(choice.team.id, choice.team.name);
    this.deps.plans?.()?.adopt(task, subtask);
    state.tasks.push(subtask);
    this.deps.log.info({ taskId, subtaskId: subtask.id, teamId: choice.team.id, reason: choice.reason }, "Maestro delegou a tarefa");
    void this.save(state, [task, subtask]);
    const agent = state.agents.find((candidate) => candidate.id === agentId);
    this.logEntry(task, {
      kind: "delegation",
      teamId: choice.team.id,
      teamName: choice.team.name,
      toAgentId: agentId,
      ...(agent ? { toAgentName: agent.name } : {}),
      reason: choice.reason,
      subtaskId: subtask.id,
    });
    this.logEntry(task, { kind: "status", status: "waiting", message: `Esperando o time ${choice.team.name} trabalhar` });
    this.setProgress(task, STEP_PROGRESS.delegated, MAESTRO_TEXTS.delegated(choice.team.name));
    this.deps.orchestrator.enqueue(agentId);
  }

  /** O Maestro não tem para quem mandar: a tarefa fica "esperando você" com a pergunta. */
  private askUser(state: OfficeState, task: Task, question: string): void {
    Object.assign(task, { status: "waiting_approval", routeReason: question, updatedAt: this.now().toISOString() });
    void this.save(state, [task]);
    this.logEntry(task, { kind: "approval", phase: "asked", question });
    this.logEntry(task, { kind: "status", status: "waiting", message: "Esperando você" });
    this.setProgress(task, 0, question);
  }

  /** A subtarefa mudou: a tarefa do Maestro acompanha. Idempotente. */
  private async onSubtask(subtask: Task): Promise<void> {
    if (this.stopped || subtask.projectId === undefined || this.deps.plans?.()?.isPlanStep(subtask)) return;
    const state = this.deps.state.read();
    const task = state.tasks.find((candidate) => candidate.id === subtask.projectId);
    if (!task || !isActiveTaskStatus(task.status)) return;
    // Pedido do Maestro de CLI: quem acompanha é o CliMaestro.
    if (this.deps.cli?.owns(state, task)) return;
    // Só a subtarefa mais recente conta (uma nova triagem pode ter criado outra).
    const latest = subtasksOf(state.tasks, task.id).at(-1);
    if (latest && latest.id !== subtask.id) return;
    const team = this.teamName(state, subtask.teamId);

    switch (subtask.status) {
      case "queued":
      case "in_progress":
        return this.follow(state, task, "in_progress", MAESTRO_TEXTS.delegated(team));
      case "waiting_approval":
        return this.follow(state, task, "waiting_approval", MAESTRO_TEXTS.waitingTeam(team));
      case "done":
        return this.startReview(state, task, subtask, team);
      case "failed":
        return this.fail(state, task, `O time ${team} não concluiu: ${subtask.result ?? "sem motivo informado"}`);
    }
  }

  /** A tarefa do Maestro acompanha o status da subtarefa (em andamento ou esperando você). */
  private async follow(state: OfficeState, task: Task, status: "in_progress" | "waiting_approval", message: string, progress: number = STEP_PROGRESS.delegated): Promise<void> {
    const changed = task.status === status ? [] : [Object.assign(task, { status, updatedAt: this.now().toISOString() })];
    const saved = this.save(state, changed);
    if (changed.length > 0) {
      this.logEntry(task, { kind: "status", status: status === "waiting_approval" ? "waiting" : "resumed", message });
    }
    this.setProgress(task, progress, message);
    await saved;
  }

  private teamName(state: OfficeState, teamId: string): string {
    for (const team of state.teams) this.teamNames.set(team.id, team.name);
    return this.teamNames.get(teamId) ?? teamId;
  }

  private async startReview(state: OfficeState, task: Task, subtask: Task, team: string): Promise<void> {
    if (this.timers.has(task.id)) return;
    this.schedule(task.id, this.deps.timings.reviewMs, () => void this.finishReview(task.id, subtask, team));
    const changed = task.status === "in_progress" ? [] : [Object.assign(task, { status: "in_progress" as const, updatedAt: this.now().toISOString() })];
    const saved = this.save(state, changed);
    this.logEntry(task, { kind: "text", text: `${MAESTRO_TEXTS.review(team)}…` });
    this.setProgress(task, STEP_PROGRESS.review, MAESTRO_TEXTS.review(team));
    await saved;
  }

  private async finishReview(taskId: string, subtask: Task, team: string): Promise<void> {
    let task = this.deps.state.read().tasks.find((candidate) => candidate.id === taskId);
    if (task) await this.writeNote(task, subtask, team);
    this.timers.delete(taskId);
    if (this.stopped) return;
    const state = this.deps.state.read();
    task = state.tasks.find((candidate) => candidate.id === taskId);
    if (!task || !isActiveTaskStatus(task.status)) {
      await this.save(state, []);
      return;
    }
    const agent = state.agents.find((candidate) => candidate.id === subtask.agentId);
    const by = agent ? `${agent.name}, time ${team}` : `time ${team}`;
    Object.assign(task, { status: "done", result: `Entregue por ${by}.\n\n${subtask.result ?? ""}`.trim(), updatedAt: this.now().toISOString() });
    this.progress.delete(taskId);
    this.startLinger();
    this.logEntry(task, { kind: "result", text: task.result ?? "" });
    this.endLog(task, { kind: "status", status: "done", message: "Concluída" });
    this.deps.log.info({ taskId, subtaskId: subtask.id }, "Maestro concluiu a tarefa");
    await this.save(state, [task]);
  }

  /** Fecha o pedido como concluído (resultado, log e o "done" do Maestro por um instante). */
  private async complete(state: OfficeState, task: Task, result: string): Promise<void> {
    Object.assign(task, { status: "done", result, updatedAt: this.now().toISOString() });
    this.progress.delete(task.id);
    this.startLinger();
    this.logEntry(task, { kind: "result", text: result });
    this.endLog(task, { kind: "status", status: "done", message: "Concluída" });
    await this.save(state, [task]);
  }

  private async fail(state: OfficeState, task: Task, result: string): Promise<void> {
    Object.assign(task, { status: "failed", result, updatedAt: this.now().toISOString() });
    this.progress.delete(task.id);
    this.endLog(task, { kind: "status", status: "failed", message: result });
    this.deps.log.info({ taskId: task.id }, "tarefa do Maestro falhou");
    await this.save(state, [task]);
  }

  /** Nota do resultado no histórico do lobby, com link para a nota que o time gravou no histórico do quarto. */
  private async writeNote(task: Task, subtask: Task, team: string): Promise<void> {
    try {
      const notes = await this.deps.brain.readHistory(subtask.roomId);
      const teamNote = notes.find((note) => note.content.includes(`task: ${JSON.stringify(subtask.id)}`));
      const state = this.deps.state.read();
      const agent = state.agents.find((candidate) => candidate.id === subtask.agentId);
      const room = state.rooms.find((candidate) => candidate.id === subtask.roomId);
      const note: NewNote = {
        title: shorten(task.prompt, 80),
        body: [
          `- **Pedido:** ${task.prompt}`,
          `- **Time:** ${team}${room ? ` (quarto ${room.name})` : ""}`,
          `- **Agente:** ${agent ? `${agent.name} (${agent.role})` : (subtask.agentId ?? "—")}`,
          `- **Motivo da escolha:** ${task.routeReason ?? "—"}`,
          `- **Nota do time:** ${teamNote ? `[[${subtask.roomId}/${teamNote.file.replace(/^historico\//, "").replace(/\.md$/i, "")}]]` : "—"}`,
          "",
          subtask.result ?? "",
        ].join("\n"),
        frontmatter: {
          task: task.id,
          agent: task.agentId ?? "",
          team: subtask.teamId,
          subtask: subtask.id,
          data: this.now().toISOString(),
          tags: ["agent-office", "tarefa", "maestro"],
        },
      };
      await this.deps.brain.writeHistoryNote(GLOBAL_BRAIN_ID, note);
    } catch (error) {
      this.deps.log.error({ err: error, taskId: task.id }, "não foi possível salvar o resultado do Maestro no Cérebro");
    }
  }

  // ---------- Infra ----------

  private logEntry(task: Task, body: AgentLogBody): void {
    this.deps.agentLog.append({ taskId: task.id, agentId: task.agentId ?? "" }, body);
  }

  private endLog(task: Task, final: AgentLogBody): void {
    this.deps.agentLog.close({ taskId: task.id, agentId: task.agentId ?? "" }, "Interrompida", final);
  }

  private schedule(taskId: string, ms: number, run: () => void): void {
    const timer = setTimeout(() => {
      if (!this.stopped) run();
    }, ms);
    timer.unref();
    this.timers.set(taskId, timer);
  }

  private startLinger(): void {
    if (this.linger) clearTimeout(this.linger);
    this.linger = setTimeout(() => {
      this.linger = undefined;
      if (!this.stopped) void this.save(this.deps.state.read(), []);
    }, this.deps.doneLingerMs);
    this.linger.unref();
  }

  private setProgress(task: Task, progress: number, message: string): void {
    const agentId = task.agentId ?? "";
    const current = this.progress.get(task.id);
    if (current && current.message === message && current.progress === progress) return;
    this.progress.set(task.id, { agentId, progress, message });
    this.deps.state.publish({ type: "task:progress", taskId: task.id, agentId, progress, message });
  }

  /** Status do agente Maestro derivado do que ele está fazendo agora. */
  private maestroStatus(state: OfficeState): AgentStatus {
    if (this.timers.size > 0) return "working";
    const cli = this.deps.cli?.agentStatus(state);
    if (cli) return cli;
    const needsUser = state.tasks.some(
      (task) => task.status === "waiting_approval" && isMaestroTask(state, task) && subtasksOf(state.tasks, task.id).length === 0,
    );
    if (needsUser) return "waiting_approval";
    return this.linger ? "done" : "idle";
  }

  /**
   * Grava as tarefas alteradas e o status do Maestro (se mudou) num commit só, com os eventos.
   * A promessa nunca rejeita (a falha de gravação vai para o log, como no orquestrador).
   */
  private save(state: OfficeState, changed: Task[]): Promise<void> {
    const events: ServerEvent[] = changed.map((task) => ({ type: "task:upserted", task }));
    const maestro = findMaestroAgent(state);
    const status = this.maestroStatus(state);
    const agentChanged = maestro !== undefined && maestro.status !== status;
    if (agentChanged) {
      maestro.status = status;
      events.push({ type: "agent:upserted", agent: maestro });
    }
    if (events.length === 0) return Promise.resolve();
    return this.deps.state
      .commit({ office: agentChanged ? officeStructure(state) : undefined, tasks: changed.length > 0 ? state.tasks : undefined, events })
      .catch((error: unknown) => this.deps.log.error({ err: error }, "falha ao gravar o estado do Maestro"));
  }
}

/** Texto da triagem no log: pontuação de cada time e o porquê da escolha (markdown). */
export function triageText(choice: TriageResult): string {
  const lines = choice.scores
    .slice()
    .sort((a, b) => b.score - a.score)
    .map((score) => {
      const words = score.words.length > 0 ? ` (${score.words.slice(0, 3).map((word) => `'${word}'`).join(", ")})` : "";
      return `- **${score.team.name}** (quarto ${score.room.name}): ${score.score} ${score.score === 1 ? "ponto" : "pontos"}${words}`;
    });
  const header = lines.length > 0 ? ["Pontuação dos times:", ...lines, ""] : [];
  const decision = choice.kind === "team" ? `Escolha: ${choice.reason}.` : `Sem time para mandar: ${choice.reason}.`;
  return [...header, decision].join("\n");
}

/** Marcador do pedido que faz o Maestro simulado montar um plano (em vez de delegar para um time). */
export const MOCK_PLAN_MARKER = "[plano]";

/**
 * Plano fixo do Maestro simulado (determinístico, para testes e demonstrações): pesquisa (A),
 * rascunho a quatro mãos (A → B, depende da pesquisa, prioridade alta), revisão (C, depende do
 * rascunho) e divulgação (A, depende da pesquisa, prioridade baixa). Os outros marcadores do pedido
 * ("[aprovar]", "[falhar]") vão na etapa de escrita.
 */
export function mockPlanTasks(agents: readonly { id: string }[], prompt: string, feedback?: string): PlanTaskInput[] {
  const [a, b = a, c = b] = agents;
  if (!a || !b || !c) return [];
  const markers = (prompt.match(/\[[^\]]*\]/g) ?? []).filter((marker) => marker !== MOCK_PLAN_MARKER).join(" ");
  const topic = shorten(prompt.replace(/\[[^\]]*\]/g, " "), 120) || "o pedido";
  const adjust = feedback ? `\n\nAjuste pedido pelo usuário: ${feedback}` : "";
  return [
    { ref: "T1", title: "Levantar referências", briefing: `Levantar referências e dados para: ${topic}${adjust}`, owner: a.id, steps: [{ agent: a.id, does: "Pesquisar e listar as referências principais" }] },
    {
      ref: "T2",
      title: "Escrever o rascunho",
      briefing: `Rascunho para: ${topic}`,
      owner: b.id,
      steps: [
        { agent: a.id, does: "Separar os pontos principais da pesquisa" },
        { agent: b.id, does: `Escrever o rascunho${markers ? ` ${markers}` : ""}` },
      ],
      depends_on: ["T1"],
      priority: "high",
    },
    { ref: "T3", title: "Revisar", briefing: `Revisar o rascunho de: ${topic}`, owner: c.id, steps: [{ agent: c.id, does: "Revisar e ajustar o texto" }], depends_on: ["T2"] },
    { ref: "T4", title: "Ideias de divulgação", briefing: `Como divulgar: ${topic}`, owner: a.id, steps: [{ agent: a.id, does: "Sugerir três formas de divulgar" }], depends_on: ["T1"], priority: "low" },
  ];
}
