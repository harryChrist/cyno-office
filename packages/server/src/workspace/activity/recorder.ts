import {
  ACTIVITY_MAESTRO,
  ACTIVITY_SYSTEM,
  ACTIVITY_USER,
  handoffLabel,
  headlineAndSummary,
  maskSecrets,
  isPlanProject,
  parseAddress,
  MAX_REWORK,
  MEDIA_KIND_LABELS,
  PROJECT_PRIORITY_LABELS,
  WORK_TIME_ZONE,
  type Agent,
  forYouOriginalText,
  type ForYouItem,
  type MediaItem,
  type Plan,
  type Routine,
  type RoutineEntry,
  type RoutineRun,
  type ServerEvent,
  type Task,
  summarizeChanges,
} from "@cyno/shared";
import { taskTitleOf } from "../../engines/usage/usage-history";
import { activeActivity, type ActivityInput } from "./log";

/**
 * O que foi feito no escritório, observado no barramento de eventos do workspace (tarefas, "Para
 * você", rotinas, mídia, planos, agentes): cada mudança de estado que uma pessoa entenderia vira UMA
 * entrada em pt-BR na Atividade. Só olha mudanças de estado (nunca o ruído de progresso), não escreve
 * no estado e nunca lança. Sem Atividade ligada (testes), nem observa.
 */

type Hub = { subscribe(listener: (event: ServerEvent) => void): () => void };

export type ActivitySnapshot = {
  tasks: readonly Task[];
  forYou: readonly ForYouItem[];
  agents: readonly Agent[];
  media: readonly MediaItem[];
  plans: readonly Plan[];
  routines: readonly Routine[];
  entries: readonly RoutineEntry[];
};

export type ActivityRecorderDeps = {
  workspaceId: string;
  hub: Hub;
  /** Retrato do estado atual (lido na hora de começar e em cada decisão que precisa de contexto). */
  snapshot: () => ActivitySnapshot;
  /** Custo e tokens de uma tarefa concluída (do histórico de gastos); falha ou ausência = sem custo. */
  cost?: (task: Task) => Promise<{ costUsd?: number; tokens?: number } | undefined>;
  now?: () => number;
};

export const quote = (text: string) => `“${text}”`;
export const shorten = (text: string, max = 90) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
export const titleOf = (task: Pick<Task, "prompt">) => shorten(taskTitleOf(task));

/** Frase curta da duração ("3 min", "1 h 05 min", "42 s"). */
export function durationLabel(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")} min`;
}

/** Para de observar; `drain` espera as entradas que ainda aguardam o custo (desligamento). */
export type ActivityObserver = (() => void) & { drain: () => Promise<void> };

export function observeWorkspaceActivity(deps: ActivityRecorderDeps): ActivityObserver {
  const pending = new Set<Promise<void>>();
  const drain = () => Promise.allSettled([...pending]).then(() => undefined);
  const noop: ActivityObserver = Object.assign(() => undefined, { drain });
  if (!activeActivity()) return noop;
  const { workspaceId } = deps;
  const now = deps.now ?? Date.now;
  const initial = deps.snapshot();

  const emit = (input: Omit<ActivityInput, "workspaceId">) => {
    try {
      activeActivity()?.record({ ...input, workspaceId });
    } catch {
      // nunca lança
    }
  };

  // Nomes (o agente pode sair depois: guarda o último nome visto).
  const names = new Map<string, string>();
  for (const agent of initial.agents) names.set(agent.id, agent.name);
  const nameOf = (agentId: string | undefined) => (agentId ? (deps.snapshot().agents.find((agent) => agent.id === agentId)?.name ?? names.get(agentId) ?? agentId) : "Um agente");

  // ---------- Tarefas ----------
  const tasks = new Map<string, { status: Task["status"]; startedAt?: number }>();
  for (const task of initial.tasks) tasks.set(task.id, { status: task.status, ...(task.status === "in_progress" ? { startedAt: Date.parse(task.updatedAt) } : {}) });
  // Tarefas vistas (retrato inicial + eventos): para achar o pedido de origem de uma subtarefa.
  const known = new Map<string, Task>(initial.tasks.map((task) => [task.id, task]));
  const rootOf = (task: Task): string => {
    let current = task;
    for (let i = 0; i < 20 && current.projectId; i += 1) {
      const parent = known.get(current.projectId);
      if (!parent) break;
      current = parent;
    }
    return current.id;
  };
  const taskRefs = (task: Task) => ({ taskId: task.id, ...(task.projectId ? { rootTaskId: rootOf(task) } : {}), ...(task.routineId ? { routineId: task.routineId } : {}), ...(task.work ? { planId: task.work.projectId } : {}) });

  const onTask = (task: Task) => {
    known.set(task.id, task);
    const previous = tasks.get(task.id);
    if (previous?.status === task.status) return;
    const at = now();
    const entry: { status: Task["status"]; startedAt?: number } = { status: task.status, ...(previous?.startedAt !== undefined ? { startedAt: previous.startedAt } : {}) };
    tasks.set(task.id, entry);
    const title = titleOf(task);
    const refs = taskRefs(task);
    if (!previous) {
      const routine = task.routineId ? deps.snapshot().routines.find((item) => item.id === task.routineId) : undefined;
      if (task.routineId) emit({ at, category: "tarefa", action: "criada", actor: ACTIVITY_SYSTEM, summary: `A rotina ${quote(routine?.title ?? task.routineId)} criou a tarefa ${quote(title)}`, refs, data: { title } });
      else if (task.projectId) emit({ at, category: "tarefa", action: "criada", actor: ACTIVITY_MAESTRO, summary: `O Maestro delegou ${quote(title)}${task.agentId ? ` para ${nameOf(task.agentId)}` : ""}`, refs, data: { title, ...(task.agentId ? { agentId: task.agentId } : {}) } });
      else emit({ at, category: "tarefa", action: "criada", actor: ACTIVITY_USER, summary: `Você pediu ${quote(title)}`, refs, data: { title } });
      if (task.status !== "in_progress") return;
    }
    const agent = task.agentId ?? ACTIVITY_SYSTEM;
    const who = nameOf(task.agentId);
    switch (task.status) {
      case "in_progress": {
        const fromApproval = previous?.status === "waiting_approval";
        if (!fromApproval) entry.startedAt = at;
        const ran = task.ranWith ? { engine: task.ranWith.engine, model: task.ranWith.model } : {};
        emit({
          at,
          category: "tarefa",
          action: fromApproval ? "retomada" : "iniciada",
          actor: agent,
          summary: fromApproval ? `${who} retomou ${quote(title)} depois da resposta` : `${who} começou ${quote(title)}`,
          refs,
          data: { title, ...ran },
        });
        return;
      }
      case "done":
      case "failed": {
        const since = entry.startedAt ?? Date.parse(task.createdAt);
        entry.startedAt = undefined;
        const durationMs = Number.isFinite(since) ? Math.max(0, at - since) : undefined;
        const cancelled = task.status === "failed" && (task.outcome === "cancelled" || /^cancelad/i.test(task.result ?? ""));
        if (task.status === "done") {
          const rawDelivery = task.role === "request" ? undefined : headlineAndSummary(task.result);
          // Vai para o disco: a manchete e o resumo do texto do agente saem mascarados.
          const delivery = rawDelivery ? { headline: maskSecrets(rawDelivery.headline), ...(rawDelivery.summary ? { summary: maskSecrets(rawDelivery.summary) } : {}) } : undefined;
          const finish = (cost: { costUsd?: number; tokens?: number } | undefined) =>
            emit({
              at,
              category: "tarefa",
              action: "concluida",
              actor: agent,
              summary: `${who} concluiu ${quote(title)}${durationMs !== undefined ? ` em ${durationLabel(durationMs)}` : ""}`,
              refs,
              data: { title, ...(delivery ? { headline: delivery.headline, ...(delivery.summary ? { summary: delivery.summary } : {}) } : {}), ...(durationMs !== undefined ? { durationMs } : {}), ...(cost?.costUsd !== undefined ? { costUsd: Math.round(cost.costUsd * 10_000) / 10_000 } : {}), ...(cost?.tokens !== undefined ? { tokens: cost.tokens } : {}) },
            });
          if (!deps.cost) finish(undefined);
          else {
            const waiting: Promise<void> = deps.cost(task).then(finish, () => finish(undefined)).finally(() => pending.delete(waiting));
            pending.add(waiting);
          }
          return;
        }
        if (cancelled) emit({ at, category: "tarefa", action: "cancelada", actor: ACTIVITY_USER, summary: `A tarefa ${quote(title)} foi cancelada`, refs, data: { title, reason: task.result } });
        else emit({ at, category: "tarefa", action: "falhou", actor: agent, summary: `${who} não conseguiu concluir ${quote(title)}`, refs, data: { title, ...(durationMs !== undefined ? { durationMs } : {}), ...(task.result ? { error: task.result } : {}) } });
        return;
      }
      default:
        return; // fila e espera de aprovação: a aprovação já tem a sua entrada
    }
  };

  // ---------- Aprovações ("Para você") ----------
  const items = new Map<string, ForYouItem["status"]>();
  for (const item of initial.forYou) items.set(item.id, item.status);
  const itemLabel = (item: ForYouItem) => shorten(item.title ?? (item.where ? `${item.where}${item.to ? ` para ${item.to}` : ""}` : item.to ? `para ${item.to}` : item.type), 80);
  const onItem = (item: ForYouItem) => {
    const previous = items.get(item.id);
    items.set(item.id, item.status);
    if (previous === item.status) return;
    // Decidido sozinho pelo Modo Automático: a linha ("… (Automático · 3 de 8 hoje)") é do runtime.
    if (item.decidedBy === "automatico") return;
    const refs = { forYouId: item.id, ...(item.taskId ? { taskId: item.taskId } : {}), ...((item.kind === "plano" || item.kind === "sprint") && item.projectId ? { planId: item.projectId } : {}), ...(item.routineId ? { routineId: item.routineId } : {}) };
    const label = itemLabel(item);
    const kind = item.kind ?? "aprovacao";
    const at = now();
    if (previous === undefined && item.status === "pendente") {
      const what = kind === "questionario" ? "respostas" : kind === "plano" ? "a aprovação de um plano" : kind === "rotina" ? "a aprovação de uma rotina" : kind === "sprint" ? "o OK na entrega de uma sprint" : kind === "regra" ? "o OK numa regra da retrospectiva" : kind === "organizacao" ? "o OK numa organização do Cérebro" : "a sua aprovação";
      emit({ at, category: "aprovacao", action: "pedida", actor: item.agentId, summary: `${nameOf(item.agentId)} pediu ${what}: ${label}`, refs, data: { type: item.type, kind, where: item.where } });
      return;
    }
    if (item.status === "pendente") return; // reaberto
    const created = Date.parse(item.createdAt);
    const decided = item.decidedAt ? Date.parse(item.decidedAt) : at;
    const durationMs = Number.isFinite(created) && Number.isFinite(decided) ? Math.max(0, decided - created) : undefined;
    const base = { type: item.type, kind, ...(durationMs !== undefined ? { durationMs } : {}) };
    if (item.status === "cancelado") {
      const by = item.cancelledBy === "maestro" ? ACTIVITY_MAESTRO : item.cancelledBy === "agente" ? item.agentId : ACTIVITY_USER;
      const byName = by === ACTIVITY_MAESTRO ? "O Maestro" : by === ACTIVITY_USER ? "Você" : nameOf(by);
      emit({ at, category: "aprovacao", action: "cancelada", actor: by, summary: `${byName} cancelou o pedido: ${label}`, refs, data: { ...base, ...(item.cancelReason ? { reason: item.cancelReason } : {}) } });
      return;
    }
    const edited = item.editedByUser && item.text !== forYouOriginalText(item);
    const verb = item.status === "aprovado" ? "aprovou" : item.status === "rejeitado" ? "rejeitou" : "respondeu";
    const action = item.status === "aprovado" ? "aprovada" : item.status === "rejeitado" ? "rejeitada" : "respondida";
    const why = item.status === "rejeitado" && item.rejection?.reason ? ` — motivo: ${quote(shorten(item.rejection.reason, 140))}` : "";
    emit({
      at,
      category: "aprovacao",
      action,
      actor: ACTIVITY_USER,
      summary: `Você ${verb}: ${label}${edited && item.status === "aprovado" ? " (com a sua edição)" : ""}${why}`,
      refs,
      data: { ...base, status: item.status, edited, ...(item.rejection?.reason ? { reason: item.rejection.reason } : {}), ...(item.rejection?.category ? { category: item.rejection.category } : {}), ...(item.groupId ? { groupId: item.groupId } : {}), ...(item.viaBatch ? { batch: true } : {}) },
    });
  };

  // ---------- Rotinas ----------
  /** O que o dono ajusta numa rotina (meta, horários, itens acompanhados): mudou = uma linha "ajustada" na Atividade. */
  const shapeOf = (routine: Routine) => JSON.stringify({ title: routine.title, target: routine.target, period: routine.period, site: routine.site, dailyCap: routine.dailyCap, instruction: routine.instruction, needsApproval: routine.needsApproval, schedules: routine.schedules });
  const trackingOf = (routine: Routine) => JSON.stringify(routine.tracking ?? null);
  const routines = new Map<string, { status: Routine["status"]; lastDispatchAt?: string; title: string; shape: string; tracking: string }>();
  for (const routine of initial.routines) routines.set(routine.id, { status: routine.status, title: routine.title, shape: shapeOf(routine), tracking: trackingOf(routine), ...(routine.lastDispatchAt ? { lastDispatchAt: routine.lastDispatchAt } : {}) });
  const runs = new Map<string, RoutineRun["outcome"]>();
  for (const routine of initial.routines) for (const run of routine.lastRuns) runs.set(run.id, run.outcome);
  const entries = new Map<string, RoutineEntry["stage"]>();
  for (const entry of initial.entries) entries.set(entry.id, entry.stage);
  /** Quem recebeu a tarefa: o agente dela (horário com agente próprio) ou, sem ela, o dono da rotina. */
  const dispatchedTo = (routine: Routine) => {
    const agentId = deps.snapshot().tasks.find((task) => task.id === routine.lastTaskId)?.agentId ?? routine.agentId;
    return agentId ? nameOf(agentId) : "o time";
  };
  const onRoutine = (routine: Routine) => {
    const previous = routines.get(routine.id);
    routines.set(routine.id, { status: routine.status, title: routine.title, shape: shapeOf(routine), tracking: trackingOf(routine), ...(routine.lastDispatchAt ? { lastDispatchAt: routine.lastDispatchAt } : {}) });
    const refs = { routineId: routine.id };
    const at = now();
    const title = quote(routine.title);
    if (!previous) {
      if (routine.status === "ativa") emit({ at, category: "rotina", action: "criada", actor: routine.createdBy === "maestro" ? ACTIVITY_MAESTRO : ACTIVITY_USER, summary: routine.type === "meta" ? `Rotina ${title} criada: ${routine.target} ${routine.unit}(s) por semana em ${routine.site}` : `Rotina ${title} criada: acompanhamento com ${routine.schedules.length} horário(s)`, refs });
      return;
    }
    if (previous.status !== routine.status) {
      if (routine.status === "ativa" && previous.status === "proposta") emit({ at, category: "rotina", action: "criada", actor: ACTIVITY_USER, summary: routine.type === "meta" ? `Você aprovou a rotina ${title}: ${routine.target} ${routine.unit}(s) por ${routine.period === "month" ? "mês" : "semana"} em ${routine.site}` : `Você aprovou a rotina ${title}: acompanhamento com ${routine.schedules.length} horário(s)`, refs });
      else if (routine.status === "ativa") emit({ at, category: "rotina", action: "retomada", actor: ACTIVITY_USER, summary: `A rotina ${title} voltou a rodar`, refs });
      else if (routine.status === "pausada") emit({ at, category: "rotina", action: "pausada", actor: ACTIVITY_USER, summary: `A rotina ${title} foi pausada`, refs });
      else if (routine.status === "encerrada" && previous.status !== "proposta") emit({ at, category: "rotina", action: "encerrada", actor: ACTIVITY_USER, summary: `A rotina ${title} foi encerrada`, refs });
    }
    // Ajustes do dono (ou do Maestro, com o OK): meta, horários e a tabela dos itens acompanhados.
    if (previous.status === routine.status && routine.status !== "proposta") {
      const parts = [previous.shape !== shapeOf(routine) ? "meta ou horários" : "", previous.tracking !== trackingOf(routine) ? "o esquema dos itens acompanhados" : ""].filter(Boolean);
      if (parts.length > 0) emit({ at, category: "rotina", action: "ajustada", actor: ACTIVITY_USER, summary: `A rotina ${title} foi ajustada (${parts.join(" e ")})`, refs, data: { tracking: previous.tracking !== trackingOf(routine) } });
    }
    // Execuções dos horários: só os fins contam (a tarefa que nasce já aparece como "A rotina criou a tarefa").
    for (const run of routine.lastRuns) {
      const before = runs.get(run.id);
      runs.set(run.id, run.outcome);
      if (before === run.outcome || run.outcome === "rodando") continue;
      const schedule = routine.schedules.find((candidate) => candidate.id === run.scheduleId);
      const what = `${schedule ? `${schedule.label} ` : "horário "}${run.slotKey ? run.slotKey.slice(11) : ""}`.trim();
      const runRefs = { ...refs, ...(run.taskId ? { taskId: run.taskId } : {}), ...(run.projectId ? { planId: run.projectId } : {}) };
      if (run.outcome === "pulada") emit({ at, category: "rotina", action: "pulada", actor: ACTIVITY_SYSTEM, summary: `O horário ${what} de ${title} foi pulado: ${run.skipReason ?? "sem motivo"}`, refs: runRefs, data: { scheduleId: run.scheduleId ?? "", slotKey: run.slotKey ?? "" } });
      else if (run.outcome === "ok" && run.changes.length > 0) emit({ at, category: "rotina", action: "mudou", actor: ACTIVITY_SYSTEM, summary: `${routine.title}: ${summarizeChanges(run.changes)}`, refs: runRefs, data: { scheduleId: run.scheduleId ?? "", slotKey: run.slotKey ?? "", changes: run.changes.length, alert: run.changes.some((change) => change.alert) } });
      else if (run.outcome === "ok") emit({ at, category: "rotina", action: "executada", actor: ACTIVITY_SYSTEM, summary: `O horário ${what} de ${title} rodou${run.summary ? `: ${shorten(run.summary, 120)}` : ""}`, refs: runRefs, data: { scheduleId: run.scheduleId ?? "", slotKey: run.slotKey ?? "" } });
      else emit({ at, category: "rotina", action: "falhou", actor: ACTIVITY_SYSTEM, summary: `O horário ${what} de ${title} falhou${run.summary ? `: ${shorten(run.summary, 120)}` : ""}`, refs: runRefs, data: { scheduleId: run.scheduleId ?? "", slotKey: run.slotKey ?? "" } });
      // Status de alerta (ex.: Entrevista): um aviso em destaque por mudança, além da linha da execução.
      for (const change of run.changes) if (change.alert) emit({ at, category: "rotina", action: "alerta", actor: ACTIVITY_SYSTEM, summary: `Atenção em ${routine.title}: ${change.text}`, refs: runRefs, data: { itemId: change.itemId, alert: true } });
    }
    if (routine.lastDispatchAt && routine.lastDispatchAt !== previous.lastDispatchAt) {
      emit({ at, category: "rotina", action: "disparou", actor: ACTIVITY_SYSTEM, summary: `A rotina ${title} abriu uma tarefa para ${dispatchedTo(routine)}`, refs: { ...refs, ...(routine.lastTaskId ? { taskId: routine.lastTaskId } : {}) } });
    }
  };
  const onRoutineEntry = (entry: RoutineEntry) => {
    const previous = entries.get(entry.id);
    entries.set(entry.id, entry.stage);
    if (previous === entry.stage) return;
    const routine = deps.snapshot().routines.find((item) => item.id === entry.routineId);
    const unit = routine?.unit ?? "item";
    const refs = { routineId: entry.routineId, taskId: entry.taskId, ...(entry.url ? { url: entry.url } : {}) };
    const at = now();
    if (previous === undefined && entry.stage === "registrado") emit({ at, category: "rotina", action: "registrado", actor: entry.agentId, summary: `${nameOf(entry.agentId)} registrou um(a) ${unit} de ${quote(routine?.title ?? entry.routineId)}`, refs, data: { periodKey: entry.periodKey } });
    else if (entry.stage === "entregue") emit({ at, category: "rotina", action: "entregue", actor: ACTIVITY_USER, summary: `${unit.charAt(0).toUpperCase()}${unit.slice(1)} entregue em ${quote(routine?.title ?? entry.routineId)}`, refs, data: { periodKey: entry.periodKey } });
    else if (entry.stage === "descartado") emit({ at, category: "rotina", action: "descartado", actor: ACTIVITY_USER, summary: `Um(a) ${unit} de ${quote(routine?.title ?? entry.routineId)} foi descartado(a)`, refs, data: { periodKey: entry.periodKey } });
  };

  // ---------- Mídia ----------
  const media = new Map<string, { status: MediaItem["status"]; title: string }>();
  for (const item of initial.media) media.set(item.id, { status: item.status, title: item.title });
  const mediaActor = (createdBy: string) => (createdBy === ACTIVITY_USER ? ACTIVITY_USER : createdBy);
  const onMedia = (item: MediaItem) => {
    const previous = media.get(item.id);
    media.set(item.id, { status: item.status, title: item.title });
    const refs = { mediaId: item.id, ...(item.taskId ? { taskId: item.taskId } : {}), ...(item.rootTaskId ? { rootTaskId: item.rootTaskId } : {}), ...(item.forYouIds?.[0] ? { forYouId: item.forYouIds[0] } : {}), ...(item.publishedUrl ? { url: item.publishedUrl } : {}) };
    const at = now();
    const title = quote(shorten(item.title, 70));
    const kind = MEDIA_KIND_LABELS[item.kind].toLowerCase();
    if (!previous) {
      const by = mediaActor(item.createdBy);
      const origin = item.origin === "upload" ? "enviou" : item.origin === "screenshot" ? "capturou" : "criou";
      emit({ at, category: "midia", action: "criada", actor: by, summary: `${by === ACTIVITY_USER ? "Você" : nameOf(by)} ${origin} ${item.origin === "screenshot" ? "uma captura" : `um(a) ${kind}`} ${title}`, refs, data: { kind: item.kind, origin: item.origin, size: item.size } });
      return;
    }
    if (previous.status === item.status) return;
    if (item.status === "aprovado") emit({ at, category: "midia", action: "aprovada", actor: ACTIVITY_USER, summary: `Você aprovou a mídia ${title}`, refs });
    else if (item.status === "publicado") emit({ at, category: "midia", action: "publicada", actor: ACTIVITY_USER, summary: `A mídia ${title} foi publicada${item.where ? ` em ${item.where}` : ""}`, refs });
    else if (item.status === "descartado") emit({ at, category: "midia", action: "descartada", actor: ACTIVITY_USER, summary: `Você descartou a mídia ${title}`, refs });
  };

  // ---------- Planos ----------
  const plans = new Map<string, Plan["status"]>();
  for (const plan of initial.plans) if (isPlanProject(plan)) plans.set(plan.id, plan.status);
  // Retrabalho: a recusa com motivo voltou para o mesmo agente (`rework.count` da tarefa do projeto subiu).
  const reworks = new Map<string, number>();
  for (const project of initial.plans) for (const task of project.tasks) reworks.set(`${project.id}/${task.ref}`, task.rework?.count ?? 0);
  const onRework = (project: Plan) => {
    for (const task of project.tasks) {
      const key = `${project.id}/${task.ref}`;
      const count = task.rework?.count ?? 0;
      const before = reworks.get(key);
      reworks.set(key, count);
      if (before === undefined || count <= before) continue;
      const step = task.steps[task.current];
      const agentId = step?.agentId ?? task.ownerId;
      emit({
        at: now(),
        category: "aprovacao",
        action: "retrabalho",
        actor: ACTIVITY_SYSTEM,
        summary: `${quote(shorten(task.title, 70))} voltou para ${nameOf(agentId)} refazer (retrabalho ${count} de ${MAX_REWORK})${task.rework.last?.reason ? ` — motivo: ${quote(shorten(task.rework.last.reason, 140))}` : ""}`,
        refs: { planId: project.id, taskId: step?.taskId ?? project.id, ...(task.rework.last?.itemId ? { forYouId: task.rework.last.itemId } : {}) },
        data: { count, ref: task.ref, agentId, ...(task.rework.last?.reason ? { reason: task.rework.last.reason } : {}) },
      });
    }
  };
  // Repasses entre agentes (send_to_colleague e a resposta de um ask): uma entrada por tarefa de repasse nova.
  const handoffs = new Set<string>();
  for (const project of initial.plans) for (const task of project.tasks) if (task.origin) handoffs.add(`${project.id}/${task.ref}`);
  const onHandoff = (project: Plan) => {
    for (const task of project.tasks) {
      const key = `${project.id}/${task.ref}`;
      if (!task.origin || handoffs.has(key)) continue;
      handoffs.add(key);
      const fromId = parseAddress(task.origin.fromAddress)?.agentId ?? task.origin.fromAddress;
      emit({
        at: task.origin.at ?? now(),
        category: "plano",
        action: "repasse",
        actor: fromId,
        summary: `${handoffLabel(task.origin, nameOf(fromId), nameOf(task.ownerId))} (${quote(shorten(project.title, 60))}, tarefa ${task.ref})`,
        refs: { planId: project.id, taskId: project.id },
        data: { ref: task.ref, fromRef: task.origin.fromRef, intent: task.origin.intent, hops: task.origin.hops, from: fromId, to: task.ownerId, ...(task.origin.reply ? { reply: true } : {}) },
      });
    }
  };
  // Prioridade, prazo, "começa em", ritmo e pausa mudados pelo usuário (ou pelo Maestro): uma entrada por mudança.
  type Edit = { priority: Plan["priority"]; dueAt?: string; startAt?: string; pace?: string; paused: boolean };
  const editOf = (project: Plan): Edit => ({ priority: project.priority, ...(project.dueAt ? { dueAt: project.dueAt } : {}), ...(project.startAt ? { startAt: project.startAt } : {}), ...(project.pace ? { pace: JSON.stringify(project.pace) } : {}), paused: project.status === "pausado" });
  const edits = new Map<string, Edit>(initial.plans.map((project) => [project.id, editOf(project)]));
  const dateLabel = (iso: string) => new Date(iso).toLocaleString("pt-BR", { timeZone: WORK_TIME_ZONE, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  const onEdit = (project: Plan) => {
    const current = editOf(project);
    const before = edits.get(project.id);
    edits.set(project.id, current);
    if (!before) return;
    const refs = { planId: project.id, taskId: project.id };
    const title = quote(shorten(project.title, 80));
    const at = now();
    const say = (action: string, summary: string, data: Record<string, unknown>) => emit({ at, category: "plano", action, actor: ACTIVITY_USER, summary, refs, data });
    if (current.priority !== before.priority) say("prioridade", `Você mudou a prioridade de ${title} para ${PROJECT_PRIORITY_LABELS[current.priority].toLowerCase()}`, { priority: current.priority });
    if (current.dueAt !== before.dueAt) say("prazo", current.dueAt ? `Você definiu o prazo de ${title} para ${dateLabel(current.dueAt)}` : `Você tirou o prazo de ${title}`, { ...(current.dueAt ? { dueAt: current.dueAt } : {}) });
    if (current.startAt !== before.startAt) say("comeco", current.startAt ? `Você marcou ${title} para começar em ${dateLabel(current.startAt)}` : `Você tirou o "começa em" de ${title}`, { ...(current.startAt ? { startAt: current.startAt } : {}) });
    if (current.pace !== before.pace) say("ritmo", current.pace ? `Você definiu o ritmo de ${title}` : `Você tirou o ritmo de ${title}`, { ...(project.pace ? { pace: project.pace } : {}) });
    if (current.paused !== before.paused) say(current.paused ? "pausado" : "retomado", current.paused ? `Você pausou ${title}` : `Você retomou ${title}`, {});
  };
  const onPlan = (plan: Plan) => {
    onRework(plan);
    onHandoff(plan);
    onEdit(plan);
    if (!isPlanProject(plan)) return;
    const previous = plans.get(plan.id);
    plans.set(plan.id, plan.status);
    if (previous === plan.status) return;
    const refs = { planId: plan.id, taskId: plan.id, ...(plan.forYouId ? { forYouId: plan.forYouId } : {}) };
    const title = quote(shorten(plan.title, 80));
    const at = now();
    if (previous === undefined) {
      emit({ at, category: "plano", action: "criado", actor: ACTIVITY_MAESTRO, summary: `O Maestro montou o plano ${title} (${plan.tasks.length} ${plan.tasks.length === 1 ? "etapa" : "etapas"})`, refs, data: { steps: plan.tasks.length } });
      return;
    }
    if (plan.status === "ativo" && (previous === "proposto" || previous === "ajustando")) emit({ at, category: "plano", action: "aprovado", actor: ACTIVITY_USER, summary: `Você aprovou o plano ${title}`, refs });
    else if (plan.status === "concluido") emit({ at, category: "plano", action: "concluido", actor: ACTIVITY_SYSTEM, summary: `O plano ${title} foi concluído`, refs });
    else if (plan.status === "cancelado") emit({ at, category: "plano", action: "cancelado", actor: ACTIVITY_USER, summary: `O plano ${title} foi cancelado`, refs });
  };

  // ---------- Agentes ----------
  const fingerprint = (agent: Agent) => ({ name: agent.name, role: agent.role, engine: agent.engine ?? "mock", model: agent.model ?? "", effort: agent.effort ?? "", internet: agent.internet, browser: agent.browser, terminal: agent.terminal });
  const agents = new Map<string, ReturnType<typeof fingerprint>>();
  for (const agent of initial.agents) agents.set(agent.id, fingerprint(agent));
  const ACCESS_LABEL = { internet: "internet", browser: "navegador", terminal: "terminal" } as const;
  const onAgent = (agent: Agent) => {
    names.set(agent.id, agent.name);
    const current = fingerprint(agent);
    const previous = agents.get(agent.id);
    agents.set(agent.id, current);
    const at = now();
    if (!previous) {
      emit({ at, category: "agente", action: "criado", actor: ACTIVITY_USER, summary: `Você adicionou o agente ${agent.name}${agent.role ? ` (${agent.role})` : ""}`, data: { agentId: agent.id, engine: current.engine, model: current.model } });
      return;
    }
    const changes: string[] = [];
    if (previous.name !== current.name) changes.push(`nome: ${previous.name} → ${current.name}`);
    if (previous.engine !== current.engine || previous.model !== current.model) changes.push(`modelo: ${[previous.engine, previous.model].filter(Boolean).join("/")} → ${[current.engine, current.model].filter(Boolean).join("/")}`);
    if (previous.effort !== current.effort) changes.push(`esforço: ${previous.effort || "padrão"} → ${current.effort || "padrão"}`);
    for (const key of ["internet", "browser", "terminal"] as const) {
      if (previous[key] !== current[key]) changes.push(`${ACCESS_LABEL[key]}: ${current[key] === false ? "desligado" : "segue o workspace"}`);
    }
    if (changes.length === 0) return; // só status (ocioso/trabalhando) ou texto: não é atividade
    emit({ at, category: "agente", action: "alterado", actor: ACTIVITY_USER, summary: `Você alterou ${agent.name} (${changes.join("; ")})`, data: { agentId: agent.id, changes } });
  };

  const unsubscribe = deps.hub.subscribe((event) => {
    try {
      switch (event.type) {
        case "task:upserted":
          return onTask(event.task);
        case "foryou:upserted":
          return onItem(event.item);
        case "foryou:deleted":
          items.delete(event.id);
          return;
        case "foryou:archived":
          // Arquivado (decidido há tempo) não é apagado nem decidido de novo: não vira registro, só sai da memória.
          for (const id of event.ids) items.delete(id);
          return;
        case "routine:upserted":
          return onRoutine(event.routine);
        case "routine:removed": {
          const known = routines.get(event.routineId);
          routines.delete(event.routineId);
          emit({ at: now(), category: "rotina", action: "apagada", actor: ACTIVITY_USER, summary: `A rotina ${quote(known?.title ?? event.routineId)} foi apagada`, refs: { routineId: event.routineId } });
          return;
        }
        case "routine:entry":
          return onRoutineEntry(event.entry);
        case "routine:items": {
          // Itens que o servidor encerrou por fim da vida: um aviso só por passada ("Sem resposta").
          if (!event.expired?.length) return;
          const title = routines.get(event.routineId)?.title ?? event.routineId;
          emit({ at: now(), category: "rotina", action: "expirou", actor: ACTIVITY_SYSTEM, summary: `${title}: ${summarizeChanges(event.expired)}`, refs: { routineId: event.routineId }, data: { changes: event.expired.length } });
          for (const change of event.expired) if (change.alert) emit({ at: now(), category: "rotina", action: "alerta", actor: ACTIVITY_SYSTEM, summary: `Atenção em ${title}: ${change.text}`, refs: { routineId: event.routineId }, data: { itemId: change.itemId, alert: true } });
          return;
        }
        case "routine:closed":
          emit({ at: now(), category: "rotina", action: "semana_fechada", actor: ACTIVITY_SYSTEM, summary: `Semana ${event.periodKey} fechada (${event.routineIds.length} ${event.routineIds.length === 1 ? "rotina" : "rotinas"})`, data: { periodKey: event.periodKey, routines: event.routineIds.length } });
          return;
        case "media:upserted":
          return onMedia(event.media);
        case "media:deleted": {
          const known = media.get(event.id);
          media.delete(event.id);
          if (known) emit({ at: now(), category: "midia", action: "apagada", actor: ACTIVITY_USER, summary: `Você apagou a mídia ${quote(shorten(known.title, 70))}`, refs: { mediaId: event.id } });
          return;
        }
        case "project:upserted":
          return onPlan(event.project);
        case "project:deleted":
          plans.delete(event.id);
          return;
        case "agent:upserted":
          return onAgent(event.agent);
        case "agent:deleted": {
          const known = names.get(event.id);
          agents.delete(event.id);
          if (known) emit({ at: now(), category: "agente", action: "removido", actor: ACTIVITY_USER, summary: `Você removeu o agente ${known}`, data: { agentId: event.id } });
          return;
        }
        default:
          return;
      }
    } catch {
      // nunca lança
    }
  });
  return Object.assign(() => unsubscribe(), { drain });
}
