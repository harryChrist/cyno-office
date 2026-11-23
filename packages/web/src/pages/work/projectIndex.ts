import {
  joinNames,
  PRIORITY_RANK,
  releaseHold,
  type Project,
  type ProjectPriority,
  type ProjectTask,
  type ProjectTaskStatus,
  type ReleaseState,
  type UnitProgress,
} from "@cyno/shared";
import { kidsOf, type TreeIndex } from "./treeIndex";

/**
 * Índice único de um projeto para a tela: montado uma vez por versão de `project.tasks` em O(n),
 * sem varreduras repetidas nem laços quadráticos. Alimenta o cabeçalho, a árvore (`buildTreeRows`),
 * os filtros, a seleção em lote, o menu da linha e o arrasto.
 */

export type NodeAgg = {
  leaves: number;
  /** Concluídas e total da conta de progresso (sem canceladas nem puladas). */
  done: number;
  counted: number;
  skipped: number;
  /** Para o resumo da mãe: concluídas e não canceladas. */
  concluded: number;
  notCancelled: number;
  cancelled: number;
  failed: number;
  /** Quantas folhas na subárvore estão travadas por dependência morta (cancelada ou que falhou). */
  deadBlockedCount: number;
  /** Folhas que ainda não terminaram (nem concluída nem cancelada). */
  unfinished: number;
  /** O estado para mostrar: o gravado na folha (travada vira "esperando você"), o calculado nos contêineres. */
  status: ProjectTaskStatus;
  waiting: number;
  /** Alguma folha da subárvore tem bloqueio externo (cota, acesso ou outro agente). */
  blocked: boolean;
  /** Folhas abertas (não concluídas/canceladas) e quantas delas estão Planejadas (`releaseHold`). */
  openLeaves: number;
  plannedOpenLeaves: number;
  /** Quantas folhas liberadas ainda na fila podem ser seguradas de volta (`isHoldable`). */
  holdableLeaves: number;
  sprints: string[];
  dueMax?: string;
  finishedMax: string;
  best: ProjectPriority | null;
  assignees: string[];
  runners: string[];
};

export type ProjectIndex = {
  /** Tarefas não arquivadas, na ordem original. */
  liveTasks: readonly ProjectTask[];
  /** Índice por `ref` e filhos diretos ordenados por `order`. */
  tree: TreeIndex;
  /** Todas as folhas vivas, na ordem da árvore (DFS). */
  leaves: readonly ProjectTask[];
  /** `ref` das folhas vivas (O(1)). */
  leafSet: ReadonlySet<string>;
  /** Posição de cada folha na ordem da árvore (para ordenar fechos de pré-requisitos). */
  leafOrder: ReadonlyMap<string, number>;
  /** Resumo agregado por `ref` (calculado uma única vez de baixo para cima). */
  agg: ReadonlyMap<string, NodeAgg>;
  /** `ref` das folhas travadas por dependência cancelada ou que falhou. */
  deadBlockedLeaves: ReadonlySet<string>;
  /** Progresso do projeto na unidade do cabeçalho (módulos de primeiro nível ou tarefas). */
  unitProgress: UnitProgress;
  /** Folhas que ainda não terminaram (nem concluída, cancelada ou falhou). */
  openLeafCount: number;
  /** Todos os responsáveis do projeto, sem repetir, na ordem das raízes. */
  agentIds: readonly string[];
  /** `taskId` de todas as etapas (inclusive arquivadas), para cruzar com "Para você" em O(1). */
  stepTaskIds: ReadonlySet<string>;
  /** Folhas abertas liberadas e Planejadas (cabeçalho e ritmo). */
  releaseCounts: { released: number; planned: number };
  /** Alguma tarefa viva tem `released === false`. */
  anyPlanned: boolean;
  /** Alguma tarefa viva tem `dependsOn.length > 0`. */
  anyDeps: boolean;
  /** Cache preguiçoso: posição na fila do agente dono (só calculado quando alguma linha precisa). */
  queuePositions: () => ReadonlyMap<string, number>;
  /** Folhas da subárvore de `ref` (cacheado sob demanda). */
  leavesUnder: (ref: string) => readonly ProjectTask[];
  /** Folhas de entrada de um contêiner (cacheado sob demanda). */
  entryRefsOf: (containerRef: string) => ReadonlySet<string>;
  /** Dependências efetivas de uma tarefa (as dela + as dos ancestrais de que é folha de entrada). */
  effectiveDepsOf: (node: Pick<ProjectTask, "ref" | "dependsOn">) => string[];
};

const sortKey = (task: ProjectTask, index: number) => task.order ?? index * 1000;

/** Estado de liberação de um contêiner a partir do agregado já pronto (O(1)). */
export function containerReleaseFromAgg(summary: NodeAgg | undefined): ReleaseState | undefined {
  if (!summary || summary.openLeaves === 0) return undefined;
  if (summary.plannedOpenLeaves === summary.openLeaves) return "planejada";
  if (summary.plannedOpenLeaves === 0) return "liberada";
  return "mista";
}

/** Estado de liberação de qualquer nó (folha ou contêiner) em O(1) usando o índice. */
export function releaseStateIn(index: ProjectIndex, ref: string): ReleaseState | undefined {
  const node = index.tree.byRef.get(ref);
  if (!node) return undefined;
  if (index.leafSet.has(ref)) {
    const finished = node.archived === true || node.status === "concluida" || node.status === "cancelada";
    return !finished && releaseHold(node) !== undefined ? "planejada" : "liberada";
  }
  return containerReleaseFromAgg(index.agg.get(ref));
}

/** O nó terminou (folha concluída/cancelada, ou contêiner com ao menos 1 folha e todas terminadas)? O(1). */
export function nodeDoneIn(index: ProjectIndex, ref: string): boolean {
  const node = index.tree.byRef.get(ref);
  if (!node) return false;
  const summary = index.agg.get(ref);
  if (!summary) return false;
  return summary.leaves > 0 && summary.unfinished === 0;
}

/** O nó está pronto para destravar dependentes (como `completedRefs` do shared: sem canceladas)? O(1). */
export function isCompletedIn(index: ProjectIndex, ref: string): boolean {
  const summary = index.agg.get(ref);
  if (!summary) return false;
  return summary.leaves > 0 && summary.unfinished === 0 && summary.cancelled === 0;
}

/** Mesma lógica do `rollupStatus` do shared, sem alocar array nem varrer várias vezes. */
function rollupFromFlags(
  count: number,
  allTerminal: boolean,
  hasDone: boolean,
  hasCancelled: boolean,
  hasRunning: boolean,
  hasWaiting: boolean,
  hasFailed: boolean,
  hasTodo: boolean,
): ProjectTaskStatus {
  if (count === 0) return "backlog";
  if (allTerminal) {
    if (!hasDone) return "cancelada";
    return hasCancelled ? "esperando_voce" : "concluida";
  }
  if (hasRunning) return "em_andamento";
  if (hasWaiting) return "esperando_voce";
  if (hasFailed) return "falhou";
  if (hasDone) return "em_andamento";
  if (hasTodo) return "a_fazer";
  return "backlog";
}

/** Junta listas pequenas de ids sem repetir, mantendo a ordem, em O(total) com Set (com atalho para folhas de 1 agente). */
function mergeUnique(first: string | undefined, steps: readonly { agentId: string }[], childLists: readonly (readonly string[])[]): string[] {
  if (childLists.length === 0) {
    if (steps.length === 0) return first ? [first] : [];
    if (steps.length === 1) {
      const a = first || "";
      const b = steps[0]!.agentId || "";
      if (!a && !b) return [];
      if (!b || a === b) return [a];
      if (!a) return [b];
      return [a, b];
    }
  }
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (id: string | undefined) => {
    if (id && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  };
  add(first);
  for (const step of steps) add(step.agentId);
  for (const list of childLists) for (const id of list) add(id);
  return out;
}

function mergeUniqueLists(childLists: readonly (readonly string[])[]): string[] {
  if (childLists.length === 0) return [];
  if (childLists.length === 1) return [...childLists[0]!];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of childLists) {
    for (const id of list) {
      if (id && !seen.has(id)) {
        seen.add(id);
        out.push(id);
      }
    }
  }
  return out;
}

const isFinishedLeafStatus = (status: ProjectTaskStatus): boolean => status === "concluida" || status === "cancelada";

/** Constrói o índice completo do projeto em uma passagem O(n). */
export function buildProjectIndex(tasks: readonly ProjectTask[]): ProjectIndex {
  const liveTasks: ProjectTask[] = [];
  const byRef = new Map<string, ProjectTask>();
  const grouped = new Map<string, { task: ProjectTask; index: number; key: number }[]>();
  const stepTaskIds = new Set<string>();
  let anyPlanned = false;
  let anyDeps = false;
  let anyDead = false;

  for (let i = 0; i < tasks.length; i += 1) {
    const task = tasks[i]!;
    for (const step of task.steps) if (step.taskId !== undefined) stepTaskIds.add(step.taskId);
    if (task.archived) continue;
    liveTasks.push(task);
    byRef.set(task.ref, task);
    if (task.released === false) anyPlanned = true;
    if (task.dependsOn.length > 0) anyDeps = true;
    if (task.status === "cancelada" || task.status === "falhou") anyDead = true;
    const parent = task.parent ?? "";
    const entry = { task, index: liveTasks.length - 1, key: sortKey(task, liveTasks.length - 1) };
    const list = grouped.get(parent);
    if (list) list.push(entry);
    else grouped.set(parent, [entry]);
  }

  const kids = new Map<string, readonly ProjectTask[]>();
  for (const [parent, list] of grouped) {
    if (list.length > 1) list.sort((a, b) => a.key - b.key || a.index - b.index);
    kids.set(parent, list.map((item) => item.task));
  }
  const tree: TreeIndex = { byRef, kids };

  const leavesCache = new Map<string, ProjectTask[]>();
  const leavesUnder = (ref: string): readonly ProjectTask[] => {
    const cached = leavesCache.get(ref);
    if (cached) return cached;
    const start = byRef.get(ref);
    if (!start) return [];
    const out: ProjectTask[] = [];
    const seen = new Set<string>();
    const walk = (node: ProjectTask) => {
      if (seen.has(node.ref)) return;
      seen.add(node.ref);
      const children = kidsOf(tree, node.ref);
      if (node.group !== true && children.length === 0) out.push(node);
      else for (const child of children) walk(child);
    };
    walk(start);
    leavesCache.set(ref, out);
    return out;
  };

  const entryCache = new Map<string, Set<string>>();
  const entryRefsOf = (containerRef: string): ReadonlySet<string> => {
    const cached = entryCache.get(containerRef);
    if (cached) return cached;
    const subLeaves = leavesUnder(containerRef);
    const inside = new Set<string>([containerRef]);
    const stack = [containerRef];
    while (stack.length > 0) {
      for (const child of kidsOf(tree, stack.pop()!)) {
        if (inside.has(child.ref)) continue;
        inside.add(child.ref);
        stack.push(child.ref);
      }
    }
    const entries = new Set<string>();
    for (const leaf of subLeaves) {
      let waitsInternal = false;
      const seen = new Set<string>([leaf.ref]);
      for (let cur: ProjectTask | undefined = leaf; cur && cur.ref !== containerRef; cur = cur.parent ? byRef.get(cur.parent) : undefined) {
        if (cur !== leaf) {
          if (seen.has(cur.ref)) break;
          seen.add(cur.ref);
        }
        for (const dep of cur.dependsOn) {
          if (inside.has(dep)) {
            waitsInternal = true;
            break;
          }
        }
        if (waitsInternal) break;
      }
      if (!waitsInternal) entries.add(leaf.ref);
    }
    if (entries.size === 0 && subLeaves[0]) entries.add(subLeaves[0].ref);
    entryCache.set(containerRef, entries);
    return entries;
  };

  let anyContainerDeps = false;
  for (const task of liveTasks) {
    if (task.dependsOn.length > 0 && (task.group === true || kids.has(task.ref))) {
      anyContainerDeps = true;
      break;
    }
  }

  const effectiveDepsOf = (node: Pick<ProjectTask, "ref" | "dependsOn">): string[] => {
    if (!anyDeps) return [];
    if (!anyContainerDeps) return [...node.dependsOn];
    const full = byRef.get(node.ref);
    if (!full?.parent) return [...node.dependsOn];
    // Verifica primeiro se algum ancestral tem dependência (evita alocar Sets no caminho comum).
    let hasAncDep = false;
    let guard = 0;
    for (let up = byRef.get(full.parent); up && guard < 64; up = up.parent ? byRef.get(up.parent) : undefined, guard += 1) {
      if (up.dependsOn.length > 0) {
        hasAncDep = true;
        break;
      }
      if (up.ref === node.ref) break;
    }
    if (!hasAncDep) return [...node.dependsOn];
    const out = [...node.dependsOn];
    const seen = new Set<string>([node.ref]);
    const added = new Set(out);
    for (let up = byRef.get(full.parent); up && !seen.has(up.ref); up = up.parent ? byRef.get(up.parent) : undefined) {
      seen.add(up.ref);
      if (up.dependsOn.length === 0) continue;
      if (!entryRefsOf(up.ref).has(node.ref)) continue;
      for (const dep of up.dependsOn) {
        if (!added.has(dep)) {
          added.add(dep);
          out.push(dep);
        }
      }
    }
    return out;
  };

  // Passo prévio só quando há tanto dependências quanto itens cancelados/falhos: identifica folhas travadas em O(n + e).
  const deadBlockedLeaves = new Set<string>();
  if (anyDeps && anyDead) {
    const deadSub = new Map<string, boolean>();
    const activeDead = new Set<string>();
    const markDead = (node: ProjectTask): boolean => {
      const known = deadSub.get(node.ref);
      if (known !== undefined) return known;
      activeDead.add(node.ref);
      const rawChildren = kidsOf(tree, node.ref);
      let hasChild = false;
      let dead = false;
      for (const child of rawChildren) {
        if (activeDead.has(child.ref)) continue;
        hasChild = true;
        if (markDead(child)) dead = true;
      }
      if (node.group !== true && !hasChild) {
        dead = node.status === "cancelada" || node.status === "falhou";
      }
      activeDead.delete(node.ref);
      deadSub.set(node.ref, dead);
      return dead;
    };
    for (const top of kidsOf(tree)) markDead(top);
    for (const task of liveTasks) if (!deadSub.has(task.ref)) markDead(task);

    const checkLeaf = (node: ProjectTask, inheritedDeadDep: boolean) => {
      if (node.status !== "backlog" && node.status !== "a_fazer") return;
      for (const dep of node.dependsOn) {
        if (deadSub.get(dep)) {
          deadBlockedLeaves.add(node.ref);
          return;
        }
      }
      if (!inheritedDeadDep) return;
      const seen = new Set<string>([node.ref]);
      for (let up = node.parent ? byRef.get(node.parent) : undefined; up && !seen.has(up.ref); up = up.parent ? byRef.get(up.parent) : undefined) {
        seen.add(up.ref);
        if (up.dependsOn.length === 0) continue;
        if (!up.dependsOn.some((dep) => deadSub.get(dep))) continue;
        if (entryRefsOf(up.ref).has(node.ref)) {
          deadBlockedLeaves.add(node.ref);
          return;
        }
      }
    };
    const activeWalk = new Set<string>();
    const walkBlocked = (node: ProjectTask, inheritedDeadDep: boolean) => {
      activeWalk.add(node.ref);
      const rawChildren = kidsOf(tree, node.ref);
      let hasChild = false;
      const nextInherited = inheritedDeadDep || (node.dependsOn.length > 0 && node.dependsOn.some((dep) => deadSub.get(dep)));
      for (const child of rawChildren) {
        if (activeWalk.has(child.ref)) continue;
        hasChild = true;
        walkBlocked(child, nextInherited);
      }
      if (node.group !== true && !hasChild) checkLeaf(node, inheritedDeadDep);
      activeWalk.delete(node.ref);
    };
    for (const top of kidsOf(tree)) walkBlocked(top, false);
  }

  // Passagem única de baixo para cima: calcula `agg`, `leaves`, `leafSet`, `openLeafCount` e contagens de liberação.
  const agg = new Map<string, NodeAgg>();
  const leaves: ProjectTask[] = [];
  const leafSet = new Set<string>();
  const leafOrder = new Map<string, number>();
  let openLeafCount = 0;
  let releasedOpen = 0;
  let plannedOpen = 0;
  const activeAgg = new Set<string>();

  const walkAgg = (node: ProjectTask): NodeAgg => {
    activeAgg.add(node.ref);
    const rawChildren = kidsOf(tree, node.ref);
    let result: NodeAgg;
    if (node.group !== true && rawChildren.length === 0) {
      leafOrder.set(node.ref, leaves.length);
      leaves.push(node);
      leafSet.add(node.ref);
      const deadBlocked = deadBlockedLeaves.has(node.ref);
      const done = node.status === "concluida";
      const cancelled = node.status === "cancelada";
      const failed = node.status === "falhou";
      const skipped = done && node.skipped === true;
      const counted = !cancelled && !skipped;
      const finished = done || cancelled;
      const hold = !finished && releaseHold(node) !== undefined;
      const holdable = !finished && !hold && (node.status === "backlog" || node.status === "a_fazer");
      if (!done && !cancelled && !failed) openLeafCount += 1;
      if (!finished) {
        if (hold) plannedOpen += 1;
        else releasedOpen += 1;
      }
      result = {
        leaves: 1,
        done: counted && done ? 1 : 0,
        counted: counted ? 1 : 0,
        skipped: skipped ? 1 : 0,
        concluded: done ? 1 : 0,
        notCancelled: cancelled ? 0 : 1,
        cancelled: cancelled ? 1 : 0,
        failed: failed ? 1 : 0,
        deadBlockedCount: deadBlocked ? 1 : 0,
        unfinished: finished ? 0 : 1,
        status: deadBlocked ? "esperando_voce" : node.status,
        waiting: node.status === "esperando_voce" ? 1 : 0,
        blocked: node.blocked !== undefined && node.blocked.type !== "voce",
        openLeaves: finished ? 0 : 1,
        plannedOpenLeaves: hold ? 1 : 0,
        holdableLeaves: holdable ? 1 : 0,
        sprints: node.sprintId ? [node.sprintId] : [],
        ...(node.dueAt ? { dueMax: node.dueAt } : {}),
        finishedMax: node.finishedAt ?? "",
        best: node.priority,
        assignees: mergeUnique(node.ownerId, node.steps, []),
        runners: node.status === "em_andamento" && node.ownerId ? [node.ownerId] : [],
      };
    } else {
      let childCount = 0;
      let leafCount = 0;
      let doneCount = 0;
      let countedCount = 0;
      let skippedCount = 0;
      let concludedCount = 0;
      let notCancelledCount = 0;
      let cancelledCount = 0;
      let failedCount = 0;
      let deadBlockedCount = 0;
      let unfinishedCount = 0;
      let waitingCount = 0;
      let blockedAny = false;
      let openLeavesCount = 0;
      let plannedOpenCount = 0;
      let holdableCount = 0;
      let dueMax = "";
      let finishedMax = "";
      let best: ProjectPriority | null = null;
      let allTerminal = true;
      let hasDone = false;
      let hasCancelled = false;
      let hasRunning = false;
      let hasWaiting = false;
      let hasFailed = false;
      let hasTodo = false;
      const sprintLists: (readonly string[])[] = [];
      const assigneeLists: (readonly string[])[] = [];
      const runnerLists: (readonly string[])[] = [];

      for (const child of rawChildren) {
        if (activeAgg.has(child.ref)) continue;
        childCount += 1;
        const item = walkAgg(child);
        leafCount += item.leaves;
        doneCount += item.done;
        countedCount += item.counted;
        skippedCount += item.skipped;
        concludedCount += item.concluded;
        notCancelledCount += item.notCancelled;
        cancelledCount += item.cancelled;
        failedCount += item.failed;
        deadBlockedCount += item.deadBlockedCount;
        unfinishedCount += item.unfinished;
        waitingCount += item.waiting;
        if (item.blocked) blockedAny = true;
        openLeavesCount += item.openLeaves;
        plannedOpenCount += item.plannedOpenLeaves;
        holdableCount += item.holdableLeaves;
        if (item.dueMax && item.dueMax > dueMax) dueMax = item.dueMax;
        if (item.finishedMax > finishedMax) finishedMax = item.finishedMax;
        if (item.best && (best === null || PRIORITY_RANK[item.best] < PRIORITY_RANK[best])) best = item.best;
        const st = item.status;
        if (!isFinishedLeafStatus(st)) allTerminal = false;
        if (st === "concluida") hasDone = true;
        else if (st === "cancelada") hasCancelled = true;
        else if (st === "em_andamento") hasRunning = true;
        else if (st === "esperando_voce") hasWaiting = true;
        else if (st === "falhou") hasFailed = true;
        else if (st === "a_fazer") hasTodo = true;
        if (item.sprints.length > 0) sprintLists.push(item.sprints);
        if (item.assignees.length > 0) assigneeLists.push(item.assignees);
        if (item.runners.length > 0) runnerLists.push(item.runners);
      }
      if (best && node.priority !== "normal" && PRIORITY_RANK[node.priority] < PRIORITY_RANK[best]) best = node.priority;
      result = {
        leaves: leafCount,
        done: doneCount,
        counted: countedCount,
        skipped: skippedCount,
        concluded: concludedCount,
        notCancelled: notCancelledCount,
        cancelled: cancelledCount,
        failed: failedCount,
        deadBlockedCount,
        unfinished: unfinishedCount,
        status: rollupFromFlags(childCount, allTerminal, hasDone, hasCancelled, hasRunning, hasWaiting, hasFailed, hasTodo),
        waiting: waitingCount,
        blocked: blockedAny,
        openLeaves: openLeavesCount,
        plannedOpenLeaves: plannedOpenCount,
        holdableLeaves: holdableCount,
        sprints: sprintLists.length > 0 ? mergeUniqueLists(sprintLists) : [],
        ...(dueMax ? { dueMax } : {}),
        finishedMax,
        best,
        assignees: mergeUnique(node.ownerId, node.steps, assigneeLists),
        runners: runnerLists.length > 0 ? mergeUniqueLists(runnerLists) : [],
      };
    }
    activeAgg.delete(node.ref);
    agg.set(node.ref, result);
    return result;
  };

  const roots = kidsOf(tree);
  for (const top of roots) walkAgg(top);

  // Progresso por unidade (módulos de primeiro nível ou tarefas) e responsáveis do projeto em O(raízes).
  const hasContainer = roots.some((root) => root.group === true || kidsOf(tree, root.ref).length > 0);
  let unitProgress: UnitProgress;
  if (!hasContainer) {
    let done = 0;
    let total = 0;
    let skipped = 0;
    for (const root of roots) {
      if (root.status === "cancelada") continue;
      if (root.status === "concluida" && root.skipped) skipped += 1;
      else {
        total += 1;
        if (root.status === "concluida") done += 1;
      }
    }
    unitProgress = { done, total, skipped, unit: "tarefas" };
  } else {
    let done = 0;
    let total = 0;
    let skipped = 0;
    for (const root of roots) {
      if (!root.group && kidsOf(tree, root.ref).length === 0) {
        if (root.status === "cancelada") continue;
        if (root.status === "concluida" && root.skipped) skipped += 1;
        else {
          total += 1;
          if (root.status === "concluida") done += 1;
        }
        continue;
      }
      const summary = agg.get(root.ref);
      if (!summary || summary.leaves === 0) {
        total += 1;
        continue;
      }
      if (summary.counted === 0) {
        if (summary.skipped > 0) skipped += 1;
        continue;
      }
      total += 1;
      if (summary.done === summary.counted) done += 1;
    }
    unitProgress = { done, total, skipped, unit: "modulos" };
  }

  const agentIds = mergeUniqueLists(roots.map((root) => agg.get(root.ref)?.assignees ?? []));

  let queueCache: Map<string, number> | null = null;
  const queuePositions = (): ReadonlyMap<string, number> => {
    if (queueCache) return queueCache;
    const out = new Map<string, number>();
    const byOwner = new Map<string, ProjectTask[]>();
    for (const leaf of leaves) {
      if (!leaf.ownerId) continue;
      const list = byOwner.get(leaf.ownerId);
      if (list) list.push(leaf);
      else byOwner.set(leaf.ownerId, [leaf]);
    }
    for (const mine of byOwner.values()) {
      const running = mine.some((leaf) => leaf.status === "em_andamento" || leaf.status === "esperando_voce");
      const waiting = mine.filter((leaf) => leaf.status === "a_fazer").sort((a, b) => (a.waitingSince ?? "").localeCompare(b.waitingSince ?? ""));
      waiting.forEach((leaf, index) => {
        if (running || index > 0) out.set(leaf.ref, index + 1);
      });
    }
    queueCache = out;
    return out;
  };

  return {
    liveTasks,
    tree,
    leaves,
    leafSet,
    leafOrder,
    agg,
    deadBlockedLeaves,
    unitProgress,
    openLeafCount,
    agentIds,
    stepTaskIds,
    releaseCounts: { released: releasedOpen, planned: plannedOpen },
    anyPlanned,
    anyDeps,
    queuePositions,
    leavesUnder,
    entryRefsOf,
    effectiveDepsOf,
  };
}

/** Resumo de pendência de uma tarefa-mãe em O(1) a partir do agregado (idêntico ao `pendencySummary` do shared). */
export function pendencySummaryFromAgg(summary: NodeAgg): string | undefined {
  if (summary.leaves === 0) return undefined;
  const { concluded: done, cancelled, failed, deadBlockedCount: blocked } = summary;
  if (cancelled + failed + blocked === 0) return undefined;
  const parts = [`${done} de ${summary.leaves} ${done === 1 ? "pronta" : "prontas"}`];
  if (cancelled) parts.push(`${cancelled} ${cancelled === 1 ? "cancelada" : "canceladas"}`);
  if (failed) parts.push(failed === 1 ? "1 falhou" : `${failed} falharam`);
  if (blocked) parts.push(`${blocked} ${blocked === 1 ? "travada" : "travadas"}`);
  return parts.join(" · ");
}

/** Dependências mortas (cancelada ou falhou) de uma folha usando o índice (sem varrer o projeto). */
export function deadDependenciesIn(index: ProjectIndex, task: ProjectTask): ProjectTask[] {
  const out: ProjectTask[] = [];
  const seen = new Set<string>();
  for (const ref of index.effectiveDepsOf(task)) {
    const dep = index.tree.byRef.get(ref);
    if (!dep) continue;
    const candidates = index.leafSet.has(dep.ref) ? [dep] : index.leavesUnder(dep.ref);
    for (const leaf of candidates) {
      if ((leaf.status === "cancelada" || leaf.status === "falhou") && !seen.has(leaf.ref)) {
        seen.add(leaf.ref);
        out.push(leaf);
      }
    }
  }
  return out;
}

const article = (name: string): string => `${/a$/i.test(name.trim()) ? "a" : "o"} ${name}`;
const ofArticle = (name: string): string => `${/a$/i.test(name.trim()) ? "a" : "o"} ${name}`;

/** Versão indexada do `waitingText` do shared (O(dependências) em vez de O(projeto) por linha). */
export function waitingTextIn(index: ProjectIndex, task: ProjectTask, agentName: (id: string) => string, queuePosition?: number): string | null {
  if (task.status === "concluida" || task.status === "cancelada" || task.status === "falhou") return null;
  if (task.status === "em_andamento") return "fazendo agora";
  if (task.status === "esperando_voce") return "esperando você";
  if (index.leafSet.has(task.ref) && releaseHold(task)) return "planejada, ainda não liberada";
  if (index.deadBlockedLeaves.has(task.ref)) {
    const dead = deadDependenciesIn(index, task);
    const first = dead[0];
    if (first) {
      const verb = first.status === "falhou" ? "falhou" : "foi cancelada";
      return `travada: “${first.title}” ${verb}${dead.length > 1 ? ` (e mais ${dead.length - 1})` : ""}`;
    }
  }
  const pending: ProjectTask[] = [];
  const seenPending = new Set<string>();
  for (const ref of index.effectiveDepsOf(task)) {
    const dep = index.tree.byRef.get(ref);
    if (!dep || isCompletedIn(index, dep.ref)) continue;
    const open = index.leafSet.has(dep.ref) ? [dep] : index.leavesUnder(dep.ref).filter((leaf) => leaf.status !== "concluida" && leaf.status !== "cancelada");
    for (const leaf of open.length > 0 ? open : [dep]) {
      if (!seenPending.has(leaf.ref)) {
        seenPending.add(leaf.ref);
        pending.push(leaf);
      }
    }
  }
  if (pending.length > 0) {
    if (pending.length === 1) {
      const only = pending[0]!;
      const who = only.ownerId ? agentName(only.ownerId) : "";
      return who ? `espera ${article(who)} terminar “${only.title}”` : `espera “${only.title}”`;
    }
    const owners = [...new Set(pending.flatMap((leaf) => (leaf.ownerId ? [agentName(leaf.ownerId)] : [])))];
    return owners.length > 0 ? `espera ${joinNames(owners)}` : `espera ${pending.length} tarefas`;
  }
  if (task.status === "a_fazer") {
    const who = task.ownerId ? agentName(task.ownerId) : "";
    if (queuePosition !== undefined && who) return `na fila d${ofArticle(who)} (${queuePosition}ª)`;
    return "pronta para começar";
  }
  return null;
}

/** Fecho transitivo de pré-requisitos Planejados usando o índice (evita varrer o projeto inteiro por linha). */
export function prerequisiteClosureIn(index: ProjectIndex, refs: readonly string[]): string[] {
  if (!index.anyPlanned || !index.anyDeps) return [];
  const visited = new Set<string>();
  const queue: string[] = [];
  for (const ref of refs) {
    for (const leaf of index.leavesUnder(ref)) {
      if (visited.has(leaf.ref)) continue;
      visited.add(leaf.ref);
      queue.push(leaf.ref);
    }
  }
  const out = new Set<string>();
  let head = 0;
  while (head < queue.length) {
    const leaf = index.tree.byRef.get(queue[head++]!);
    if (!leaf) continue;
    for (const dep of index.effectiveDepsOf(leaf)) {
      for (const found of index.leavesUnder(dep)) {
        if (visited.has(found.ref)) continue;
        visited.add(found.ref);
        if (found.archived === true || found.status === "concluida" || found.status === "cancelada") continue;
        if (releaseHold(found) !== undefined) out.add(found.ref);
        queue.push(found.ref);
      }
    }
  }
  return [...out].sort((a, b) => (index.leafOrder.get(a) ?? 0) - (index.leafOrder.get(b) ?? 0));
}

/** Atalho para construir o índice a partir de um `Project` ou `{ tasks }`. */
export const projectIndexOf = (project: Pick<Project, "tasks">): ProjectIndex => buildProjectIndex(project.tasks);
