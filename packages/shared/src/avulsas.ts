import { projectDefaults, PROJECT_DEFAULT_MODE, type Project, type ProjectTask } from "./projects";

/**
 * "Avulsas": o projeto fixo (`system: "avulsas"`, id `avulsas`) onde cada pedido simples vira uma
 * FOLHA (antes era um projeto `kind: "tarefa"` de 1 tarefa). Não se apaga, não conclui e fica sempre
 * `ativo`. Só as folhas abertas e as finalizadas nos últimos 14 dias ficam no arquivo vivo
 * (`projects/avulsas.json`); o resto vai para `projects/avulsas.archive/AAAA-MM.json` (somente leitura).
 */
export const AVULSAS_ID = "avulsas";
export const AVULSAS_TITLE = "Avulsas";
export const AVULSAS_KEEP_DAYS = 14;
const DAY_MS = 86_400_000;

/** Cópia profunda (o pacote não tem `structuredClone` nos tipos). */
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** O projeto fixo, vazio (workspace novo e o que a migração cria quando falta). */
export function emptyAvulsas(at: string): Project {
  return {
    ...projectDefaults(),
    id: AVULSAS_ID,
    kind: "tarefa",
    system: "avulsas",
    title: AVULSAS_TITLE,
    origin: "usuario",
    status: "ativo",
    mode: clone(PROJECT_DEFAULT_MODE),
    version: 1,
    labels: [],
    sprints: [],
    nextRef: 1,
    tasks: [],
    createdAt: at,
    updatedAt: at,
  } satisfies Project;
}

/** É o projeto fixo das tarefas avulsas? */
export function isAvulsas(project: Pick<Project, "system">): boolean {
  return project.system === "avulsas";
}

/** Próximo `ref` do Avulsas ("A1", "A2"…): usa o contador `nextRef` (e o avança); sem ele, parte do maior `A<n>` que existe. */
export function takeAvulsasRef(project: Pick<Project, "nextRef" | "tasks">): string {
  let next = project.nextRef;
  if (next === undefined) {
    next = 1;
    for (const task of project.tasks) {
      const match = /^A(\d+)$/.exec(task.ref);
      if (match) next = Math.max(next, Number(match[1]) + 1);
    }
  }
  project.nextRef = next + 1;
  return `A${next}`;
}

/** A folha está finalizada de vez (concluída, cancelada ou falhou) há mais de `AVULSAS_KEEP_DAYS` dias? Então vai para o arquivo mensal. */
export function isArchivable(task: Pick<ProjectTask, "status" | "finishedAt" | "updatedAt">, now: number): boolean {
  if (task.status !== "concluida" && task.status !== "cancelada" && task.status !== "falhou") return false;
  const at = Date.parse(task.finishedAt ?? task.updatedAt);
  return !Number.isNaN(at) && at < now - AVULSAS_KEEP_DAYS * DAY_MS;
}

/** Id do pedido que gerou a folha (o de `meta.requestId`; sem ele, a própria folha). */
export const leafRequestId = (task: Pick<ProjectTask, "ref" | "meta">): string => task.meta?.requestId ?? task.ref;

const FINISHED = new Set(["concluida", "cancelada", "falhou"]);

/**
 * O que o pedido simples era antes do Avulsas: um projeto `kind: "tarefa"` com o id do pedido e as
 * folhas dele como tarefas. É só uma VISTA (nunca gravada): quem ainda lê "um projeto por pedido"
 * (cartões, Hoje, o estado dos pedidos do Cyno, a tela atual) continua lendo assim.
 */
export function legacyViewOf(requestId: string, leaves: readonly ProjectTask[]): Project {
  const first = leaves[0]!;
  const meta = first.meta;
  const open = leaves.some((leaf) => !FINISHED.has(leaf.status));
  const anyDone = leaves.some((leaf) => leaf.status === "concluida" && !leaf.skipped);
  const createdAt = leaves.map((leaf) => leaf.meta?.createdAt ?? leaf.startedAt ?? leaf.updatedAt).sort()[0]!;
  const updatedAt = leaves.map((leaf) => leaf.updatedAt).sort().at(-1)!;
  const finishedAt = open ? undefined : leaves.map((leaf) => leaf.finishedAt ?? leaf.updatedAt).sort().at(-1);
  const dueAt = leaves.find((leaf) => leaf.dueAt)?.dueAt;
  const startAt = leaves.find((leaf) => leaf.startAt)?.startAt;
  // "Isso primeiro" de um pedido simples: vale a folha aberta fixada há mais tempo.
  const pinnedAt = leaves.filter((leaf) => leaf.pinnedAt && !FINISHED.has(leaf.status)).map((leaf) => leaf.pinnedAt!).sort()[0];
  const status = open ? "ativo" : anyDone ? "concluido" : "cancelado";
  // Como o projeto antigo: fechado sem nenhuma entrega, o motivo da falha vai no resumo.
  const failure = status === "cancelado" ? leaves.find((leaf) => leaf.failure)?.failure : undefined;
  return {
    ...projectDefaults(),
    id: requestId,
    kind: "tarefa",
    title: first.title,
    origin: meta?.origin ?? "usuario",
    ...(meta?.routineRef ? { routineRef: clone(meta.routineRef) } : {}),
    status,
    version: 1,
    ...(failure ? { summary: failure } : {}),
    priority: first.priority,
    ...(startAt ? { startAt } : {}),
    ...(dueAt ? { dueAt } : {}),
    ...(pinnedAt ? { pinnedAt } : {}),
    ...(meta?.brief ? { brief: meta.brief } : {}),
    ...(meta?.joint ? { joint: clone(meta.joint) } : {}),
    tasks: clone([...leaves]),
    createdAt,
    updatedAt,
    ...(finishedAt ? { finishedAt } : {}),
  };
}

/** Folhas do Avulsas agrupadas por pedido, na ordem em que aparecem. */
export function leavesByRequest(avulsas: Pick<Project, "tasks">): Map<string, ProjectTask[]> {
  const out = new Map<string, ProjectTask[]>();
  for (const task of avulsas.tasks) out.set(leafRequestId(task), [...(out.get(leafRequestId(task)) ?? []), task]);
  return out;
}

/**
 * A lista de projetos como era antes do Avulsas: o projeto fixo sai e cada pedido simples volta como
 * projeto `kind: "tarefa"` (vista, nunca gravada). Os outros projetos passam como estão.
 */
export function expandAvulsas(projects: readonly Project[]): Project[] {
  const out: Project[] = [];
  for (const project of projects) {
    if (!isAvulsas(project)) {
      out.push(project);
      continue;
    }
    for (const [requestId, leaves] of leavesByRequest(project)) out.push(legacyViewOf(requestId, leaves));
  }
  return out;
}

/** O projeto de um pedido: o de mesmo id (plano, projeto do Cyno) ou, se o pedido virou folha do Avulsas, a vista dele. */
export function requestProject(projects: readonly Project[], requestId: string): Project | undefined {
  const own = projects.find((project) => project.id === requestId && !isAvulsas(project));
  if (own) return own;
  const avulsas = projects.find(isAvulsas);
  const leaves = avulsas?.tasks.filter((task) => leafRequestId(task) === requestId) ?? [];
  return avulsas && leaves.length > 0 ? legacyViewOf(requestId, leaves) : undefined;
}
