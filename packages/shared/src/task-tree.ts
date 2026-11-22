import type { Project, ProjectTask, ProjectTaskStatus } from "./projects";
import { findDependencyCycle, PROJECT_LIMITS, PROJECT_SAFETY } from "./projects";
import { effectiveDeps } from "./task-flow";

/**
 * Árvore de tarefas do projeto: funções puras sobre `Project.tasks` (cada tarefa guarda `parent`, o
 * `ref` do pai; ausente = filha direta do projeto). Só as FOLHAS executam; módulo (`group`, em qualquer
 * profundidade) e pai têm estado e responsáveis calculados aqui, nunca gravados. Sem `parent` em ninguém (todos os
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

/** Filhas diretas por pai (`""` = o projeto), já na ordem da árvore: um índice só, em vez de varrer a lista a cada nó. */
function childIndex(tasks: readonly ProjectTask[]): Map<string, ProjectTask[]> {
  const groups = new Map<string, { task: ProjectTask; index: number }[]>();
  tasks.forEach((task, index) => {
    const key = task.parent ?? "";
    const list = groups.get(key);
    if (list) list.push({ task, index });
    else groups.set(key, [{ task, index }]);
  });
  const out = new Map<string, ProjectTask[]>();
  for (const [key, list] of groups) {
    list.sort((a, b) => sortKey(a.task, a.index) - sortKey(b.task, b.index) || a.index - b.index);
    out.set(
      key,
      list.map(({ task }) => task),
    );
  }
  return out;
}

/** Folhas do projeto inteiro ou da subárvore de `ref` (uma folha devolve ela mesma). Na ordem da árvore. */
export function leavesOf(project: Tasks, ref?: string): ProjectTask[] {
  const out: ProjectTask[] = [];
  const index = childIndex(project.tasks);
  const seen = new Set<string>();
  const walk = (node: ProjectTask) => {
    if (seen.has(node.ref)) return;
    seen.add(node.ref);
    const kids = index.get(node.ref);
    if (!node.group && !kids) out.push(node);
    else for (const child of kids ?? []) walk(child);
  };
  if (ref === undefined) for (const top of index.get("") ?? []) walk(top);
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

/** A folha terminou: concluída (inclui a pulada), cancelada ou arquivada. */
function leafFinished(task: ProjectTask): boolean {
  return task.archived === true || task.status === "concluida" || task.status === "cancelada";
}

/** A tarefa/módulo tem filhas ou é um módulo vazio (`group`): é contêiner, não executa. */
export function isContainer(project: Tasks, node: ProjectTask): boolean {
  return !isLeaf(project, node);
}

/**
 * O nó terminou: a folha concluída (a pulada é concluída), cancelada ou arquivada; o contêiner (módulo ou mãe) quando TODAS as
 * folhas dele terminaram. Contêiner sem nenhuma folha (módulo vazio) ainda não terminou. `ref` desconhecido: false.
 */
export function nodeDone(project: Tasks, ref: string): boolean {
  const node = project.tasks.find((task) => task.ref === ref);
  if (!node) return false;
  if (isLeaf(project, node)) return leafFinished(node);
  const leaves = leavesOf(project, ref);
  return leaves.length > 0 && leaves.every(leafFinished);
}

/**
 * `ref` dos nós "prontos" para quem depende deles: a folha concluída (ou pulada) e o contêiner (módulo ou mãe) em que toda folha terminou
 * (`nodeDone`) sem nenhuma cancelada: uma folha cancelada ou que falhou segura quem depende (fica "travada", `deadDependencies`), como sempre.
 */
export function completedRefs(project: Tasks): Set<string> {
  const index = childIndex(project.tasks);
  const out = new Set<string>();
  const memo = new Map<string, { leaves: number; open: number; cancelled: number }>();
  const tally = (node: ProjectTask, seen: Set<string>): { leaves: number; open: number; cancelled: number } => {
    const known = memo.get(node.ref);
    if (known) return known;
    const kids = (index.get(node.ref) ?? []).filter((child) => !seen.has(child.ref));
    let result: { leaves: number; open: number; cancelled: number };
    if (!node.group && !index.has(node.ref)) {
      const cancelled = node.status === "cancelada" ? 1 : 0;
      result = { leaves: 1, open: leafFinished(node) ? 0 : 1, cancelled };
    } else {
      const next = new Set(seen).add(node.ref);
      result = { leaves: 0, open: 0, cancelled: 0 };
      for (const child of kids) {
        const part = tally(child, next);
        result.leaves += part.leaves;
        result.open += part.open;
        result.cancelled += part.cancelled;
      }
    }
    memo.set(node.ref, result);
    return result;
  };
  for (const task of project.tasks) {
    if (!task.group && !index.has(task.ref)) {
      if (task.status === "concluida") out.add(task.ref);
      continue;
    }
    const total = tally(task, new Set());
    if (total.leaves > 0 && total.open === 0 && total.cancelled === 0) out.add(task.ref);
  }
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
function descendantRefs(index: Map<string, ProjectTask[]>, ref: string): Set<string> {
  const out = new Set<string>();
  const stack = [ref];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const child of index.get(current) ?? []) {
      if (out.has(child.ref) || child.ref === ref) continue;
      out.add(child.ref);
      stack.push(child.ref);
    }
  }
  return out;
}

/**
 * Confere a árvore (erros em inglês, para o modelo corrigir): `group` (módulo) em QUALQUER profundidade, mas sem `steps`; folha com `steps` vazios;
 * `parent` inexistente ou ciclo; `sprintId` inexistente ou em quem não é folha; mais de 5 etiquetas; `dependsOn` que aponta para um descendente;
 * dependências que formam um ciclo (também por módulos e tarefas-mãe). Sem teto de itens, de níveis nem de filhas: só a rede de segurança
 * `PROJECT_SAFETY` (itens e profundidade) contra erro grosseiro. Dependência de uma sprint posterior vira aviso (não bloqueia).
 */
export function validateTree(project: Pick<Project, "tasks" | "sprints" | "labels">): TreeProblems {
  const errors: string[] = [];
  const warnings: string[] = [];
  const tasks = project.tasks;
  const byRef = new Map(tasks.map((task) => [task.ref, task]));
  if (tasks.length > PROJECT_SAFETY.nodes) errors.push(`The project would have ${tasks.length} items (safety net: at most ${PROJECT_SAFETY.nodes} items per project). Split it into more than one project`);
  const parents = parentRefs(tasks);
  const sprints = new Map((project.sprints ?? []).map((sprint) => [sprint.id, sprint]));
  const labelIds = project.labels ? new Set(project.labels.map((label) => label.id)) : undefined;
  const cyclic = new Set<string>();
  let tooDeep = 0;
  const depthIn = (ref: string): number => {
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
  };
  for (const task of tasks) {
    const label = `Task ${task.ref}`;
    if (task.parent !== undefined && !byRef.has(task.parent)) errors.push(`${label}: parent "${task.parent}" does not exist`);
    if (task.parent === task.ref) errors.push(`${label}: cannot be its own parent`);
    const depth = depthIn(task.ref);
    if (depth === Number.POSITIVE_INFINITY) {
      cyclic.add(task.ref);
      if (task.parent !== task.ref) errors.push(`${label}: the parent chain forms a cycle`);
      continue;
    }
    if (depth > PROJECT_SAFETY.depth) {
      tooDeep += 1;
      if (tooDeep === 1) errors.push(`${label}: nested ${depth} levels deep (safety net: at most ${PROJECT_SAFETY.depth} levels below the project). Flatten the structure`);
    }
    if (task.group) {
      if (task.steps.length > 0) errors.push(`${label}: a module (group) has no steps; it never runs`);
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
  const index = tasks.some((task) => task.dependsOn.length > 0) ? childIndex(tasks) : new Map<string, ProjectTask[]>();
  for (const task of tasks) {
    if (cyclic.has(task.ref) || task.dependsOn.length === 0) continue;
    const descendants = descendantRefs(index, task.ref);
    const ancestors = new Set<string>();
    for (let up = task.parent ? byRef.get(task.parent) : undefined; up && !ancestors.has(up.ref); up = up.parent ? byRef.get(up.parent) : undefined) ancestors.add(up.ref);
    for (const dep of task.dependsOn) {
      if (descendants.has(dep)) errors.push(`Task ${task.ref}: depends on its own descendant "${dep}"`);
      if (ancestors.has(dep)) errors.push(`Task ${task.ref}: depends on its own ancestor "${dep}" (it only finishes after this one)`);
      const mine = task.sprintId ? sprints.get(task.sprintId) : undefined;
      const other = byRef.get(dep);
      const theirs = other?.sprintId ? sprints.get(other.sprintId) : undefined;
      if (mine && theirs && theirs.order > mine.order) warnings.push(`${task.ref} is in ${mine.name} and depends on ${dep}, which is in ${theirs.name}`);
    }
  }
  if (cyclic.size === 0 && errors.length === 0 && index.size > 0) {
    const cycle = dependencyCycle(project);
    if (cycle) errors.push(`The dependencies form a cycle: ${cycle.join(" → ")}. Remove one of them`);
  }
  return { errors, warnings };
}

/**
 * Ciclo de dependências no grafo EFETIVO das folhas (cada folha espera as folhas das suas dependências e das do módulo/mãe de que é entrada),
 * ou `null`. Pega "A espera B e B espera A" também por módulos e tarefas-mãe. Devolve os refs das folhas, a primeira repetida no fim.
 */
export function dependencyCycle(project: Tasks): string[] | null {
  const graph = new Map<string, string[]>();
  for (const leaf of leavesOf(project)) {
    const waits = new Set<string>();
    for (const dep of effectiveDeps(project, leaf)) for (const found of leavesOf(project, dep)) if (found.ref !== leaf.ref) waits.add(found.ref);
    graph.set(leaf.ref, [...waits]);
  }
  return findDependencyCycle(graph);
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

/** Progresso de um módulo (ou de uma tarefa-mãe): as folhas dentro dele, submódulos incluídos (= `treeProgress(project, ref)`). */
export function moduleProgress(project: Tasks, ref: string): { done: number; total: number; skipped: number } {
  return treeProgress(project, ref);
}

/** Progresso do PROJETO na unidade que ele usa: módulos de primeiro nível ou tarefas. */
export type UnitProgress = { done: number; total: number; skipped: number; unit: "modulos" | "tarefas" };

/**
 * Progresso do projeto por unidade. Sem nenhum módulo na raiz: as tarefas (folhas), como sempre ("12 de 40 tarefas"). Com módulos na raiz
 * (`group` ou tarefa com filhas): cada módulo e cada tarefa solta na raiz conta como uma unidade ("3 de 8 módulos", unidade `modulos` também no
 * misto). Módulo concluído = todas as folhas contáveis dele concluídas; módulo vazio conta como unidade pendente. Fora da conta, como sempre:
 * canceladas, puladas (contam em `skipped`) e arquivadas; módulo cujas folhas todas caíram fora também sai.
 */
export function projectUnitProgress(project: Tasks): UnitProgress {
  const index = childIndex(project.tasks);
  const roots = (index.get("") ?? []).filter((task) => !task.archived);
  const hasContainer = roots.some((task) => task.group || index.has(task.ref));
  if (!hasContainer) return { ...treeProgress(project), unit: "tarefas" };
  let done = 0;
  let total = 0;
  let skipped = 0;
  for (const root of roots) {
    if (!root.group && !index.has(root.ref)) {
      if (root.status === "cancelada") continue;
      if (root.status === "concluida" && root.skipped) skipped += 1;
      else {
        total += 1;
        if (root.status === "concluida") done += 1;
      }
      continue;
    }
    const leaves = leavesOf(project, root.ref);
    if (leaves.length === 0) {
      total += 1;
      continue;
    }
    const progress = progressOf(leaves);
    if (progress.total === 0) {
      if (progress.skipped > 0) skipped += 1;
      continue;
    }
    total += 1;
    if (progress.done === progress.total) done += 1;
  }
  return { done, total, skipped, unit: "modulos" };
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
