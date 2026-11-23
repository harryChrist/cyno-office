import {
  PROJECT_SAFETY,
  leavesOf,
  isOpenStatus,
  joinNames,
  releaseHold,
  type Label,
  type Project,
  type ProjectPriority,
  type ProjectTask,
  type ProjectTaskStatus,
} from "@cyno/shared";
import { visibleWindow } from "./visibleWindow";
import {
  buildProjectIndex,
  containerReleaseFromAgg,
  pendencySummaryFromAgg,
  waitingTextIn,
  type ProjectIndex,
} from "./projectIndex";
import { containerState, leafState, plannedWaits, type PlannedWait, type RowState } from "./releaseView";
import { carriedLabel, startsInLabel } from "./sprintsView";
import { ancestorsIn, heightIn, isLeafIn, kidsOf, moveDependencyConflict, subtreeSet, treeIndex, type TreeIndex } from "./treeIndex";
import { spanLabel, shortDate } from "./workView";

/**
 * Linhas da árvore de tarefas de um projeto (a lista em árvore do ClickUp): módulos, tarefas e subtarefas em
 * qualquer profundidade, com seta de abrir e fechar, contador, responsáveis, data e prioridade. Função pura: o
 * React só desenha o que sai daqui. Quem contém outros itens é contêiner e o estado dele é o calculado das
 * folhas (`rollupStatus`), nunca o gravado. Para a árvore grande: tudo nasce recolhido (o dono abre o que quiser),
 * cada nível mostra os filhos de 30 em 30 ("ver mais N"), a busca mostra só os achados com os ancestrais e
 * `buildTreeRows` só percorre os nós visíveis/abertos usando o `ProjectIndex` memoizado por versão do projeto.
 */

const DAY = 86_400_000;
/** Quantos avatares a coluna Responsáveis mostra antes do "+N". */
export const ASSIGNEES_SHOWN = 3;

export type DueTone = "done" | "late" | "soon" | "normal";
export type DueInfo = { label: string; tone: DueTone; at: string; title: string };
/** Dados puros de prazo da linha (sem depender de `now`): permitem recalcular o texto relativo só nas linhas visíveis. */
export type DueMeta = { at: string; finishedAt?: string };

export type TreeNodeRow = {
  kind: "node";
  key: string;
  ref: string;
  node: ProjectTask;
  /** 1 = direto no projeto, 2 = filha, 3 = neta, sem limite. */
  depth: number;
  parentRef?: string;
  /** Módulo criado de propósito (`group`), mesmo vazio. */
  isGroup: boolean;
  /** Contém outros itens (módulo ou tarefa com subtarefas): o estado e o progresso saem das folhas, nunca executa. */
  isContainer: boolean;
  /** Tem filhas (a seta aparece). */
  hasChildren: boolean;
  /** Quantas filhas diretas (as arquivadas não contam). */
  childCount: number;
  open: boolean;
  /** O gravado se é folha; o calculado das filhas se é pai ou módulo. */
  status: ProjectTaskStatus;
  /** Folhas (atividades) concluídas e total da subárvore ("2/3"); undefined em folha. */
  progress?: { done: number; total: number };
  /** Títulos de quem ancestral é, do mais alto ao pai ("Leitura", "Capítulos"): o caminho que o celular mostra no lugar do recuo. */
  trail: string[];
  /** "espera Autenticação": o que este item (módulo, mãe ou tarefa) ainda espera e não terminou. Ausente se nada trava. */
  waits?: string;
  assignees: string[];
  /** Quantos agentes passam do teto de avatares ("+N"). */
  moreAssignees: number;
  due: DueInfo | null;
  /** Prazo bruto da linha para resolver atraso/vence em relação a `now` sem reconstruir a árvore. */
  dueMeta?: DueMeta;
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
  /** O que a coluna Estado diz (Planejada, Na fila, Em andamento…; no módulo, Planejado, Misto, Em execução…). */
  state: RowState;
  /** O que este item liberado espera e ainda está Planejado ("espera T7, que está Planejada"). */
  plannedWaits: PlannedWait[];
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
  /** Tarefa-mãe: quantas subtarefas estão prontas, de quantas (a barrinha e o "Tudo pronto"). */
  done?: number;
  total?: number;
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
  /** No fim do projeto: dois botões (módulo e tarefa). */
  root: boolean;
  /** Dois botões ("+ Módulo" e "+ Tarefa"): a raiz e o fim de cada módulo. Falso = um só ("+ Subtarefa"). */
  both: boolean;
};

/** "ver mais 70": a linha que mostra mais filhos de um nível com muitos itens (de 30 em 30). */
export type TreeMoreRow = {
  kind: "more";
  key: string;
  depth: number;
  /** Pai dos itens escondidos; ausente = o projeto. */
  parentRef?: string;
  remaining: number;
};

export type TreeRow = TreeNodeRow | TreeStepRow | TreeAddRow | TreeMoreRow;

/** Quantos filhos cada nível mostra de uma vez (e quantos mais cada "ver mais" traz). */
export const TREE_PAGE = 30;

/** A partir de quantas linhas visíveis a árvore liga a janela de rolagem (virtualização). */
export const TREE_VIRTUALIZE_FROM = 200;

/** A coluna Sprint aparece só quando o projeto tem sprints. */
export const hasSprintColumn = (project: Pick<Project, "sprints">): boolean => (project.sprints?.length ?? 0) > 0;

/** Projeto sem sprints (todo projeto novo): a coluna Estado ocupa o lugar da Sprint. */
export const hasStateColumn = (project: Pick<Project, "sprints">): boolean => !hasSprintColumn(project);

const live = (project: Pick<Project, "tasks">): Pick<Project, "tasks"> => ({ tasks: project.tasks.filter((task) => !task.archived) });

/** Texto sem acento nem caixa (a busca da árvore). */
export const normalizeText = (text: string): string => text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

/** O caminho de ancestrais que o celular mostra no lugar do recuo: "Leitura > Capítulos > Lote 1". */
export const pathText = (titles: readonly string[]): string => titles.join(" > ");

/** A partir de que nível o celular para de recuar (o resto fica por conta do caminho). */
export const MOBILE_INDENT_LEVELS = 4;

/** Quantos níveis de recuo a linha tem: no desktop sem limite; no celular pára no nível 4 (`depth` 1 = sem recuo). */
export const indentLevel = (depth: number, mobile: boolean): number => Math.max(0, mobile ? Math.min(depth, MOBILE_INDENT_LEVELS) - 1 : depth - 1);

/** Prazo da linha a partir dos dados brutos (`at`, `finishedAt`) e do relógio `now`. Verde se concluída no prazo, vermelho se atrasada, âmbar se falta menos de 24 h. */
export function resolveDue(meta: DueMeta | undefined, status: ProjectTaskStatus, now: number): DueInfo | null {
  if (!meta?.at) return null;
  const due = Date.parse(meta.at);
  if (Number.isNaN(due)) return null;
  const label = shortDate(meta.at);
  if (status === "concluida") {
    const finished = meta.finishedAt ? Date.parse(meta.finishedAt) : NaN;
    if (!Number.isNaN(finished) && finished <= due) return { label, tone: "done", at: meta.at, title: "Concluída no prazo" };
    return { label, tone: Number.isNaN(finished) ? "normal" : "late", at: meta.at, title: Number.isNaN(finished) ? "Concluída" : "Concluída depois do prazo" };
  }
  if (status === "cancelada") return { label, tone: "normal", at: meta.at, title: "Cancelada" };
  if (due < now) return { label, tone: "late", at: meta.at, title: `Atrasada há ${spanLabel(now - due)}` };
  if (due - now < DAY) return { label, tone: "soon", at: meta.at, title: `Vence em ${spanLabel(due - now)}` };
  return { label, tone: "normal", at: meta.at, title: "Prazo" };
}

function dueMetaOf(node: ProjectTask, leafDue: string | undefined, leafFinished: string | undefined): DueMeta | undefined {
  const at = node.dueAt || leafDue;
  if (!at) return undefined;
  const finishedAt = node.finishedAt ?? (leafFinished || undefined);
  return finishedAt ? { at, finishedAt } : { at };
}

export function dueOf(project: Pick<Project, "tasks">, node: ProjectTask, status: ProjectTaskStatus, now: number): DueInfo | null {
  const leaves = leavesOf(project, node.ref);
  let dueMax: string | undefined;
  let finishedMax = "";
  for (const leaf of leaves) {
    if (leaf.dueAt && (!dueMax || leaf.dueAt > dueMax)) dueMax = leaf.dueAt;
    if (leaf.finishedAt && leaf.finishedAt > finishedMax) finishedMax = leaf.finishedAt;
  }
  return resolveDue(dueMetaOf(node, dueMax, finishedMax), status, now);
}

/**
 * Quais nós ficam fechados: todos, menos os que o dono abriu (`openRefs`). A árvore sempre nasce fechada (projeto de
 * centenas de itens não vira uma parede de linhas); o que o dono abre é lembrado por projeto, e um nó novo nasce fechado.
 */
export function closedRefsOf(project: Pick<Project, "tasks">, openRefs: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  for (const task of project.tasks) if (!task.archived && !openRefs.has(task.ref)) out.add(task.ref);
  return out;
}

/** A folha já começou (saiu de backlog/a fazer ou tem etapa entregue a um agente)? Então não vira mãe. */
const started = (task: ProjectTask): boolean => (task.status !== "backlog" && task.status !== "a_fazer") || task.steps.some((step) => step.status !== "pendente" || step.taskId !== undefined);

type Options = {
  /** Linhas "Adicionar …" no fim de cada nível (só quando o projeto aceita criar à mão). */
  addRows?: boolean;
  /** Tarefa que acabou de ganhar "Adicionar subtarefa": abre e mostra a linha de adicionar mesmo sem filhas. */
  forceAdd?: string;
  /** Relógio para calcular prazos relativos; quando omitido, a linha guarda só `dueMeta` e a célula resolve com `now`. */
  now?: number;
  /** Nome do agente por id (para "espera a Sônia…"). Sem isso, mostra o id. */
  agentName?: (id: string) => string;
  /** Busca: mostra só quem bate no título ou no `ref` e os ancestrais deles (abertos). Vazio = árvore normal. */
  query?: string;
  /** Quantos filhos cada pai mostra (chave = `ref` do pai; "" = o projeto). O que faltar usa `TREE_PAGE`. */
  shown?: ReadonlyMap<string, number>;
  /** Filtro "Mostrar" (Liberadas, Planejadas): `ref` das linhas que ficam (folhas que batem e ancestrais). Junto com a busca, vale quem passa nos dois. */
  filter?: ReadonlySet<string> | null;
  /** Índice já montado para esta versão do projeto (evita reindexar a cada abertura/fechamento). */
  index?: ProjectIndex;
  /** Quando informado, define os nós abertos diretamente (sem precisar montar `closedRefs` com todos os nós do projeto). */
  openRefs?: ReadonlySet<string>;
};

export function queuePositions(project: Pick<Project, "tasks">, prebuilt?: ProjectIndex): Map<string, number> {
  return new Map((prebuilt ?? buildProjectIndex(project.tasks)).queuePositions());
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

/** O que a busca deixa na tela: quem bate (título ou `ref`, sem acento nem caixa) e os ancestrais deles. `null` = busca vazia. */
export type TreeSearch = { matches: Set<string>; show: Set<string> };

function searchIn(index: TreeIndex, query: string): TreeSearch | null {
  const needle = normalizeText(query.trim());
  if (!needle) return null;
  const matches = new Set<string>();
  for (const task of index.byRef.values()) if (normalizeText(`${task.title} ${task.ref}`).includes(needle)) matches.add(task.ref);
  const show = new Set(matches);
  for (const ref of matches) for (const ancestor of ancestorsIn(index, ref)) show.add(ancestor.ref);
  return { matches, show };
}

export function searchTree(project: Pick<Project, "tasks">, query: string, prebuilt?: ProjectIndex): TreeSearch | null {
  return searchIn(prebuilt ? prebuilt.tree : treeIndex(live(project).tasks), query);
}

/** "espera Autenticação" / "espera Autenticação e Pagamentos" / "espera Autenticação e mais 2". */
export function waitsText(titles: readonly string[]): string {
  if (titles.length === 0) return "";
  if (titles.length <= 2) return `espera ${joinNames(titles)}`;
  return `espera ${titles[0]} e mais ${titles.length - 1}`;
}

/**
 * As linhas visíveis, na ordem da tela: cada nó (com `order`), os filhos só se o nó está aberto (de 30 em 30, com a
 * linha "ver mais N"), e as linhas de "Adicionar" no fim de cada nível aberto. Tarefas arquivadas não aparecem. Com
 * `query`, só os achados e os ancestrais deles (sempre abertos) e sem linhas de adicionar.
 */
export function buildTreeRows(project: Project, closedRefs: ReadonlySet<string>, options: Options): TreeRow[] {
  const pIndex = options.index ?? buildProjectIndex(project.tasks);
  const index = pIndex.tree;
  const agg = pIndex.agg;
  const labelOf = new Map((project.labels ?? []).map((label) => [label.id, label]));
  const name = options.agentName ?? ((id: string) => id);
  const isClosed = options.openRefs ? (ref: string) => !options.openRefs!.has(ref) : (ref: string) => closedRefs.has(ref);
  const found = options.query ? searchIn(index, options.query) : null;
  const narrow = options.filter ?? null;
  // Busca e filtro "Mostrar" usam o mesmo caminho (mostrar só os achados e os ancestrais); com os dois, vale quem passa nos dois.
  const search: TreeSearch | null = (() => {
    if (!found && !narrow) return null;
    if (!found) return { matches: new Set(narrow!), show: new Set(narrow!) };
    if (!narrow) return found;
    const matches = new Set([...found.matches].filter((ref) => narrow.has(ref)));
    const show = new Set(matches);
    for (const ref of matches) for (const ancestor of ancestorsIn(index, ref)) if (narrow.has(ancestor.ref)) show.add(ancestor.ref);
    return { matches, show };
  })();
  const { anyPlanned, anyDeps } = pIndex;
  const pageOf = (key: string) => options.shown?.get(key) ?? TREE_PAGE;
  /** Terminou? Folha: concluída ou cancelada; contêiner: todas as folhas dele (vazio não conta como feito). Ref que não existe (arquivado) já terminou. */
  const finished = (ref: string): boolean => {
    const item = agg.get(ref);
    return item === undefined ? true : item.leaves > 0 && item.unfinished === 0;
  };
  let queue: ReadonlyMap<string, number> | null = null;
  const queueOf = (): ReadonlyMap<string, number> => (queue ??= pIndex.queuePositions());
  const rows: TreeRow[] = [];
  const walk = (node: ProjectTask, depth: number, trail: string[]) => {
    const allKids = kidsOf(index, node.ref);
    const kids = search ? allKids.filter((child) => search.show.has(child.ref)) : allKids;
    const isGroup = node.group === true;
    const parent = isGroup || allKids.length > 0;
    const open = search ? kids.length > 0 : (isGroup && allKids.length === 0) || ((parent || options.forceAdd === node.ref) && (options.forceAdd === node.ref || !isClosed(node.ref)));
    const summary = agg.get(node.ref)!;
    const status = summary.status;
    const mother = !isGroup && allKids.length > 0;
    const parentNode = node.parent ? index.byRef.get(node.parent) : undefined;
    const inMother = !isGroup && allKids.length === 0 && parentNode !== undefined && !parentNode.group;
    const hasPendingDeps = !isGroup && allKids.length === 0 && node.dependsOn.length > 0 && isOpenStatus(node.status);
    let flow: FlowInfo | undefined;
    if (mother) {
      const running = summary.runners.map((id) => name(id));
      flow = {
        kind: "mother",
        // Mãe com subtarefa cancelada, que falhou ou travada: "3 de 5 prontas · 1 cancelada · 1 travada" (ela não conclui sozinha).
        summary: pendencySummaryFromAgg(summary) ?? `${summary.concluded} de ${summary.notCancelled} ${summary.notCancelled === 1 ? "pronta" : "prontas"}${running.length > 0 ? ` · agora: ${joinNames(running)}` : ""}`,
        everyone: summary.assignees,
        done: summary.concluded,
        total: summary.notCancelled,
        text: "",
      };
    } else if (inMother || hasPendingDeps) {
      const q = queueOf();
      const waits = waitingTextIn(pIndex, node, name, q.get(node.ref));
      const ended = node.status === "concluida" ? "entregou" : node.status === "falhou" ? "falhou" : node.status === "cancelada" ? "cancelada" : undefined;
      flow = { kind: "subtask", ...(node.ownerId ? { ownerId: node.ownerId, ownerName: name(node.ownerId) } : {}), text: waits ?? ended ?? (node.status === "backlog" ? "sem responsável ou parada" : "") };
    }
    const stepCount = !isGroup && allKids.length === 0 && node.steps.length > 1 ? node.steps.length : 0;
    const waitTitles = isOpenStatus(status) ? node.dependsOn.flatMap((ref) => (index.byRef.has(ref) && !finished(ref) ? [index.byRef.get(ref)!.title] : [])) : [];
    const leaf = !parent;
    const state = leaf
      ? leafState({ status, hold: releaseHold(node) !== undefined, blocked: summary.blocked })
      : containerState({ status, release: summary.leaves === 0 && node.released === false ? "planejada" : anyPlanned ? containerReleaseFromAgg(summary) : undefined });
    const dueMeta = dueMetaOf(node, summary.dueMax, summary.finishedMax);
    const due = options.now !== undefined ? resolveDue(dueMeta, status, options.now) : null;
    const startsIn = leaf ? startsInLabel(project, node) : null;
    const carried = leaf ? carriedLabel(project, node) : null;
    rows.push({
      state,
      plannedWaits: anyPlanned && anyDeps ? plannedWaits(project, node, pIndex) : [],
      kind: "node",
      key: node.ref,
      ref: node.ref,
      node,
      depth,
      ...(node.parent ? { parentRef: node.parent } : {}),
      isGroup,
      isContainer: parent,
      hasChildren: allKids.length > 0,
      childCount: allKids.length,
      open,
      status,
      ...(parent ? { progress: { done: summary.done, total: summary.counted } } : {}),
      trail,
      ...(waitTitles.length > 0 ? { waits: waitsText(waitTitles) } : {}),
      assignees: summary.assignees.slice(0, ASSIGNEES_SHOWN),
      moreAssignees: Math.max(0, summary.assignees.length - ASSIGNEES_SHOWN),
      due,
      ...(dueMeta ? { dueMeta } : {}),
      priority: leaf ? node.priority : summary.best,
      labels: (node.labels ?? []).flatMap((id) => (labelOf.has(id) ? [labelOf.get(id)!] : [])),
      blocked: summary.blocked,
      waiting: summary.waiting,
      sprints: summary.sprints,
      ...(startsIn ? { startsIn } : {}),
      ...(carried ? { carried } : {}),
      ...(flow ? { flow } : {}),
      ...(stepCount > 0 ? { stepCount } : {}),
      canAddChild: depth < PROJECT_SAFETY.depth && (isGroup || allKids.length > 0 || (!started(node) && isLeafIn(index, node))),
    });
    // Tarefa antiga com `steps`: cada passo vira uma linha filha só de leitura (a seta abre e fecha).
    if (stepCount > 0 && !isClosed(node.ref)) {
      node.steps.forEach((step, position) => {
        const stateOfStep = stepStatus(node, position);
        rows.push({ kind: "step", key: `step:${node.ref}:${position}`, parentRef: node.ref, depth: depth + 1, index: position, total: node.steps.length, agentId: step.agentId, what: step.what, status: stateOfStep, text: stepText(node, position, stateOfStep, name) });
      });
    }
    if (!open) return;
    const limit = pageOf(node.ref);
    const nextTrail = [...trail, node.title];
    const shownCount = Math.min(kids.length, limit);
    for (let i = 0; i < shownCount; i += 1) walk(kids[i]!, depth + 1, nextTrail);
    if (kids.length > limit) rows.push({ kind: "more", key: `more:${node.ref}`, depth: depth + 1, parentRef: node.ref, remaining: kids.length - limit });
    if (options.addRows && !search && (isGroup || allKids.length > 0 || options.forceAdd === node.ref) && depth < PROJECT_SAFETY.depth) {
      rows.push({ kind: "add", key: `add:${node.ref}`, depth: depth + 1, parentRef: node.ref, label: isGroup ? "Adicionar tarefa" : "Adicionar subtarefa", root: false, both: isGroup });
    }
  };
  const allTops = kidsOf(index);
  const tops = search ? allTops.filter((top) => search.show.has(top.ref)) : allTops;
  const rootLimit = pageOf("");
  const shownTops = Math.min(tops.length, rootLimit);
  for (let i = 0; i < shownTops; i += 1) walk(tops[i]!, 1, []);
  if (tops.length > rootLimit) rows.push({ kind: "more", key: "more:root", depth: 1, remaining: tops.length - rootLimit });
  if (options.addRows && !search) rows.push({ kind: "add", key: "add:root", depth: 1, label: "Adicionar módulo ou tarefa", root: true, both: true });
  return rows;
}

/** Altura estimada de uma linha da árvore (para a janela de rolagem quando há muitas linhas abertas). */
export function treeRowHeight(row: TreeRow, mobile: boolean): number {
  if (row.kind === "add" || row.kind === "more") return 36;
  if (row.kind === "step") return mobile ? 64 : 58;
  const hasSub = Boolean(row.flow) || row.plannedWaits.length > 0 || (row.isContainer && Boolean(row.waits));
  if (mobile) return hasSub ? 96 : 70;
  return hasSub ? 60 : 37;
}

/** Janela de rolagem da árvore (reaproveita `visibleWindow` de `allTasksView.ts`). */
export function treeVisibleRange(rows: readonly TreeRow[], mobile: boolean, top: number, height: number, overscan = 12): { start: number; end: number; total: number; offset: number; bottom: number } {
  const range = visibleWindow(rows, (row) => treeRowHeight(row, mobile), top, height, overscan);
  let sliceHeight = 0;
  for (let i = range.start; i < range.end; i += 1) sliceHeight += treeRowHeight(rows[i]!, mobile);
  return { ...range, bottom: Math.max(0, range.total - range.offset - sliceHeight) };
}

/**
 * Os destinos válidos de "Mover para…": o projeto e todo item que aceita filha (módulos primeiro, mas também tarefas que
 * ainda não começaram), sem o próprio nó nem os de dentro dele, sem o pai atual e sem criar dependência impossível.
 */
export type MoveTarget = {
  ref: string | null;
  label: string;
  depth: number;
  /** "Leitura > Capítulos": onde o destino fica. */
  path: string;
  /** Módulo ou item que já tem filhas (os outros são tarefas que virariam mãe). */
  container: boolean;
};

export function moveTargets(project: Project, ref: string, prebuilt?: ProjectIndex): MoveTarget[] {
  const index = prebuilt ? prebuilt.tree : treeIndex(live(project).tasks);
  const node = index.byRef.get(ref);
  if (!node) return [];
  const below = subtreeSet(index, ref);
  const need = heightIn(index, ref);
  const out: MoveTarget[] = [];
  if (node.parent !== undefined) out.push({ ref: null, label: "Direto no projeto", depth: 0, path: "", container: true });
  const walk = (task: ProjectTask, depth: number, trail: string[]) => {
    if (below.has(task.ref)) return;
    const startedLeaf = isLeafIn(index, task) && task.status !== "backlog" && task.status !== "a_fazer";
    if (depth + need <= PROJECT_SAFETY.depth && task.ref !== node.parent && !startedLeaf && !moveDependencyConflict(index, ref, task.ref)) {
      out.push({ ref: task.ref, label: task.title, depth, path: pathText(trail), container: !isLeafIn(index, task) });
    }
    for (const child of kidsOf(index, task.ref)) walk(child, depth + 1, [...trail, task.title]);
  };
  for (const top of kidsOf(index)) walk(top, 1, []);
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

/** Chave do localStorage com os nós que o dono abriu num projeto. */
export const treeOpenKey = (workspaceId: string | null, projectId: string): string => `cyno:tree-open:${workspaceId ?? "-"}:${projectId}`;

/** Lê o que o dono deixou aberto (null = nunca abriu nada). Com try/catch: sem armazenamento tudo funciona. */
export function readOpenRefs(key: string): Set<string> | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed.filter((item): item is string => typeof item === "string")) : null;
  } catch {
    return null;
  }
}

export function writeOpenRefs(key: string, refs: ReadonlySet<string>): void {
  try {
    localStorage.setItem(key, JSON.stringify([...refs]));
  } catch {
    // Sem armazenamento: só não lembra.
  }
}
