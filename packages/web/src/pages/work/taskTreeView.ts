import {
  assigneeCount,
  assigneesOf,
  childrenOf,
  isLeaf,
  PRIORITY_RANK,
  PROJECT_LIMITS,
  flowStatusOf,
  pendencySummary,
  treeProgress,
  leavesOf,
  isOpenStatus,
  joinNames,
  waitingText,
  type Label,
  type Project,
  type ProjectPriority,
  type ProjectTask,
  type ProjectTaskStatus,
} from "@cyno/shared";
import { carriedLabel, startsInLabel } from "./sprintsView";
import { spanLabel, shortDate } from "./workView";

/**
 * Linhas da árvore de tarefas de um projeto (a lista em árvore do ClickUp): entregáveis (grupos), tarefas e
 * subtarefas, com seta de abrir e fechar, contador, responsáveis, data e prioridade. Função pura: o React só
 * desenha o que sai daqui. O estado de um pai é o calculado (`statusOf`), nunca o gravado.
 */

const DAY = 86_400_000;
/** Quantos avatares a coluna Responsáveis mostra antes do "+N". */
export const ASSIGNEES_SHOWN = 3;

export type DueTone = "done" | "late" | "soon" | "normal";
export type DueInfo = { label: string; tone: DueTone; at: string; title: string };

export type TreeNodeRow = {
  kind: "node";
  key: string;
  ref: string;
  node: ProjectTask;
  /** 1 = direto no projeto (entregável ou tarefa), 2 = filha, 3 = neta. */
  depth: number;
  parentRef?: string;
  isGroup: boolean;
  /** Tem filhas (a seta aparece). */
  hasChildren: boolean;
  /** Quantas filhas diretas (as arquivadas não contam). */
  childCount: number;
  open: boolean;
  /** O gravado se é folha; o calculado das filhas se é pai ou entregável. */
  status: ProjectTaskStatus;
  /** Folhas concluídas e total da subárvore ("2/3"); undefined em folha. */
  progress?: { done: number; total: number };
  assignees: string[];
  /** Quantos agentes passam do teto de avatares ("+N"). */
  moreAssignees: number;
  due: DueInfo | null;
  priority: ProjectPriority | null;
  labels: Label[];
  /** Alguma folha da subárvore está bloqueada (selo). */
  blocked: boolean;
  /** Quantas folhas da subárvore esperam você. */
  waiting: number;
  /** Id de sprint das folhas (a coluna Sprint, que só aparece com sprints no projeto). */
  sprints: string[];
  /** Só na folha: a sprint já tem data e ainda não começou ("Começa em 18/11"). */
  startsIn?: string;
  /** Só na folha: veio da sprint anterior ("veio da Sprint 1"). */
  carried?: string;
  canAddChild: boolean;
  /** Fluxo: subtarefa (quem faz e o que espera) ou tarefa-mãe (resumo). Ausente nas demais. */
  flow?: FlowInfo;
  /** Tarefa antiga com passos (`steps`): tem linhas filhas de leitura (a seta aparece). */
  stepCount?: number;
};

/** O que a linha diz do fluxo: quem faz, o que espera, e (na tarefa-mãe) o resumo com todos os responsáveis. */
export type FlowInfo = {
  kind: "subtask" | "mother";
  /** Subtarefa: o responsável (avatar e nome). */
  ownerId?: string;
  ownerName?: string;
  /** Subtarefa: "espera a Sônia terminar “Criar os textos”", "na fila do Hugo (2ª)", "fazendo agora", "entregou"… */
  text: string;
  /** Tarefa-mãe: "2 de 5 prontas · agora: Davi". */
  summary?: string;
  /** Tarefa-mãe: todos os responsáveis, sem corte, na ordem da árvore. */
  everyone?: string[];
};

/** Passo de uma tarefa antiga (`steps`): uma linha filha só de leitura, marcada como passo. */
export type TreeStepRow = {
  kind: "step";
  key: string;
  /** A tarefa dona do passo. */
  parentRef: string;
  /** Profundidade da linha (a da tarefa + 1). */
  depth: number;
  index: number;
  total: number;
  agentId: string;
  what: string;
  status: ProjectTaskStatus;
  text: string;
};

export type TreeAddRow = {
  kind: "add";
  key: string;
  depth: number;
  /** `ref` do pai onde a nova entra; ausente = no projeto. */
  parentRef?: string;
  label: string;
  /** No fim do projeto: dois botões (entregável e tarefa). */
  root: boolean;
};

export type TreeRow = TreeNodeRow | TreeStepRow | TreeAddRow;

/** A coluna Sprint aparece só quando o projeto tem sprints. */
export const hasSprintColumn = (project: Pick<Project, "sprints">): boolean => (project.sprints?.length ?? 0) > 0;

const live = (project: Pick<Project, "tasks">): Pick<Project, "tasks"> => ({ tasks: project.tasks.filter((task) => !task.archived) });

/** Maior prioridade (alta antes) entre as folhas; só tarefas têm a própria. */
function priorityOf(project: Pick<Project, "tasks">, node: ProjectTask, isGroup: boolean, parent: boolean): ProjectPriority | null {
  if (!isGroup && !parent) return node.priority;
  const leaves = leavesOf(project, node.ref);
  if (leaves.length === 0) return null;
  const best = leaves.reduce((acc, leaf) => (PRIORITY_RANK[leaf.priority] < PRIORITY_RANK[acc] ? leaf.priority : acc), leaves[0]!.priority);
  return node.priority !== "normal" && PRIORITY_RANK[node.priority] < PRIORITY_RANK[best] ? node.priority : best;
}

/** Prazo da linha: o do próprio nó ou, num pai sem prazo, o maior das folhas. Verde se concluída no prazo, vermelho se atrasada, âmbar se falta menos de 24 h. */
export function dueOf(project: Pick<Project, "tasks">, node: ProjectTask, status: ProjectTaskStatus, now: number): DueInfo | null {
  let at = node.dueAt;
  if (!at) {
    const dues = leavesOf(project, node.ref).flatMap((leaf) => (leaf.dueAt ? [leaf.dueAt] : []));
    at = dues.sort().at(-1);
  }
  if (!at) return null;
  const due = Date.parse(at);
  if (Number.isNaN(due)) return null;
  const label = shortDate(at);
  if (status === "concluida") {
    const finishedAt = node.finishedAt ?? leavesOf(project, node.ref).map((leaf) => leaf.finishedAt ?? "").sort().at(-1);
    const finished = finishedAt ? Date.parse(finishedAt) : NaN;
    if (!Number.isNaN(finished) && finished <= due) return { label, tone: "done", at, title: "Concluída no prazo" };
    return { label, tone: Number.isNaN(finished) ? "normal" : "late", at, title: Number.isNaN(finished) ? "Concluída" : "Concluída depois do prazo" };
  }
  if (status === "cancelada") return { label, tone: "normal", at, title: "Cancelada" };
  if (due < now) return { label, tone: "late", at, title: `Atrasada há ${spanLabel(now - due)}` };
  if (due - now < DAY) return { label, tone: "soon", at, title: `Vence em ${spanLabel(due - now)}` };
  return { label, tone: "normal", at, title: "Prazo" };
}

/** Quais nós começam fechados quando o dono nunca mexeu: projeto pequeno abre tudo; grande fecha as tarefas-mãe e deixa só os entregáveis abertos. Pai novo (que aparece depois) nasce aberto. */
export function defaultClosed(project: Pick<Project, "tasks">): Set<string> {
  const tasks = live(project).tasks;
  if (tasks.length <= 40) return new Set();
  const parents = tasks.filter((task) => !task.group && tasks.some((candidate) => candidate.parent === task.ref));
  return new Set(parents.map((task) => task.ref));
}

/** A folha já começou (saiu de backlog/a fazer ou tem etapa entregue a um agente)? Então não vira mãe. */
const started = (task: ProjectTask): boolean => (task.status !== "backlog" && task.status !== "a_fazer") || task.steps.some((step) => step.status !== "pendente" || step.taskId !== undefined);

type Options = {
  /** Linhas "Adicionar …" no fim de cada nível (só quando o projeto aceita criar à mão). */
  addRows?: boolean;
  /** Tarefa que acabou de ganhar "Adicionar subtarefa": abre e mostra a linha de adicionar mesmo sem filhas. */
  forceAdd?: string;
  now: number;
  /** Nome do agente por id (para "espera a Sônia…"). Sem isso, mostra o id. */
  agentName?: (id: string) => string;
};

/** Posição de cada folha `a_fazer` na fila do dono dentro do projeto: 1 = a próxima. Só entra quem tem alguém na frente (outra folha do dono rodando ou na fila antes). */
export function queuePositions(project: Pick<Project, "tasks">): Map<string, number> {
  const out = new Map<string, number>();
  const leaves = leavesOf(project);
  const byOwner = new Map<string, ProjectTask[]>();
  for (const leaf of leaves) if (leaf.ownerId) byOwner.set(leaf.ownerId, [...(byOwner.get(leaf.ownerId) ?? []), leaf]);
  for (const mine of byOwner.values()) {
    const running = mine.some((leaf) => leaf.status === "em_andamento" || leaf.status === "esperando_voce");
    const waiting = mine.filter((leaf) => leaf.status === "a_fazer").sort((a, b) => (a.waitingSince ?? "").localeCompare(b.waitingSince ?? ""));
    waiting.forEach((leaf, index) => {
      if (running || index > 0) out.set(leaf.ref, index + 1);
    });
  }
  return out;
}

const STEP_STATUS: Record<string, ProjectTaskStatus> = { feita: "concluida", falhou: "falhou", em_andamento: "em_andamento" };

/** Estado de um passo na tela: o gravado; um passo pendente é `a_fazer` só se for o da vez e a tarefa já está liberada. */
function stepStatus(task: ProjectTask, index: number): ProjectTaskStatus {
  const step = task.steps[index]!;
  if (step.status === "em_andamento" && task.status === "esperando_voce") return "esperando_voce";
  const mapped = STEP_STATUS[step.status];
  if (mapped) return task.status === "cancelada" && mapped !== "concluida" ? "cancelada" : mapped;
  if (task.status === "cancelada") return "cancelada";
  return index === task.current && task.status === "a_fazer" ? "a_fazer" : "backlog";
}

/** O texto de um passo: "entregou", "fazendo agora" ou "espera a Sônia terminar o passo 1". */
function stepText(task: ProjectTask, index: number, status: ProjectTaskStatus, name: (id: string) => string): string {
  if (status === "concluida") return "entregou";
  if (status === "em_andamento") return "fazendo agora";
  if (status === "esperando_voce") return "esperando você";
  if (status === "falhou") return "falhou";
  if (status === "cancelada") return "cancelada";
  if (index === 0) return "pronto para começar";
  const before = task.steps[index - 1]!;
  const who = name(before.agentId);
  return `espera ${/a$/i.test(who.trim()) ? "a" : "o"} ${who} terminar o passo ${index}`;
}

/**
 * As linhas visíveis, na ordem da tela: cada nó (com `order`), os filhos só se o nó está aberto, e as linhas
 * de "Adicionar" no fim de cada nível aberto. Tarefas arquivadas não aparecem.
 */
export function buildTreeRows(project: Project, closedRefs: ReadonlySet<string>, options: Options): TreeRow[] {
  const visible = live(project);
  const labelOf = new Map((project.labels ?? []).map((label) => [label.id, label]));
  const name = options.agentName ?? ((id: string) => id);
  const queue = queuePositions(visible);
  const rows: TreeRow[] = [];
  const walk = (node: ProjectTask, depth: number) => {
    const children = childrenOf(visible, node.ref);
    const isGroup = node.group === true;
    const parent = isGroup || children.length > 0;
    // Tudo começa aberto; só o que o dono fechou fica fechado. Entregável vazio e tarefa que ganha subtarefa agora ficam abertos.
    const open = (isGroup && children.length === 0) || ((parent || options.forceAdd === node.ref) && (options.forceAdd === node.ref || !closedRefs.has(node.ref)));
    const status = flowStatusOf(visible, node);
    const all = assigneesOf(visible, node, Number.POSITIVE_INFINITY);
    const leaves = leavesOf(visible, node.ref);
    const progress = parent ? (({ done, total }) => ({ done, total }))(treeProgress(visible, node.ref)) : undefined;
    const mother = !isGroup && children.length > 0;
    const inMother = !isGroup && children.length === 0 && node.parent !== undefined && visible.tasks.some((candidate) => candidate.ref === node.parent && !candidate.group);
    const hasPendingDeps = !isGroup && children.length === 0 && node.dependsOn.length > 0 && isOpenStatus(node.status);
    let flow: FlowInfo | undefined;
    if (mother) {
      const done = leaves.filter((leaf) => leaf.status === "concluida").length;
      const counted = leaves.filter((leaf) => leaf.status !== "cancelada").length;
      const running = [...new Set(leaves.filter((leaf) => leaf.status === "em_andamento" && leaf.ownerId).map((leaf) => name(leaf.ownerId)))];
      flow = {
        kind: "mother",
        // Mãe com subtarefa cancelada, que falhou ou travada: "3 de 5 prontas · 1 cancelada · 1 travada" (ela não conclui sozinha).
        summary: pendencySummary(visible, node)?.text ?? `${done} de ${counted} ${counted === 1 ? "pronta" : "prontas"}${running.length > 0 ? ` · agora: ${joinNames(running)}` : ""}`,
        everyone: all,
        text: "",
      };
    } else if (inMother || hasPendingDeps) {
      const waits = waitingText({ task: node, project: visible, agentName: name, ...(queue.has(node.ref) ? { queuePosition: queue.get(node.ref)! } : {}) });
      const ended = node.status === "concluida" ? "entregou" : node.status === "falhou" ? "falhou" : node.status === "cancelada" ? "cancelada" : undefined;
      flow = { kind: "subtask", ...(node.ownerId ? { ownerId: node.ownerId, ownerName: name(node.ownerId) } : {}), text: waits ?? ended ?? (node.status === "backlog" ? "sem responsável ou parada" : "") };
    }
    const stepCount = !isGroup && children.length === 0 && node.steps.length > 1 ? node.steps.length : 0;
    rows.push({
      kind: "node",
      key: node.ref,
      ref: node.ref,
      node,
      depth,
      ...(node.parent ? { parentRef: node.parent } : {}),
      isGroup,
      hasChildren: children.length > 0,
      childCount: children.length,
      open,
      status,
      ...(progress ? { progress } : {}),
      assignees: all.slice(0, ASSIGNEES_SHOWN),
      moreAssignees: Math.max(0, assigneeCount(visible, node) - ASSIGNEES_SHOWN),
      due: dueOf(visible, node, status, options.now),
      priority: priorityOf(visible, node, isGroup, parent),
      labels: (node.labels ?? []).flatMap((id) => (labelOf.has(id) ? [labelOf.get(id)!] : [])),
      blocked: leaves.some((leaf) => leaf.blocked !== undefined && leaf.blocked.type !== "voce"),
      waiting: leaves.filter((leaf) => leaf.status === "esperando_voce").length,
      sprints: [...new Set(leaves.flatMap((leaf) => (leaf.sprintId ? [leaf.sprintId] : [])))],
      ...(!parent && startsInLabel(project, node) ? { startsIn: startsInLabel(project, node)! } : {}),
      ...(!parent && carriedLabel(project, node) ? { carried: carriedLabel(project, node)! } : {}),
      ...(flow ? { flow } : {}),
      ...(stepCount > 0 ? { stepCount } : {}),
      canAddChild: isGroup || (depth < PROJECT_LIMITS.depth && (children.length > 0 || (!started(node) && isLeaf(visible, node)))),
    });
    // Tarefa antiga com `steps`: cada passo vira uma linha filha só de leitura (a seta abre e fecha).
    if (stepCount > 0 && !closedRefs.has(node.ref)) {
      node.steps.forEach((step, index) => {
        const state = stepStatus(node, index);
        rows.push({ kind: "step", key: `step:${node.ref}:${index}`, parentRef: node.ref, depth: depth + 1, index, total: node.steps.length, agentId: step.agentId, what: step.what, status: state, text: stepText(node, index, state, name) });
      });
    }
    if (!open) return;
    for (const child of children) walk(child, depth + 1);
    if (options.addRows && (isGroup || children.length > 0 || options.forceAdd === node.ref) && depth < PROJECT_LIMITS.depth) {
      rows.push({ kind: "add", key: `add:${node.ref}`, depth: depth + 1, parentRef: node.ref, label: isGroup ? "Adicionar tarefa" : "Adicionar subtarefa", root: false });
    }
  };
  for (const top of childrenOf(visible)) walk(top, 1);
  if (options.addRows) rows.push({ kind: "add", key: "add:root", depth: 1, label: "Adicionar entregável ou tarefa", root: true });
  return rows;
}

/** Os destinos válidos de "Mover para…": o projeto, os entregáveis e as tarefas que ainda cabem uma filha (sem o próprio nó nem os de dentro dele). */
export type MoveTarget = { ref: string | null; label: string; depth: number };

export function moveTargets(project: Project, ref: string): MoveTarget[] {
  const visible = live(project);
  const node = visible.tasks.find((task) => task.ref === ref);
  if (!node) return [];
  const below = new Set<string>([ref]);
  const stack = [ref];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const child of childrenOf(visible, current)) {
      if (below.has(child.ref)) continue;
      below.add(child.ref);
      stack.push(child.ref);
    }
  }
  // Altura da subárvore do nó (1 = só ele): o destino precisa de espaço para ela.
  const height = (current: ProjectTask): number => 1 + Math.max(0, ...childrenOf(visible, current.ref).map(height));
  const need = height(node);
  const out: MoveTarget[] = [];
  if (node.parent !== undefined) out.push({ ref: null, label: "Direto no projeto", depth: 0 });
  const walk = (task: ProjectTask, depth: number) => {
    if (!below.has(task.ref) && !node.group && depth + need <= PROJECT_LIMITS.depth && !(task.ref === node.parent)) {
      const startedLeaf = isLeaf(visible, task) && !task.group && task.status !== "backlog" && task.status !== "a_fazer";
      if (!startedLeaf) out.push({ ref: task.ref, label: task.title, depth });
    }
    for (const child of childrenOf(visible, task.ref)) walk(child, depth + 1);
  };
  for (const top of childrenOf(visible)) walk(top, 1);
  return out;
}

/** Rótulos do estado (ícone e texto) de uma linha. */
export const TREE_STATUS_LABEL: Record<ProjectTaskStatus, string> = {
  backlog: "Backlog",
  a_fazer: "A fazer",
  em_andamento: "Em andamento",
  esperando_voce: "Esperando você",
  concluida: "Concluída",
  falhou: "Falhou",
  cancelada: "Cancelada",
};

/** Chave do localStorage com os nós que o dono fechou num projeto. */
export const treeClosedKey = (workspaceId: string | null, projectId: string): string => `cyno:tree-closed:${workspaceId ?? "-"}:${projectId}`;

/** Lê o que o dono deixou fechado (null = nunca mexeu). Com try/catch: sem armazenamento tudo funciona. */
export function readClosedRefs(key: string): Set<string> | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed.filter((item): item is string => typeof item === "string")) : null;
  } catch {
    return null;
  }
}

export function writeClosedRefs(key: string, refs: ReadonlySet<string>): void {
  try {
    localStorage.setItem(key, JSON.stringify([...refs]));
  } catch {
    // Sem armazenamento: só não lembra.
  }
}
