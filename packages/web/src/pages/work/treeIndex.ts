import type { ProjectTask } from "@cyno/shared";

/**
 * Índice da árvore para a tela: filhos de cada nó já na ordem (`order`, empate pela posição na lista, como
 * `childrenOf` do shared), tudo montado uma vez em O(n log n). As funções do shared recalculam isso a cada chamada,
 * o que não escala para projetos com centenas de itens; a tela usa este índice nos laços por linha.
 */
export type TreeIndex = {
  byRef: ReadonlyMap<string, ProjectTask>;
  /** Filhos diretos por `ref` do pai (a chave "" é o próprio projeto). */
  kids: ReadonlyMap<string, readonly ProjectTask[]>;
};

const sortKey = (task: ProjectTask, index: number) => task.order ?? index * 1000;

export function treeIndex(tasks: readonly ProjectTask[]): TreeIndex {
  const byRef = new Map<string, ProjectTask>();
  const keyed = tasks.map((task, index) => ({ task, index, key: sortKey(task, index) }));
  for (const task of tasks) byRef.set(task.ref, task);
  keyed.sort((a, b) => a.key - b.key || a.index - b.index);
  const kids = new Map<string, ProjectTask[]>();
  for (const { task } of keyed) {
    const parent = task.parent ?? "";
    const list = kids.get(parent);
    if (list) list.push(task);
    else kids.set(parent, [task]);
  }
  return { byRef, kids };
}

const NONE: readonly ProjectTask[] = [];

/** Filhos diretos de `ref` (ausente = do projeto). */
export function kidsOf(index: TreeIndex, ref?: string | null): readonly ProjectTask[] {
  return index.kids.get(ref ?? "") ?? NONE;
}

/** O nó executa (nem módulo nem pai de alguém)? */
export function isLeafIn(index: TreeIndex, task: Pick<ProjectTask, "ref" | "group">): boolean {
  return task.group !== true && kidsOf(index, task.ref).length === 0;
}

/** `ref` do nó e de todos os descendentes (tolera ciclo). */
export function subtreeSet(index: TreeIndex, ref: string): Set<string> {
  const out = new Set<string>([ref]);
  const stack = [ref];
  while (stack.length > 0) {
    for (const child of kidsOf(index, stack.pop())) {
      if (out.has(child.ref)) continue;
      out.add(child.ref);
      stack.push(child.ref);
    }
  }
  return out;
}

/** Altura da subárvore do nó (1 = só ele). */
export function heightIn(index: TreeIndex, ref: string): number {
  const walk = (current: string, seen: Set<string>): number => {
    if (seen.has(current)) return 0;
    seen.add(current);
    let best = 0;
    for (const child of kidsOf(index, current)) best = Math.max(best, walk(child.ref, seen));
    seen.delete(current);
    return 1 + best;
  };
  return walk(ref, new Set());
}

/** Profundidade do nó (1 = direto no projeto); pára num ciclo. */
export function depthIn(index: TreeIndex, ref: string): number {
  let depth = 0;
  const seen = new Set<string>();
  for (let current = index.byRef.get(ref); current && !seen.has(current.ref); current = current.parent ? index.byRef.get(current.parent) : undefined) {
    seen.add(current.ref);
    depth += 1;
  }
  return depth;
}

/** Os ancestrais do nó, do pai mais próximo até o de cima. */
export function ancestorsIn(index: TreeIndex, ref: string): ProjectTask[] {
  const out: ProjectTask[] = [];
  const seen = new Set<string>([ref]);
  for (let current = index.byRef.get(ref)?.parent; current && !seen.has(current); current = index.byRef.get(current)?.parent) {
    const node = index.byRef.get(current);
    if (!node) break;
    seen.add(current);
    out.push(node);
  }
  return out;
}

/**
 * Soltar/mover `movedRef` para dentro de `newParent` (undefined = direto no projeto) cria uma dependência impossível?
 * Dois casos: um futuro ancestral espera algo que ficaria dentro dele (o módulo esperaria o próprio conteúdo), ou o item
 * movido espera um dos futuros ancestrais (nunca começaria). Devolve a frase para mostrar, ou null se está tudo certo.
 */
export function moveDependencyConflict(index: TreeIndex, movedRef: string, newParent: string | undefined): string | null {
  if (!newParent) return null;
  const moved = index.byRef.get(movedRef);
  if (!moved) return null;
  const inside = subtreeSet(index, movedRef);
  const chain = [index.byRef.get(newParent), ...ancestorsIn(index, newParent)].filter((node): node is ProjectTask => node !== undefined);
  for (const ancestor of chain) {
    if (ancestor.dependsOn.some((dep) => inside.has(dep))) return `“${ancestor.title}” espera “${index.byRef.get(ancestor.dependsOn.find((dep) => inside.has(dep))!)?.title ?? movedRef}”: não dá para pôr um dentro do outro.`;
  }
  const chainRefs = new Set(chain.map((node) => node.ref));
  for (const ref of inside) {
    const node = index.byRef.get(ref);
    const dep = node?.dependsOn.find((candidate) => chainRefs.has(candidate));
    if (node && dep) return `“${node.title}” espera “${index.byRef.get(dep)?.title ?? dep}”: não dá para pôr dentro dele.`;
  }
  return null;
}
