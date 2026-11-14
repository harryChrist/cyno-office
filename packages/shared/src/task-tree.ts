import type { Project, ProjectTask, ProjectTaskStatus } from "./projects";
import { PROJECT_LIMITS } from "./projects";

/**
 * Árvore de tarefas do projeto: funções puras sobre `Project.tasks` (cada tarefa guarda `parent`, o
 * `ref` do pai; ausente = filha direta do projeto). Só as FOLHAS executam; entregável (`group`) e pai
 * têm estado e responsáveis calculados aqui, nunca gravados. Sem `parent` em ninguém (todos os
 * projetos gravados até hoje), toda tarefa é folha e nada muda.
 */

type Tasks = Pick<Project, "tasks">;
const sortKey = (task: ProjectTask, index: number) => task.order ?? index * 1000;

/** Filhas diretas de `ref` (ausente = do projeto), por `order` e, no empate, pela posição na lista. */
export function childrenOf(project: Tasks, ref?: string): ProjectTask[] {
  return project.tasks
    .map((task, index) => ({ task, index }))
    .filter(({ task }) => (ref === undefined ? !task.parent : task.parent === ref))
    .sort((a, b) => sortKey(a.task, a.index) - sortKey(b.task, b.index) || a.index - b.index)
    .map(({ task }) => task);
}

/** Os `ref` que são pai de alguém. */
function parentRefs(tasks: readonly ProjectTask[]): Set<string> {
  const out = new Set<string>();
  for (const task of tasks) if (task.parent) out.add(task.parent);
  return out;
}

/** As folhas da lista: nem entregável (`group`) nem pai de alguém. */
export function leafTasks(tasks: readonly ProjectTask[]): ProjectTask[] {
  const parents = parentRefs(tasks);
  return tasks.filter((task) => !task.group && !parents.has(task.ref));
}

/** A tarefa executa (é folha)? */
export function isLeaf(project: Tasks, task: Pick<ProjectTask, "ref" | "group">): boolean {
  return !task.group && !project.tasks.some((candidate) => candidate.parent === task.ref);
}

/** Folhas do projeto inteiro ou da subárvore de `ref` (uma folha devolve ela mesma). Na ordem da árvore. */
export function leavesOf(project: Tasks, ref?: string): ProjectTask[] {
  const out: ProjectTask[] = [];
  const parents = parentRefs(project.tasks);
  const seen = new Set<string>();
  const walk = (node: ProjectTask) => {
    if (seen.has(node.ref)) return;
    seen.add(node.ref);
    if (!node.group && !parents.has(node.ref)) out.push(node);
    else for (const child of childrenOf(project, node.ref)) walk(child);
  };
  if (ref === undefined) for (const top of childrenOf(project)) walk(top);
  else {
    const node = project.tasks.find((task) => task.ref === ref);
    if (node) walk(node);
  }
  return out;
}

/** Profundidade abaixo do projeto: 1 = filha direta. `Infinity` se a cadeia de pais dá um ciclo; `ref` desconhecido = 0. */
export function depthOf(project: Tasks, ref: string): number {
  const byRef = new Map(project.tasks.map((task) => [task.ref, task]));
  const seen = new Set<string>();
  let depth = 0;
  let current = byRef.get(ref);
  while (current) {
    if (seen.has(current.ref)) return Number.POSITIVE_INFINITY;
    seen.add(current.ref);
    depth += 1;
    current = current.parent ? byRef.get(current.parent) : undefined;
  }
  return depth;
}

/** Do mais alto até a própria tarefa (o caminho "Front-End › Tela de login"). Ciclo ou pai que falta: pára onde dá. */
export function pathOf(project: Tasks, ref: string): ProjectTask[] {
  const byRef = new Map(project.tasks.map((task) => [task.ref, task]));
  const out: ProjectTask[] = [];
  const seen = new Set<string>();
  let current = byRef.get(ref);
  while (current && !seen.has(current.ref)) {
    seen.add(current.ref);
    out.unshift(current);
    current = current.parent ? byRef.get(current.parent) : undefined;
  }
  return out;
}

const isTerminal = (status: ProjectTaskStatus) => status === "concluida" || status === "cancelada";

/**
 * Estado calculado de um pai ou entregável a partir do estado das filhas (NÃO é gravado). Ordem:
 * todas terminadas => `concluida` (ou `cancelada` se nenhuma concluiu; com uma concluída e outra CANCELADA fica `esperando_voce`, "com pendência"); alguma `em_andamento`;
 * alguma `esperando_voce`; alguma `falhou`; alguma concluída e o resto pendente => `em_andamento`;
 * alguma `a_fazer`; senão `backlog`. Sem filhas = `backlog`.
 */
export function rollupStatus(children: readonly Pick<ProjectTask, "status">[]): ProjectTaskStatus {
  if (children.length === 0) return "backlog";
  const has = (status: ProjectTaskStatus) => children.some((child) => child.status === status);
  if (children.every((child) => isTerminal(child.status))) {
    if (!has("concluida")) return "cancelada";
    // Revisão 2, M5: uma subtarefa cancelada não deixa a mãe concluir sozinha: ela fica "com pendência" (esperando o dono ver, refazer ou pular).
    return has("cancelada") ? "esperando_voce" : "concluida";
  }
  if (has("em_andamento")) return "em_andamento";
  if (has("esperando_voce")) return "esperando_voce";
  if (has("falhou")) return "falhou";
  if (has("concluida")) return "em_andamento";
  if (has("a_fazer")) return "a_fazer";
  return "backlog";
}

/** Estado de uma tarefa na árvore: o gravado, se é folha; o calculado das filhas, se é pai ou entregável. */
export function statusOf(project: Tasks, task: ProjectTask): ProjectTaskStatus {
  const walk = (node: ProjectTask, seen: Set<string>): ProjectTaskStatus => {
    seen.add(node.ref);
    const children = childrenOf(project, node.ref).filter((child) => !seen.has(child.ref));
    if (!node.group && children.length === 0) return node.status;
    return rollupStatus(children.map((child) => ({ status: walk(child, seen) })));
  };
  return walk(task, new Set());
}

/**
 * `ref` das tarefas "prontas" para quem depende delas: a folha concluída e o pai/entregável cujas folhas
 * terminaram (todas concluídas ou canceladas, ao menos uma concluída). Uma dependência que aponta para
 * um pai espera todas as folhas dele.
 */
export function completedRefs(project: Tasks): Set<string> {
  const out = new Set<string>();
  for (const task of project.tasks) if (statusOf(project, task) === "concluida") out.add(task.ref);
  return out;
}

/** Agentes de um nó, sem repetir: o dono e os das etapas; no pai, depois os das filhas, na ordem da árvore. */
function agentsOf(project: Tasks, node: ProjectTask, seen = new Set<string>()): string[] {
  if (seen.has(node.ref)) return [];
  seen.add(node.ref);
  const out: string[] = [];
  const add = (id: string | undefined) => {
    if (id && !out.includes(id)) out.push(id);
  };
  add(node.ownerId);
  for (const step of node.steps) add(step.agentId);
  for (const child of childrenOf(project, node.ref)) for (const id of agentsOf(project, child, seen)) add(id);
  return out;
}

/** Quantos agentes distintos trabalham no nó (para o "+N" depois do teto). */
export function assigneeCount(project: Tasks, node: ProjectTask): number {
  return agentsOf(project, node).length;
}

/**
 * Responsáveis derivados (`ownerId`, depois os agentes das etapas e das filhas): ids únicos, em ordem,
 * no máximo `max` (padrão 3, só para telas apertadas; não existe limite de agentes por tarefa). Não existe campo gravado: um só lugar de verdade (`ownerId` + `steps`).
 */
export function assigneesOf(project: Tasks, node: ProjectTask, max: number = 3): string[] {
  return agentsOf(project, node).slice(0, max);
}

export type TreeProblems = { errors: string[]; warnings: string[] };

/** `ref` de todos os descendentes de `ref` (sem repetir, tolera ciclo). */
function descendantRefs(project: Tasks, ref: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>([ref]);
  const stack = [ref];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const task of project.tasks) {
      if (task.parent !== current || seen.has(task.ref)) continue;
      seen.add(task.ref);
      out.push(task.ref);
      stack.push(task.ref);
    }
  }
  return out;
}

/**
 * Confere a árvore (erros em inglês, para o modelo corrigir): `group` só em profundidade 1 e sem
 * `steps`; folha com `steps` vazios; `parent` inexistente ou ciclo; profundidade acima de 3; mais de
 * 200 nós ou 40 filhas; `sprintId` inexistente ou em quem não é folha; mais de 12 subtarefas numa
 * tarefa (teto técnico contra erro); mais de 5 etiquetas; `dependsOn` que aponta para um descendente. Dependência
 * de uma sprint posterior vira aviso (não bloqueia).
 */
export function validateTree(project: Pick<Project, "tasks" | "sprints" | "labels">): TreeProblems {
  const errors: string[] = [];
  const warnings: string[] = [];
  const tasks = project.tasks;
  const byRef = new Map(tasks.map((task) => [task.ref, task]));
  if (tasks.length > PROJECT_LIMITS.nodes) errors.push(`At most ${PROJECT_LIMITS.nodes} nodes per project (deliverables count)`);
  const parents = parentRefs(tasks);
  const sprints = new Map((project.sprints ?? []).map((sprint) => [sprint.id, sprint]));
  const labelIds = project.labels ? new Set(project.labels.map((label) => label.id)) : undefined;
  const cyclic = new Set<string>();
  const children = new Map<string, number>();
  for (const task of tasks) {
    children.set(task.parent ?? "", (children.get(task.parent ?? "") ?? 0) + 1);
    const label = `Task ${task.ref}`;
    if (task.parent !== undefined && !byRef.has(task.parent)) errors.push(`${label}: parent "${task.parent}" does not exist`);
    if (task.parent === task.ref) errors.push(`${label}: cannot be its own parent`);
    const depth = depthOf(project, task.ref);
    if (depth === Number.POSITIVE_INFINITY) {
      cyclic.add(task.ref);
      if (task.parent !== task.ref) errors.push(`${label}: the parent chain forms a cycle`);
      continue;
    }
    if (depth > PROJECT_LIMITS.depth) errors.push(`${label}: nested ${depth} levels deep (at most ${PROJECT_LIMITS.depth} below the project: deliverable > task > subtask)`);
    if (task.group) {
      if (depth !== 1) errors.push(`${label}: a deliverable (group) can only sit directly under the project`);
      if (task.steps.length > 0) errors.push(`${label}: a deliverable (group) has no steps; it never runs`);
    } else if (!parents.has(task.ref) && task.steps.length === 0) {
      errors.push(`${label}: a leaf task needs at least one step`);
    }
    if (task.sprintId !== undefined) {
      if (task.group || parents.has(task.ref)) errors.push(`${label}: only leaf tasks go in a sprint (the parent shows the sprints of its children)`);
      if (!sprints.has(task.sprintId)) errors.push(`${label}: sprint "${task.sprintId}" does not exist`);
    }
    if ((task.labels?.length ?? 0) > PROJECT_LIMITS.labelsPerTask) errors.push(`${label}: at most ${PROJECT_LIMITS.labelsPerTask} labels per task`);
    if (labelIds) for (const id of task.labels ?? []) if (!labelIds.has(id)) errors.push(`${label}: label "${id}" does not exist in the project`);
  }
  for (const [ref, count] of children) if (count > PROJECT_LIMITS.children) errors.push(`${ref === "" ? "The project" : `Task ${ref}`} has ${count} children (at most ${PROJECT_LIMITS.children})`);
  for (const task of tasks) {
    if (cyclic.has(task.ref)) continue;
    const depth = depthOf(project, task.ref);
    if (depth >= 2 && depth <= PROJECT_LIMITS.depth) {
      const total = childrenOf(project, task.ref).length;
      if (total > PROJECT_LIMITS.subtasksPerTask) errors.push(`Task ${task.ref}: ${total} subtasks (at most ${PROJECT_LIMITS.subtasksPerTask} per task; group the work into fewer subtasks or split the task)`);
    }
    const descendants = new Set(descendantRefs(project, task.ref));
    for (const dep of task.dependsOn) {
      if (descendants.has(dep)) errors.push(`Task ${task.ref}: depends on its own descendant "${dep}"`);
      const mine = task.sprintId ? sprints.get(task.sprintId) : undefined;
      const other = byRef.get(dep);
      const theirs = other?.sprintId ? sprints.get(other.sprintId) : undefined;
      if (mine && theirs && theirs.order > mine.order) warnings.push(`${task.ref} is in ${mine.name} and depends on ${dep}, which is in ${theirs.name}`);
    }
  }
  return { errors, warnings };
}

type Progress = { done: number; total: number; skipped: number };

function progressOf(all: readonly ProjectTask[]): Progress {
  const leaves = all.filter((task) => !task.archived);
  const skipped = leaves.filter((task) => task.status === "concluida" && task.skipped).length;
  const counted = leaves.filter((task) => task.status !== "cancelada" && !(task.status === "concluida" && task.skipped));
  return { done: counted.filter((task) => task.status === "concluida").length, total: counted.length, skipped };
}

/** Progresso de uma subárvore (ou do projeto): folhas concluídas e total, sem canceladas nem puladas (que contam à parte). "3 de 5". */
export function treeProgress(project: Tasks, ref?: string): Progress {
  return progressOf(leavesOf(project, ref));
}

/** Progresso de uma sprint: as folhas com aquele `sprintId`. */
export function sprintProgress(project: Tasks, sprintId: string): Progress {
  return progressOf(leavesOf(project).filter((task) => task.sprintId === sprintId));
}

/** Próximo `ref` livre do projeto ("T1", "T2"…): o maior `T<n>` que existe mais um (e nunca repete um `ref` já usado). */
export function nextTaskRef(project: Tasks): string {
  const used = new Set(project.tasks.map((task) => task.ref));
  let next = 1;
  for (const task of project.tasks) {
    const match = /^T(\d+)$/.exec(task.ref);
    if (match) next = Math.max(next, Number(match[1]) + 1);
  }
  while (used.has(`T${next}`)) next += 1;
  return `T${next}`;
}

/** `ref` do nó e de todos os descendentes (o próprio primeiro), na ordem da árvore. */
export function subtreeRefs(project: Tasks, ref: string): string[] {
  const out: string[] = [];
  const walk = (current: string) => {
    if (out.includes(current)) return;
    out.push(current);
    for (const child of childrenOf(project, current)) walk(child.ref);
  };
  walk(ref);
  return out;
}
