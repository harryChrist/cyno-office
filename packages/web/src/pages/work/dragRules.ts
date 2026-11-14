import { childrenOf, isLeaf, PROJECT_LIMITS, type Project, type ProjectTask } from "@cyno/shared";

/**
 * As regras de onde uma linha pode cair ao arrastar (árvore e sprints). Funções puras: a tela só pergunta
 * "pode?" e mostra o aviso curto quando não pode. Valem as mesmas regras do servidor (`moveNode`, `moveToSprint`).
 */

export type DropZone = "before" | "after" | "inside";

/** `move` = o que mandar ao servidor (`parent: null` = direto no projeto; `before: null` = no fim). */
export type TreeVerdict =
  | { ok: true; move: { parent: string | null; before: string | null }; zone: DropZone; overRef: string }
  /** `reason` vazio = soltar no lugar onde já está (nada a avisar). */
  | { ok: false; reason: string; zone: DropZone; overRef: string };

const live = (project: Pick<Project, "tasks">): Pick<Project, "tasks"> => ({ tasks: project.tasks.filter((task) => !task.archived) });

/** A folha já começou? Então não vira mãe (o servidor recusa). */
const startedLeaf = (task: ProjectTask): boolean => !task.group && task.status !== "backlog" && task.status !== "a_fazer";

/** Os `ref` de dentro da subárvore (inclusive o próprio). */
function subtree(project: Pick<Project, "tasks">, ref: string): Set<string> {
  const out = new Set<string>([ref]);
  const stack = [ref];
  while (stack.length > 0) {
    for (const child of childrenOf(project, stack.pop())) {
      if (out.has(child.ref)) continue;
      out.add(child.ref);
      stack.push(child.ref);
    }
  }
  return out;
}

/** Altura da subárvore do nó (1 = só ele). */
function height(project: Pick<Project, "tasks">, task: ProjectTask): number {
  return 1 + Math.max(0, ...childrenOf(project, task.ref).map((child) => height(project, child)));
}

/** Profundidade de um nó (1 = direto no projeto). */
function depthOf(project: Pick<Project, "tasks">, task: ProjectTask): number {
  const byRef = new Map(project.tasks.map((candidate) => [candidate.ref, candidate]));
  let depth = 1;
  for (let parent = task.parent ? byRef.get(task.parent) : undefined, guard = 0; parent && guard < 10; parent = parent.parent ? byRef.get(parent.parent) : undefined, guard += 1) depth += 1;
  return depth;
}

/**
 * Onde a linha `dragRef` cai se soltar sobre `overRef` na zona dada (antes, depois ou dentro). Respeita a
 * profundidade máxima, não deixa soltar dentro de si mesma nem nos filhos dela, entregável só na raiz e
 * tarefa que já começou não vira mãe.
 */
export function treeDrop(project: Project, dragRef: string, overRef: string, zone: DropZone): TreeVerdict {
  const visible = live(project);
  const dragged = visible.tasks.find((task) => task.ref === dragRef);
  const over = visible.tasks.find((task) => task.ref === overRef);
  const no = (reason: string): TreeVerdict => ({ ok: false, reason, zone, overRef });
  if (!dragged || !over) return no("");
  if (dragRef === overRef) return no("");
  if (subtree(visible, dragRef).has(overRef)) return no("Não dá para soltar dentro dela mesma.");
  const need = height(visible, dragged);

  let parent: ProjectTask | undefined;
  if (zone === "inside") {
    if (dragged.group) return no("Entregável só fica direto no projeto.");
    if (startedLeaf(over) && isLeaf(visible, over)) return no("Essa tarefa já começou: não dá para dividir em subtarefas.");
    parent = over;
  } else {
    parent = over.parent ? visible.tasks.find((task) => task.ref === over.parent) : undefined;
    if (dragged.group && parent) return no("Entregável só fica direto no projeto.");
  }
  const parentDepth = parent ? depthOf(visible, parent) : 0;
  if (parentDepth + need > PROJECT_LIMITS.depth) return no(`Passa do limite de ${PROJECT_LIMITS.depth} níveis.`);

  const newParent = parent?.ref ?? null;
  const siblings = childrenOf(visible, newParent ?? undefined).filter((task) => task.ref !== dragRef);
  if (siblings.length >= PROJECT_LIMITS.children && (dragged.parent ?? null) !== newParent) return no(`Cada nível aceita até ${PROJECT_LIMITS.children} itens.`);

  let before: string | null;
  if (zone === "inside") before = null;
  else if (zone === "before") before = over.ref;
  else {
    const at = siblings.findIndex((task) => task.ref === over.ref);
    before = siblings[at + 1]?.ref ?? null;
  }

  // Já está exatamente aí?
  const current = childrenOf(visible, dragged.parent).map((task) => task.ref);
  const index = current.indexOf(dragRef);
  const stays = (dragged.parent ?? null) === newParent && (before === null ? index === current.length - 1 : current[index + 1] === before);
  if (stays) return no("");
  return { ok: true, move: { parent: newParent, before }, zone, overRef };
}

/** O que cada zona da linha significa pelo ponteiro: o quarto de cima, o do meio (dentro) e o de baixo. */
export function zoneAt(y: number, top: number, height: number, canInside: boolean): DropZone {
  const fraction = height <= 0 ? 0.5 : (y - top) / height;
  if (canInside && fraction >= 0.28 && fraction <= 0.72) return "inside";
  return fraction < 0.5 ? "before" : "after";
}

// ---------- Sprints ----------

export type SprintVerdict = { ok: true; sprintId: string | null } | { ok: false; reason: string };

/**
 * Soltar uma tarefa numa faixa de sprint (`sprintId` null = "Sem sprint"). Sprint fechada (ou esperando o OK da
 * entrega) não aceita; tarefa que terminou fica na sprint em que terminou; só folhas mudam de sprint.
 */
export function sprintDrop(project: Project, taskRef: string, sprintId: string | null): SprintVerdict {
  const visible = live(project);
  const task = visible.tasks.find((candidate) => candidate.ref === taskRef);
  if (!task) return { ok: false, reason: "" };
  if (!isLeaf(visible, task)) return { ok: false, reason: "Só as tarefas que executam entram numa sprint." };
  if (task.status === "concluida" || task.status === "cancelada") return { ok: false, reason: "A tarefa já terminou: fica na sprint em que terminou." };
  const sprint = sprintId === null ? undefined : project.sprints?.find((candidate) => candidate.id === sprintId);
  if (sprintId !== null && !sprint) return { ok: false, reason: "" };
  if (sprint && (sprint.status === "fechada" || sprint.status === "fechando")) return { ok: false, reason: "Essa sprint já fechou: solte na ativa ou numa futura." };
  const current = task.sprintId && project.sprints?.some((candidate) => candidate.id === task.sprintId) ? task.sprintId : null;
  if (current === sprintId) return { ok: false, reason: "" };
  return { ok: true, sprintId };
}

/** A tarefa pode ser pega para arrastar entre sprints (folha que ainda não terminou)? */
export function canDragToSprint(project: Project, taskRef: string): boolean {
  const visible = live(project);
  const task = visible.tasks.find((candidate) => candidate.ref === taskRef);
  return !!task && isLeaf(visible, task) && task.status !== "concluida" && task.status !== "cancelada";
}
