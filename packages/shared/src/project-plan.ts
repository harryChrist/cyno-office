import { buildProjectTasks, PROJECT_LIMITS, projectMarkdown, type Label, type Project, type ProjectAgentPool, type ProjectTask, type ProjectTaskInput } from "./projects";
import { sprintDay, sprintsInOrder, type Sprint } from "./sprints";
import { childrenOf, validateTree } from "./task-tree";

/**
 * A proposta do Maestro (`create_project`) e as tarefas novas (`add_project_tasks`) com a árvore, as
 * sprints e as etiquetas: monta tudo, confere com `validateTree` e devolve erros em inglês, um por
 * problema e dizendo qual tarefa e qual regra, para o modelo corrigir sozinho. Sem `parent`, `kind`,
 * `sprint` nem `sprints` é o formato antigo (lista plana) e o resultado é o mesmo de antes.
 */

/** Sprint como o Maestro manda. Sem datas: começa onde a anterior acaba (a primeira, no começo do projeto ou agora) e dura `duration_days` (7). */
export type SprintInput = {
  /** Apelido para as tarefas citarem em `sprint` (ex.: "S1"); sem ele vale o id gerado ("S1", "S2"…) ou o nome. */
  ref?: string;
  name: string;
  goal?: string;
  start_at?: string;
  end_at?: string;
  duration_days?: number;
};

/** Etiqueta como o Maestro manda. */
export type LabelInput = { name: string; color?: string };

/** Paleta das etiquetas (ids que a tela conhece), em rodízio. */
export const LABEL_COLORS = ["blue", "green", "amber", "rose", "violet", "teal"] as const;

const DAY_MS = 86_400_000;

const plain = (text: string) =>
  text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();

export type ProjectPlanInput = {
  tasks: readonly ProjectTaskInput[];
  sprints?: readonly SprintInput[];
  labels?: readonly LabelInput[];
};

/** Projeto que já existe (add_project_tasks): as tarefas, as sprints e as etiquetas de hoje. */
export type ExistingPlan = Pick<Project, "tasks" | "sprints" | "labels">;

export type ProjectPlanResult = { ok: true; tasks: ProjectTask[]; sprints: Sprint[]; labels: Label[]; warnings: string[] } | { ok: false; errors: string[] };

/** Acha a sprint pelo apelido da chamada, pelo id ("S1"), pelo número ("1") ou pelo nome (sem acento/caixa). */
function findSprint(all: readonly Sprint[], aliases: ReadonlyMap<string, string>, wanted: string): Sprint | undefined {
  const key = plain(wanted);
  const id = aliases.get(key) ?? all.find((sprint) => plain(sprint.id) === key || plain(sprint.name) === key || key === `sprint ${sprint.id.slice(1)}` || key === sprint.id.slice(1))?.id;
  return id ? all.find((sprint) => sprint.id === id) : undefined;
}

/**
 * Monta as tarefas, as sprints e as etiquetas da chamada. `startAt`: de quando a primeira sprint sem data
 * começa (o começo do projeto, ou agora). `existing`: o projeto que já tem tarefas (add_project_tasks).
 */
export function buildProjectPlan(input: ProjectPlanInput, pool: ProjectAgentPool, at: string, nowMs: number, startAt?: string, existing?: ExistingPlan): ProjectPlanResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const base = existing?.tasks ?? [];
  // ---- Sprints novas (num projeto que já existe, é add_sprint) ----
  const oldSprints = existing?.sprints ?? [];
  const sprints: Sprint[] = [];
  const aliases = new Map<string, string>();
  const inputSprints = input.sprints ?? [];
  if (oldSprints.length + inputSprints.length > PROJECT_LIMITS.sprints) errors.push(`At most ${PROJECT_LIMITS.sprints} sprints per project`);
  let nextId = oldSprints.reduce((max, sprint) => Math.max(max, Number(/^S(\d+)$/.exec(sprint.id)?.[1] ?? 0)), 0);
  const firstStart = startAt ? Date.parse(startAt) : Number.NaN;
  let cursor = Number.isFinite(firstStart) ? firstStart : nowMs;
  const lastOrder = oldSprints.reduce((max, sprint) => Math.max(max, sprint.order), 0);
  for (const [index, item] of inputSprints.entries()) {
    const label = `Sprint ${index + 1} (“${item.name}”)`;
    const id = `S${++nextId}`;
    if (item.ref?.trim()) {
      const key = plain(item.ref);
      if (aliases.has(key)) errors.push(`${label}: ref "${item.ref}" is used by another sprint`);
      aliases.set(key, id);
    }
    const startMs = item.start_at ? Date.parse(item.start_at) : cursor;
    if (!Number.isFinite(startMs)) errors.push(`${label}: start_at "${item.start_at}" is not a valid date (use ISO 8601, e.g. "2026-11-18T09:00:00-03:00")`);
    const endMs = item.end_at ? Date.parse(item.end_at) : startMs + (item.duration_days ?? 7) * DAY_MS;
    if (!Number.isFinite(endMs)) errors.push(`${label}: end_at "${item.end_at}" is not a valid date (use ISO 8601)`);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) continue;
    if (endMs <= startMs) errors.push(`${label}: end_at must be after start_at`);
    cursor = endMs;
    sprints.push({
      id,
      name: item.name.trim().replace(/\s+/g, " ") || `Sprint ${id.slice(1)}`,
      ...(item.goal?.trim() ? { goal: item.goal.trim() } : {}),
      startAt: new Date(startMs).toISOString(),
      endAt: new Date(endMs).toISOString(),
      order: lastOrder + index + 1,
      status: "planejada",
    });
  }
  const allSprints = [...oldSprints, ...sprints];
  // ---- Etiquetas ----
  const labels: Label[] = [...(existing?.labels ?? [])];
  const ensureLabel = (name: string, color?: string): Label | undefined => {
    const clean = name.trim().replace(/\s+/g, " ");
    if (!clean) return undefined;
    const found = labels.find((label) => plain(label.name) === plain(clean));
    if (found) return found;
    if (labels.length >= PROJECT_LIMITS.labels) {
      errors.push(`At most ${PROJECT_LIMITS.labels} labels per project`);
      return undefined;
    }
    let n = labels.length + 1;
    while (labels.some((label) => label.id === `L${n}`)) n += 1;
    const label: Label = { id: `L${n}`, name: clean, color: color && (LABEL_COLORS as readonly string[]).includes(color) ? color : LABEL_COLORS[labels.length % LABEL_COLORS.length]! };
    labels.push(label);
    return label;
  };
  for (const item of input.labels ?? []) ensureLabel(item.name, item.color);
  // ---- Tarefas ----
  const built = buildProjectTasks(input.tasks, pool, at, base);
  if (!built.ok) return { ok: false, errors: [...errors, ...built.errors] };
  const parentRefs = new Set([...built.tasks, ...base].flatMap((task) => (task.parent ? [task.parent] : [])));
  const known = new Set([...base, ...built.tasks].map((task) => task.ref));
  const counters = new Map<string, number>();
  for (const [index, task] of built.tasks.entries()) {
    const item = input.tasks[index]!;
    const where = `Task ${task.ref}`;
    if (task.parent && !known.has(task.parent)) errors.push(`${where}: parent "${task.parent}" is not a task of this project (refs: ${[...known].join(", ")}). Give the parent an explicit ref and list it in the same call`);
    const key = task.parent ?? "";
    const position = (counters.get(key) ?? childrenOf({ tasks: base }, task.parent).length) + 1;
    counters.set(key, position);
    task.order = position * 1000;
    if (item.sprint?.trim() && !task.group) {
      const sprint = findSprint(allSprints, aliases, item.sprint);
      if (sprint) task.sprintId = sprint.id;
      else errors.push(`${where}: sprint "${item.sprint}" does not exist (sprints: ${allSprints.map((candidate) => candidate.id).join(", ") || "none; sprints are retired for new projects: use modules and release_work/set_release_pace"})`);
    }
    if (item.labels?.length) {
      const ids = [...new Set(item.labels.flatMap((name) => ensureLabel(name)?.id ?? []))];
      if (ids.length > PROJECT_LIMITS.labelsPerTask) errors.push(`${where}: at most ${PROJECT_LIMITS.labelsPerTask} labels per task`);
      if (ids.length > 0) task.labels = ids;
    }
  }
  // Proposta com sprints: a folha sem sprint cai na primeira (nunca fica parada no backlog sem querer).
  const first = existing ? undefined : sprintsInOrder({ sprints: allSprints })[0];
  if (first) for (const task of built.tasks) if (!task.group && !parentRefs.has(task.ref) && !task.sprintId) task.sprintId = first.id;
  if (errors.length === 0) {
    const problems = validateTree({ tasks: [...base, ...built.tasks], sprints: allSprints, labels });
    errors.push(...problems.errors);
    warnings.push(...problems.warnings);
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, tasks: built.tasks, sprints, labels, warnings };
}

/** O plano em markdown para o dono (o texto do item em Aprovações): sprints, módulos, tarefas, subtarefas e responsáveis. Lista plana sem sprints = o formato de sempre. */
export function projectTreeMarkdown(plan: Pick<Project, "title" | "summary" | "tasks" | "sprints">, agentName: (id: string) => string): string {
  const nested = plan.tasks.some((task) => task.parent || task.group);
  const sprints = sprintsInOrder(plan);
  if (!nested && sprints.length === 0) return projectMarkdown(plan, agentName);
  const lines = [`**${plan.title}**`, ...(plan.summary ? ["", plan.summary] : []), ""];
  if (sprints.length > 0) {
    for (const sprint of sprints) lines.push(`- **${sprint.name}** (${sprintDay(sprint.startAt)} a ${sprintDay(sprint.endAt)})${sprint.goal ? `: ${sprint.goal}` : ""}`);
    lines.push("");
  }
  const sprintName = new Map(sprints.map((sprint) => [sprint.id, sprint.name]));
  const walk = (task: ProjectTask, depth: number) => {
    const kids = childrenOf(plan, task.ref);
    const pad = "  ".repeat(depth);
    const after = task.dependsOn.length > 0 ? ` (depois de ${task.dependsOn.join(", ")})` : "";
    if (task.group) lines.push(`${pad}- **${task.title}** (módulo)${after}`);
    else if (kids.length > 0) lines.push(`${pad}- **${task.ref} · ${task.title}**${after}`);
    else {
      const chain = task.steps.map((step) => agentName(step.agentId)).join(" → ");
      const deps = task.dependsOn.length > 0 ? ` (depois de ${task.dependsOn.join(", ")})` : "";
      const sprint = task.sprintId && sprintName.has(task.sprintId) ? ` · ${sprintName.get(task.sprintId)}` : "";
      lines.push(`${pad}- **${task.ref} · ${task.title}** — ${agentName(task.ownerId)}${task.steps.length > 1 ? `; etapas: ${chain}` : ""}${deps}${sprint}`);
    }
    for (const child of kids) walk(child, depth + 1);
  };
  for (const top of childrenOf(plan)) walk(top, 0);
  return lines.join("\n");
}
