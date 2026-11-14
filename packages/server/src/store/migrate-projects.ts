import { access, copyFile, mkdir, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import {
  agentAddress,
  findMaestroAgent,
  forYouItemSchema,
  projectSchema,
  taskSchema,
  type ForYouItem,
  type Project,
  type Task,
} from "@cyno/shared";
import { writeJsonAtomic } from "./atomic-write";
import { monthOf, readJsonIfExists, readOfficeFile } from "./files";
import { migrateTasksData } from "./migrations";
import type { DataPaths } from "./paths";

/**
 * Migração para o layout de projetos (`schema.json` dataVersion 3). Roda no boot do workspace,
 * antes do OfficeStore carregar, e é idempotente:
 * 1. com `dataVersion >= 3`, sai;
 * 2. backup em `backup/pre-projetos-<ts>/` (não sobrescreve um que já exista);
 * 3. monta tudo em memória a partir dos arquivos antigos (`tasks.json`, `plans.json`, `for-you.json`)
 *    e valida; se algo falhar, NADA é gravado e o boot do workspace falha com a mensagem (os arquivos
 *    antigos ficam intactos);
 * 4. grava os arquivos novos, o `migration-report.json`, renomeia os antigos para `*.legacy.json` e
 *    grava `schema.json` POR ÚLTIMO. Se cair no meio, o marcador falta e o passo 3 roda de novo
 *    (lendo os `*.legacy.json` se o original já foi renomeado).
 */

export const DATA_VERSION = 3;

export class MigrationError extends Error {
  constructor(problems: string[]) {
    super(`Migração para projetos abortada, nada foi gravado e os arquivos antigos estão intactos:\n- ${problems.join("\n- ")}`);
    this.name = "MigrationError";
  }
}

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export type MigrationOptions = {
  /** Agrupa os pedidos "N/M" (mesmo prefixo, mesmo total, mesmo dia) num projeto só. */
  group: boolean;
  workspaceId: string;
  now?: () => Date;
  /** Gancho de teste: chamado depois de cada etapa de gravação (pode lançar para simular uma queda). */
  afterStep?: (step: string) => void;
};

export type MigrationReport = {
  migratedAt: string;
  dataVersion: number;
  grouping: boolean;
  counts: { tasks: number; requests: number; projects: number; projectsFromPlans: number; projectsFromRequests: number; projectsFromRoutines: number; forYouItems: number };
  groups: { projectId: string; title: string; total: number; requestIds: string[]; titles: string[] }[];
  skippedGroups: { reason: string; requestIds: string[]; titles: string[] }[];
  warnings: string[];
};

export type MigrationInput = { tasks: unknown[]; plans: unknown[]; forYou: unknown[]; maestroAgentId?: string };
export type MigrationResult = { tasks: Task[]; projects: Project[]; forYou: ForYouItem[]; report: MigrationReport };

const MAESTRO_FALLBACK_OWNER = "maestro";
const GROUP_TITLE = /^(.*?)\s+(\d+)\/(\d+):/;

const firstLine = (text: string) => text.split("\n")[0]!.replace(/\s+/g, " ").trim();
const shorten = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);
const isActive = (status: string) => status === "queued" || status === "in_progress" || status === "waiting_approval";

const PLAN_STATUS: Record<string, string> = { aguardando_aprovacao: "proposto", em_execucao: "ativo" };
const TASK_TO_PROJECT_TASK: Record<string, string> = { queued: "a_fazer", in_progress: "em_andamento", waiting_approval: "esperando_voce", done: "concluida", failed: "falhou" };
const TASK_TO_STEP: Record<string, string> = { queued: "pendente", in_progress: "em_andamento", waiting_approval: "em_andamento", done: "feita", failed: "falhou" };

/** Dia local (AAAA-MM-DD) de um instante ISO. */
function localDay(iso: string): string {
  const date = new Date(iso);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

type Draft = {
  request: Json;
  project: Json;
  /** Tarefas-filhas (Task) e a `ref` de cada uma no projeto. */
  refs: Map<string, string>;
  /** Pedido sem filhos: a tarefa do projeto é o próprio pedido (ref). */
  selfRef?: string;
  fromPlan: boolean;
};

/** Parte pura da migração: formato antigo -> formato novo + relatório. Lança MigrationError se a validação falhar. */
export function buildProjectsMigration(input: MigrationInput, options: MigrationOptions): MigrationResult {
  const at = (options.now ?? (() => new Date()))().toISOString();
  const ws = options.workspaceId;
  const warnings: string[] = [];
  const maestroId = input.maestroAgentId;
  const rawTasks = (migrateTasksData(structuredClone(input.tasks)).data as Json[]).map((task) => ({ ...task }));
  const rawPlans = structuredClone(input.plans) as Json[];
  const rawItems = structuredClone(input.forYou) as Json[];
  const originalIds = rawTasks.map((task) => String(task.id));

  // ---- planos: o mais novo de cada pedido vira o projeto; planId -> pedido
  const planToRequest = new Map<string, string>();
  const latestPlan = new Map<string, Json>();
  for (const plan of rawPlans) {
    planToRequest.set(plan.id, plan.requestId);
    const current = latestPlan.get(plan.requestId);
    if (!current || String(plan.createdAt) >= String(current.createdAt)) latestPlan.set(plan.requestId, plan);
  }
  const byId = new Map(rawTasks.map((task) => [String(task.id), task]));
  for (const plan of rawPlans) {
    if (!byId.has(plan.requestId)) warnings.push(`Plano ${plan.id}: o pedido ${plan.requestId} não existe mais (plano descartado do layout novo; continua no backup)`);
    else if (latestPlan.get(plan.requestId) !== plan) warnings.push(`Pedido ${plan.requestId}: havia mais de um plano; o mais novo (${latestPlan.get(plan.requestId)!.id}) virou o projeto`);
  }

  // ---- campos antigos das tarefas -> novos
  for (const task of rawTasks) {
    const parentId = task.parentId as string | undefined;
    delete task.parentId;
    if (parentId !== undefined) task.projectId = parentId;
    const plan = task.plan as Json | undefined;
    delete task.plan;
    if (plan) task.work = { projectId: planToRequest.get(plan.planId) ?? parentId ?? plan.planId, ref: plan.ref, step: plan.step };
  }
  const isRequest = (task: Json) => task.role === "request" || (task.role === undefined && task.projectId === undefined && maestroId !== undefined && task.agentId === maestroId);
  const requests = rawTasks.filter(isRequest);
  for (const request of requests) request.role = "request";
  const requestIds = new Set(requests.map((request) => String(request.id)));
  const children = new Map<string, Json[]>();
  for (const task of rawTasks) {
    if (isRequest(task) || task.projectId === undefined) continue;
    if (!requestIds.has(task.projectId)) {
      warnings.push(`Tarefa ${task.id}: o pai ${task.projectId} não é um pedido do Maestro (mantida como está)`);
      continue;
    }
    children.set(task.projectId, [...(children.get(task.projectId) ?? []), task]);
  }
  const itemsOfRequest = new Map<string, number>();
  for (const item of rawItems) {
    const key = item.requestId ?? item.taskId;
    if (key && requestIds.has(key)) itemsOfRequest.set(key, (itemsOfRequest.get(key) ?? 0) + 1);
  }

  // ---- um rascunho de projeto por pedido
  const drafts = new Map<string, Draft>();
  const maestroOwner = maestroId ?? MAESTRO_FALLBACK_OWNER;
  const stepOf = (agentId: string, what: string, status: string, taskId: string | undefined, result: unknown, startedAt?: string, finishedAt?: string): Json => ({
    agentId,
    address: agentAddress(ws, agentId),
    what,
    status,
    ...(taskId ? { taskId } : {}),
    ...(typeof result === "string" ? { result } : {}),
    ...(startedAt ? { startedAt } : {}),
    ...(finishedAt ? { finishedAt } : {}),
  });
  const orderedRequests = [...requests].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  for (const request of orderedRequests) {
    const id = String(request.id);
    const kids = (children.get(id) ?? []).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    const plan = latestPlan.get(id);
    const origin = request.routineId ? "rotina" : "usuario";
    const routine = request.routineId ? { routineRef: { routineId: request.routineId } } : {};
    const closed = !isActive(request.status);
    if (plan) {
      const tasks = (plan.tasks as Json[]).map((task) => ({ ...task, steps: (task.steps as Json[]).map((step) => ({ ...step, address: agentAddress(ws, step.agentId) })) }));
      const { requestId: _drop, id: _planId, ...rest } = plan;
      const project = { ...rest, id, kind: "projeto", origin, ...routine, status: PLAN_STATUS[plan.status] ?? plan.status, tasks };
      const refs = new Map<string, string>();
      for (const kid of kids) if (kid.work) refs.set(String(kid.id), kid.work.ref);
      const loose = kids.filter((kid) => !kid.work).length;
      if (loose > 0) warnings.push(`Pedido ${id}: ${loose} tarefa(s) delegada(s) fora do plano ficaram ligadas ao projeto sem fazer parte das tarefas dele`);
      drafts.set(id, { request, project, refs, fromPlan: true });
      continue;
    }
    if (kids.length === 0) {
      // Só vira projeto o pedido já fechado que teve aprovações dele mesmo (conversas sem trabalho ficam só como registro).
      if (!closed || !itemsOfRequest.get(id)) continue;
      const title = shorten(firstLine(String(request.prompt)) || "Pedido", 120);
      const failed = request.status === "failed";
      const task = failed
        ? undefined
        : {
            ref: "T1",
            title,
            briefing: String(request.prompt),
            ownerId: maestroOwner,
            steps: [stepOf(maestroOwner, shorten(String(request.prompt), 1000), "feita", id, request.result, request.createdAt, request.updatedAt)],
            current: 0,
            dependsOn: [],
            priority: "normal",
            status: "concluida",
            ...(typeof request.result === "string" ? { result: request.result } : {}),
            startedAt: request.createdAt,
            finishedAt: request.updatedAt,
            updatedAt: request.updatedAt,
          };
      const project = {
        id,
        kind: "tarefa",
        title,
        ...(failed && typeof request.result === "string" ? { summary: request.result } : {}),
        origin,
        ...routine,
        status: failed ? "cancelado" : "concluido",
        version: 1,
        tasks: task ? [task] : [],
        createdAt: request.createdAt,
        updatedAt: request.updatedAt,
        finishedAt: request.updatedAt,
      };
      drafts.set(id, { request, project, refs: new Map(), ...(task ? { selfRef: "T1" } : {}), fromPlan: false });
      continue;
    }
    // Sem plano, com filhos: cada filho vira uma tarefa de 1 etapa.
    const refs = new Map<string, string>();
    const tasks = kids.map((kid, index) => {
      const ref = `T${index + 1}`;
      refs.set(String(kid.id), ref);
      const agentId = String(kid.agentId ?? maestroOwner);
      const briefing = String(kid.prompt);
      return {
        ref,
        title: shorten(firstLine(briefing) || ref, 120),
        briefing,
        ownerId: agentId,
        steps: [stepOf(agentId, shorten(briefing, 1000), TASK_TO_STEP[kid.status] ?? "pendente", String(kid.id), kid.result, isActive(kid.status) && kid.status === "queued" ? undefined : kid.createdAt, isActive(kid.status) ? undefined : kid.updatedAt)],
        current: 0,
        dependsOn: [],
        priority: "normal",
        status: TASK_TO_PROJECT_TASK[kid.status] ?? "a_fazer",
        ...(typeof kid.result === "string" && kid.status === "done" ? { result: kid.result } : {}),
        ...(kid.status === "failed" ? { failure: String(kid.result ?? "sem motivo informado") } : {}),
        ...(kid.status === "queued" ? {} : { startedAt: kid.createdAt }),
        ...(isActive(kid.status) ? {} : { finishedAt: kid.updatedAt }),
        updatedAt: kid.updatedAt,
      };
    });
    const status = closed ? (request.status === "failed" ? "cancelado" : "concluido") : "ativo";
    const project = {
      id,
      kind: kids.length === 1 ? "tarefa" : "projeto",
      title: shorten(firstLine(String(request.prompt)) || "Pedido", 120),
      ...(closed && request.status === "failed" && typeof request.result === "string" ? { summary: request.result } : {}),
      origin,
      ...routine,
      status,
      version: 1,
      tasks,
      createdAt: request.createdAt,
      updatedAt: request.updatedAt,
      ...(closed ? { finishedAt: request.updatedAt } : {}),
    };
    drafts.set(id, { request, project, refs, fromPlan: false });
  }

  // ---- agrupamento dos pedidos "N/M"
  const groups: MigrationReport["groups"] = [];
  const skippedGroups: MigrationReport["skippedGroups"] = [];
  /** Pedido absorvido -> { cabeça, ref de renumeração do próprio pedido, mapa filho -> ref nova }. */
  const merged = new Map<string, { head: string; selfRef?: string; refs: Map<string, string> }>();
  if (options.group) {
    const buckets = new Map<string, Draft[]>();
    for (const draft of drafts.values()) {
      if (draft.fromPlan) continue;
      const match = GROUP_TITLE.exec(firstLine(String(draft.request.prompt)));
      if (!match) continue;
      const key = `${localDay(String(draft.request.createdAt))}|${match[1]!.trim()}|${match[3]}`;
      buckets.set(key, [...(buckets.get(key) ?? []), draft]);
    }
    for (const [key, members] of buckets) {
      if (members.length < 2) continue;
      const titles = members.map((member) => firstLine(String(member.request.prompt)));
      const ids = members.map((member) => String(member.request.id));
      const busy = members.some((member) => isActive(member.request.status) || (children.get(String(member.request.id)) ?? []).some((kid) => isActive(kid.status)));
      if (busy) {
        skippedGroups.push({ reason: "há pedido ou tarefa ainda em andamento no grupo", requestIds: ids, titles });
        continue;
      }
      const [prefix, total] = key.split("|").slice(1) as [string, string];
      const sorted = [...members].sort((a, b) => String(a.request.createdAt).localeCompare(String(b.request.createdAt)) || String(a.request.id).localeCompare(String(b.request.id)));
      const head = sorted[0]!;
      const headId = String(head.request.id);
      const tasks: Json[] = [];
      for (const member of sorted) {
        const memberId = String(member.request.id);
        const refs = new Map<string, string>();
        let selfRef: string | undefined;
        const own = member.project.tasks as Json[];
        // Os filhos do pedido (ou o próprio pedido, quando não teve filhos) viram tarefas do projeto-cabeça, renumeradas.
        const renamedByOld = new Map<string, string>();
        for (const task of own) {
          const ref = `T${tasks.length + 1}`;
          renamedByOld.set(task.ref, ref);
          tasks.push({ ...task, ref });
        }
        for (const [kidId, oldRef] of member.refs) refs.set(kidId, renamedByOld.get(oldRef) ?? oldRef);
        if (member.selfRef) selfRef = renamedByOld.get(member.selfRef);
        merged.set(memberId, { head: headId, ...(selfRef ? { selfRef } : {}), refs });
      }
      const createdAt = sorted.map((member) => String(member.project.createdAt)).sort()[0]!;
      const updatedAt = sorted.map((member) => String(member.project.updatedAt)).sort().at(-1)!;
      const allCancelled = sorted.every((member) => member.project.status === "cancelado");
      head.project = {
        ...head.project,
        id: headId,
        kind: "projeto",
        title: `${prefix} (${sorted.length} de ${total})`,
        status: allCancelled ? "cancelado" : "concluido",
        tasks,
        createdAt,
        updatedAt,
        finishedAt: updatedAt,
      };
      delete head.project.summary;
      groups.push({ projectId: headId, title: String(head.project.title), total: Number(total), requestIds: ids, titles });
      for (const member of sorted) if (member !== head) drafts.delete(String(member.request.id));
    }
  }

  // ---- projetos das tarefas de rotina soltas (sem pedido)
  const routineProjects: Json[] = [];
  for (const task of rawTasks) {
    if (isRequest(task) || task.projectId !== undefined || !task.routineId) continue;
    const agentId = String(task.agentId ?? maestroOwner);
    const status = isActive(task.status) ? "ativo" : task.status === "failed" ? "cancelado" : "concluido";
    const projectTask = {
      ref: "T1",
      title: shorten(firstLine(String(task.prompt)) || "Rotina", 120),
      briefing: String(task.prompt),
      ownerId: agentId,
      steps: [stepOf(agentId, shorten(String(task.prompt), 1000), TASK_TO_STEP[task.status] ?? "pendente", String(task.id), task.result, task.status === "queued" ? undefined : task.createdAt, isActive(task.status) ? undefined : task.updatedAt)],
      current: 0,
      dependsOn: [],
      priority: "normal",
      status: TASK_TO_PROJECT_TASK[task.status] ?? "a_fazer",
      ...(typeof task.result === "string" && task.status === "done" ? { result: task.result } : {}),
      ...(task.status === "failed" ? { failure: String(task.result ?? "sem motivo informado") } : {}),
      updatedAt: task.updatedAt,
    };
    task.work = { projectId: String(task.id), ref: "T1", step: 0 };
    routineProjects.push({
      id: task.id,
      kind: "tarefa",
      title: projectTask.title,
      origin: "rotina",
      routineRef: { routineId: task.routineId },
      status,
      version: 1,
      tasks: [projectTask],
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      ...(isActive(task.status) ? {} : { finishedAt: task.updatedAt }),
    });
  }

  // ---- aplica nas tarefas: work dos filhos sem plano e reapontamento dos agrupados
  const refOfChild = new Map<string, { projectId: string; ref: string }>();
  for (const [id, draft] of drafts) for (const [kidId, ref] of draft.refs) refOfChild.set(kidId, { projectId: id, ref });
  for (const info of merged.values()) for (const [kidId, ref] of info.refs) refOfChild.set(kidId, { projectId: info.head, ref });
  for (const task of rawTasks) {
    const placed = refOfChild.get(String(task.id));
    if (placed && !isRequest(task)) {
      task.projectId = placed.projectId;
      task.work = { projectId: placed.projectId, ref: placed.ref, step: task.work?.step ?? 0 };
    }
    const into = merged.get(String(task.id))?.head;
    if (into && into !== String(task.id)) task.mergedInto = into;
  }

  // ---- Para você
  const forYou = rawItems.map((item): Json => {
    const { requestId, planId, planRef, ...rest } = item;
    const task = item.taskId ? byId.get(String(item.taskId)) : undefined;
    let projectId: string | undefined = requestId ?? (planId ? planToRequest.get(planId) : undefined) ?? (task ? (isRequest(task) ? String(task.id) : (task.projectId as string | undefined)) : undefined);
    let taskRef: string | undefined = planRef;
    if (task && !isRequest(task)) taskRef ??= refOfChild.get(String(task.id))?.ref;
    if (task && isRequest(task) && merged.has(String(task.id))) taskRef ??= merged.get(String(task.id))!.selfRef;
    else if (task && isRequest(task)) taskRef ??= drafts.get(String(task.id))?.selfRef;
    if (projectId && merged.has(projectId)) {
      const info = merged.get(projectId)!;
      projectId = info.head;
      taskRef = (item.taskId ? refOfChild.get(String(item.taskId))?.ref : undefined) ?? info.selfRef ?? taskRef;
    }
    return { ...rest, ...(projectId ? { projectId } : {}), ...(taskRef ? { taskRef } : {}) };
  });

  // ---- valida e fecha
  const problems: string[] = [];
  const tasks: Task[] = [];
  for (const raw of rawTasks) {
    const parsed = taskSchema.safeParse(raw);
    if (parsed.success) tasks.push(parsed.data);
    else problems.push(`Tarefa ${raw.id}: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
  }
  const projects: Project[] = [];
  for (const raw of [...drafts.values()].map((draft) => draft.project).concat(routineProjects)) {
    const parsed = projectSchema.safeParse(raw);
    if (!parsed.success) {
      problems.push(`Projeto ${raw.id}: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
      continue;
    }
    if (parsed.data.tasks.length === 0 && !(parsed.data.kind === "tarefa" && parsed.data.status === "cancelado")) problems.push(`Projeto ${raw.id} ficou sem tarefas`);
    projects.push(parsed.data);
  }
  projects.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const items: ForYouItem[] = [];
  for (const raw of forYou) {
    const parsed = forYouItemSchema.safeParse(raw);
    if (parsed.success) items.push(parsed.data);
    else problems.push(`Item ${raw.id}: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
  }
  const newIds = new Set(tasks.map((task) => task.id));
  for (const id of originalIds) if (!newIds.has(id)) problems.push(`A tarefa ${id} sumiria`);
  if (tasks.length !== originalIds.length) problems.push(`Número de tarefas mudou (${originalIds.length} -> ${tasks.length})`);
  if (items.length !== rawItems.length) problems.push(`Número de itens do Para você mudou (${rawItems.length} -> ${items.length})`);
  for (const item of rawItems) {
    if (item.taskId && byId.has(String(item.taskId)) && !newIds.has(String(item.taskId))) problems.push(`O item ${item.id} perderia a tarefa ${item.taskId}`);
    if (item.taskId && !byId.has(String(item.taskId))) warnings.push(`Item ${item.id}: a tarefa ${item.taskId} já não existia antes da migração`);
  }
  const projectIds = new Set(projects.map((project) => project.id));
  for (const item of items) if (item.projectId && !projectIds.has(item.projectId) && !requestIds.has(item.projectId)) warnings.push(`Item ${item.id}: o projeto ${item.projectId} não existe`);
  if (problems.length > 0) throw new MigrationError(problems);

  return {
    tasks,
    projects,
    forYou: items,
    report: {
      migratedAt: at,
      dataVersion: DATA_VERSION,
      grouping: options.group,
      counts: {
        tasks: tasks.length,
        requests: requests.length,
        projects: projects.length,
        projectsFromPlans: [...drafts.values()].filter((draft) => draft.fromPlan).length,
        projectsFromRequests: [...drafts.values()].filter((draft) => !draft.fromPlan).length,
        projectsFromRoutines: routineProjects.length,
        forYouItems: items.length,
      },
      groups,
      skippedGroups,
      warnings,
    },
  };
}

export type MigrationOutcome = { status: "already" | "fresh" | "migrated"; report?: MigrationReport };

async function exists(file: string): Promise<boolean> {
  return access(file).then(
    () => true,
    () => false,
  );
}

/** Lê um arquivo antigo: o original, ou o `*.legacy.json` se uma tentativa anterior já o renomeou. */
async function readLegacy(original: string, renamed: string): Promise<{ data: unknown[]; found: boolean }> {
  for (const file of [original, renamed]) {
    let raw: unknown;
    try {
      raw = await readJsonIfExists(file);
    } catch (error) {
      throw new MigrationError([`${path.basename(file)} ilegível: ${(error as Error).message}`]);
    }
    if (raw === undefined) continue;
    if (!Array.isArray(raw)) throw new MigrationError([`${path.basename(file)} não é uma lista`]);
    return { data: raw, found: true };
  }
  return { data: [], found: false };
}

/** Leva o workspace ao layout de projetos (veja o comentário do arquivo). */
export async function migrateToProjects(paths: DataPaths, options: MigrationOptions): Promise<MigrationOutcome> {
  const marker = (await readJsonIfExists(paths.schemaFile).catch(() => undefined)) as { dataVersion?: number } | undefined;
  if (marker && typeof marker.dataVersion === "number" && marker.dataVersion >= DATA_VERSION) return { status: "already" };

  const tasks = await readLegacy(paths.legacy.tasks, paths.legacy.tasksRenamed);
  const plans = await readLegacy(paths.legacy.plans, paths.legacy.plansRenamed);
  const forYou = await readLegacy(paths.legacy.forYou, paths.legacy.forYouRenamed);
  const now = (options.now ?? (() => new Date()))();
  const step = (name: string) => options.afterStep?.(name);

  if (!tasks.found && !plans.found && !forYou.found) {
    await writeJsonAtomic(paths.schemaFile, { dataVersion: DATA_VERSION, migratedAt: now.toISOString() });
    return { status: "fresh" };
  }

  const { office } = await readOfficeFile(paths.officeFile);
  const built = buildProjectsMigration({ tasks: tasks.data, plans: plans.data, forYou: forYou.data, maestroAgentId: findMaestroAgent(office)?.id }, options);

  // Backup (não sobrescreve um que já exista).
  const existing = await readdir(paths.backupRoot).catch(() => [] as string[]);
  if (!existing.some((name) => name.startsWith("pre-projetos-"))) {
    const dir = path.join(paths.backupRoot, `pre-projetos-${now.toISOString().replace(/[:.]/g, "-")}`);
    await mkdir(dir, { recursive: true });
    for (const file of [paths.legacy.tasks, paths.legacy.plans, paths.legacy.forYou, paths.officeFile]) {
      if (await exists(file)) await copyFile(file, path.join(dir, path.basename(file)));
    }
  }
  step("backup");

  // Arquivos novos (as pastas só existem por causa desta migração: recomeça limpo).
  for (const dir of [paths.tasksDir, paths.forYouDir, paths.projectsDir]) await rm(dir, { recursive: true, force: true });
  await mkdir(paths.tasksDir, { recursive: true });
  await mkdir(paths.forYouDir, { recursive: true });
  await mkdir(paths.projectsDir, { recursive: true });
  const writeMonths = async <T extends { createdAt: string }>(dir: string, list: T[]) => {
    const months = new Map<string, T[]>();
    for (const item of list) months.set(monthOf(item.createdAt), [...(months.get(monthOf(item.createdAt)) ?? []), item]);
    for (const [month, items] of months) await writeJsonAtomic(path.join(dir, `${month}.json`), items);
  };
  await writeMonths(paths.tasksDir, built.tasks);
  step("tasks");
  await writeMonths(paths.forYouDir, built.forYou);
  step("for-you");
  for (const project of built.projects) await writeJsonAtomic(path.join(paths.projectsDir, `${project.id}.json`), project);
  step("projects");
  await writeJsonAtomic(paths.migrationReportFile, built.report);
  step("report");

  // Antigos viram *.legacy.json (nunca apagados); o marcador vai por último.
  for (const [from, to] of [
    [paths.legacy.tasks, paths.legacy.tasksRenamed],
    [paths.legacy.plans, paths.legacy.plansRenamed],
    [paths.legacy.forYou, paths.legacy.forYouRenamed],
  ] as const) {
    if (await exists(from)) await rename(from, to);
  }
  step("legacy");
  await writeJsonAtomic(paths.schemaFile, { dataVersion: DATA_VERSION, migratedAt: now.toISOString() });
  return { status: "migrated", report: built.report };
}
