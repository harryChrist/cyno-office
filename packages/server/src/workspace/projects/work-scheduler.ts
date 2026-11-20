import { randomUUID } from "node:crypto";
import {
  agentAddress,
  clearBlocked,
  setBlocked,
  agentEngine,
  clockLabel,
  compareWork,
  dailyLimitMs,
  isActiveTaskStatus,
  isMaestroAgent,
  leafTasks,
  leavesOf,
  nextSprintBoundary,
  nextWorkDayStart,
  receivedBy,
  receiversOf,
  sprintHold,
  taskRankInput,
  windowState,
  workClock,
  type Agent,
  type Blocked,
  type DispatchSettings,
  type OfficeState,
  type Project,
  type ProjectTask,
  type Task,
  isSeedProject,
  isSeedTask,
} from "@cyno/shared";
import { shorten } from "../../util/text";
import { hasLifecycle, requestTitle, shorten2, TEXT, withoutMockMarkers, type ProjectContext } from "./project-types";

/** O que o agendador pede ao ciclo de vida do plano (que fica no ProjectService). */
export type ProjectSchedulerHooks = {
  /** Uma subtarefa de etapa mudou: a tarefa do plano acompanha. */
  onStepTask(sub: Task): void;
  /** O plano é cancelado (as tarefas param). */
  cancelPlan(plan: Project, reason: string): void;
  /** A tarefa do plano falhou (acorda o Maestro). */
  failTask(plan: Project, task: ProjectTask, reason: string): void;
  /** Abre e fecha as sprints cuja data chegou (antes de decidir quem começa). */
  advanceSprints(): void;
};

/** "Done when: 1. … 2. …" (o critério de pronto da tarefa; o agente confere e manda `checklist`). */
export function doneWhenBlock(task: Pick<ProjectTask, "doneWhen">): string {
  if (task.doneWhen.length === 0) return "";
  return `Done when:\n${task.doneWhen.map((item, index) => `${index + 1}. ${item.text}`).join("\n")}`;
}

/** Prazo da tarefa (ou do projeto), em uma linha. */
export function dueLine(task: Pick<ProjectTask, "dueAt">, plan: Pick<Project, "dueAt">): string {
  const due = task.dueAt ?? plan.dueAt;
  return due ? `Prazo: ${due}` : "";
}

/**
 * "Depois de você…" de uma tarefa sem próxima etapa: quem recebe a entrega (as subtarefas que dependem dela) ou,
 * sem ninguém depois, o que o resultado é (a entrega da tarefa-mãe ou da própria tarefa).
 */
export function receiverLine(plan: Pick<Project, "tasks">, task: ProjectTask, agentName: (id: string) => string): string {
  const receivers = receiversOf(plan, task.ref);
  if (receivers.length > 0) {
    const who = receivers.map((leaf) => `${leaf.ownerId ? agentName(leaf.ownerId) : "?"} (${leaf.ref} «${shorten(leaf.title, 60)}»)`).join(", ");
    return `Depois de você: ${who} ${receivers.length > 1 ? "recebem" : "recebe"} o seu resultado na íntegra. Entregue algo que dê para usar direto, sem depender de você.`;
  }
  const mother = task.parent ? plan.tasks.find((candidate) => candidate.ref === task.parent && !candidate.group) : undefined;
  return mother ? `Você é a última subtarefa: o seu resultado é a entrega da tarefa «${mother.title}».` : "Você é a última etapa: o seu resultado é o entregável da tarefa.";
}

/** " · subtarefa de «Criar a postagem»" (vazio fora de uma tarefa-mãe). */
export function motherNote(plan: Pick<Project, "tasks">, task: Pick<ProjectTask, "parent">): string {
  const mother = task.parent ? plan.tasks.find((candidate) => candidate.ref === task.parent && !candidate.group) : undefined;
  return mother ? ` · subtarefa de «${mother.title}»` : "";
}

/** "Fluxo da tarefa «mãe»: T1a Sônia (pesquisa) → …": o time inteiro, para o agente saber onde está. Vazio fora de uma tarefa-mãe. */
export function flowLine(plan: Pick<Project, "tasks">, task: ProjectTask, agentName: (id: string) => string): string {
  const mother = task.parent ? plan.tasks.find((candidate) => candidate.ref === task.parent && !candidate.group) : undefined;
  if (!mother) return "";
  const siblings = leavesOf(plan, mother.ref);
  if (siblings.length < 2) return "";
  const line = siblings.map((leaf) => `${leaf.ref} ${leaf.ownerId ? agentName(leaf.ownerId) : "?"} «${shorten(leaf.title, 40)}»${leaf.ref === task.ref ? " (você)" : ""}${leaf.dependsOn.length > 0 ? ` [depois de ${leaf.dependsOn.join(", ")}]` : ""}`).join(" → ");
  return `Fluxo da tarefa «${mother.title}»: ${line}`;
}

/** Candidata a começar: a tarefa, o plano dela e a posição no plano (desempate). */
type Candidate = { plan: Project; task: ProjectTask; index: number };

/** Quantas tarefas rodam agora no workspace e por agente (conta para as vagas). */
type Load = { running: number; perAgent: Map<string, number> };

/** Por que uma etapa espera: o texto, o bloqueio com tipo (quando há) e quando o motivo some sozinho. */
export type Hold = { note: string; blocked?: { type: Blocked["type"]; by?: string }; wakeAt?: number };

const HOUR_MS = 3_600_000;

/** "1 h", "30 min", "20 s", "1,5 h" (como as notas falam o limite de horas). */
export function hoursText(hours: number): string {
  if (hours * 3600 < 60) return `${Math.max(1, Math.round(hours * 3600))} s`;
  if (hours < 1) return `${Math.round(hours * 60)} min`;
  return `${String(Math.round(hours * 100) / 100).replace(".", ",")} h`;
}

/** "12/11 às 14h30" no fuso do trabalho. */
export function startText(ms: number): string {
  const { day, minutes } = workClock(ms);
  return `${day.slice(8, 10)}/${day.slice(5, 7)} às ${clockLabel(minutes)}`;
}

/**
 * Elegibilidade do ritmo, antes de ordenar: "começa em" (da tarefa ou do projeto), janela de horário
 * (fuso America/Sao_Paulo), limite de horas do dia e etapas em paralelo. Devolve a recusa (uma nota
 * legível, não um erro) ou undefined = pode começar. O limite é "mole": só impede começar etapa NOVA.
 * `workedMs`: horas de hoje já trabalhadas; `runningOthers`: etapas do projeto rodando (sem esta).
 */
export function paceHold(project: Pick<Project, "startAt" | "pace">, task: Pick<ProjectTask, "startAt">, at: number, workedMs: number, runningOthers: number): Hold | undefined {
  const start = task.startAt ?? project.startAt;
  const startMs = start ? Date.parse(start) : NaN;
  if (!Number.isNaN(startMs) && at < startMs) return { note: `Começa em ${startText(startMs)}`, wakeAt: startMs };
  const window = windowState(project.pace?.window, at);
  if (!window.open) return { note: `Fora do horário (volta às ${clockLabel(window.opensAtMinutes)})`, wakeAt: window.opensAt };
  const limit = dailyLimitMs(project.pace);
  if (limit !== undefined && workedMs >= limit) return { note: `Limite de ${hoursText(project.pace!.hoursPerDay!)} de hoje atingido (volta amanhã)`, wakeAt: nextWorkDayStart(at) };
  const max = project.pace?.maxParallel;
  if (max !== undefined && runningOthers >= max) return { note: `Esperando outra etapa do projeto terminar (no máximo ${max} por vez)` };
  return undefined;
}

/**
 * Agendador dos projetos: decide quais etapas começam (elegibilidade do ritmo, dependências, vagas,
 * agente livre, motor disponível), na ordem do `workRank`; cria as subtarefas, concilia no boot e
 * avisa o Maestro das paradas. Também admite as tarefas avulsas (`admitTask`, chamado pelo
 * orquestrador antes de uma tarefa começar) e acorda sozinho na hora em que um motivo some
 * (`startAt`, abertura da janela, virada do dia).
 */
export class WorkScheduler {
  /** Quando cada espera por ritmo pode acabar (chave "L:" = tarefa de plano, "T:" = tarefa avulsa). */
  private readonly wakes = new Map<string, number>();
  private wakeTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly ctx: ProjectContext,
    private readonly hooks: ProjectSchedulerHooks,
  ) {}

  /** Boot: concilia as etapas com as subtarefas (algumas podem ter terminado com o server fora) e distribui. */
  resume(): void {
    const state = this.ctx.deps.state.read();
    const changed: Project[] = [];
    for (const plan of this.ctx.plans) {
      // A semente do app de teste não é conciliada nem executada (veja `isSeedProject`).
      if ((plan.status !== "ativo" && plan.status !== "pausado") || !hasLifecycle(plan) || isSeedProject(plan)) continue;
      const request = state.tasks.find((task) => task.id === plan.id);
      // Projeto criado à mão (origem "usuario") não tem pedido do Maestro: não é cancelado por isso.
      if (plan.origin !== "usuario" && (!request || !isActiveTaskStatus(request.status))) {
        this.hooks.cancelPlan(plan, "O pedido foi fechado");
        continue;
      }
      for (const planTask of plan.tasks) {
        const step = planTask.steps[planTask.current];
        if (!step || step.status !== "em_andamento" || !step.taskId || isSeedTask(planTask)) continue;
        const sub = state.tasks.find((task) => task.id === step.taskId);
        if (!sub) {
          Object.assign(step, { status: "pendente" });
          delete step.taskId;
          planTask.status = planTask.current > 0 ? "em_andamento" : "a_fazer";
          if (planTask.status === "a_fazer") planTask.queuedAt = this.ctx.at();
          changed.push(plan);
        } else if (!isActiveTaskStatus(sub.status) || sub.status === "waiting_approval") this.hooks.onStepTask(sub);
      }
    }
    if (changed.length > 0) this.ctx.save([...new Set(changed)]);
    this.pump();
  }

  /** Começa as etapas que podem começar agora (ritmo, dependências, vagas, agente livre, motor disponível). */
  pump(): void {
    if (this.ctx.isStopped()) return;
    this.hooks.advanceSprints();
    const settings = this.ctx.deps.settings();
    const state = this.ctx.deps.state.read();
    const now = this.ctx.nowMs();
    // Os projetos da semente do app de teste não são executados (veja `isSeedProject`).
    const live = this.ctx.plans.filter((plan) => plan.status === "ativo" && hasLifecycle(plan) && !isSeedProject(plan));
    const load = this.currentLoad(live);
    const changed = new Set<Project>();
    const started: Project[] = [];
    for (const key of [...this.wakes.keys()]) if (key.startsWith("L:") || key.startsWith("S:")) this.wakes.delete(key);
    // O agendador acorda na hora em que uma sprint abre ou fecha.
    for (const plan of live) {
      const boundary = nextSprintBoundary(plan);
      if (boundary !== undefined) this.wakes.set(`S:${plan.id}`, boundary);
    }
    for (const { plan, task } of this.preferOpenHours(this.sortedCandidates(live, now))) {
      const agent = state.agents.find((candidate) => candidate.id === task.steps[task.current]!.agentId);
      const holdsSlot = task.status === "em_andamento";
      if (!agent || isMaestroAgent(state, agent)) {
        this.hooks.failTask(plan, task, `O agente da etapa ${task.current + 1} não existe mais`);
        changed.add(plan);
        continue;
      }
      const sprint = sprintHold(plan, task);
      if (sprint) {
        if (this.markWaiting(task, sprint)) changed.add(plan);
        continue;
      }
      const running = leafTasks(plan.tasks).filter((candidate) => candidate.status === "em_andamento").length - (holdsSlot ? 1 : 0);
      const pace = paceHold(plan, task, now, this.ctx.workedToday(plan), running);
      if (pace) {
        if (this.markWaiting(task, pace)) changed.add(plan);
        if (pace.wakeAt !== undefined) this.wakes.set(`L:${plan.id}/${task.ref}`, pace.wakeAt);
        continue;
      }
      const wait = this.waitNote(agent, holdsSlot, load, settings);
      if (wait) {
        if (this.markWaiting(task, wait)) changed.add(plan);
        continue;
      }
      if (!holdsSlot) load.running += 1;
      load.perAgent.set(agent.id, (load.perAgent.get(agent.id) ?? 0) + 1);
      this.startStep(state, plan, task, agent);
      changed.add(plan);
      started.push(plan);
    }
    if (changed.size > 0) this.ctx.save([...changed]);
    for (const plan of new Set(started)) this.ctx.progress(plan);
    this.armWake();
  }

  /**
   * Admissão de uma Task que já está na fila do agente (o orquestrador pergunta antes de começá-la).
   * Projeto pausado não começa nada novo; tarefa de projeto avulso (sem ciclo de plano) passa pelo
   * mesmo ritmo das etapas (começa em, janela, limite de horas, em paralelo). As etapas de plano já
   * foram admitidas em `pump`. A tarefa simples, sem ritmo, começa na hora.
   */
  admitTask(plan: Project, planTask: ProjectTask): boolean {
    const key = `T:${plan.id}/${planTask.ref}`;
    if (plan.status === "pausado") {
      this.wakes.delete(key);
      return false;
    }
    if (hasLifecycle(plan)) return true;
    const now = this.ctx.nowMs();
    const state = this.ctx.deps.state.read();
    const running = state.tasks.filter((task) => task.work?.projectId === plan.id && task.status === "in_progress").length;
    const hold = paceHold(plan, planTask, now, this.ctx.workedToday(plan), running);
    if (hold) {
      if (this.markWaiting(planTask, hold)) {
        plan.updatedAt = this.ctx.at();
        this.ctx.save([plan]);
      }
      if (hold.wakeAt !== undefined) this.wakes.set(key, hold.wakeAt);
      else this.wakes.delete(key);
      this.armWake();
      return false;
    }
    this.wakes.delete(key);
    if (planTask.note !== undefined || planTask.blocked !== undefined) {
      delete planTask.note;
      clearBlocked(planTask, this.ctx.at());
      delete planTask.waitingSince;
      plan.updatedAt = this.ctx.at();
      this.ctx.save([plan]);
    }
    return true;
  }

  /** Quando a espera por ritmo mais próxima acaba (`startAt`, abertura da janela, virada do dia); undefined = nenhuma. */
  nextWakeAt(): number | undefined {
    let next: number | undefined;
    for (const at of this.wakes.values()) if (next === undefined || at < next) next = at;
    return next;
  }

  /** Programa UM timeout para a próxima espera por ritmo (além do tick de 1 minuto). */
  private armWake(): void {
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    this.wakeTimer = undefined;
    const next = this.nextWakeAt();
    if (next === undefined || this.ctx.isStopped()) return;
    const delay = Math.min(24 * HOUR_MS, Math.max(1000, next - this.ctx.nowMs() + 250));
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = undefined;
      this.pump();
      this.ctx.deps.orchestrator.retryWaiting();
    }, delay);
    this.wakeTimer.unref();
  }

  /** Shutdown: cancela o timeout de acordar. */
  stop(): void {
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    this.wakeTimer = undefined;
  }

  /** Tarefas rodando no workspace e etapas em andamento por agente (as que esperam o usuário ocupam o agente, não a vaga). */
  private currentLoad(live: Project[]): Load {
    let running = 0;
    const perAgent = new Map<string, number>();
    for (const plan of live) {
      for (const task of leafTasks(plan.tasks)) {
        if (task.status === "em_andamento") running += 1;
        const step = task.steps[task.current];
        if (step?.status === "em_andamento" && (task.status === "em_andamento" || task.status === "esperando_voce")) perAgent.set(step.agentId, (perAgent.get(step.agentId) ?? 0) + 1);
      }
    }
    return { running, perAgent };
  }

  /** Tarefas com a etapa atual pendente, na ordem do `workRank` (quem já tem vaga primeiro; depois urgência, prioridade, prazo, plano mais antigo, posição). */
  private sortedCandidates(live: Project[], now: number): Candidate[] {
    const avgTaskMs = this.ctx.avgTaskMs();
    // Só as FOLHAS executam: entregável e tarefa-mãe têm o estado calculado das filhas e nunca viram etapa.
    return live
      .flatMap((plan) => {
        const leaves = new Set(leafTasks(plan.tasks));
        return plan.tasks.map((task, index) => ({ plan, task, index })).filter(({ task }) => leaves.has(task));
      })
      // Tarefa sem responsável (criada à mão, ainda sem agente na etapa) não executa até ganhar um.
      .filter(({ task }) => (task.status === "a_fazer" || task.status === "em_andamento") && task.steps[task.current]?.status === "pendente" && Boolean(task.steps[task.current]?.agentId))
      // Pedido simples fabricado pela semente do app de teste (dentro do Avulsas): fica como está, não vira trabalho de verdade.
      .filter(({ task }) => !isSeedTask(task))
      .sort(
        (a, b) =>
          Number(b.task.status === "em_andamento") - Number(a.task.status === "em_andamento") ||
          compareWork(taskRankInput(a.plan, a.task, a.index), taskRankInput(b.plan, b.task, b.index), now, { tieBreak: "approved", ...(avgTaskMs ? { avgTaskMs } : {}) }),
      );
  }

  /**
   * Freebuff cobra por HORA ABERTA: quem já tem a hora aberta usa uma que já foi paga, e outro agente em Freebuff
   * abriria outra (ou esperaria o teto). Entre as tarefas de agentes em Freebuff, as de quem tem a hora aberta
   * vão primeiro; as posições dos outros motores não mudam (a ordem de importância segue o `workRank`).
   */
  private preferOpenHours(sorted: Candidate[]): Candidate[] {
    const holds = this.ctx.deps.holdsHour;
    if (!holds) return sorted;
    const state = this.ctx.deps.state.read();
    const agentOf = (candidate: Candidate) => state.agents.find((agent) => agent.id === candidate.task.steps[candidate.task.current]?.agentId);
    const slots: number[] = [];
    const hourly: Candidate[] = [];
    sorted.forEach((candidate, index) => {
      const agent = agentOf(candidate);
      if (agent && agentEngine(agent) === "freebuff") {
        slots.push(index);
        hourly.push(candidate);
      }
    });
    if (hourly.length < 2) return sorted;
    const ordered = [...hourly.filter((candidate) => holds(agentOf(candidate)!)), ...hourly.filter((candidate) => !holds(agentOf(candidate)!))];
    const out = [...sorted];
    slots.forEach((slot, position) => {
      out[slot] = ordered[position]!;
    });
    return out;
  }

  /** Por que a etapa não pode começar agora (motor, agente ocupado, sem vaga); undefined = pode. */
  private waitNote(agent: Agent, holdsSlot: boolean, load: Load, settings: DispatchSettings): Hold | undefined {
    const by = agentAddress(this.ctx.deps.workspaceId, agent.id);
    const block = this.ctx.deps.availability?.(agent);
    if (block) {
      const quota = block.reason === "quota" || block.reason === "paused";
      return { note: `${agent.name} indisponível (${block.reason === "paused" ? "pausado no limite do plano" : quota ? "sem cota" : "motor fora do ar"}): espera voltar`, blocked: { type: quota ? "cota" : "acesso", by } };
    }
    if ((load.perAgent.get(agent.id) ?? 0) >= settings.perAgent) return { note: `Esperando ${agent.name} ficar livre`, blocked: { type: "agente", by } };
    if (!holdsSlot && load.running >= settings.maxRunning) return { note: `Esperando vaga (${settings.maxRunning} tarefa(s) por vez)` };
    return undefined;
  }

  /** Registra a espera na tarefa (nota e bloqueio com tipo); true se o motivo mudou (então o projeto precisa ser gravado). */
  private markWaiting(task: ProjectTask, hold: Hold): boolean {
    const blockedSame = hold.blocked ? task.blocked?.type === hold.blocked.type && task.blocked.note === hold.note : task.blocked === undefined;
    if (task.note === hold.note && blockedSame) return false;
    if (task.note !== hold.note) {
      // A espera mudou de motivo: o aviso de parada conta a partir daqui.
      Object.assign(task, { note: hold.note, waitingSince: this.ctx.at(), stallWarned: false });
    }
    const at = this.ctx.at();
    if (hold.blocked) setBlocked(task, { type: hold.blocked.type, ...(hold.blocked.by ? { by: hold.blocked.by } : {}), note: hold.note, since: task.blocked?.type === hold.blocked.type ? task.blocked.since : at }, at);
    else clearBlocked(task, at);
    return true;
  }

  /** Cria a subtarefa da etapa atual (na fila do agente) com o contexto das anteriores. */
  private startStep(state: OfficeState, plan: Project, task: ProjectTask, agent: Agent): void {
    const team = state.teams.find((candidate) => candidate.id === agent.teamId);
    const request = state.tasks.find((candidate) => candidate.id === plan.id);
    const at = this.ctx.at();
    const index = task.current;
    const step = task.steps[index]!;
    const subtask: Task = {
      id: randomUUID(),
      roomId: team?.roomId ?? "",
      teamId: agent.teamId,
      agentId: agent.id,
      projectId: plan.id,
      routeReason: shorten(`Plano · ${task.ref} «${task.title}» · etapa ${index + 1}/${task.steps.length}`, 300),
      prompt: this.stepPrompt(state, plan, task, request),
      status: "queued",
      work: { projectId: plan.id, ref: task.ref, step: index },
      createdAt: at,
      updatedAt: at,
    };
    state.tasks.push(subtask);
    void this.ctx.commitTasks(state.tasks, [{ type: "task:upserted", task: subtask }]);
    Object.assign(step, { status: "em_andamento", taskId: subtask.id, startedAt: at });
    Object.assign(task, { status: "em_andamento", startedAt: task.startedAt ?? at, stallWarned: false, updatedAt: at });
    delete task.note;
    clearBlocked(task, at);
    delete task.waitingSince;
    plan.updatedAt = at;
    if (request) {
      const from = index > 0 ? this.ctx.agentName(state, task.steps[index - 1]!.agentId) : undefined;
      this.ctx.logRequest(request, {
        kind: "delegation",
        teamId: agent.teamId,
        teamName: team?.name ?? agent.teamId,
        toAgentId: agent.id,
        toAgentName: agent.name,
        reason: from ? `${task.ref} «${task.title}»: ${from} passou para ${agent.name} (etapa ${index + 1}/${task.steps.length})` : `${task.ref} «${task.title}» (etapa 1/${task.steps.length})`,
        subtaskId: subtask.id,
      });
    }
    this.ctx.deps.orchestrator.enqueue(agent.id);
  }

  /** Texto da subtarefa de uma etapa (cabe no limite do prompt; a íntegra das anteriores fica no get_task). */
  private stepPrompt(state: OfficeState, plan: Project, task: ProjectTask, request: Task | undefined): string {
    const index = task.current;
    const step = task.steps[index]!;
    const next = task.steps[index + 1];
    // A primeira linha é o que as listas de tarefas mostram: a tarefa do plano e a etapa.
    const head = [
      `${task.ref} · ${task.title} — etapa ${index + 1}/${task.steps.length}`,
      `Do pedido: ${shorten(requestTitle(request) || plan.title, 200)}`,
      `Briefing: ${shorten2(task.briefing, 1400)}`,
      flowLine(plan, task, (id) => this.ctx.agentName(state, id)),
      `Sua etapa (${index + 1} de ${task.steps.length}): ${shorten2(step.what, 800)}`,
      doneWhenBlock(task),
      dueLine(task, plan),
    ]
      .filter(Boolean)
      .join("\n\n");
    const tail = [
      next ? `Depois de você: ${this.ctx.agentName(state, next.agentId)} recebe o seu resultado (${shorten(withoutMockMarkers(next.what), 160)}). Entregue algo que ele possa usar direto.` : receiverLine(plan, task, (id) => this.ctx.agentName(state, id)),
      !next && task.approvalType && this.ctx.deps.typeNote ? this.ctx.deps.typeNote(task.approvalType) : "",
      task.doneWhen.length > 0 ? "Antes de entregar, confira cada item de \"Done when\" e mande `checklist` (index, met, note) junto do submit_result (ou do request_approval)." : "",
      "Use get_task para ler a íntegra das etapas anteriores. Precisa de algo do usuário? ask_user. Faltou alguém/algo? request_help. Termine com submit_result.",
    ]
      .filter(Boolean)
      .join("\n\n");
    let budget = TEXT.prompt - head.length - tail.length - 200;
    const parts: string[] = [];
    const previous = task.steps.slice(0, index).filter((candidate) => candidate.result);
    if (previous.length > 0 && budget > 200) {
      const each = Math.max(200, Math.min(TEXT.previous, Math.floor(budget / (previous.length + 1))));
      const lines = previous.map((candidate, stepIndex) => `- Etapa ${stepIndex + 1} (${this.ctx.agentName(state, candidate.agentId)}): ${shorten(candidate.result ?? "", each)}`);
      const block = `## O que as etapas anteriores entregaram\n${lines.join("\n")}`;
      parts.push(block);
      budget -= block.length;
    }
    // Passagem de bastão: a entrega de cada subtarefa de que esta depende (a de uma mãe é a da última subtarefa), com o nome de quem fez.
    const deps = receivedBy(plan, task);
    if (deps.length > 0 && budget > 200) {
      const each = Math.max(150, Math.min(TEXT.dependency, Math.floor(budget / (deps.length + 1))));
      parts.push(`## O que as subtarefas de que esta depende entregaram\n${deps.map((dep) => `- ${dep.ref} «${dep.title}» (${dep.ownerId ? this.ctx.agentName(state, dep.ownerId) : "?"}): ${shorten(dep.result ?? "", each)}`).join("\n")}\n(A íntegra está no get_task.)`);
    }
    const text = [head, ...parts, tail].join("\n\n");
    return text.length > 4000 ? `${text.slice(0, 3990)}…` : text;
  }

  /** Avisa o Maestro das tarefas paradas demais (motor indisponível, agente que sumiu, etapa longa demais). Uma vez por espera. */
  checkStalls(): void {
    if (this.ctx.isStopped()) return;
    const now = this.ctx.deps.now().getTime();
    const state = this.ctx.deps.state.read();
    for (const plan of this.ctx.plans) {
      if (plan.status !== "ativo" || !hasLifecycle(plan) || isSeedProject(plan)) continue;
      const stalled = this.collectStalled(plan, state, now);
      if (stalled.length === 0) continue;
      this.ctx.save([plan]);
      const message = [
        `Pedido ${plan.id}: tarefas do plano paradas há muito tempo:`,
        stalled.join("\n"),
        "Se der, ajuste (resolve_task, add_project_tasks) ou avise o usuário na resposta; senão, só termine o turno (elas seguem sozinhas quando destravarem).",
      ].join("\n\n");
      this.ctx.deps.host(plan.id)?.wake(plan.id, "stalled", () => message);
    }
  }

  /** Linhas das tarefas do plano paradas demais; marca cada uma como avisada (stallWarned). */
  private collectStalled(plan: Project, state: OfficeState, now: number): string[] {
    const stalled: string[] = [];
    for (const task of leafTasks(plan.tasks)) {
      if (task.stallWarned || isSeedTask(task)) continue;
      const step = task.steps[task.current];
      const blockedSince = task.waitingSince && task.note?.includes("indisponível") ? Date.parse(task.waitingSince) : NaN;
      const runningSince = step?.status === "em_andamento" && task.status === "em_andamento" && step.startedAt ? Date.parse(step.startedAt) : NaN;
      if (now - blockedSince > this.ctx.limits().stallMs) stalled.push(`- ${task.ref} «${task.title}»: parada há ${Math.round((now - blockedSince) / 60_000)} min (${task.note})`);
      else if (now - runningSince > this.ctx.limits().stepMaxMs) stalled.push(`- ${task.ref} «${task.title}»: a etapa ${task.current + 1} (${this.ctx.agentName(state, step?.agentId)}) está rodando há ${Math.round((now - runningSince) / 60_000)} min`);
      else continue;
      task.stallWarned = true;
    }
    return stalled;
  }
}
