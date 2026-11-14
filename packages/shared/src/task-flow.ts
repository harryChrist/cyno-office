import type { Project, ProjectTask, ProjectTaskStatus } from "./projects";
import { childrenOf, isLeaf, leavesOf, pathOf, rollupStatus, statusOf } from "./task-tree";

/**
 * Fluxo entre subtarefas: quem entrega para quem. Funções puras sobre `Project.tasks`. Uma tarefa que passa
 * por vários agentes é uma tarefa-mãe com uma subtarefa por agente, ligadas por `dependsOn`; aqui saem a
 * entrega da mãe, o que cada subtarefa recebe, quem recebe o que ela entrega e o texto "espera quem".
 */

type Tasks = Pick<Project, "tasks">;

/**
 * As folhas "finais" de um nó: as da subárvore que nenhuma outra folha da mesma subárvore espera. Numa cadeia
 * é a última subtarefa; em paralelo são todas as pontas. Uma folha devolve ela mesma.
 */
export function finalLeaves(project: Tasks, ref: string): ProjectTask[] {
  const leaves = leavesOf(project, ref);
  if (leaves.length <= 1) return leaves;
  const waited = new Set<string>();
  for (const leaf of leaves) for (const dep of leaf.dependsOn) waited.add(dep);
  const finals = leaves.filter((leaf) => !waited.has(leaf.ref));
  return finals.length > 0 ? finals : leaves.slice(-1);
}

/**
 * A entrega de um nó: o resultado da folha, ou, numa tarefa-mãe, o das folhas finais (a última subtarefa; o
 * conjunto quando terminam em paralelo). Só entram as que já entregaram algo; ordem da árvore.
 */
export function deliveryLeaves(project: Tasks, ref: string): ProjectTask[] {
  if (!project.tasks.some((task) => task.ref === ref)) return [];
  return finalLeaves(project, ref).filter((leaf) => leaf.status === "concluida" && leaf.result !== undefined && leaf.result !== "");
}

/** O que `task` recebe das tarefas de que depende: a entrega de cada dependência (a de uma mãe é a das folhas finais). Sem repetir. */
export function receivedBy(project: Tasks, task: Pick<ProjectTask, "ref" | "dependsOn">): ProjectTask[] {
  const out: ProjectTask[] = [];
  for (const dep of effectiveDeps(project, task)) for (const leaf of deliveryLeaves(project, dep)) if (!out.some((seen) => seen.ref === leaf.ref)) out.push(leaf);
  return out;
}

/** As folhas de entrada de um nó: as que não esperam nenhuma outra da mesma subárvore (começam primeiro). */
function entryLeaves(project: Tasks, ref: string): ProjectTask[] {
  const leaves = leavesOf(project, ref);
  const inside = new Set(leaves.map((leaf) => leaf.ref));
  const entries = leaves.filter((leaf) => !leaf.dependsOn.some((dep) => inside.has(dep)));
  return entries.length > 0 ? entries : leaves.slice(0, 1);
}

/**
 * As dependências que valem para uma folha: as dela e as das tarefas-mãe de que ela é subtarefa de entrada
 * (quem não espera ninguém dentro da mãe). Assim "a mãe depende de X" faz as primeiras subtarefas esperarem X.
 */
export function effectiveDeps(project: Tasks, task: Pick<ProjectTask, "ref" | "dependsOn">): string[] {
  const out = [...task.dependsOn];
  for (const node of pathOf(project, task.ref)) {
    if (node.ref === task.ref || node.group || node.dependsOn.length === 0) continue;
    if (!entryLeaves(project, node.ref).some((leaf) => leaf.ref === task.ref)) continue;
    for (const dep of node.dependsOn) if (!out.includes(dep)) out.push(dep);
  }
  return out;
}

/**
 * Quem recebe a entrega de `ref` (folhas): as que dependem dela, ou de uma mãe de que ela é folha final.
 * Se quem depende é uma mãe, recebem as subtarefas de entrada dela. Sem repetir, na ordem da lista.
 */
export function receiversOf(project: Tasks, ref: string): ProjectTask[] {
  const mine = new Set<string>();
  for (const node of pathOf(project, ref)) if (node.ref === ref || finalLeaves(project, node.ref).some((leaf) => leaf.ref === ref)) mine.add(node.ref);
  const out: ProjectTask[] = [];
  for (const task of project.tasks) {
    if (task.ref === ref || !task.dependsOn.some((dep) => mine.has(dep))) continue;
    for (const leaf of isLeaf(project, task) ? [task] : entryLeaves(project, task.ref)) if (leaf.ref !== ref && !out.some((seen) => seen.ref === leaf.ref)) out.push(leaf);
  }
  return out;
}

/** Os nomes numa frase: "Sônia", "Sônia e Davi", "Sônia, Davi e Ana". */
export function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} e ${names.at(-1)}`;
}

export type WaitingInput = {
  task: ProjectTask;
  project: Tasks;
  /** Nome do agente por id. */
  agentName: (id: string) => string;
  /** Posição (1 = a próxima) na fila do agente dono, quando a tarefa está `a_fazer` atrás de outras. */
  queuePosition?: number;
};

/**
 * Dependências que NÃO vão acontecer (revisão 2, M5): as folhas de que a tarefa depende que foram canceladas ou falharam. Quem depende delas
 * não roda sozinha (o resultado de que precisa não existe): fica travada até o dono refazer a que falhou, tirar a dependência ou cancelar.
 */
export function deadDependencies(project: Tasks, task: Pick<ProjectTask, "ref" | "dependsOn">): ProjectTask[] {
  const out: ProjectTask[] = [];
  for (const ref of effectiveDeps(project, task)) {
    const dep = project.tasks.find((candidate) => candidate.ref === ref);
    if (!dep) continue;
    for (const leaf of isLeaf(project, dep) ? [dep] : leavesOf(project, dep.ref)) {
      if ((leaf.status === "cancelada" || leaf.status === "falhou") && !out.some((seen) => seen.ref === leaf.ref)) out.push(leaf);
    }
  }
  return out;
}

/** A folha está travada: não começou (backlog ou a fazer) e alguma dependência foi cancelada ou falhou. */
export function isBlockedLeaf(project: Tasks, task: ProjectTask): boolean {
  return isLeaf(project, task) && (task.status === "backlog" || task.status === "a_fazer") && deadDependencies(project, task).length > 0;
}

/** As folhas travadas do projeto. */
export function blockedLeaves(project: Tasks): ProjectTask[] {
  return leavesOf(project).filter((leaf) => isBlockedLeaf(project, leaf));
}

/** "travada: “Criar os textos” foi cancelada" / "falhou" / "…e mais 1": o texto da folha travada (null se não está). */
export function blockedText(project: Tasks, task: ProjectTask): string | null {
  if (!isBlockedLeaf(project, task)) return null;
  const dead = deadDependencies(project, task);
  const first = dead[0]!;
  const verb = first.status === "falhou" ? "falhou" : "foi cancelada";
  return `travada: “${first.title}” ${verb}${dead.length > 1 ? ` (e mais ${dead.length - 1})` : ""}`;
}

/**
 * Estado para MOSTRAR: como `statusOf`, mas a folha travada conta como `esperando_voce` (a mãe sobe com ela). O estado gravado da folha não muda
 * (ela segue no backlog e volta a rodar quando a dependência é refeita ou tirada).
 */
export function flowStatusOf(project: Tasks, task: ProjectTask): ProjectTaskStatus {
  const walk = (node: ProjectTask, seen: Set<string>): ProjectTaskStatus => {
    seen.add(node.ref);
    const children = childrenOf(project, node.ref).filter((child) => !seen.has(child.ref));
    if (!node.group && children.length === 0) return isBlockedLeaf(project, node) ? "esperando_voce" : node.status;
    return rollupStatus(children.map((child) => ({ status: walk(child, seen) })));
  };
  return walk(task, new Set());
}

/** "3 de 5 prontas · 1 cancelada · 1 travada": o resumo da mãe com pendência (undefined se nada está cancelado, falho ou travado). */
export function pendencySummary(project: Tasks, mother: ProjectTask): { text: string; done: number; total: number; cancelled: number; failed: number; blocked: number } | undefined {
  const leaves = isLeaf(project, mother) ? [] : leavesOf(project, mother.ref);
  if (leaves.length === 0) return undefined;
  const done = leaves.filter((leaf) => leaf.status === "concluida").length;
  const cancelled = leaves.filter((leaf) => leaf.status === "cancelada").length;
  const failed = leaves.filter((leaf) => leaf.status === "falhou").length;
  const blocked = leaves.filter((leaf) => isBlockedLeaf(project, leaf)).length;
  if (cancelled + failed + blocked === 0) return undefined;
  const parts = [`${done} de ${leaves.length} ${done === 1 ? "pronta" : "prontas"}`];
  if (cancelled) parts.push(`${cancelled} ${cancelled === 1 ? "cancelada" : "canceladas"}`);
  if (failed) parts.push(failed === 1 ? "1 falhou" : `${failed} falharam`);
  if (blocked) parts.push(`${blocked} ${blocked === 1 ? "travada" : "travadas"}`);
  return { text: parts.join(" · "), done, total: leaves.length, cancelled, failed, blocked };
}

/**
 * "O que ela espera", em palavras, para uma folha na árvore:
 * - concluída/cancelada/falhou: nada (null);
 * - rodando: "fazendo agora";
 * - esperando você: "esperando você";
 * - travada (dependência cancelada ou que falhou): "travada: “Criar os textos” foi cancelada" / "falhou";
 * - parada por dependência não concluída: "espera a Sônia terminar “Criar os textos”" (uma) ou "espera Sônia e Davi" (várias);
 * - na fila do próprio agente: "na fila do Hugo (2ª)";
 * - `a_fazer` livre: "pronta para começar"; backlog sem dependência pendente: null.
 * Dependência já concluída não entra. Dependência numa mãe espera as folhas dela que faltam.
 */
export function waitingText({ task, project, agentName, queuePosition }: WaitingInput): string | null {
  if (task.status === "concluida" || task.status === "cancelada" || task.status === "falhou") return null;
  if (task.status === "em_andamento") return "fazendo agora";
  if (task.status === "esperando_voce") return "esperando você";
  const stuck = blockedText(project, task);
  if (stuck) return stuck;
  const pending: ProjectTask[] = [];
  for (const ref of effectiveDeps(project, task)) {
    const dep = project.tasks.find((candidate) => candidate.ref === ref);
    if (!dep || statusOf(project, dep) === "concluida") continue;
    // Dependência numa mãe: quem falta são as folhas dela que ainda não terminaram.
    const open = isLeaf(project, dep) ? [dep] : leavesOf(project, dep.ref).filter((leaf) => leaf.status !== "concluida" && leaf.status !== "cancelada");
    for (const leaf of open.length > 0 ? open : [dep]) if (!pending.some((seen) => seen.ref === leaf.ref)) pending.push(leaf);
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

/** "a Sônia", "o Hugo": o artigo pelo fim do nome (a heurística do português; nome terminado em "a" é "a", o resto "o"). */
function article(name: string): string {
  return `${/a$/i.test(name.trim()) ? "a" : "o"} ${name}`;
}

/** "a Sônia" / "o Hugo" sem o espaço de artigo, para "na fila da Sônia" / "do Hugo". */
function ofArticle(name: string): string {
  return `${/a$/i.test(name.trim()) ? "a" : "o"} ${name}`;
}

/** Estados em que a subtarefa ainda vai fazer algo. */
export const isOpenStatus = (status: ProjectTaskStatus): boolean => status !== "concluida" && status !== "cancelada" && status !== "falhou";
