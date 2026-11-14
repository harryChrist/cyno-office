import { mkdir, readdir, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { ACTIVITY_MAESTRO, ACTIVITY_SYSTEM, ACTIVITY_USER, MEDIA_KIND_LABELS, isSafeId, type ActivityEntry } from "@cyno/shared";
import { readForYouAnyLayout, readMediaFile, readOfficeFile, readPlanSummaries, readRoutinesFile, readTasksAnyLayout } from "../../store/files";
import { dataPaths } from "../../store/paths";
import { taskCostsOf, readUsageDir } from "./cost";
import { ActivityLog, DAY_FILE, systemActivityDir, workspaceActivityDir, type ActivityInput } from "./log";
import { startSummary, type PreviousStop } from "../../platform/activity/lifecycle";
import { durationLabel, quote, shorten, titleOf } from "./recorder";
import { parseActivityLine } from "./query";
import { activityDay } from "./time";

/**
 * Migração e preenchimento da Atividade no primeiro boot depois da mudança (idempotente: o marcador
 * `DATA_DIR/activity/.migrated.json` impede de rodar de novo, e uma rodada interrompida no meio é
 * refeita sem duplicar, porque as entradas migradas/preenchidas são sempre regravadas do zero):
 *  1. converte o que presta do diário antigo (`logs/system/*.jsonl`: tarefa, aprovação, boots) para o
 *     formato novo (`data.migrated`);
 *  2. preenche o histórico a partir do estado que já existe (tasks.json, for-you.json, routines.json,
 *     media.json, plans.json), com `data.backfill`, sem repetir o que veio do diário antigo;
 *  3. apaga os arquivos do diário antigo.
 * Nunca mexe no estado nem nos logs de trabalho das tarefas.
 */

export const MIGRATION_MARKER = ".migrated.json";
const MIGRATION_VERSION = 1;
const DAY_MS = 86_400_000;

export type MigrationResult = { ran: boolean; migrated: number; backfilled: number; removedFiles: number };

export type MigrationOptions = {
  dataDir: string;
  now?: () => Date;
  /** Preenche só o que for mais novo que isso (dias; padrão: a retenção da Atividade, 180). */
  keepDays?: number;
};

type OldEvent = { at?: string; level?: string; category?: string; type?: string; workspaceId?: string; agentId?: string; taskId?: string; durationMs?: number; data?: Record<string, unknown> };
type Draft = { ws?: string; input: ActivityInput };

const atMs = (value: ActivityInput["at"]): number => (typeof value === "number" ? value : value instanceof Date ? value.getTime() : Date.parse(String(value)));
const isTagged = (entry: ActivityEntry) => entry.data?.backfill === true || entry.data?.migrated === true;

export async function migrateActivity(options: MigrationOptions): Promise<MigrationResult> {
  const { dataDir } = options;
  const now = options.now?.() ?? new Date();
  const systemDir = systemActivityDir(dataDir);
  const markerFile = path.join(systemDir, MIGRATION_MARKER);
  try {
    await readFile(markerFile, "utf8");
    return { ran: false, migrated: 0, backfilled: 0, removedFiles: 0 };
  } catch {
    // sem marcador: roda
  }
  const cutoff = now.getTime() - (options.keepDays ?? 180) * DAY_MS;
  const workspaces = await workspaceIds(dataDir);

  // Nomes e títulos (para as frases) de cada workspace.
  const context = new Map<string, WorkspaceContext>();
  for (const id of workspaces) context.set(id, await loadContext(dataDir, id));

  const migrated = await convertOldJournal(dataDir, context);
  const seen = new Set(migrated.map(dedupeKey).filter((key): key is string => key !== undefined));
  const backfilled: Draft[] = [];
  for (const id of workspaces) backfilled.push(...(await backfillWorkspace(context.get(id)!, cutoff, seen)));

  const drafts = [...migrated.map((draft) => tag(draft, "migrated")), ...backfilled.map((draft) => tag(draft, "backfill"))].filter((draft) => atMs(draft.input.at) >= cutoff);
  await writeDrafts(dataDir, drafts);
  const removedFiles = await removeOldJournal(dataDir);

  await mkdir(systemDir, { recursive: true });
  const result = { ran: true, migrated: migrated.length, backfilled: backfilled.length, removedFiles };
  await writeFile(markerFile, `${JSON.stringify({ version: MIGRATION_VERSION, at: now.toISOString(), ...result }, null, 2)}\n`, "utf8");
  return result;
}

function tag(draft: Draft, kind: "migrated" | "backfill"): Draft {
  return { ...draft, input: { ...draft.input, data: { ...draft.input.data, [kind]: true } } };
}

/** Chave de uma entrada que o estado também conta (tarefa criada/concluída, aprovação decidida), para não repetir. */
function dedupeKey(draft: Draft): string | undefined {
  const { input } = draft;
  const id = input.category === "tarefa" ? input.refs?.taskId : input.category === "aprovacao" ? input.refs?.forYouId : undefined;
  return id ? `${draft.ws ?? ""}|${input.category}|${input.action}|${id}` : undefined;
}

/** Chave de conteúdo de uma entrada (sem o id nem a hora): a mesma coisa gravada ao vivo e recuperada do histórico tem a mesma chave. */
function contentKey(entry: ActivityEntry): string {
  const { taskId, forYouId } = entry.refs ?? {};
  const id = entry.category === "tarefa" ? taskId : entry.category === "aprovacao" ? forYouId : undefined;
  if (id) return `${entry.workspaceId ?? ""}|${entry.category}|${entry.action}|${id}`;
  return `${entry.workspaceId ?? ""}|${entry.category}|${entry.action}|${entry.actor}|${entry.summary}|${JSON.stringify(entry.refs ?? {})}`;
}

async function workspaceIds(dataDir: string): Promise<string[]> {
  try {
    const entries = await readdir(path.join(dataDir, "workspaces"), { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory() && isSafeId(entry.name)).map((entry) => entry.name);
  } catch {
    return [];
  }
}

type WorkspaceContext = {
  id: string;
  root: string;
  agents: Map<string, string>;
  tasks: Awaited<ReturnType<typeof readTasksAnyLayout>>;
};

async function loadContext(dataDir: string, id: string): Promise<WorkspaceContext> {
  const root = path.join(dataDir, "workspaces", id);
  const paths = dataPaths(root);
  const agents = new Map<string, string>();
  try {
    for (const agent of (await readOfficeFile(paths.officeFile)).office.agents) agents.set(agent.id, agent.name);
  } catch {
    // sem office.json legível: usa os ids
  }
  let tasks: WorkspaceContext["tasks"] = [];
  try {
    tasks = await readTasksAnyLayout(paths);
  } catch {
    // sem tasks.json legível
  }
  return { id, root, agents, tasks };
}

// ---------- 1. Diário antigo ----------

async function convertOldJournal(dataDir: string, context: Map<string, WorkspaceContext>): Promise<Draft[]> {
  const dir = path.join(dataDir, "logs", "system");
  let names: string[];
  try {
    names = (await readdir(dir)).filter((name) => DAY_FILE.test(name)).sort();
  } catch {
    return [];
  }
  const out: Draft[] = [];
  const lowMemoryHours = new Set<string>();
  for (const name of names) {
    let text: string;
    try {
      text = await readFile(path.join(dir, name), "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let event: OldEvent;
      try {
        event = JSON.parse(line) as OldEvent;
      } catch {
        continue;
      }
      const at = event.at ? Date.parse(event.at) : NaN;
      if (Number.isNaN(at) || typeof event.category !== "string" || typeof event.type !== "string") continue;
      const draft = convertOldEvent(event, at, context);
      if (!draft) continue;
      if (draft.input.action === "memoria_baixa") {
        const hour = Math.floor(at / 3_600_000);
        if (lowMemoryHours.has(String(hour))) continue;
        lowMemoryHours.add(String(hour));
      }
      out.push(draft);
    }
  }
  return out;
}

function convertOldEvent(event: OldEvent, at: number, context: Map<string, WorkspaceContext>): Draft | undefined {
  const data = event.data ?? {};
  const ws = event.workspaceId;
  const ctx = ws ? context.get(ws) : undefined;
  const who = event.agentId ? (ctx?.agents.get(event.agentId) ?? event.agentId) : "Um agente";
  const task = event.taskId ? ctx?.tasks.find((item) => item.id === event.taskId) : undefined;
  const title = task ? quote(titleOf(task)) : "uma tarefa";
  const refs = event.taskId ? { taskId: event.taskId } : {};
  const duration = typeof event.durationMs === "number" ? event.durationMs : undefined;
  const base = { at, ...(ws ? { workspaceId: ws } : {}) };
  const make = (input: Omit<ActivityInput, "at" | "workspaceId">): Draft => ({ ...(ws ? { ws } : {}), input: { ...base, ...input } });
  switch (`${event.category}.${event.type}`) {
    case "task.created":
      return make({ category: "tarefa", action: "criada", actor: ACTIVITY_USER, summary: `Tarefa criada: ${title}`, refs, data: { ...(task ? { title: titleOf(task) } : {}) } });
    case "task.started":
      return make({ category: "tarefa", action: "iniciada", actor: event.agentId ?? ACTIVITY_SYSTEM, summary: `${who} começou ${title}`, refs, data: { engine: data.engine, model: data.model } });
    case "task.resumed":
      return make({ category: "tarefa", action: "retomada", actor: event.agentId ?? ACTIVITY_SYSTEM, summary: `${who} retomou ${title} depois da resposta`, refs });
    case "task.finished":
      return make({ category: "tarefa", action: "concluida", actor: event.agentId ?? ACTIVITY_SYSTEM, summary: `${who} concluiu ${title}${duration !== undefined ? ` em ${durationLabel(duration)}` : ""}`, refs, data: { ...(duration !== undefined ? { durationMs: duration } : {}) } });
    case "task.failed":
      return make({ category: "tarefa", action: "falhou", actor: event.agentId ?? ACTIVITY_SYSTEM, summary: `${who} não conseguiu concluir ${title}`, refs, data: { ...(duration !== undefined ? { durationMs: duration } : {}), ...(typeof data.reason === "string" ? { error: data.reason } : {}) } });
    case "approval.requested": {
      const forYouId = typeof data.item === "string" ? data.item : undefined;
      return make({ category: "aprovacao", action: "pedida", actor: event.agentId ?? ACTIVITY_SYSTEM, summary: `${who} pediu a sua aprovação`, refs: { ...refs, ...(forYouId ? { forYouId } : {}) } });
    }
    case "approval.decided":
    case "approval.cancelled": {
      const forYouId = typeof data.item === "string" ? data.item : undefined;
      const status = typeof data.status === "string" ? data.status : "";
      const action = event.type === "cancelled" ? "cancelada" : status === "aprovado" ? "aprovada" : status === "rejeitado" ? "rejeitada" : "respondida";
      const verb = action === "cancelada" ? "cancelou o pedido" : status === "aprovado" ? "aprovou" : status === "rejeitado" ? "rejeitou" : "respondeu";
      return make({ category: "aprovacao", action, actor: action === "cancelada" ? (event.agentId ?? ACTIVITY_SYSTEM) : ACTIVITY_USER, summary: `${action === "cancelada" ? who : "Você"} ${verb}${data.type ? `: ${String(data.type)}` : ""}`, refs: { ...refs, ...(forYouId ? { forYouId } : {}) }, data: { ...(duration !== undefined ? { durationMs: duration } : {}), type: data.type } });
    }
    case "server.start": {
      const stop = { previousStop: (data.previousStop as PreviousStop["previousStop"]) ?? "unknown", ...(typeof data.oomKills === "number" ? { oomKills: data.oomKills } : {}), ...(typeof data.previousError === "string" ? { previousError: data.previousError } : {}), ...(data.killedDuringShutdown === true ? { killedDuringShutdown: true } : {}) } as PreviousStop;
      return make({ category: "sistema", action: "iniciado", actor: ACTIVITY_SYSTEM, summary: startSummary(stop), data: { previousStop: stop.previousStop, pid: data.pid } });
    }
    case "server.shutdown":
      return make({ category: "sistema", action: "desligado", actor: ACTIVITY_SYSTEM, summary: `Servidor desligado normalmente${data.signal ? ` (${String(data.signal)})` : ""}${duration !== undefined ? ` depois de ${durationLabel(duration)} no ar` : ""}`, data: { signal: data.signal, uptimeMs: duration } });
    case "server.uncaught_exception":
    case "server.unhandled_rejection":
      return make({ category: "sistema", action: "erro_fatal", actor: ACTIVITY_SYSTEM, summary: `Um erro inesperado derrubou o servidor${data.message ? `: ${String(data.message)}` : ""}`, data: { message: data.message } });
    case "resources.low_memory":
      return make({ category: "sistema", action: "memoria_baixa", actor: ACTIVITY_SYSTEM, summary: `Pouca memória livre: ${String(data.memAvailableMb ?? "?")} MB (${String(data.memAvailablePct ?? "?")}%) disponíveis`, data: { memAvailableMb: data.memAvailableMb, memAvailablePct: data.memAvailablePct } });
    case "resources.oom_kill":
      return make({ category: "sistema", action: "processo_morto_por_memoria", actor: ACTIVITY_SYSTEM, summary: "O sistema matou processos por falta de memória", data: { kills: data.kills } });
    default:
      return undefined; // amostras, terminais, MCP, navegador, consultas de uso: ruído
  }
}

// ---------- 2. Preenchimento a partir do estado ----------

async function backfillWorkspace(ctx: WorkspaceContext, cutoff: number, seen: Set<string>): Promise<Draft[]> {
  const paths = dataPaths(ctx.root);
  const ws = ctx.id;
  const out: Draft[] = [];
  const add = (input: Omit<ActivityInput, "workspaceId">) => {
    const at = atMs(input.at);
    if (Number.isNaN(at) || at < cutoff) return;
    const draft: Draft = { ws, input: { ...input, workspaceId: ws } };
    const key = dedupeKey(draft);
    if (key && seen.has(key)) return;
    out.push(draft);
  };
  const nameOf = (id: string | undefined) => (id ? (ctx.agents.get(id) ?? id) : "Um agente");

  const costs = taskCostsOf(await readUsageDir(path.join(ctx.root, "usage")));
  const byId = new Map(ctx.tasks.map((task) => [task.id, task]));
  const rootOf = (task: (typeof ctx.tasks)[number]) => {
    let current = task;
    for (let i = 0; i < 20 && current.projectId; i += 1) {
      const parent = byId.get(current.projectId);
      if (!parent) break;
      current = parent;
    }
    return current.id;
  };
  for (const task of ctx.tasks) {
    const title = titleOf(task);
    const refs = { taskId: task.id, ...(task.projectId ? { rootTaskId: rootOf(task) } : {}), ...(task.routineId ? { routineId: task.routineId } : {}), ...(task.work ? { planId: task.work.projectId } : {}) };
    if (task.routineId) add({ at: task.createdAt, category: "tarefa", action: "criada", actor: ACTIVITY_SYSTEM, summary: `Uma rotina criou a tarefa ${quote(title)}`, refs, data: { title } });
    else if (task.projectId) add({ at: task.createdAt, category: "tarefa", action: "criada", actor: ACTIVITY_MAESTRO, summary: `O Maestro delegou ${quote(title)}${task.agentId ? ` para ${nameOf(task.agentId)}` : ""}`, refs, data: { title } });
    else add({ at: task.createdAt, category: "tarefa", action: "criada", actor: ACTIVITY_USER, summary: `Você pediu ${quote(title)}`, refs, data: { title } });
    const actor = task.agentId ?? ACTIVITY_SYSTEM;
    if (task.status === "done") {
      const cost = costs.get(task.id);
      add({ at: task.updatedAt, category: "tarefa", action: "concluida", actor, summary: `${nameOf(task.agentId)} concluiu ${quote(title)}`, refs, data: { title, ...(cost ? { costUsd: Math.round(cost.costUsd * 10_000) / 10_000, tokens: cost.tokens } : {}) } });
    } else if (task.status === "failed") {
      if (/^cancelad/i.test(task.result ?? "")) add({ at: task.updatedAt, category: "tarefa", action: "cancelada", actor: ACTIVITY_USER, summary: `A tarefa ${quote(title)} foi cancelada`, refs, data: { title, reason: task.result } });
      else add({ at: task.updatedAt, category: "tarefa", action: "falhou", actor, summary: `${nameOf(task.agentId)} não conseguiu concluir ${quote(title)}`, refs, data: { title, ...(task.result ? { error: task.result } : {}) } });
    }
  }

  try {
    for (const item of await readForYouAnyLayout(paths)) {
      const refs = { forYouId: item.id, ...(item.taskId ? { taskId: item.taskId } : {}), ...(item.kind === "plano" && item.projectId ? { planId: item.projectId } : {}), ...(item.routineId ? { routineId: item.routineId } : {}) };
      const label = shorten(item.title ?? (item.where ? `${item.where}${item.to ? ` para ${item.to}` : ""}` : item.type), 80);
      add({ at: item.createdAt, category: "aprovacao", action: "pedida", actor: item.agentId, summary: `${nameOf(item.agentId)} pediu a sua aprovação: ${label}`, refs, data: { type: item.type, kind: item.kind ?? "aprovacao" } });
      if (item.status === "pendente" || !item.decidedAt) continue;
      if (item.status === "cancelado") {
        const by = item.cancelledBy === "maestro" ? ACTIVITY_MAESTRO : item.cancelledBy === "agente" ? item.agentId : ACTIVITY_USER;
        add({ at: item.decidedAt, category: "aprovacao", action: "cancelada", actor: by, summary: `${by === ACTIVITY_USER ? "Você" : by === ACTIVITY_MAESTRO ? "O Maestro" : nameOf(by)} cancelou o pedido: ${label}`, refs, data: { type: item.type, ...(item.cancelReason ? { reason: item.cancelReason } : {}) } });
        continue;
      }
      const edited = item.editedByUser && item.text !== item.originalText;
      const verb = item.status === "aprovado" ? "aprovou" : item.status === "rejeitado" ? "rejeitou" : "respondeu";
      const action = item.status === "aprovado" ? "aprovada" : item.status === "rejeitado" ? "rejeitada" : "respondida";
      add({ at: item.decidedAt, category: "aprovacao", action, actor: ACTIVITY_USER, summary: `Você ${verb}: ${label}${edited && item.status === "aprovado" ? " (com a sua edição)" : ""}`, refs, data: { type: item.type, status: item.status, edited } });
    }
  } catch {
    // for-you.json ilegível: sem esse trecho
  }

  try {
    const data = await readRoutinesFile(paths.routinesFile);
    const routines = new Map(data.routines.map((routine) => [routine.id, routine]));
    for (const routine of data.routines) {
      if (routine.status === "proposta") continue;
      add({ at: routine.createdAt, category: "rotina", action: "criada", actor: routine.createdBy === "maestro" ? ACTIVITY_MAESTRO : ACTIVITY_USER, summary: `Rotina ${quote(routine.title)} criada: ${routine.target} ${routine.unit}(s) por semana em ${routine.site}`, refs: { routineId: routine.id } });
    }
    for (const [routineId, decisions] of Object.entries(data.decisions)) {
      const routine = routines.get(routineId);
      for (const decision of decisions) {
        if (decision.kind !== "dispatched") continue;
        add({ at: decision.at, category: "rotina", action: "disparou", actor: ACTIVITY_SYSTEM, summary: `A rotina ${quote(routine?.title ?? routineId)} abriu uma tarefa`, refs: { routineId, ...(decision.taskId ? { taskId: decision.taskId } : {}) } });
      }
    }
    for (const entry of data.entries) {
      const routine = routines.get(entry.routineId);
      const unit = routine?.unit ?? "item";
      const refs = { routineId: entry.routineId, taskId: entry.taskId, ...(entry.url ? { url: entry.url } : {}) };
      add({ at: entry.at, category: "rotina", action: "registrado", actor: entry.agentId, summary: `${nameOf(entry.agentId)} registrou um(a) ${unit} de ${quote(routine?.title ?? entry.routineId)}`, refs, data: { periodKey: entry.periodKey } });
      if (entry.stage === "entregue" && entry.settledAt) add({ at: entry.settledAt, category: "rotina", action: "entregue", actor: ACTIVITY_USER, summary: `${unit.charAt(0).toUpperCase()}${unit.slice(1)} entregue em ${quote(routine?.title ?? entry.routineId)}`, refs, data: { periodKey: entry.periodKey } });
      else if (entry.stage === "descartado" && entry.settledAt) add({ at: entry.settledAt, category: "rotina", action: "descartado", actor: ACTIVITY_USER, summary: `Um(a) ${unit} de ${quote(routine?.title ?? entry.routineId)} foi descartado(a)`, refs, data: { periodKey: entry.periodKey } });
    }
  } catch {
    // routines.json ilegível
  }

  try {
    for (const item of await readMediaFile(paths.mediaFile)) {
      const by = item.createdBy;
      const verb = item.origin === "upload" ? "enviou" : item.origin === "screenshot" ? "capturou" : "criou";
      add({ at: item.createdAt, category: "midia", action: "criada", actor: by, summary: `${by === ACTIVITY_USER ? "Você" : nameOf(by)} ${verb} ${item.origin === "screenshot" ? "uma captura" : `um(a) ${MEDIA_KIND_LABELS[item.kind].toLowerCase()}`} ${quote(shorten(item.title, 70))}`, refs: { mediaId: item.id, ...(item.taskId ? { taskId: item.taskId } : {}), ...(item.rootTaskId ? { rootTaskId: item.rootTaskId } : {}), ...(item.publishedUrl ? { url: item.publishedUrl } : {}) }, data: { kind: item.kind, origin: item.origin, size: item.size } });
    }
  } catch {
    // media.json ilegível
  }

  try {
    for (const plan of await readPlanSummaries(paths)) {
      const refs = { planId: plan.id, taskId: plan.requestId, ...(plan.forYouId ? { forYouId: plan.forYouId } : {}) };
      const title = quote(shorten(plan.title, 80));
      add({ at: plan.createdAt, category: "plano", action: "criado", actor: ACTIVITY_MAESTRO, summary: `O Maestro montou o plano ${title} (${plan.taskCount} ${plan.taskCount === 1 ? "etapa" : "etapas"})`, refs });
      if (plan.approvedAt) add({ at: plan.approvedAt, category: "plano", action: "aprovado", actor: ACTIVITY_USER, summary: `Você aprovou o plano ${title}`, refs });
      if (plan.finishedAt && plan.status === "concluido") add({ at: plan.finishedAt, category: "plano", action: "concluido", actor: ACTIVITY_SYSTEM, summary: `O plano ${title} foi concluído`, refs });
    }
  } catch {
    // plans.json ilegível
  }
  return out;
}

// ---------- Gravação e limpeza ----------

/** Grava os rascunhos nos arquivos do dia, regravando só as linhas migradas/preenchidas (as ao vivo ficam como estão). */
async function writeDrafts(dataDir: string, drafts: Draft[]): Promise<void> {
  const builder = new ActivityLog({ dataDir });
  const byFile = new Map<string, ActivityEntry[]>();
  for (const draft of drafts) {
    const entry = builder.build(draft.input);
    if (!entry) continue;
    const dir = draft.ws ? workspaceActivityDir(dataDir, draft.ws) : systemActivityDir(dataDir);
    const file = path.join(dir, `${activityDay(Date.parse(entry.at))}.jsonl`);
    const list = byFile.get(file);
    if (list) list.push(entry);
    else byFile.set(file, [entry]);
  }
  for (const [file, entries] of byFile) {
    let kept: ActivityEntry[] = [];
    try {
      kept = (await readFile(file, "utf8")).split("\n").map(parseActivityLine).filter((entry): entry is ActivityEntry => entry !== undefined && !isTagged(entry));
    } catch {
      // arquivo novo
    }
    // O que o gravador ao vivo já escreveu no dia (sem etiqueta) não é preenchido de novo: num DATA_DIR copiado sem o
    // marcador, a primeira subida duplicava centenas de entradas "recuperadas". Rodar duas vezes dá o mesmo arquivo.
    const live = new Set(kept.map(contentKey));
    const fresh = entries.filter((entry) => !live.has(contentKey(entry)));
    const all = [...kept, ...fresh].sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || (a.id < b.id ? -1 : 1));
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, `${all.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
    await rename(tmp, file);
  }
}

/** Apaga o diário antigo (só os JSONL dos dias e o heartbeat.json que sobrou). Devolve quantos arquivos saíram. */
async function removeOldJournal(dataDir: string): Promise<number> {
  const dir = path.join(dataDir, "logs", "system");
  let removed = 0;
  try {
    for (const name of await readdir(dir)) {
      if (!DAY_FILE.test(name) && name !== "heartbeat.json") continue;
      await rm(path.join(dir, name), { force: true });
      removed += 1;
    }
    await rmdir(dir).catch(() => undefined);
    await rmdir(path.join(dataDir, "logs")).catch(() => undefined);
  } catch {
    // pasta já não existe
  }
  return removed;
}
