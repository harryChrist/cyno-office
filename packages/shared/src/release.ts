import type { Project, ProjectPriority, ProjectTask } from "./projects";
import { PRIORITY_RANK } from "./projects";
import { effectiveDeps } from "./task-flow";
import { childrenOf, isLeaf, leavesOf } from "./task-tree";

/**
 * LIBERAÇÃO ("criar não executa"): funções puras sobre `Project.tasks`. `ProjectTask.released` diz se a folha entra na fila
 * (`true` ou ausente = liberada, `false` = Planejada). NÃO confundir com `isPlanned(project)` (projects.ts), que é "o ciclo de vida do
 * plano cuida deste projeto". Nenhum estado novo foi criado: a folha Planejada segue `backlog`/`a_fazer` e o agendador só não a despacha.
 *
 * Prioridade efetiva de uma folha na ordem de liberação: a MAIS ALTA entre a dela e a dos contêineres (módulos e tarefas-mãe) acima
 * dela (alta > normal > baixa). É só da liberação: a ordem de urgência da fila (`compareWork`) não muda.
 */

type Tasks = Pick<Project, "tasks">;

/** A nota que a folha Planejada mostra (e que o agendador grava em `note` enquanto a segura). */
export const PLANNED_NOTE = "Planejada: libere para entrar na fila";

/** A tarefa está liberada? Sem o campo (dados antigos) = sim. */
export function isReleased(task: Pick<ProjectTask, "released">): boolean {
  return task.released !== false;
}

/**
 * O freio da liberação: a FOLHA Planejada (`released === false`) que ainda não começou não entra na fila. Quem já está
 * `em_andamento` (ou terminou) nunca é interrompido. Devolve a nota, ou undefined = pode seguir.
 */
export function releaseHold(task: Pick<ProjectTask, "released" | "status">): { note: string } | undefined {
  if (task.released !== false) return undefined;
  if (task.status === "em_andamento" || task.status === "concluida" || task.status === "cancelada") return undefined;
  return { note: PLANNED_NOTE };
}

/** A folha terminou (concluída, cancelada ou arquivada): fora da conta da liberação. */
function finished(task: ProjectTask): boolean {
  return task.archived === true || task.status === "concluida" || task.status === "cancelada";
}

/** Folha ainda Planejada: não terminou e o freio vale. */
function plannedLeaf(task: ProjectTask): boolean {
  return !finished(task) && releaseHold(task) !== undefined;
}

export type ReleaseState = "planejada" | "liberada" | "mista";

/**
 * Estado de liberação de um item. Folha: pelo campo (concluída ou em andamento conta como liberada). Contêiner: `planejada` se TODAS as
 * folhas dele que ainda não terminaram são Planejadas, `liberada` se todas estão liberadas, senão `mista`. Contêiner sem folhas, ou com todas
 * terminadas, e `ref` desconhecido: undefined.
 */
export function releaseState(project: Tasks, ref: string): ReleaseState | undefined {
  const node = project.tasks.find((task) => task.ref === ref);
  if (!node) return undefined;
  if (isLeaf(project, node)) return plannedLeaf(node) ? "planejada" : "liberada";
  const open = leavesOf(project, ref).filter((leaf) => !finished(leaf));
  if (open.length === 0) return undefined;
  const planned = open.filter(plannedLeaf).length;
  return planned === open.length ? "planejada" : planned === 0 ? "liberada" : "mista";
}

/** Quantas folhas ainda Planejadas (não terminadas) há no projeto ou na subárvore de `ref`. */
export function plannedLeafCount(project: Tasks, ref?: string): number {
  return leavesOf(project, ref).filter(plannedLeaf).length;
}

/**
 * Projeto "estacionado" (estruturado no backlog, sem trabalho liberado nem rodando): status `ativo`
 * ou `pausado`, com ao menos uma folha aberta, nenhuma folha `em_andamento` nem `esperando_voce`, e
 * todas as folhas abertas Planejadas (`releaseHold(leaf) !== undefined`). Um projeto estacionado
 * não segura o pedido do Maestro aberto.
 */
export function isParked(project: Pick<Project, "status" | "tasks">): boolean {
  if (project.status !== "ativo" && project.status !== "pausado") return false;
  const open = leavesOf(project).filter((leaf) => !finished(leaf));
  if (open.length === 0) return false;
  return open.every((leaf) => leaf.status !== "em_andamento" && leaf.status !== "esperando_voce" && releaseHold(leaf) !== undefined);
}

/** Índice (0 = alta) da prioridade efetiva de cada folha: a mais alta entre a dela e a dos contêineres acima. */
function rankIndex(project: Tasks): (task: ProjectTask) => number {
  const byRef = new Map(project.tasks.map((task) => [task.ref, task]));
  const memo = new Map<string, number>();
  const rank = (task: ProjectTask, seen: Set<string>): number => {
    const known = memo.get(task.ref);
    if (known !== undefined) return known;
    seen.add(task.ref);
    let best = PRIORITY_RANK[task.priority];
    const parent = task.parent ? byRef.get(task.parent) : undefined;
    if (parent && !seen.has(parent.ref)) best = Math.min(best, rank(parent, seen));
    memo.set(task.ref, best);
    return best;
  };
  return (task) => rank(task, new Set());
}

/** Prioridade efetiva do item na ordem de liberação (a mais alta entre a dele e a dos contêineres acima). */
export function releasePriority(project: Tasks, ref: string): ProjectPriority | undefined {
  const node = project.tasks.find((task) => task.ref === ref);
  if (!node) return undefined;
  const index = rankIndex(project)(node);
  return (Object.keys(PRIORITY_RANK) as ProjectPriority[]).find((priority) => PRIORITY_RANK[priority] === index);
}

/**
 * Os `ref` das folhas PLANEJADAS que precisam ser liberadas junto com as folhas de `refs` (`refs` pode citar contêiner = as folhas dele):
 * o fecho transitivo por `effectiveDeps` (dependência em contêiner = todas as folhas dele). Não inclui as folhas de `refs` em si nem
 * as já liberadas ou terminadas (a folha liberada que ainda não terminou é atravessada: as dependências dela também precisam sair).
 * Sem repetir, na ordem da árvore.
 */
export function prerequisiteClosure(project: Tasks, refs: string[]): string[] {
  const treeIndex = new Map(leavesOf(project).map((leaf, index) => [leaf.ref, index]));
  const byRef = new Map(project.tasks.map((task) => [task.ref, task]));
  const visited = new Set<string>();
  const queue: string[] = [];
  for (const ref of refs) {
    for (const leaf of leavesOf(project, ref)) {
      if (visited.has(leaf.ref)) continue;
      visited.add(leaf.ref);
      queue.push(leaf.ref);
    }
  }
  const out = new Set<string>();
  while (queue.length > 0) {
    const leaf = byRef.get(queue.shift()!);
    if (!leaf) continue;
    for (const dep of effectiveDeps(project, leaf)) {
      for (const found of leavesOf(project, dep)) {
        if (visited.has(found.ref)) continue;
        visited.add(found.ref);
        if (finished(found)) continue;
        if (plannedLeaf(found)) out.add(found.ref);
        queue.push(found.ref);
      }
    }
  }
  return [...out].sort((a, b) => (treeIndex.get(a) ?? 0) - (treeIndex.get(b) ?? 0));
}

/**
 * As folhas Planejadas na ordem em que a liberação diária as solta: prioridade efetiva (mais alta primeiro) e, no empate, a ordem da árvore
 * (DFS por `order`). `now` fica na assinatura para a ordem poder olhar prazos no futuro; hoje não é usado.
 */
export function releaseOrder(project: Tasks, now: number): string[] {
  void now;
  const rank = rankIndex(project);
  return leavesOf(project)
    .filter(plannedLeaf)
    .map((leaf, index) => ({ leaf, index, rank: rank(leaf) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(({ leaf }) => leaf.ref);
}

/** O que a liberação diária solta agora: as folhas e quantas unidades (tarefas ou módulos) isso gastou do dia. */
export type ReleaseBatch = { refs: string[]; units: number };

/**
 * O próximo lote da liberação diária, sem mexer em nada. `unit` "tarefas": as próximas folhas Planejadas de `releaseOrder`, cada uma com o fecho
 * de pré-requisitos (que CONTA no total). `unit` "modulos": o próximo módulo de primeiro nível com folhas Planejadas (prioridade efetiva mais
 * alta entre as folhas dele e depois a ordem da árvore) inteiro, com o fecho (os módulos de que depende contam como módulos liberados; só as
 * folhas de que depende saem); cada tarefa solta na raiz é uma unidade. `budget` = unidades que ainda cabem hoje; `guaranteeFirst` = sai ao
 * menos o primeiro item com o fecho inteiro, mesmo que passe do `budget` (depois o lote para).
 */
export function nextReleaseBatch(project: Tasks, unit: "tarefas" | "modulos", budget: number, options: { guaranteeFirst: boolean }, now: number): ReleaseBatch {
  const treeIndex = new Map(leavesOf(project).map((leaf, index) => [leaf.ref, index]));
  const byTree = (refs: Iterable<string>) => [...refs].sort((a, b) => (treeIndex.get(a) ?? 0) - (treeIndex.get(b) ?? 0));
  const taken = new Set<string>();
  let units = 0;
  const fits = (cost: number) => units + cost <= budget || (taken.size === 0 && options.guaranteeFirst);
  if (unit === "tarefas") {
    for (const ref of releaseOrder(project, now)) {
      if (taken.has(ref)) continue;
      const closure = prerequisiteClosure(project, [ref]).filter((other) => !taken.has(other));
      if (!fits(1 + closure.length)) break;
      taken.add(ref);
      for (const other of closure) taken.add(other);
      units += 1 + closure.length;
      if (units >= budget) break;
    }
    return { refs: byTree(taken), units };
  }
  const byRef = new Map(project.tasks.map((task) => [task.ref, task]));
  const rootOf = (ref: string): string => {
    const seen = new Set<string>();
    let current = byRef.get(ref);
    while (current?.parent && !seen.has(current.ref) && byRef.has(current.parent)) {
      seen.add(current.ref);
      current = byRef.get(current.parent);
    }
    return current?.ref ?? ref;
  };
  const rank = rankIndex(project);
  const roots = childrenOf(project)
    .filter((node) => !node.archived)
    .map((node, index) => {
      const planned = leavesOf(project, node.ref).filter(plannedLeaf);
      return { node, index, planned, rank: Math.min(Number.POSITIVE_INFINITY, ...planned.map(rank)) };
    })
    .filter((entry) => entry.planned.length > 0)
    .sort((a, b) => a.rank - b.rank || a.index - b.index);
  const spent = new Set<string>();
  for (const entry of roots) {
    if (spent.has(entry.node.ref)) continue;
    const closure = prerequisiteClosure(project, [entry.node.ref]).filter((other) => !taken.has(other));
    const touched = new Set(closure.map(rootOf));
    touched.delete(entry.node.ref);
    for (const root of [...touched]) if (spent.has(root)) touched.delete(root);
    if (!fits(1 + touched.size)) break;
    for (const leaf of entry.planned) taken.add(leaf.ref);
    for (const other of closure) taken.add(other);
    spent.add(entry.node.ref);
    for (const root of touched) spent.add(root);
    units += 1 + touched.size;
    if (units >= budget) break;
  }
  return { refs: byTree(taken), units };
}
