import { isLeaf, PROJECT_SAFETY, type Project, type ProjectTask } from "@cyno/shared";
import { depthIn, heightIn, isLeafIn, kidsOf, moveDependencyConflict, subtreeSet, treeIndex, type TreeIndex } from "./treeIndex";

/**
 * As regras de onde uma linha pode cair ao arrastar (árvore e sprints). Funções puras: a tela só pergunta
 * "pode?" e mostra o aviso curto quando não pode. Valem as mesmas regras do servidor (`moveNode`, `moveToSprint`).
 * Não há limite de profundidade nem de itens por nível (só a rede de segurança `PROJECT_SAFETY`); módulo pode ir
 * para dentro de módulo.
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

/**
 * Onde a linha `dragRef` cai se soltar sobre `overRef` na zona dada (antes, depois ou dentro). Não deixa soltar
 * dentro de si mesma nem nos filhos dela, nem criar dependência impossível (um módulo esperando o próprio conteúdo),
 * e tarefa que já começou não vira mãe.
 */
export function treeDrop(project: Project, dragRef: string, overRef: string, zone: DropZone, prebuilt?: TreeIndex): TreeVerdict {
  const index = prebuilt ?? treeIndex(live(project).tasks);
  const dragged = index.byRef.get(dragRef);
  const over = index.byRef.get(overRef);
  const no = (reason: string): TreeVerdict => ({ ok: false, reason, zone, overRef });
  if (!dragged || !over) return no("");
  if (dragRef === overRef) return no("");
  if (subtreeSet(index, dragRef).has(overRef)) return no("Não dá para soltar dentro dela mesma.");
  const need = heightIn(index, dragRef);

  let parent: ProjectTask | undefined;
  if (zone === "inside") {
    if (startedLeaf(over) && isLeafIn(index, over)) return no("Essa tarefa já começou: não dá para dividir em subtarefas.");
    parent = over;
  } else {
    parent = over.parent ? index.byRef.get(over.parent) : undefined;
  }
  const parentDepth = parent ? depthIn(index, parent.ref) : 0;
  if (parentDepth + need > PROJECT_SAFETY.depth) return no(`Passa do limite de ${PROJECT_SAFETY.depth} níveis.`);
  const conflict = moveDependencyConflict(index, dragRef, parent?.ref);
  if (conflict) return no(conflict);

  const newParent = parent?.ref ?? null;
  const siblings = kidsOf(index, newParent).filter((task) => task.ref !== dragRef);

  let before: string | null;
  if (zone === "inside") before = null;
  else if (zone === "before") before = over.ref;
  else {
    const at = siblings.findIndex((task) => task.ref === over.ref);
    before = siblings[at + 1]?.ref ?? null;
  }

  // Já está exatamente aí?
  const current = kidsOf(index, dragged.parent).map((task) => task.ref);
  const position = current.indexOf(dragRef);
  const stays = (dragged.parent ?? null) === newParent && (before === null ? position === current.length - 1 : current[position + 1] === before);
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
