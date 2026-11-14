// O simulador do escritório de mentira (a demonstração): puro e determinístico por semente, sem relógio, rede nem
// servidor. Mesma semente e mesmo `now`, mesmo escritório, mesmos números. Cada agente anda numa pequena máquina de
// fases (ocioso, trabalhando, esperando o dono, pedindo ajuda) e o simulador devolve os MESMOS eventos que o
// servidor manda pelo socket (`task:upserted`, `agent:log`, `foryou:upserted`...), então a interface não sabe a diferença.
// A estrutura (fases com sorteio e um perfil de ritmo por hora do dia) segue a ideia do simulador do Habblaud
// (`shared/demo/`, MIT, Copyright 2026 Márcio Junior); o código é nosso, escrito sobre os dados do Cyno.
// A diária, o gasto e o dia gravado saem das MESMAS tarefas fabricadas aqui, então batem entre si.
import { addDays, buildDayStats, dayKeyOf, dayRange, HOUR_MS, localHourOf, zeroClockMs, type ClockBucket, type ClockMs, type ClockState, type DayStats, type DayUsage, type StateDayFile } from "../day-stats";
import type { ServerEvent } from "../events";
import type { ForYouItem } from "../for-you";
import { LEGACY_FOR_YOU_TYPES, type ForYouTypeDef } from "../for-you-types";
import type { Project, ProjectTask } from "../projects";
import type { AgentLogEntry } from "../agent-log";
import type { AgentTerminalInfo } from "../terminal";
import type { Agent, OfficeState, Room, Task, Team } from "../types";
import type { UsageRecord } from "../usage-history";
import type { TaskProgressInfo } from "../events";
import { cloneFrame, diffFrames, keyframeOf, KEYFRAME_MS, THROTTLE_MS, type SceneFrame, type TimelineRecord } from "../timeline";
import { buildSceneFrame, emptyLogMemory, forgetAgentLog, rememberLogEntry, type LogMemory } from "../timeline-frame";
import { fraseDeAtividade } from "../work-phrase";
import { ANDAMENTOS, APROVACOES, DEMO_ROOMS, DEMO_TEAMS, DEMO_WORKSPACE_ID, FERRAMENTAS, SUBAGENTES, TITULOS_POR_TIME, demoAgents, demoProjects } from "./cenario";
import { between, hash32, mulberry32, pick, type Rng } from "./rng";

const STEP_MS = 2_000;
/** O dia do escritório começa às 08h (de São Paulo). */
const INICIO_DO_DIA_H = 8;
/** Quanto o ritmo do escritório vale em cada hora do dia (1 = o pico): manhã e tarde cheias, almoço devagar, noite quase parada. */
const PERFIL: Record<number, number> = { 8: 0.55, 9: 0.9, 10: 1, 11: 0.95, 12: 0.4, 13: 0.55, 14: 0.9, 15: 1, 16: 0.85, 17: 0.5, 18: 0.25, 19: 0.15, 20: 0.1, 21: 0.1 };
export const pesoDaHora = (t: number): number => PERFIL[localHourOf(t)] ?? 0.05;

const USD_BRL = 5.5;
const MODELO = "gemini-3.8-flash-medium";

type Fase = "ocioso" | "trabalhando" | "esperando" | "ajuda";
type Maquina = {
  fase: Fase;
  ate: number;
  taskId?: string;
  task?: Task;
  inicio: number;
  duracao: number;
  proximaFerramenta: number;
  proximoAndamento: number;
  sub?: { id: string; ate: number; label: string; goal: string };
  /** Já voltou de uma espera ou de um pedido de ajuda: agora só falta entregar. */
  retomada: boolean;
  itemId?: string;
  ferramenta?: { id: string; entry: AgentLogEntry };
};

export type DemoOptions = {
  /** Semente do sorteio (padrão 7). */
  seed?: number;
  /** O instante "agora" do escritório de mentira (ms). */
  now: number;
};

const iso = (ms: number): string => new Date(ms).toISOString();

export class DemoOffice {
  readonly seed: number;
  readonly day: string;
  /** Quando o dia de trabalho de mentira começou (ms). */
  readonly start: number;
  readonly rooms: Room[] = DEMO_ROOMS.map((room) => ({ ...room }));
  readonly teams: Team[] = DEMO_TEAMS.map((team) => ({ ...team }));
  readonly agents: Agent[] = demoAgents();
  readonly tasks: Task[] = [];
  readonly projects: Project[];
  readonly forYou: ForYouItem[] = [];
  readonly progress: Record<string, TaskProgressInfo> = {};
  readonly terminals: Record<string, AgentTerminalInfo> = {};
  readonly usage: UsageRecord[] = [];
  readonly log: LogMemory = emptyLogMemory();
  readonly timeline: TimelineRecord[] = [];

  private t: number;
  private readonly rng: Rng;
  private readonly machines = new Map<string, Maquina>();
  private events: ServerEvent[] = [];
  private capturing = false;
  private counters = { task: 0, item: 0, tool: 0, log: 0, usage: 0 };
  private readonly buckets = new Map<number, ClockBucket>();
  private prevFrame: SceneFrame | null = null;
  private lastKeyframe = 0;
  private lastWrite = 0;
  private steps = 0;
  /** Algo mudou desde o último quadro do dia gravado (sem mudança não há o que ler). */
  private dirty = true;

  constructor(options: DemoOptions) {
    this.seed = options.seed ?? 7;
    this.day = dayKeyOf(options.now);
    this.start = Math.min(options.now, dayRange(this.day).start + INICIO_DO_DIA_H * HOUR_MS);
    this.t = this.start;
    this.rng = mulberry32(hash32(`demo:${this.seed}:${this.day}`));
    this.projects = demoProjects(dayRange(this.day).start);
    for (const agent of this.agents) {
      this.terminals[agent.id] = { agentId: agent.id, engine: "gemini", status: "idle", mode: "headless", everStarted: true, updatedAt: iso(this.start) };
      this.machines.set(agent.id, { fase: "ocioso", ate: this.start + between(this.rng, 10, 900) * 1000, inicio: this.start, duracao: 0, proximaFerramenta: 0, proximoAndamento: 0, retomada: false });
    }
    this.recordTimeline(true);
    this.advanceTo(options.now);
    this.capturing = true;
  }

  /** O "agora" do simulador. */
  get now(): number {
    return this.t;
  }

  /** Avança até `now` e devolve os eventos que o servidor teria mandado. */
  tick(now: number): ServerEvent[] {
    this.advanceTo(now);
    const out = this.events;
    this.events = [];
    return out;
  }

  /** O estado completo, como o `office:snapshot` do servidor. */
  snapshot(): ServerEvent {
    return {
      type: "office:snapshot",
      office: this.office(),
      progress: { ...this.progress },
      terminals: { ...this.terminals },
      usage: [],
      projects: this.projects,
      forYou: this.forYou,
      forYouTypes: this.forYouTypes(),
      connectors: [],
      epoch: "demo",
      seq: 0,
    } as ServerEvent;
  }

  office(): OfficeState {
    return { rooms: this.rooms, teams: this.teams, agents: this.agents, tasks: this.tasks };
  }

  forYouTypes(): ForYouTypeDef[] {
    return LEGACY_FOR_YOU_TYPES.map((preset) => ({ ...preset, createdBy: "system" as const, createdAt: iso(this.start) }));
  }

  /** O quadro do "Rever o dia" de agora (o mesmo que o gravador do servidor monta). */
  frame(): SceneFrame {
    return buildSceneFrame({ office: this.office(), terminals: this.terminals, forYou: this.forYou, projects: this.projects, progress: this.progress, block: () => undefined, log: this.log, now: this.t });
  }

  /** O dia gravado de mentira: o mesmo formato do arquivo do servidor. */
  dayRecords(): TimelineRecord[] {
    return this.timeline;
  }

  // ---------------------------------------------------------------- diária e gasto

  /** O gasto do dia (das tarefas fabricadas): tokens, custo e turnos. */
  dayUsage(day: string = this.day): DayUsage {
    const { start, end } = dayRange(day);
    const records = this.usage.filter((record) => Date.parse(record.at) >= start && Date.parse(record.at) < end);
    const sum = (pick: (r: UsageRecord) => number) => records.reduce((total, r) => total + pick(r), 0);
    const tokens = { input: sum((r) => r.tokens?.input ?? 0), output: sum((r) => r.tokens?.output ?? 0), cacheRead: sum((r) => r.tokens?.cacheRead ?? 0), cacheCreation: sum((r) => r.tokens?.cacheCreation ?? 0) };
    const costUsd = sum((r) => r.costUsd ?? 0);
    const totalTokens = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheCreation;
    return {
      tokens,
      costUsd,
      costBrl: costUsd * USD_BRL,
      turns: records.length,
      unmeasuredTurns: 0,
      providers: records.length ? [{ provider: "gemini", label: "Antigravity (Gemini)", turns: records.length, unmeasuredTurns: 0, totalTokens, costUsd, costBrl: costUsd * USD_BRL }] : [],
    };
  }

  /** O arquivo do relógio de estados do dia (o que o servidor grava em `day-stats/`). */
  clockFile(): StateDayFile {
    return {
      v: 1,
      day: this.day,
      names: { agents: this.agents.map((a) => [a.id, a.name]), projects: this.projects.map((p) => [p.id, p.title]), sprints: this.projects.flatMap((p) => (p.sprints ?? []).map((s): [string, string] => [`${p.id}:${s.id}`, s.name])) },
      buckets: [...this.buckets.values()].sort((a, b) => a.t - b.t),
      liveAt: this.t,
    };
  }

  /** "Meu dia" de mentira: a mesma conta do servidor sobre as tarefas fabricadas (só o dia de hoje). */
  dayStats(day: string = this.day): DayStats {
    return buildDayStats({
      day,
      now: this.t,
      clock: day === this.day ? this.clockFile() : null,
      clockFrom: this.start,
      items: this.forYou,
      tasks: this.tasks,
      projects: this.projects,
      agents: this.agents,
      usage: this.dayUsage(day),
    });
  }

  /** Os dias com dado (só hoje; o dia anterior não é fabricado). */
  days(): string[] {
    return [this.day];
  }

  /** Para o "Ver esse momento" e o gráfico: os dias gravados do replay. */
  timelineDays(): { day: string; bytes: number; from: number; to: number }[] {
    const first = this.timeline[0];
    const last = this.timeline[this.timeline.length - 1];
    return first && last ? [{ day: this.day, bytes: JSON.stringify(this.timeline).length, from: first.at, to: last.at }] : [];
  }

  /** O dia anterior no calendário (para quem precisar). */
  previousDay(): string {
    return addDays(this.day, -1);
  }

  // ---------------------------------------------------------------- simulação

  private advanceTo(now: number): void {
    while (this.t + STEP_MS <= now) {
      this.t += STEP_MS;
      this.step();
    }
  }

  private emit(event: ServerEvent): void {
    this.dirty = true;
    if (this.capturing) this.events.push(event);
  }

  private step(): void {
    for (const agent of this.agents) this.stepAgent(agent);
    this.accumulate();
    this.steps += 1;
    if (this.steps % (this.capturing ? 2 : 3) === 0 && (this.dirty || this.t - this.lastKeyframe >= KEYFRAME_MS)) this.recordTimeline(false);
  }

  private maquina(agent: Agent): Maquina {
    return this.machines.get(agent.id)!;
  }

  private stepAgent(agent: Agent): void {
    const m = this.maquina(agent);
    if (m.fase === "ocioso") {
      if (this.t >= m.ate) {
        if (this.rng() < pesoDaHora(this.t)) this.startTask(agent, m);
        else m.ate = this.t + between(this.rng, 30, 120) * 1000;
      }
      return;
    }
    if (m.fase === "trabalhando") {
      this.work(agent, m);
      if (this.t >= m.ate) this.finishWork(agent, m);
      return;
    }
    if (this.t < m.ate) return;
    if (m.fase === "esperando") this.resolveApproval(agent, m);
    else this.resolveHelp(agent, m);
  }

  private upsertAgent(agent: Agent, status: Agent["status"]): void {
    agent.status = status;
    this.emit({ type: "agent:upserted", agent: { ...agent } });
  }

  private setTerminal(agent: Agent, status: AgentTerminalInfo["status"]): void {
    const info: AgentTerminalInfo = { ...this.terminals[agent.id]!, status, updatedAt: iso(this.t) };
    this.terminals[agent.id] = info;
    this.emit({ type: "agent:terminal", terminal: info });
  }

  private taskOf(m: Maquina): Task | undefined {
    return m.task;
  }

  private projectTaskOf(task: Task): { project: Project; item: ProjectTask } | undefined {
    if (!task.work) return undefined;
    const project = this.projects.find((p) => p.id === task.work!.projectId);
    const item = project?.tasks.find((t) => t.ref === task.work!.ref);
    return project && item ? { project, item } : undefined;
  }

  private touchProject(project: Project): void {
    project.updatedAt = iso(this.t);
    if (project.tasks.every((t) => t.status === "concluida")) {
      project.status = "concluido";
      project.finishedAt = iso(this.t);
    }
    this.dirty = true;
    if (this.capturing) this.emit({ type: "project:upserted", project: JSON.parse(JSON.stringify(project)) as Project });
  }

  private logEntry(agent: Agent, taskId: string, body: Record<string, unknown>): AgentLogEntry {
    this.counters.log += 1;
    const entry = { id: `${this.t.toString(36)}-${this.counters.log.toString(36).padStart(4, "0")}`, taskId, agentId: agent.id, at: iso(this.t), ...body } as AgentLogEntry;
    rememberLogEntry(this.log, entry, this.t);
    this.emit({ type: "agent:log", entry });
    return entry;
  }

  private startTask(agent: Agent, m: Maquina): void {
    const team = agent.teamId;
    const candidate = this.projects.flatMap((p) => p.tasks.filter((t) => t.ownerId === agent.id && t.status === "a_fazer" && p.tasks.filter((x) => x.status !== "concluida").length > 1 && t.dependsOn.every((ref) => p.tasks.find((x) => x.ref === ref)?.status === "concluida")).map((t) => ({ p, t })))[0];
    const useProject = candidate !== undefined && this.rng() < 0.12;
    const titulo = useProject ? candidate!.t.title : pick(this.rng, TITULOS_POR_TIME[team] ?? ["Tarefa"]);
    this.counters.task += 1;
    const room = this.teams.find((x) => x.id === team)!.roomId;
    const task: Task = {
      id: `d${this.counters.task}`,
      roomId: room,
      teamId: team,
      agentId: agent.id,
      prompt: `${titulo}\n\nPedido da demonstração.`,
      status: "in_progress",
      createdAt: iso(this.t),
      updatedAt: iso(this.t),
      ...(useProject ? { work: { projectId: candidate!.p.id, ref: candidate!.t.ref, step: 0 } } : {}),
    };
    this.tasks.push(task);
    m.fase = "trabalhando";
    m.taskId = task.id;
    m.task = task;
    m.inicio = this.t;
    m.duracao = between(this.rng, 150, 540) * 1000;
    m.ate = this.t + m.duracao;
    m.proximaFerramenta = this.t + 1500;
    m.proximoAndamento = this.t + 4000;
    m.retomada = false;
    delete m.sub;
    this.emit({ type: "task:upserted", task: { ...task } });
    this.upsertAgent(agent, "working");
    this.setTerminal(agent, "busy");
    this.logEntry(agent, task.id, { kind: "status", status: "started", message: "Começou a trabalhar" });
    if (useProject) {
      candidate!.t.status = "em_andamento";
      candidate!.t.startedAt = iso(this.t);
      candidate!.t.updatedAt = iso(this.t);
      candidate!.t.steps[0]!.status = "em_andamento";
      this.touchProject(candidate!.p);
    }
  }

  /** Um segundo de trabalho: troca de ferramenta, andamento e subagente. */
  private work(agent: Agent, m: Maquina): void {
    const task = this.taskOf(m);
    if (!task) return;
    if (this.t >= m.proximaFerramenta) {
      if (m.ferramenta) this.logEntry(agent, task.id, { ...m.ferramenta.entry, id: m.ferramenta.entry.id, at: m.ferramenta.entry.at, status: "ok" });
      const escolha = pick(this.rng, FERRAMENTAS);
      this.counters.tool += 1;
      const toolUseId = `tu-${this.counters.tool}`;
      const entry = this.logEntry(agent, task.id, { kind: "tool", toolUseId, name: escolha.name, summary: "", phrase: fraseDeAtividade(escolha), input: escolha.input, status: "running" });
      m.ferramenta = { id: toolUseId, entry };
      m.proximaFerramenta = this.t + between(this.rng, 4, 11) * 1000;
    }
    if (this.t >= m.proximoAndamento) {
      const info: TaskProgressInfo = { agentId: agent.id, progress: Math.min(0.95, (this.t - m.inicio) / Math.max(1, m.duracao)), message: pick(this.rng, ANDAMENTOS) };
      this.progress[task.id] = info;
      this.emit({ type: "task:progress", taskId: task.id, ...info });
      m.proximoAndamento = this.t + 25_000;
    }
    if (m.sub && this.t >= m.sub.ate) {
      this.logEntry(agent, task.id, { kind: "subagent", phase: "finished", subagentId: m.sub.id, label: m.sub.label, status: "ok" });
      delete m.sub;
    } else if (!m.sub && m.ate - this.t > 40_000 && this.rng() < 0.006) {
      const sub = pick(this.rng, SUBAGENTES);
      m.sub = { id: `s${this.counters.log + 1}`, ate: this.t + between(this.rng, 25, 70) * 1000, ...sub };
      this.logEntry(agent, task.id, { kind: "subagent", phase: "started", subagentId: m.sub.id, label: sub.label, goal: sub.goal, model: "gemini-3.8-flash-medium" });
    }
  }

  private closeToolAndSub(agent: Agent, m: Maquina, task: Task): void {
    if (m.ferramenta) this.logEntry(agent, task.id, { ...m.ferramenta.entry, at: m.ferramenta.entry.at, status: "ok" });
    delete m.ferramenta;
    if (m.sub) this.logEntry(agent, task.id, { kind: "subagent", phase: "finished", subagentId: m.sub.id, label: m.sub.label, status: "ok" });
    delete m.sub;
  }

  private finishWork(agent: Agent, m: Maquina): void {
    const task = this.taskOf(m);
    if (!task) return;
    this.closeToolAndSub(agent, m, task);
    const sorteio = this.rng();
    const linked = this.projectTaskOf(task);
    if (!m.retomada && sorteio < 0.17) return this.askApproval(agent, m, task);
    if (!m.retomada && sorteio < 0.22 && linked) return this.askHelp(agent, m, task, linked);
    this.settle(agent, m, task, !m.retomada && sorteio >= 0.97 ? "failed" : "done");
  }

  private askApproval(agent: Agent, m: Maquina, task: Task): void {
    const modelo = pick(this.rng, APROVACOES);
    this.counters.item += 1;
    const item: ForYouItem = {
      id: `A-${String(this.counters.item).padStart(4, "0")}`,
      taskId: task.id,
      agentId: agent.id,
      roomId: task.roomId,
      type: modelo.type,
      status: "pendente",
      title: modelo.title,
      ...(modelo.where ? { where: modelo.where } : {}),
      meta: {},
      text: modelo.text,
      originalText: modelo.text,
      editedByUser: false,
      createdAt: iso(this.t),
      ...(this.projectTaskOf(task) ? { projectId: this.projectTaskOf(task)!.project.id, taskRef: task.work!.ref } : {}),
    } as ForYouItem;
    this.forYou.push(item);
    m.fase = "esperando";
    m.itemId = item.id;
    m.ate = this.t + between(this.rng, 120, 1000) * 1000;
    task.status = "waiting_approval";
    task.updatedAt = iso(this.t);
    this.progress[task.id] = { agentId: agent.id, progress: 0.9, message: `Aguardando sua aprovação: ${modelo.title}` };
    this.emit({ type: "foryou:upserted", item: { ...item } });
    this.emit({ type: "task:progress", taskId: task.id, ...this.progress[task.id]! });
    this.emit({ type: "task:upserted", task: { ...task } });
    this.upsertAgent(agent, "waiting_approval");
    this.setTerminal(agent, "idle");
    const linked = this.projectTaskOf(task);
    if (linked) {
      linked.item.status = "esperando_voce";
      linked.item.updatedAt = iso(this.t);
      this.touchProject(linked.project);
    }
  }

  private resolveApproval(agent: Agent, m: Maquina): void {
    const task = this.taskOf(m);
    const item = this.forYou.find((x) => x.id === m.itemId);
    if (!task || !item) return this.settle(agent, m, task ?? this.tasks[0]!, "done");
    const aprovado = this.rng() < 0.92;
    item.status = aprovado ? "aprovado" : "rejeitado";
    item.decidedAt = iso(this.t);
    item.decidedBy = "usuario";
    if (!aprovado) item.rejection = { reason: "Ajustar o tom da mensagem", category: "tom" };
    this.emit({ type: "foryou:upserted", item: { ...item } });
    delete this.progress[task.id];
    task.status = "in_progress";
    task.updatedAt = iso(this.t);
    this.emit({ type: "task:upserted", task: { ...task } });
    m.fase = "trabalhando";
    m.retomada = true;
    m.inicio = this.t;
    m.duracao = between(this.rng, 30, 100) * 1000;
    m.ate = this.t + m.duracao;
    m.proximaFerramenta = this.t + 1000;
    m.proximoAndamento = this.t + 5000;
    this.upsertAgent(agent, "working");
    this.setTerminal(agent, "busy");
    const linked = this.projectTaskOf(task);
    if (linked) {
      linked.item.status = "em_andamento";
      linked.item.updatedAt = iso(this.t);
      this.touchProject(linked.project);
    }
  }

  private askHelp(agent: Agent, m: Maquina, task: Task, linked: { project: Project; item: ProjectTask }): void {
    linked.item.blocked = { type: "agente", by: `${DEMO_WORKSPACE_ID}/lia`, note: "Preciso do briefing atualizado", since: iso(this.t) };
    linked.item.updatedAt = iso(this.t);
    this.touchProject(linked.project);
    m.fase = "ajuda";
    m.ate = this.t + between(this.rng, 60, 240) * 1000;
    this.setTerminal(agent, "idle");
    this.upsertAgent(agent, "idle");
    void task;
  }

  private resolveHelp(agent: Agent, m: Maquina): void {
    const task = this.taskOf(m);
    const linked = task ? this.projectTaskOf(task) : undefined;
    if (linked) {
      delete linked.item.blocked;
      linked.item.updatedAt = iso(this.t);
      this.touchProject(linked.project);
    }
    m.fase = "trabalhando";
    m.retomada = true;
    m.inicio = this.t;
    m.duracao = between(this.rng, 40, 120) * 1000;
    m.ate = this.t + m.duracao;
    m.proximaFerramenta = this.t + 1000;
    m.proximoAndamento = this.t + 5000;
    this.upsertAgent(agent, "working");
    this.setTerminal(agent, "busy");
  }

  /** A tarefa termina (entregue ou falhou): grava o gasto, solta o agente e sorteia a próxima pausa. */
  private settle(agent: Agent, m: Maquina, task: Task, resultado: "done" | "failed"): void {
    task.status = resultado;
    task.updatedAt = iso(this.t);
    if (resultado === "done") task.result = "Entregue.";
    delete this.progress[task.id];
    this.emit({ type: "task:upserted", task: { ...task } });
    this.logEntry(agent, task.id, { kind: "status", status: resultado === "done" ? "done" : "failed", message: resultado === "done" ? "Concluída" : "Não deu certo desta vez" });
    const linked = this.projectTaskOf(task);
    if (linked) {
      linked.item.status = resultado === "done" ? "concluida" : "falhou";
      linked.item.updatedAt = iso(this.t);
      linked.item.finishedAt = iso(this.t);
      linked.item.steps[0]!.status = resultado === "done" ? "feita" : "falhou";
      if (resultado === "done") linked.item.result = "Entregue.";
      this.touchProject(linked.project);
    }
    this.recordUsage(agent, task);
    m.fase = "ocioso";
    delete m.taskId;
    delete m.task;
    delete m.itemId;
    m.ate = this.t + (between(this.rng, 60, 300) * 1000) / Math.max(0.2, pesoDaHora(this.t));
    this.upsertAgent(agent, "idle");
    this.setTerminal(agent, "idle");
  }

  private recordUsage(agent: Agent, task: Task): void {
    this.counters.usage += 1;
    const input = Math.round(between(this.rng, 6_000, 45_000));
    const output = Math.round(between(this.rng, 900, 7_000));
    const cacheRead = Math.round(between(this.rng, 15_000, 160_000));
    const costUsd = (input * 0.3 + output * 2.5 + cacheRead * 0.03) / 1_000_000;
    this.usage.push({
      v: 1,
      id: `u${this.counters.usage}`,
      at: iso(this.t),
      agentId: agent.id,
      agentName: agent.name,
      provider: "gemini",
      model: MODELO,
      modelSource: "config",
      taskId: task.id,
      taskTitle: task.prompt.split("\n")[0]!,
      channel: "task",
      source: "live",
      turns: 1,
      measured: true,
      tokens: { input, output, cacheRead, cacheCreation: 0 },
      costUsd,
      priceVersion: "demo",
    });
  }

  /** Soma um segundo no relógio de estados da diária (trabalhando e esperando o Maestro; "esperando você" vem dos itens). */
  private accumulate(): void {
    const hour = Math.floor(this.t / HOUR_MS) * HOUR_MS;
    let bucket = this.buckets.get(hour);
    if (!bucket) {
      bucket = { t: hour, ms: zeroClockMs(), byAgent: [], byProject: [], bySprint: [] };
      this.buckets.set(hour, bucket);
    }
    const add = (list: Array<[string, ClockMs]>, key: string, state: ClockState): void => {
      let entry = list.find(([k]) => k === key);
      if (!entry) list.push((entry = [key, zeroClockMs()]));
      entry[1][state] += STEP_MS;
    };
    for (const agent of this.agents) {
      const m = this.machines.get(agent.id)!;
      const state: ClockState | undefined = m.fase === "trabalhando" ? "working" : m.fase === "ajuda" ? "waiting_maestro" : undefined;
      if (!state) continue;
      bucket.ms[state] += STEP_MS;
      add(bucket.byAgent, agent.id, state);
      const task = this.taskOf(m);
      const linked = task ? this.projectTaskOf(task) : undefined;
      if (linked) {
        add(bucket.byProject, linked.project.id, state);
        const sprint = (linked.item as ProjectTask & { sprintId?: string }).sprintId;
        if (sprint) add(bucket.bySprint, `${linked.project.id}:${sprint}`, state);
      }
    }
  }

  /** Grava o dia fabricado no mesmo formato do gravador: quadro completo a cada 5 min e mudanças (no máximo uma por segundo). */
  private recordTimeline(boot: boolean): void {
    this.dirty = false;
    const frame = this.frame();
    const now = this.t;
    if (this.prevFrame === null || now - this.lastKeyframe >= KEYFRAME_MS) {
      this.timeline.push(keyframeOf(frame, now, KEYFRAME_MS, boot && this.prevFrame === null));
      this.prevFrame = cloneFrame(frame);
      this.lastKeyframe = now;
      this.lastWrite = now;
      return;
    }
    if (now - this.lastWrite < THROTTLE_MS) return;
    const changes = diffFrames(this.prevFrame, frame);
    if (!changes) return;
    this.timeline.push({ t: "d", at: now, ...changes });
    this.prevFrame = cloneFrame(frame);
    this.lastWrite = now;
  }

  /** Esquece um agente removido (só para o caso de a interface pedir). */
  forget(agentId: string): void {
    forgetAgentLog(this.log, agentId);
  }
}
