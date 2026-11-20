import { childrenOf, effectiveDeps, finalLeaves, isLeaf, joinNames, leavesOf, pathOf, subtreeRefs, waitingText, type Project, type ProjectTask, type ProjectTaskStatus } from "@cyno/shared";
import { queuePositions } from "./taskTreeView";

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
      return [{ ref, label, done: dep.status === "concluida" }];
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

export type DependsChoice = { ref: string; title: string; ownerId: string; checked: boolean };

/**
 * As opções da lista "Depois de" de uma tarefa: as irmãs (mesmo pai), menos ela mesma; as que já são dependência e não
 * são irmãs ficam na lista para dar para tirar. Fora: entregáveis, a mãe dela e as de dentro dela (o servidor recusaria).
 */
export function dependsChoices(project: Tasks, task: Pick<ProjectTask, "ref" | "parent" | "dependsOn">): DependsChoice[] {
  const visible = live(project);
  const ancestors = new Set(pathOf(visible, task.ref).map((node) => node.ref));
  const below = new Set(subtreeRefs(visible, task.ref));
  const siblings = childrenOf(visible, task.parent).filter((sibling) => !sibling.group && sibling.ref !== task.ref && !ancestors.has(sibling.ref) && !below.has(sibling.ref));
  const extra = task.dependsOn.flatMap((ref) => (siblings.some((sibling) => sibling.ref === ref) ? [] : visible.tasks.filter((candidate) => candidate.ref === ref)));
  return [...siblings, ...extra].map((candidate) => ({ ref: candidate.ref, title: candidate.title, ownerId: candidate.ownerId, checked: task.dependsOn.includes(candidate.ref) }));
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
    const done = dep.status === "concluida";
    return [{ ref, title: dep.title, ownerId: dep.ownerId, status: dep.status, done, stateLabel: DEP_STATE_LABEL[dep.status] ?? "ainda não começou" }];
  });
  const ordered = [...rows.filter((row) => !row.done), ...rows.filter((row) => row.done)];
  const pending = rows.filter((row) => !row.done).length;
  const started = task.status !== "backlog" && task.status !== "a_fazer";
  const summary =
    rows.length === 0 ? "" : pending > 0 ? `Esperando ${pending} de ${rows.length}` : started ? "Todas as dependências foram feitas" : "Nada travando: pode começar";
  return { rows: ordered, total: rows.length, pending, summary };
}

/** Filtra as opções da lista completa pelo nome da tarefa ou do responsável (sem acento nem caixa). */
export function filterDependsChoices(choices: DependsChoice[], query: string, ownerName: (id: string) => string): DependsChoice[] {
  const norm = (text: string) => text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const needle = norm(query.trim());
  if (!needle) return choices;
  return choices.filter((choice) => norm(`${choice.title} ${choice.ownerId ? ownerName(choice.ownerId) : ""}`).includes(needle));
}
