import { readFile } from "node:fs/promises";
import {
  blockedLeaves,
  deadDependencies,
  ATTENTION_COALESCE_MS,
  ATTENTION_DEDUPE_MS,
  ATTENTION_FAILED_COALESCE_MS,
  ATTENTION_KINDS,
  attentionPrefsSchema,
  DEFAULT_ATTENTION_PREFS,
  ENGINE_DOWN_SETTLE_MS,
  headlineAndSummary,
  HELP_ESCALATE_MS,
  isSelfResolving,
  needsOwnerOf,
  USAGE_HYSTERESIS,
  type AgentEngine,
  type AgentTerminalInfo,
  type AttentionAlert,
  type AttentionClearReason,
  type AttentionKind,
  type AttentionLevel,
  type AttentionPrefs,
  type AttentionPrefsBody,
  type AttentionServerEvent,
  type AttentionTarget,
  type ForYouItem,
  type Project,
  type ProjectHelp,
  type ServerEvent,
  type SubscriptionUsage,
  type Task,
} from "@cyno/shared";
import { writeJsonAtomic } from "../../store/atomic-write";
import { WriteQueue } from "../../store/write-queue";
import {
  cutText,
  engineDownText,
  deliveryText,
  blockedAlertText,
  failedText,
  projectDeliveredText,
  forYouAlertKind,
  forYouText,
  helpText,
  targetOf,
  usageAlertLevel,
  usageLevelOf,
  usageLevelStillHolds,
  USAGE_LEVEL_NAME,
  usageText,
  type UsageLevel,
} from "./rules";

/** O que o serviço lê de um workspace na hora (o resto chega por evento). */
export type AttentionSourceData = {
  forYou: ForYouItem[];
  tasks: Task[];
  projects: Project[];
  agents: { id: string; name: string; engine?: AgentEngine }[];
  terminals: AgentTerminalInfo[];
};

/** Um workspace como o serviço o enxerga (o `app.ts` monta um por runtime; os testes usam falsos). */
export type AttentionSource = {
  id: string;
  name: string;
  subscribe: (listener: (event: ServerEvent) => void) => () => void;
  read: () => AttentionSourceData;
};

export type AttentionDeps = {
  sources: () => AttentionSource[];
  /** Avisa quando a lista de workspaces muda (criou, renomeou, excluiu). */
  subscribeList: (listener: () => void) => () => void;
  /** O uso da assinatura (da conta, igual para todos os workspaces). */
  usage: { subscribe: (listener: (event: ServerEvent) => void) => () => void; snapshot: () => SubscriptionUsage[] };
  /** `data/platform/attention.json`. */
  file: string;
  now: () => Date;
  queue?: WriteQueue;
  log: { error: (obj: unknown, message?: string) => void };
  /** Quanto tempo espera entre as conferências por relógio (pedido de ajuda parado, janela que renovou). */
  tickMs?: number;
};

/** Quanto tempo uma tarefa já vista não volta a avisar (depois de um reinício). */
const SEEN_MEMORY_MS = 24 * 3_600_000;
/** A entrega (aviso discreto) some sozinha depois disto, se o dono não marcar "Visto". */
export const DELIVERY_ALERT_MS = 24 * 3_600_000;
const SEEN_CAP = 100;

type Entry = {
  alert: AttentionAlert;
  /** As causas juntas (um item, uma tarefa, um agente...), cada uma com a sua chave de causa. */
  refs: Set<string>;
  /** O que as agrupa (agente, projeto) e o que as junta de uma vez (lote). */
  scope: string;
  groupId?: string;
  build: (count: number) => string;
  /** A causa some sozinha neste instante (limite de uso que renova). */
  expiresAt?: number;
};

type RaiseInput = {
  kind: AttentionKind;
  level: AttentionLevel;
  workspace?: { id: string; name: string };
  ref: string;
  scope: string;
  windowMs?: number;
  agentId?: string;
  agentName?: string;
  projectId?: string;
  sprintId?: string;
  taskId?: string;
  forYouId?: string;
  groupId?: string;
  build: (count: number) => string;
  target?: AttentionTarget;
  /** Boot ou reabertura: entra na lista e no número, sem aviso. */
  replay?: boolean;
  /** Boot: a hora é a do item, e só o lote junta (não a janela de tempo). */
  at?: string;
  expiresAt?: number;
  /** Já visto pelo dono há pouco (mesmo depois de um reinício): não nasce de novo. */
  skipIfSeen?: boolean;
  /** Troca o `needsOwner` do tipo (limite de uso nunca entra no número da aba). */
  needsOwnerOverride?: boolean;
};

type PendingHelp = { workspace: { id: string; name: string }; project: string; taskRef: string; help: ProjectHelp; agentName?: string; projectTitle?: string; raised: boolean };

const persistedFileSchema = {
  parsePrefs: (value: unknown): AttentionPrefs => {
    const parsed = attentionPrefsSchema.safeParse(value);
    return parsed.success ? parsed.data : { ...DEFAULT_ATTENTION_PREFS };
  },
};

const isStoredAlert = (value: unknown): value is AttentionAlert => {
  if (typeof value !== "object" || value === null) return false;
  const alert = value as Partial<AttentionAlert>;
  return typeof alert.key === "string" && typeof alert.id === "string" && typeof alert.text === "string" && typeof alert.at === "string" && (ATTENTION_KINDS as readonly string[]).includes(alert.kind ?? "");
};

/**
 * A cadeia de atenção, do lado do servidor. O alerta nasce aqui, uma vez, quando algo passa a
 * esperar o dono (item novo em Aprovações, pedido de ajuda, tarefa que falhou, terminal que caiu,
 * limite de uso), e vai a todas as abas pelo socket da plataforma. O estado nunca é adivinhado: vem
 * dos eventos que os workspaces já publicam, e o alerta some quando a causa some.
 *
 * Regras para não cansar: a mesma chave não volta em 10 min (`ATTENTION_DEDUPE_MS`: só sobe a
 * contagem, e uma reabertura entra quieta); vários do mesmo tipo, workspace e agente em 3 s viram um
 * (`ATTENTION_COALESCE_MS`; um lote de aprovações é sempre um); nada dispara na carga inicial, no
 * reinício do servidor nem na reconexão (`replay`: conta e aparece no sino, sem aviso). O silêncio
 * (tipo desligado, workspace silenciado, "não perturbe") é decidido pelo navegador com as
 * preferências da conta: o alerta continua contando.
 */
export class AttentionService {
  private readonly queue: WriteQueue;
  private readonly listeners = new Set<(event: AttentionServerEvent) => void>();
  private readonly open = new Map<string, Entry>();
  /** Chave de causa -> chave do alerta que a contém. */
  private readonly refIndex = new Map<string, string>();
  private readonly lastRaised = new Map<string, number>();
  private readonly seen = new Map<string, string>();
  private readonly watching = new Map<string, () => void>();
  private readonly taskStatus = new Map<string, Task["status"]>();
  private readonly failures = new Map<string, number>();
  private readonly projectStatus = new Map<string, string>();
  private readonly pendingHelp = new Map<string, PendingHelp>();
  private readonly sourceNames = new Map<string, string>();
  private readonly engineTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly usageLevels = new Map<string, UsageLevel>();
  private offList: (() => void) | undefined;
  private offUsage: (() => void) | undefined;
  private tick: ReturnType<typeof setInterval> | undefined;
  private started = false;
  private closed = false;
  private seq = 0;

  private constructor(
    private readonly deps: AttentionDeps,
    private prefsState: AttentionPrefs,
    private readonly restored: AttentionAlert[],
  ) {
    this.queue = deps.queue ?? new WriteQueue();
  }

  /** Lê o arquivo (as preferências, os alertas de tarefa que falhou e o que o dono já viu). Arquivo ausente ou quebrado = começa limpo. */
  static async open(deps: AttentionDeps): Promise<AttentionService> {
    let prefs = { ...DEFAULT_ATTENTION_PREFS };
    let restored: AttentionAlert[] = [];
    let seen: Record<string, string> = {};
    try {
      const raw = JSON.parse(await readFile(deps.file, "utf8")) as { prefs?: unknown; open?: unknown; seen?: unknown };
      prefs = persistedFileSchema.parsePrefs(raw.prefs);
      if (Array.isArray(raw.open)) restored = raw.open.filter(isStoredAlert);
      if (raw.seen && typeof raw.seen === "object" && !Array.isArray(raw.seen)) {
        seen = Object.fromEntries(Object.entries(raw.seen as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
      }
    } catch {
      // Sem arquivo (ou quebrado): preferências padrão e nada pendente.
    }
    const service = new AttentionService(deps, prefs, restored);
    for (const [key, at] of Object.entries(seen)) service.seen.set(key, at);
    return service;
  }

  // ---------- API ----------

  /** Os alertas abertos, do mais antigo ao mais novo. */
  list(): AttentionAlert[] {
    return [...this.open.values()].map((entry) => entry.alert).sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  }

  prefs(): AttentionPrefs {
    return structuredClone(this.prefsState);
  }

  subscribe(listener: (event: AttentionServerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** O dono trocou as preferências (só o que veio). `dndUntil: null` tira o "não perturbe". */
  updatePrefs(body: AttentionPrefsBody): AttentionPrefs {
    const next: AttentionPrefs = { ...this.prefsState };
    if (body.mutedWorkspaces) next.mutedWorkspaces = { ...body.mutedWorkspaces };
    if (body.kinds) next.kinds = { ...body.kinds };
    if (body.dndUntil === null) delete next.dndUntil;
    else if (body.dndUntil !== undefined) next.dndUntil = body.dndUntil;
    this.prefsState = attentionPrefsSchema.parse(next);
    this.persist();
    return this.prefs();
  }

  /** O dono viu um alerta que não se resolve sozinho (tarefa que falhou, entrega, orçamento, aviso). */
  markSeen(key: string): "ok" | "not-found" | "not-allowed" {
    const entry = this.open.get(key);
    if (!entry) return "not-found";
    // O que espera o dono (aprovação, pergunta...) só sai quando ele decide, e o que se resolve sozinho (limite de
    // uso, terminal) sai quando a causa some; "Visto" é só para o resto (tarefa que falhou, entrega, aviso).
    if (entry.alert.needsOwner || isSelfResolving(entry.alert.kind)) return "not-allowed";
    const at = this.deps.now().toISOString();
    this.seen.set(key, at);
    for (const ref of entry.refs) this.seen.set(ref, at);
    this.dropEntry(entry, "seen");
    this.persist();
    return "ok";
  }

  /**
   * Orçamento de consumo (J2-09, só avisa): `ref` é único por período e degrau (`dia-2026-11-12-100`),
   * então cada degrau avisa uma vez por período. 80% é `warn`; 100% é `alert`; nenhum entra no número
   * da aba (não espera o dono). O alerta some sozinho no fim do período (`expiresAt`), quando o
   * limite é tirado (`clearBudget`) ou quando o dono marca "Visto" (não volta no mesmo degrau e período).
   */
  raiseBudget(input: { ref: string; level: AttentionLevel; text: string; expiresAt?: number; replay?: boolean }): void {
    if (this.closed) return;
    this.raise({
      kind: "budget",
      level: input.level,
      ref: input.ref,
      scope: "budget",
      build: () => input.text,
      target: targetOf("budget", {}),
      needsOwnerOverride: false,
      skipIfSeen: true,
      ...(input.replay ? { replay: true } : {}),
      ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
    });
  }

  /**
   * Pausa por limite de uso do plano (e o aviso de que voltou): é um alerta do tipo "Limite de uso", que não entra
   * no número da aba. `ref` é único por pausa (ou por volta); `expiresAt` o tira sozinho (o reset da janela).
   */
  raiseUsagePause(input: { ref: string; level: AttentionLevel; text: string; expiresAt?: number }): void {
    if (this.closed) return;
    this.raise({
      kind: "usage",
      level: input.level,
      ref: input.ref,
      scope: "usage-pause",
      build: () => cutText(input.text),
      target: targetOf("usage", {}),
      needsOwnerOverride: false,
      ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
    });
  }

  /** Tira o alerta de uma pausa (a pausa acabou). */
  clearUsagePause(ref: string): void {
    this.clearRef(`usage:plataforma:${ref}`, "resolved");
  }

  /** Tira os alertas de orçamento abertos (cuja `ref` passa no filtro; sem filtro, todos). */
  clearBudget(keep?: (ref: string) => boolean): void {
    const prefix = "budget:plataforma:";
    for (const refKey of [...this.refIndex.keys()]) {
      if (!refKey.startsWith(prefix)) continue;
      if (keep?.(refKey.slice(prefix.length))) continue;
      this.clearRef(refKey, "resolved");
    }
  }

  /** Liga a cadeia: lê o que já espera (entra como `replay`), assina os workspaces e o uso. Chamado depois do boot dos workspaces. */
  start(): void {
    if (this.started || this.closed) return;
    this.started = true;
    for (const source of this.deps.sources()) {
      this.watch(source);
      this.seed(source);
    }
    this.restoreFailed();
    for (const usage of this.deps.usage.snapshot()) this.evaluateUsage(usage, true);
    this.offUsage = this.deps.usage.subscribe((event) => {
      if (event.type === "usage:updated") this.evaluateUsage(event.usage, false);
    });
    this.offList = this.deps.subscribeList(() => this.syncSources());
    this.tick = setInterval(() => this.onTick(), this.deps.tickMs ?? 30_000);
    this.tick.unref();
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.tick) clearInterval(this.tick);
    this.offList?.();
    this.offUsage?.();
    for (const off of this.watching.values()) off();
    this.watching.clear();
    for (const timer of this.engineTimers.values()) clearTimeout(timer);
    this.engineTimers.clear();
    await this.queue.idle();
  }

  /** Espera as gravações pendentes (testes e o fechamento do app). */
  idle(): Promise<void> {
    return this.queue.idle();
  }

  // ---------- Assinaturas ----------

  private watch(source: AttentionSource): void {
    this.watching.get(source.id)?.();
    this.watching.set(
      source.id,
      source.subscribe((event) => this.onEvent(source, event)),
    );
  }

  private syncSources(): void {
    if (this.closed) return;
    const sources = this.deps.sources();
    const ids = new Set(sources.map((source) => source.id));
    for (const source of sources) this.sourceNames.set(source.id, source.name);
    for (const id of [...this.sourceNames.keys()]) if (!ids.has(id)) this.sourceNames.delete(id);
    for (const source of sources) {
      if (!this.watching.has(source.id)) {
        this.watch(source);
        this.seed(source);
      }
    }
    for (const id of [...this.watching.keys()]) {
      if (ids.has(id)) continue;
      this.watching.get(id)?.();
      this.watching.delete(id);
      this.clearWorkspace(id);
    }
  }

  /** O que já esperava quando o serviço ligou (ou quando o workspace nasceu): entra quieto. */
  private seed(source: AttentionSource): void {
    const data = source.read();
    for (const task of data.tasks) this.taskStatus.set(`${source.id}|${task.id}`, task.status);
    for (const item of data.forYou) if (item.status === "pendente") this.handleForYou(source, item, { seed: true });
    for (const project of data.projects) {
      this.projectStatus.set(`${source.id}|${project.id}`, project.status);
      this.handleProject(source, project, { seed: true });
    }
  }

  /** As tarefas que falharam e o dono ainda não viu voltam do arquivo (quietas), se a causa continua. */
  private restoreFailed(): void {
    const workspaces = new Map(this.deps.sources().map((source) => [source.id, source] as const));
    for (const stored of this.restored) {
      if (stored.kind !== "failed" || !stored.workspaceId || !stored.taskId) continue;
      const source = workspaces.get(stored.workspaceId);
      const task = source?.read().tasks.find((candidate) => candidate.id === stored.taskId);
      if (!source || task?.status !== "failed") continue;
      const refKey = `failed:${source.id}:${stored.taskId}`;
      if (this.refIndex.has(refKey)) continue;
      const entry: Entry = { alert: { ...stored, replay: true }, refs: new Set([refKey]), scope: stored.projectId ?? stored.agentId ?? "", build: () => stored.text };
      this.open.set(stored.key, entry);
      this.refIndex.set(refKey, stored.key);
    }
  }

  // ---------- Eventos dos workspaces ----------

  private onEvent(source: AttentionSource, event: ServerEvent): void {
    if (!this.started || this.closed) return;
    switch (event.type) {
      case "foryou:upserted":
        this.handleForYou(source, event.item, {});
        break;
      case "foryou:deleted":
        this.clearForYouItem(source.id, event.id, "resolved");
        break;
      case "task:upserted":
        this.handleTask(source, event.task);
        break;
      case "project:upserted":
        this.handleProjectDelivery(source, event.project);
        this.handleProject(source, event.project, {});
        break;
      case "project:deleted":
        this.clearProject(source.id, event.id);
        break;
      case "agent:terminal":
        this.handleTerminal(source, event.terminal);
        break;
      case "agent:deleted":
        this.clearAgent(source.id, event.id);
        break;
      default:
        break;
    }
  }

  private workspaceOf(source: AttentionSource): { id: string; name: string } {
    // O nome mais recente (renomear o workspace vale para os alertas novos, sem reiniciar o servidor).
    return { id: source.id, name: this.sourceNames.get(source.id) ?? source.name };
  }

  // ---------- Aprovações, perguntas, planos, rotinas e sprints ----------

  private handleForYou(source: AttentionSource, item: ForYouItem, options: { seed?: boolean }): void {
    if (item.status !== "pendente") {
      this.clearForYouItem(source.id, item.id, "decided");
      return;
    }
    const kind = forYouAlertKind(item);
    const data = source.read();
    const agentName = data.agents.find((agent) => agent.id === item.agentId)?.name;
    const project = item.projectId ? data.projects.find((candidate) => candidate.id === item.projectId) : undefined;
    const sprintName = item.sprintId ? project?.sprints?.find((sprint) => sprint.id === item.sprintId)?.name : undefined;
    const context = { item, ...(agentName ? { agentName } : {}), ...(project ? { projectTitle: project.title } : {}), ...(sprintName ? { sprintName } : {}) };
    this.raise({
      kind,
      level: "alert",
      workspace: this.workspaceOf(source),
      ref: item.id,
      scope: item.agentId,
      windowMs: ATTENTION_COALESCE_MS,
      agentId: item.agentId,
      ...(agentName ? { agentName } : {}),
      ...(item.projectId ? { projectId: item.projectId } : {}),
      ...(item.sprintId ? { sprintId: item.sprintId } : {}),
      ...(item.taskId ? { taskId: item.taskId } : {}),
      ...(item.groupId ? { groupId: item.groupId } : {}),
      forYouId: item.id,
      build: (count) => forYouText(kind, context, count),
      target: targetOf(kind, { workspaceId: source.id, ref: item.id }),
      ...(options.seed ? { replay: true, at: item.createdAt } : {}),
    });
  }

  private clearForYouItem(workspaceId: string, itemId: string, reason: AttentionClearReason): void {
    for (const kind of ["approval", "question", "plan", "routine", "sprint"] as const) this.clearRef(`${kind}:${workspaceId}:${itemId}`, reason);
  }

  // ---------- Tarefa que falhou ----------

  /** O projeto virou "concluido" agora: aviso discreto de entrega (a carga inicial não conta). */
  private handleProjectDelivery(source: AttentionSource, project: Project): void {
    const key = `${source.id}|${project.id}`;
    const previous = this.projectStatus.get(key);
    this.projectStatus.set(key, project.status);
    if (previous === undefined || previous === "concluido" || project.status !== "concluido") return;
    this.raise({
      kind: "delivery",
      level: "info",
      workspace: this.workspaceOf(source),
      ref: `projeto:${project.id}`,
      scope: project.id,
      projectId: project.id,
      build: () => projectDeliveredText(project.title),
      target: targetOf("delivery", { workspaceId: source.id, ref: project.id }),
      expiresAt: this.deps.now().getTime() + DELIVERY_ALERT_MS,
    });
  }

  private handleTask(source: AttentionSource, task: Task): void {
    if (task.role === "request") {
      this.handleRequestDelivery(source, task);
      return;
    }
    const taskKey = `${source.id}|${task.id}`;
    const previous = this.taskStatus.get(taskKey);
    this.taskStatus.set(taskKey, task.status);
    const refKey = `failed:${source.id}:${task.id}`;
    if (task.status !== "failed") {
      if (previous === "failed") this.clearRef(refKey, "resolved");
      if (task.status === "done") this.failures.delete(taskKey);
      return;
    }
    if (task.outcome === "cancelled") {
      this.clearRef(refKey, "resolved");
      return;
    }
    if (previous === "failed") return;
    const count = (this.failures.get(taskKey) ?? 0) + 1;
    this.failures.set(taskKey, count);
    const data = source.read();
    const agentName = task.agentId ? data.agents.find((agent) => agent.id === task.agentId)?.name : undefined;
    const projectId = task.work?.projectId ?? task.projectId;
    const project = projectId ? data.projects.find((candidate) => candidate.id === projectId) : undefined;
    this.raise({
      kind: "failed",
      level: count >= 2 ? "alert" : "warn",
      workspace: this.workspaceOf(source),
      ref: task.id,
      scope: projectId ?? task.agentId ?? task.id,
      windowMs: ATTENTION_FAILED_COALESCE_MS,
      ...(task.agentId ? { agentId: task.agentId } : {}),
      ...(agentName ? { agentName } : {}),
      ...(projectId ? { projectId } : {}),
      taskId: task.id,
      build: (together) => failedText(agentName, task.prompt, together, project?.title),
      target: targetOf("failed", { workspaceId: source.id, ref: task.id }),
      skipIfSeen: true,
    });
  }

  /** O pedido do dono foi concluído (o fim do trabalho): aviso discreto com a manchete da entrega. */
  private handleRequestDelivery(source: AttentionSource, task: Task): void {
    const taskKey = `${source.id}|${task.id}`;
    const previous = this.taskStatus.get(taskKey);
    this.taskStatus.set(taskKey, task.status);
    if (previous === undefined || previous === "done" || task.status !== "done" || task.outcome === "cancelled") return;
    const headline = headlineAndSummary(task.result)?.headline;
    if (!headline) return;
    const agentName = task.agentId ? source.read().agents.find((agent) => agent.id === task.agentId)?.name : undefined;
    this.raise({
      kind: "delivery",
      level: "info",
      workspace: this.workspaceOf(source),
      ref: task.id,
      scope: task.id,
      ...(task.agentId ? { agentId: task.agentId } : {}),
      ...(agentName ? { agentName } : {}),
      taskId: task.id,
      build: () => deliveryText(agentName, headline),
      target: targetOf("delivery", { workspaceId: source.id, ref: task.id }),
      expiresAt: this.deps.now().getTime() + DELIVERY_ALERT_MS,
    });
  }

  // ---------- Pedido de ajuda ----------

  private handleProject(source: AttentionSource, project: Project, options: { seed?: boolean }): void {
    const data = source.read();
    const live = new Set<string>();
    for (const task of project.tasks) {
      // O `help[]` é só o histórico dos pedidos (nunca encolhe): o pedido está aberto enquanto a tarefa segue
      // "Esperando o Maestro" (o bloqueio sai com a resposta, o tempo ou o fim da tarefa: `helpReleased`).
      const last = task.help?.at(-1);
      for (const help of last && task.blocked && task.note?.startsWith("Esperando o Maestro") ? [last] : []) {
        const ref = `${project.id}/${task.ref}/${help.at}`;
        const refKey = `help:${source.id}:${ref}`;
        live.add(refKey);
        const known = this.pendingHelp.get(refKey);
        if (known) {
          known.projectTitle = project.title;
          continue;
        }
        const agentName = data.agents.find((agent) => agent.id === help.agentId)?.name;
        this.pendingHelp.set(refKey, { workspace: this.workspaceOf(source), project: project.id, taskRef: task.ref, help, ...(agentName ? { agentName } : {}), projectTitle: project.title, raised: false });
      }
    }
    for (const [refKey, pending] of [...this.pendingHelp]) {
      if (pending.workspace.id !== source.id || pending.project !== project.id || live.has(refKey)) continue;
      this.pendingHelp.delete(refKey);
      this.clearRef(refKey, "resolved");
    }
    this.escalateHelp(options.seed === true);
    this.handleBlocked(source, project);
  }

  /**
   * Subtarefa travada (a que ela espera foi cancelada ou falhou): um alerta que espera o dono, por tarefa, até ela ser destravada (refazer a outra,
   * tirar a dependência ou cancelar). Ao destravar, o alerta sai sozinho.
   */
  private handleBlocked(source: AttentionSource, project: Project): void {
    const prefix = `blocked:${source.id}:${project.id}/`;
    const live = new Set<string>();
    if (project.status === "ativo" || project.status === "pausado" || project.status === "proposto") {
      for (const leaf of blockedLeaves(project)) {
        const dead = deadDependencies(project, leaf);
        const first = dead[0];
        if (!first) continue;
        const ref = `${project.id}/${leaf.ref}`;
        live.add(`blocked:${source.id}:${ref}`);
        this.raise({
          kind: "blocked",
          level: "alert",
          workspace: this.workspaceOf(source),
          ref,
          scope: project.id,
          projectId: project.id,
          build: () => blockedAlertText(leaf.title, project.title, first.title, first.status, dead.length - 1),
          target: targetOf("blocked", { workspaceId: source.id, ref: project.id }),
        });
      }
    }
    for (const refKey of [...this.refIndex.keys()]) if (refKey.startsWith(prefix) && !live.has(refKey)) this.clearRef(refKey, "resolved");
  }

  /** Pedido de acesso chama já; o resto só se o Maestro não resolveu em 5 minutos. */
  private escalateHelp(seed: boolean): void {
    const nowMs = this.deps.now().getTime();
    for (const [refKey, pending] of this.pendingHelp) {
      if (pending.raised) continue;
      const since = Date.parse(pending.help.at);
      const age = Number.isFinite(since) ? nowMs - since : 0;
      if (pending.help.kind !== "access" && age < HELP_ESCALATE_MS) continue;
      pending.raised = true;
      const ref = refKey.slice(`help:${pending.workspace.id}:`.length);
      this.raise({
        kind: "help",
        level: "alert",
        workspace: pending.workspace,
        ref,
        scope: pending.help.agentId,
        windowMs: ATTENTION_COALESCE_MS,
        agentId: pending.help.agentId,
        ...(pending.agentName ? { agentName: pending.agentName } : {}),
        projectId: pending.project,
        build: () => helpText(pending.agentName, pending.help.what, pending.help.kind),
        target: targetOf("help", { workspaceId: pending.workspace.id, ref: pending.project }),
        // Um pedido de acesso que já estava aberto no boot não toca de novo.
        ...(seed ? { replay: true, at: pending.help.at } : {}),
      });
    }
  }

  private clearProject(workspaceId: string, projectId: string): void {
    for (const [refKey, pending] of [...this.pendingHelp]) {
      if (pending.workspace.id !== workspaceId || pending.project !== projectId) continue;
      this.pendingHelp.delete(refKey);
      this.clearRef(refKey, "resolved");
    }
  }

  // ---------- Terminal que caiu ----------

  private handleTerminal(source: AttentionSource, terminal: AgentTerminalInfo): void {
    const id = `${source.id}|${terminal.agentId}`;
    const refKey = `engine_down:${source.id}:${terminal.agentId}`;
    if (terminal.status !== "error") {
      const timer = this.engineTimers.get(id);
      if (timer) clearTimeout(timer);
      this.engineTimers.delete(id);
      this.clearRef(refKey, "resolved");
      return;
    }
    if (this.engineTimers.has(id) || this.refIndex.has(refKey)) return;
    // Cada queda põe o terminal em erro por um instante enquanto tenta de novo: só conta quem fica assim.
    const timer = setTimeout(() => {
      this.engineTimers.delete(id);
      // Workspace apagado ou fechado nos 45 s de espera: nada de alerta órfão.
      if (this.closed || !this.watching.has(source.id)) return;
      const now = source.read().terminals.find((candidate) => candidate.agentId === terminal.agentId);
      if (now?.status !== "error") return;
      const data = source.read();
      const agent = data.agents.find((candidate) => candidate.id === terminal.agentId);
      this.raise({
        kind: "engine_down",
        level: "alert",
        workspace: this.workspaceOf(source),
        ref: terminal.agentId,
        scope: terminal.agentId,
        agentId: terminal.agentId,
        ...(agent?.name ? { agentName: agent.name } : {}),
        build: () => engineDownText(agent?.name, now.engine),
        target: targetOf("engine_down", { workspaceId: source.id, ref: terminal.agentId }),
      });
    }, ENGINE_DOWN_SETTLE_MS);
    timer.unref();
    this.engineTimers.set(id, timer);
  }

  private clearAgent(workspaceId: string, agentId: string): void {
    const id = `${workspaceId}|${agentId}`;
    const timer = this.engineTimers.get(id);
    if (timer) clearTimeout(timer);
    this.engineTimers.delete(id);
    this.clearRef(`engine_down:${workspaceId}:${agentId}`, "resolved");
  }

  // ---------- Limite de uso ----------

  private evaluateUsage(usage: SubscriptionUsage, seed: boolean): void {
    for (const window of usage.windows) {
      const id = `${usage.provider}:${window.id}${window.group ? `:${window.group}` : ""}`;
      const current = this.usageLevels.get(id) ?? 0;
      let held = current;
      // O uso caiu mais que a folga abaixo do nível: o alerta daquele nível sai (a renovação da janela cai aqui).
      while (held > 0 && !usageLevelStillHolds(held as UsageLevel, window, USAGE_HYSTERESIS)) held -= 1;
      for (let level = held + 1; level <= current; level += 1) this.clearRef(this.usageRef(id, level as UsageLevel), "resolved");
      const reached = usageLevelOf(window);
      if (reached > held) {
        if (held > 0) this.clearRef(this.usageRef(id, held as UsageLevel), "resolved");
        const { level, needsOwner } = usageAlertLevel(reached);
        const expiresAt = window.resetsAt ? Date.parse(window.resetsAt) : undefined;
        this.raise({
          kind: "usage",
          level,
          ref: id.replaceAll(":", "-") + `:${USAGE_LEVEL_NAME[reached]}`,
          scope: id,
          build: () => usageText(usage, window, reached, (iso) => this.resetClock(iso)),
          target: targetOf("usage", {}),
          ...(seed ? { replay: true } : {}),
          ...(expiresAt !== undefined && Number.isFinite(expiresAt) ? { expiresAt } : {}),
          needsOwnerOverride: needsOwner,
        });
        held = reached;
      }
      this.usageLevels.set(id, held);
    }
  }

  private usageRef(id: string, level: UsageLevel): string {
    return `usage:plataforma:${id.replaceAll(":", "-")}:${USAGE_LEVEL_NAME[level]}`;
  }

  /** "às 15h" (hoje), "amanhã às 15h" ou "12/11 às 15h", no horário de São Paulo. */
  private resetClock(iso: string): string {
    const when = new Date(iso);
    const zone = "America/Sao_Paulo";
    const parts = (date: Date) => new Intl.DateTimeFormat("pt-BR", { timeZone: zone, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(date);
    const pick = (list: Intl.DateTimeFormatPart[], type: string) => list.find((part) => part.type === type)?.value ?? "";
    const a = parts(when);
    const n = parts(this.deps.now());
    const clock = `${Number(pick(a, "hour"))}h${pick(a, "minute") === "00" ? "" : pick(a, "minute")}`;
    const sameDay = pick(a, "day") === pick(n, "day") && pick(a, "month") === pick(n, "month");
    if (sameDay) return `às ${clock}`;
    const tomorrow = parts(new Date(this.deps.now().getTime() + 86_400_000));
    if (pick(a, "day") === pick(tomorrow, "day") && pick(a, "month") === pick(tomorrow, "month")) return `amanhã às ${clock}`;
    return `${pick(a, "day")}/${pick(a, "month")} às ${clock}`;
  }

  // ---------- Relógio ----------

  private onTick(): void {
    if (this.closed) return;
    this.escalateHelp(false);
    const nowMs = this.deps.now().getTime();
    for (const entry of [...this.open.values()]) if (entry.expiresAt !== undefined && entry.expiresAt <= nowMs) this.dropEntry(entry, "expired");
    for (const [refKey, at] of this.lastRaised) if (nowMs - at > ATTENTION_DEDUPE_MS) this.lastRaised.delete(refKey);
  }

  // ---------- O núcleo: nascer, juntar, limpar ----------

  private raise(input: RaiseInput): void {
    const nowMs = this.deps.now().getTime();
    const nowIso = new Date(nowMs).toISOString();
    const workspaceKey = input.workspace?.id ?? "plataforma";
    const refKey = `${input.kind}:${workspaceKey}:${input.ref}`;

    const existingKey = this.refIndex.get(refKey);
    if (existingKey) {
      // Já está aberto: só atualiza o texto (item editado) e o nível (falhou de novo).
      const entry = this.open.get(existingKey);
      if (!entry) return;
      entry.build = input.build;
      this.refresh(entry, input.level, nowIso);
      return;
    }

    if (input.skipIfSeen) {
      const seenAt = Date.parse(this.seen.get(refKey) ?? "");
      // Com `expiresAt` (orçamento), o "Visto" vale até o fim do período; senão, por 24 h.
      if (Number.isFinite(seenAt) && nowMs < (input.expiresAt !== undefined ? Math.max(input.expiresAt, seenAt + SEEN_MEMORY_MS) : seenAt + SEEN_MEMORY_MS)) return;
    }

    // Reaberto dentro da janela de 10 min: volta para a lista, mas quieto (o dono mesmo o reabriu, ou é eco).
    const raisedBefore = this.lastRaised.get(refKey);
    const repeated = raisedBefore !== undefined && nowMs - raisedBefore < ATTENTION_DEDUPE_MS;
    const quiet = input.replay === true || repeated;
    this.lastRaised.set(refKey, nowMs);

    // Rajada: o mesmo lote, ou o mesmo tipo/workspace/agente em poucos segundos, vira um alerta só.
    const windowMs = input.windowMs ?? 0;
    const together = [...this.open.values()].find((entry) => {
      const alert = entry.alert;
      if (alert.kind !== input.kind || alert.workspaceId !== input.workspace?.id || entry.scope !== input.scope || alert.level !== input.level) return false;
      if (!quiet && alert.replay) return false;
      if (input.groupId && entry.groupId === input.groupId) return true;
      return input.replay !== true && windowMs > 0 && nowMs - Date.parse(alert.at) <= windowMs;
    });
    if (together) {
      together.refs.add(refKey);
      this.refIndex.set(refKey, together.alert.key);
      together.build = input.build;
      this.refresh(together, input.level, nowIso);
      return;
    }

    const needsOwner = input.needsOwnerOverride ?? needsOwnerOf(input.kind, input.level);
    this.seq += 1;
    const alert: AttentionAlert = {
      id: `al-${nowMs}-${this.seq}`,
      key: refKey,
      kind: input.kind,
      level: input.level,
      needsOwner,
      ...(input.workspace ? { workspaceId: input.workspace.id, workspaceName: input.workspace.name } : {}),
      ...(input.agentId ? { agentId: input.agentId } : {}),
      ...(input.agentName ? { agentName: input.agentName } : {}),
      ...(input.projectId ? { projectId: input.projectId } : {}),
      ...(input.sprintId ? { sprintId: input.sprintId } : {}),
      ...(input.taskId ? { taskId: input.taskId } : {}),
      ...(input.forYouId ? { forYouId: input.forYouId } : {}),
      ...(input.groupId ? { groupId: input.groupId } : {}),
      text: cutText(input.build(1)),
      count: 1,
      at: input.at ?? nowIso,
      updatedAt: nowIso,
      target: input.target ?? targetOf(input.kind, { ...(input.workspace ? { workspaceId: input.workspace.id } : {}), ref: input.ref }),
      ...(quiet ? { replay: true } : {}),
    };
    const entry: Entry = { alert, refs: new Set([refKey]), scope: input.scope, build: input.build, ...(input.groupId ? { groupId: input.groupId } : {}), ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}) };
    this.open.set(refKey, entry);
    this.refIndex.set(refKey, refKey);
    this.emit({ type: "attention:raised", alert });
    if (input.kind === "failed") this.persist();
  }

  /** Recalcula contagem, texto e nível de um alerta aberto; só avisa (`updated`) se algo mudou. */
  private refresh(entry: Entry, level: AttentionLevel, nowIso: string): void {
    const alert = entry.alert;
    const count = entry.refs.size;
    const text = cutText(entry.build(count));
    const nextLevel = level === "alert" || alert.level === "alert" ? "alert" : alert.level;
    if (alert.count === count && alert.text === text && alert.level === nextLevel) return;
    alert.count = count;
    alert.text = text;
    alert.level = nextLevel;
    alert.updatedAt = nowIso;
    this.emit({ type: "attention:updated", alert: { ...alert } });
    if (alert.kind === "failed") this.persist();
  }

  /** A causa saiu: tira dela do alerta; sem mais nenhuma, o alerta some. */
  private clearRef(refKey: string, reason: AttentionClearReason): void {
    const key = this.refIndex.get(refKey);
    if (!key) return;
    this.refIndex.delete(refKey);
    const entry = this.open.get(key);
    if (!entry) return;
    entry.refs.delete(refKey);
    if (entry.refs.size === 0) {
      this.open.delete(key);
      this.emit({ type: "attention:cleared", key, reason });
      if (entry.alert.kind === "failed") this.persist();
      return;
    }
    this.refresh(entry, entry.alert.level, this.deps.now().toISOString());
  }

  private dropEntry(entry: Entry, reason: AttentionClearReason): void {
    for (const ref of entry.refs) this.refIndex.delete(ref);
    this.open.delete(entry.alert.key);
    this.emit({ type: "attention:cleared", key: entry.alert.key, reason });
    if (entry.alert.kind === "failed") this.persist();
  }

  private clearWorkspace(workspaceId: string): void {
    for (const entry of [...this.open.values()]) if (entry.alert.workspaceId === workspaceId) this.dropEntry(entry, "resolved");
    for (const [refKey, pending] of [...this.pendingHelp]) if (pending.workspace.id === workspaceId) this.pendingHelp.delete(refKey);
    // Os temporizadores de "terminal caído" do workspace (45 s de espera) também morrem com ele.
    for (const [id, timer] of [...this.engineTimers]) {
      if (!id.startsWith(`${workspaceId}|`)) continue;
      clearTimeout(timer);
      this.engineTimers.delete(id);
    }
    for (const key of [...this.taskStatus.keys()]) if (key.startsWith(`${workspaceId}|`)) this.taskStatus.delete(key);
    for (const key of [...this.projectStatus.keys()]) if (key.startsWith(`${workspaceId}|`)) this.projectStatus.delete(key);
  }

  private emit(event: AttentionServerEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  // ---------- Disco ----------

  private persist(): void {
    if (this.closed) return;
    const cutoff = this.deps.now().getTime() - SEEN_MEMORY_MS;
    const seen = [...this.seen].filter(([, at]) => Date.parse(at) >= cutoff).sort((a, b) => b[1].localeCompare(a[1])).slice(0, SEEN_CAP);
    const snapshot = {
      version: 1,
      prefs: this.prefsState,
      open: [...this.open.values()].map((entry) => entry.alert).filter((alert) => alert.kind === "failed"),
      seen: Object.fromEntries(seen),
    };
    void this.queue.enqueue(() => writeJsonAtomic(this.deps.file, snapshot)).catch((error: unknown) => this.deps.log.error({ err: error }, "não foi possível gravar os alertas"));
  }
}
