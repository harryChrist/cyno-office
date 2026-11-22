import { effectiveDeps, finalLeaves, isContainer, isLeaf, joinNames, leavesOf, nodeDone, pathOf, statusOf, waitingText, type Project, type ProjectTask, type ProjectTaskStatus } from "@cyno/shared";
import { normalizeText, pathText, queuePositions, waitsText } from "./taskTreeView";
import { ancestorsIn, kidsOf, subtreeSet, treeIndex, type TreeIndex } from "./treeIndex";

/**
 * O bloco "Fluxo" do painel de uma tarefa-mãe e a lista "Depois de" de quem edita as dependências. Funções puras:
 * o React só desenha. Sem biblioteca de grafo: uma lista em ordem, cada item dizendo de quem ele espera.
 */

type Tasks = Pick<Project, "tasks">;
const live = (project: Tasks): Tasks => ({ tasks: project.tasks.filter((task) => !task.archived) });

export type FlowItem = {
  ref: string;
  title: string;
  ownerId: string;
  ownerName: string;
  status: ProjectTaskStatus;
  /** "espera a Sônia terminar “Pesquisar”", "fazendo agora", "entregou"… */
  text: string;
  /** De quem ela espera (a seta "←"): uma etiqueta por dependência ainda não vista como pronta ou já entregue. */
  after: { ref: string; label: string; done: boolean }[];
  /** O que entregou (só depois de concluída). */
  result?: string;
  /** Faz parte da entrega da tarefa-mãe (é uma das últimas). */
  final: boolean;
};

/** Ordem do fluxo: quem não espera ninguém primeiro, e cada subtarefa só depois das que ela espera (a ordem da árvore desempata). */
export function flowOrder(project: Tasks, motherRef: string): ProjectTask[] {
  const visible = live(project);
  const leaves = leavesOf(visible, motherRef);
  const refs = new Set(leaves.map((leaf) => leaf.ref));
  const waits = new Map(leaves.map((leaf) => [leaf.ref, leaf.dependsOn.filter((dep) => refs.has(dep))]));
  const out: ProjectTask[] = [];
  const placed = new Set<string>();
  while (out.length < leaves.length) {
    const next = leaves.find((leaf) => !placed.has(leaf.ref) && (waits.get(leaf.ref) ?? []).every((dep) => placed.has(dep)));
    // Ciclo (não deveria existir: o servidor recusa): põe o resto na ordem da árvore.
    const pick = next ?? leaves.find((leaf) => !placed.has(leaf.ref))!;
    placed.add(pick.ref);
    out.push(pick);
  }
  return out;
}

/** Os itens do bloco "Fluxo" de uma tarefa-mãe. */
export function flowItems(project: Tasks, motherRef: string, agentName: (id: string) => string): FlowItem[] {
  const visible = live(project);
  const queue = queuePositions(visible);
  const finalRefs = new Set(finalLeaves(visible, motherRef).map((leaf) => leaf.ref));
  return flowOrder(visible, motherRef).map((leaf) => {
    const wait = waitingText({ task: leaf, project: visible, agentName, ...(queue.has(leaf.ref) ? { queuePosition: queue.get(leaf.ref)! } : {}) });
    const ended = leaf.status === "concluida" ? "entregou" : leaf.status === "falhou" ? "falhou" : leaf.status === "cancelada" ? "cancelada" : "";
    const after = effectiveDeps(visible, leaf).flatMap((ref) => {
      const dep = visible.tasks.find((task) => task.ref === ref);
      if (!dep) return [];
      const label = isLeaf(visible, dep) && dep.ownerId ? `${agentName(dep.ownerId)} · ${dep.title}` : dep.title;
      return [{ ref, label, done: isContainer(visible, dep) ? nodeDone(visible, ref) : dep.status === "concluida" }];
    });
    return {
      ref: leaf.ref,
      title: leaf.title,
      ownerId: leaf.ownerId,
      ownerName: leaf.ownerId ? agentName(leaf.ownerId) : "Sem responsável",
      status: leaf.status,
      text: wait ?? ended ?? "",
      after,
      ...(leaf.status === "concluida" && leaf.result ? { result: leaf.result } : {}),
      final: finalRefs.has(leaf.ref),
    };
  });
}

export type DependsChoice = {
  ref: string;
  title: string;
  ownerId: string;
  checked: boolean;
  /** Irmã (mesmo pai) do item que escolhe: as outras opções são módulos e tarefas de outros lugares. */
  sibling?: boolean;
  /** Onde fica ("Leitura > Capítulos"); vazio para quem está direto no projeto. */
  path?: string;
  /** Módulo ou item com filhas (a dependência espera todas as atividades dele). */
  container?: boolean;
};

/** Tudo que `ref` espera, direta ou indiretamente: as dependências dele, as de quem está dentro e as dos ancestrais; esperar um módulo vale esperar o módulo inteiro. */
function waitsClosure(index: TreeIndex, ref: string): Set<string> {
  const out = new Set<string>();
  const visited = new Set<string>();
  const queue = [ref];
  while (queue.length > 0) {
    const current = queue.pop()!;
    if (visited.has(current)) continue;
    visited.add(current);
    const holders = [...subtreeSet(index, current), ...ancestorsIn(index, current).map((node) => node.ref)];
    for (const holder of holders) {
      for (const dep of index.byRef.get(holder)?.dependsOn ?? []) {
        if (out.has(dep)) continue;
        out.add(dep);
        queue.push(dep);
      }
    }
  }
  return out;
}

/**
 * As opções da lista "Depois de" de um item (módulo, tarefa-mãe ou tarefa): as irmãs (mesmo pai, módulos também) e, depois,
 * os outros módulos e tarefas-mãe do projeto, menos ele mesmo, os ancestrais, os de dentro dele e quem criaria um ciclo (o servidor
 * também recusa). As que já são dependência e não aparecem ali ficam na lista para dar para tirar. `siblingsOnly` (nova subtarefa) só oferece as irmãs.
 */
export function dependsChoices(project: Tasks, task: Pick<ProjectTask, "ref" | "parent" | "dependsOn">, options: { siblingsOnly?: boolean } = {}): DependsChoice[] {
  const visible = live(project);
  const index = treeIndex(visible.tasks);
  const ancestors = new Set(pathOf(visible, task.ref).map((node) => node.ref));
  // `ref` vazio = item que ainda não existe (nova subtarefa): não tem ancestrais nem descendentes.
  const below = task.ref === "" ? new Set<string>() : subtreeSet(index, task.ref);
  const avoid = new Set<string>([...below, ...ancestors]);
  const cycles = (ref: string) => {
    if (task.ref === "") return false;
    for (const reached of waitsClosure(index, ref)) if (avoid.has(reached)) return true;
    return false;
  };
  const trailOf = (ref: string) => pathText(ancestorsIn(index, ref).map((node) => node.title).reverse());
  const make = (candidate: ProjectTask, sibling: boolean): DependsChoice => ({
    ref: candidate.ref,
    title: candidate.title,
    ownerId: candidate.ownerId,
    checked: task.dependsOn.includes(candidate.ref),
    sibling,
    path: trailOf(candidate.ref),
    container: !isLeaf(visible, candidate),
  });
  const siblings = kidsOf(index, task.parent).filter((sibling) => sibling.ref !== task.ref && !ancestors.has(sibling.ref) && !below.has(sibling.ref) && (task.dependsOn.includes(sibling.ref) || !cycles(sibling.ref)));
  const siblingRefs = new Set(siblings.map((sibling) => sibling.ref));
  const others = options.siblingsOnly
    ? []
    : visible.tasks.filter((candidate) => !siblingRefs.has(candidate.ref) && !avoid.has(candidate.ref) && !isLeaf(visible, candidate) && candidate.ref !== task.ref && (task.dependsOn.includes(candidate.ref) || !cycles(candidate.ref)));
  const listed = new Set([...siblings, ...others].map((candidate) => candidate.ref));
  const extra = task.dependsOn.flatMap((ref) => (listed.has(ref) ? [] : visible.tasks.filter((candidate) => candidate.ref === ref)));
  return [...siblings.map((candidate) => make(candidate, true)), ...[...others, ...extra].map((candidate) => make(candidate, false))];
}

/** "Depois de: Sônia e Davi" — o resumo das dependências de uma tarefa para a lista (vazio se não espera ninguém). */
export function dependsSummary(project: Tasks, task: Pick<ProjectTask, "dependsOn">, agentName: (id: string) => string): string {
  const names = task.dependsOn.flatMap((ref) => {
    const dep = project.tasks.find((candidate) => candidate.ref === ref);
    return dep ? [dep.ownerId ? agentName(dep.ownerId) : dep.title] : [];
  });
  return names.length > 0 ? `Depois de ${joinNames([...new Set(names)])}` : "";
}

export type DependsRow = { ref: string; title: string; ownerId: string; status: ProjectTaskStatus; done: boolean; stateLabel: string };
export type DependsOverview = {
  /** As que ainda travam (não concluídas) primeiro, depois as feitas; dentro de cada grupo, a ordem em que foram marcadas. */
  rows: DependsRow[];
  total: number;
  pending: number;
  /** "Esperando 1 de 2", "Nada travando: pode começar"… Vazio quando não espera ninguém. */
  summary: string;
};

const DEP_STATE_LABEL: Partial<Record<ProjectTaskStatus, string>> = {
  concluida: "feita",
  em_andamento: "fazendo",
  esperando_voce: "esperando você",
  falhou: "falhou",
  cancelada: "cancelada",
};

/** O que a tarefa realmente espera: só as dependências marcadas, separadas em "ainda falta" e "feita", mais a frase-resumo. */
export function dependsOverview(project: Tasks, task: Pick<ProjectTask, "dependsOn" | "status">): DependsOverview {
  const rows = task.dependsOn.flatMap((ref): DependsRow[] => {
    const dep = project.tasks.find((candidate) => candidate.ref === ref);
    if (!dep) return [];
    // Módulo e tarefa-mãe: o estado é o das folhas (o gravado nunca muda) e "feita" é todas as folhas terminadas.
    const container = isContainer(project, dep);
    const status = container ? statusOf(project, dep) : dep.status;
    const done = container ? nodeDone(project, ref) : dep.status === "concluida";
    return [{ ref, title: dep.title, ownerId: dep.ownerId, status, done, stateLabel: done ? "feita" : (DEP_STATE_LABEL[status] ?? "ainda não começou") }];
  });
  const ordered = [...rows.filter((row) => !row.done), ...rows.filter((row) => row.done)];
  const pending = rows.filter((row) => !row.done).length;
  const started = task.status !== "backlog" && task.status !== "a_fazer";
  const summary =
    rows.length === 0 ? "" : pending > 0 ? `Esperando ${pending} de ${rows.length}` : started ? "Todas as dependências foram feitas" : "Nada travando: pode começar";
  return { rows: ordered, total: rows.length, pending, summary };
}

/** "espera Autenticação": o que o item ainda espera (dependências não terminadas), na frase da linha e do painel; vazio se nada trava. */
export function pendingWaitsText(project: Tasks, task: Pick<ProjectTask, "dependsOn" | "status">): string {
  return waitsText(dependsOverview(live(project), task).rows.filter((row) => !row.done).map((row) => row.title));
}

/** Filtra as opções da lista completa pelo nome do item, do responsável ou do caminho (sem acento nem caixa). */
export function filterDependsChoices(choices: DependsChoice[], query: string, ownerName: (id: string) => string): DependsChoice[] {
  const needle = normalizeText(query.trim());
  if (!needle) return choices;
  return choices.filter((choice) => normalizeText(`${choice.title} ${choice.path ?? ""} ${choice.ownerId ? ownerName(choice.ownerId) : ""}`).includes(needle));
}
