import {
  childrenOf,
  clearBlocked,
  completedRefs,
  depthOf,
  effectiveDeps,
  findDependencyCycle,
  isLeaf,
  leavesOf,
  pathOf,
  isProjectTaskFinished,
  LABEL_COLORS,
  nextTaskRef,
  PROJECT_LIMITS,
  PROJECT_SAFETY,
  projectTaskDefaults,
  releaseHold,
  subtreeRefs,
  validateTree,
  type Label,
  type Project,
  type ProjectPriority,
  type ProjectTask,
} from "@cyno/shared";
import { HttpError } from "../../platform/http/errors";
import { inheritSprint, requireSprint } from "./sprint-service";

/**
 * Edição da árvore de tarefas pela tela (funções que mexem no `Project` em memória; o `ProjectService`
 * grava, publica e põe a fila para andar). Tudo aqui lança `HttpError` em português, para a tela mostrar.
 */

const ORDER_STEP = 1000;

/** Cores das etiquetas (ids que a tela conhece), em rodízio. */
export { LABEL_COLORS };

/** A tarefa já começou (alguma etapa saiu de "pendente" ou o estado não é backlog/a fazer)? */
export function hasStarted(task: ProjectTask): boolean {
  return (task.status !== "backlog" && task.status !== "a_fazer") || task.steps.some((step) => step.status !== "pendente" || step.taskId !== undefined);
}

export function requireTask(project: Project, ref: string): ProjectTask {
  const task = project.tasks.find((candidate) => candidate.ref === ref);
  if (!task) throw new HttpError(404, `A tarefa "${ref}" não existe neste projeto`);
  return task;
}

/** Estado de uma folha que ainda não começou: sem responsável fica no backlog; com responsável e dependências prontas, vai para a fila. */
export function idleStatus(project: Pick<Project, "tasks">, task: Pick<ProjectTask, "ownerId" | "dependsOn"> & { ref?: string }): "backlog" | "a_fazer" {
  if (!task.ownerId) return "backlog";
  const done = completedRefs(project);
  // As dependências da mãe valem para as subtarefas de entrada dela (`effectiveDeps`).
  const deps = task.ref !== undefined && project.tasks.some((candidate) => candidate.ref === task.ref) ? effectiveDeps(project, { ref: task.ref, dependsOn: task.dependsOn }) : task.dependsOn;
  return deps.every((ref) => done.has(ref)) ? "a_fazer" : "backlog";
}

/** Passos de uma tarefa nova: um só, do responsável (vazio = sem responsável ainda), fazendo o que o briefing pede. */
export function singleStep(agentId: string, what: string): ProjectTask["steps"] {
  return [{ agentId, what: what.trim() || "Fazer a tarefa", status: "pendente" }];
}

/** Próximo valor de `order` no fim dos irmãos. */
function lastOrder(project: Project, parent: string | undefined): number {
  const siblings = childrenOf(project, parent);
  const last = siblings.at(-1);
  return last ? (last.order ?? siblings.length * ORDER_STEP) + ORDER_STEP : ORDER_STEP;
}

/** Reescreve `order` dos irmãos de `parent` em passos de 1000, na ordem dada. */
function reindex(project: Project, parent: string | undefined, ordered: ProjectTask[]): void {
  void project;
  void parent;
  ordered.forEach((task, index) => {
    task.order = (index + 1) * ORDER_STEP;
  });
}

/**
 * O erro do `validateTree` em português para o DONO (a tela). O texto em inglês é o que o Maestro recebe pelas ferramentas MCP e fica como está
 * lá; aqui ele não aparece misturado ("Não dá para fazer isso: Task T3: depends on its own descendant…").
 */
export function ownerTreeError(error: string): string {
  const rules: [RegExp, (match: RegExpExecArray) => string][] = [
    [/^The project would have (\d+) items \(safety net/, (m) => `o projeto ficaria com ${m[1]} itens (a rede de segurança é ${PROJECT_SAFETY.nodes}): divida em mais de um projeto`],
    [/^(Task \S+|\S+): parent "(.+)" does not exist$/, (m) => `${where(m[1]!)}: a tarefa-mãe "${m[2]}" não existe`],
    [/^(Task \S+|\S+): cannot be its own parent$/, (m) => `${where(m[1]!)}: não pode ser mãe de si mesma`],
    [/^(Task \S+|\S+): the parent chain forms a cycle$/, (m) => `${where(m[1]!)}: a cadeia de mães forma um ciclo`],
    [/^(Task \S+|\S+): nested (\d+) levels deep \(safety net/, (m) => `${where(m[1]!)}: fica ${m[2]} níveis abaixo do projeto (a rede de segurança é ${PROJECT_SAFETY.depth}): simplifique a estrutura`],
    [/^(Task \S+|\S+): a (?:deliverable|module) \(group\) has no steps/, (m) => `${where(m[1]!)}: o módulo não tem passos, ele nunca executa`],
    [/^(Task \S+|\S+): a leaf task needs at least one step$/, (m) => `${where(m[1]!)}: a tarefa precisa de pelo menos um passo`],
    [/^(Task \S+|\S+): only leaf tasks go in a sprint/, (m) => `${where(m[1]!)}: só as tarefas que executam entram numa sprint`],
    [/^(Task \S+|\S+): sprint "(.+)" does not exist$/, (m) => `${where(m[1]!)}: a sprint "${m[2]}" não existe`],
    [/^(Task \S+|\S+): at most (\d+) labels per task$/, (m) => `${where(m[1]!)}: no máximo ${m[2]} etiquetas por tarefa`],
    [/^(Task \S+|\S+): label "(.+)" does not exist in the project$/, (m) => `${where(m[1]!)}: a etiqueta "${m[2]}" não existe no projeto`],
    [/^Task (\S+): depends on its own descendant "(.+)"$/, (m) => `A tarefa ${m[1]} não pode depender de uma subtarefa dela mesma ("${m[2]}")`],
    [/^Task (\S+): depends on its own ancestor "(.+)"/, (m) => `A tarefa ${m[1]} não pode depender do módulo ou da tarefa de que faz parte ("${m[2]}")`],
    [/^The dependencies form a cycle: (.+)\. Remove one of them$/, (m) => `as ligações de "depois de" formam um ciclo (${m[1]}): uma não poderia começar antes da outra`],
  ];
  const where = (label: string) => (label.startsWith("Task ") ? `A tarefa ${label.slice(5)}` : `A tarefa ${label}`);
  for (const [pattern, translate] of rules) {
    const match = pattern.exec(error);
    if (match) return translate(match);
  }
  return "a estrutura das tarefas ficaria inválida";
}

/** O primeiro erro do `validateTree`, em português (é a tela do dono que chama; o Maestro usa `validateTree` direto, em inglês). */
export function assertValidTree(project: Pick<Project, "tasks" | "sprints" | "labels">): void {
  const { errors } = validateTree(project);
  if (errors.length > 0) throw new HttpError(400, `Não dá para fazer isso: ${ownerTreeError(errors[0]!)}`);
}

/** A folha que ainda não começou vira "mãe": deixa de executar (o estado e os responsáveis passam a vir das filhas). */
export function becomeMother(parent: ProjectTask, at: string): void {
  delete parent.sprintId;
  parent.steps = [];
  parent.ownerId = "";
  parent.current = 0;
  parent.status = "backlog";
  delete parent.note;
  clearBlocked(parent, at);
  delete parent.waitingSince;
  parent.updatedAt = at;
}

/**
 * "Criar não executa": o item novo nasce Planejado (`released: false`), EXCETO dentro de um contêiner direto com `released === true`
 * explícito (módulo já em execução), onde nasce liberado. Na raiz do projeto é sempre Planejado.
 */
export function newNodeReleased(parent: Pick<ProjectTask, "released"> | undefined): boolean {
  return parent?.released === true;
}

/**
 * Cria o nó (módulo, tarefa ou subtarefa) no fim dos irmãos e devolve a tarefa nova. Nasce Planejado (veja `newNodeReleased`), a menos que
 * `input.released` diga outra coisa (o retrabalho da sprint e as subtarefas de uma tarefa já liberada passam o valor).
 */
export function addNode(
  project: Project,
  input: { title: string; parent?: string; group?: boolean; briefing?: string; assignee?: string; priority?: ProjectPriority; startAt?: string; dueAt?: string; labels?: string[]; released?: boolean },
  at: string,
): ProjectTask {
  const title = input.title.trim().replace(/\s+/g, " ");
  if (!title) throw new HttpError(400, "O título não pode ficar vazio");
  let parent: ProjectTask | undefined;
  if (input.parent !== undefined) {
    parent = requireTask(project, input.parent);
    if (isProjectTaskFinished(parent) && !parent.group && childrenOf(project, parent.ref).length === 0) throw new HttpError(409, "A tarefa já terminou: não dá para criar dentro dela");
  }
  if (input.group && input.assignee) throw new HttpError(400, "Módulo não tem responsável: o responsável vem das tarefas dentro dele");
  // Só a rede de segurança (não há limite de itens, filhas nem níveis).
  const depth = parent ? depthOf(project, parent.ref) + 1 : 1;
  if (depth > PROJECT_SAFETY.depth) throw new HttpError(400, `Passou de ${PROJECT_SAFETY.depth} níveis de módulos dentro de módulos: simplifique a estrutura`);
  if (project.tasks.length >= PROJECT_SAFETY.nodes) throw new HttpError(400, `O projeto chegou a ${PROJECT_SAFETY.nodes} itens (rede de segurança): divida em mais de um projeto`);
  // A sprint da tarefa nova: a da mãe (se for folha) ou a ativa do projeto (risco 4: nunca nasce "travada").
  const sprintId = input.group ? undefined : inheritSprint(project, parent?.sprintId);
  if (parent && !parent.group && childrenOf(project, parent.ref).length === 0) {
    // A tarefa vira "mãe": deixa de executar (o estado e os responsáveis vêm das filhas).
    if (hasStarted(parent)) throw new HttpError(409, "A tarefa já começou: não dá para dividir em subtarefas");
    delete parent.sprintId;
    parent.steps = [];
    parent.ownerId = "";
    parent.current = 0;
    parent.status = "backlog";
    delete parent.note;
    clearBlocked(parent, at);
    delete parent.waitingSince;
    parent.updatedAt = at;
  }
  const briefing = input.briefing?.trim() ?? "";
  const task: ProjectTask = {
    ref: nextTaskRef(project),
    title,
    briefing: input.group ? briefing : briefing || title,
    ownerId: input.assignee ?? "",
    steps: input.group ? [] : singleStep(input.assignee ?? "", briefing || title),
    current: 0,
    dependsOn: [],
    priority: input.priority ?? "normal",
    ...projectTaskDefaults(),
    status: "backlog",
    ...(parent ? { parent: parent.ref } : {}),
    order: lastOrder(project, parent?.ref),
    ...(input.group ? { group: true as const } : {}),
    released: input.released ?? newNodeReleased(parent),
    ...(sprintId ? { sprintId } : {}),
    ...(input.startAt ? { startAt: input.startAt } : {}),
    ...(input.dueAt ? { dueAt: input.dueAt } : {}),
    ...(input.labels?.length ? { labels: [...new Set(input.labels)] } : {}),
    updatedAt: at,
  };
  // Entra na lista antes de calcular o estado: assim as dependências do módulo ou da mãe (`effectiveDeps`) já valem para a tarefa nova.
  project.tasks.push(task);
  if (!input.group) {
    task.status = idleStatus(project, task);
    if (task.status === "a_fazer") task.waitingSince = at;
  }
  assertValidTree(project);
  return task;
}

/** Tira o estado de execução de uma cópia: volta à fila (ou ao backlog), sem resultado, falha, bloqueio nem etapas feitas. */
function resetRun(task: ProjectTask, project: Pick<Project, "tasks">, at: string): void {
  task.steps = task.steps.map((step) => ({ agentId: step.agentId, ...(step.address ? { address: step.address } : {}), what: step.what, status: "pendente" as const }));
  task.current = 0;
  for (const key of ["result", "failure", "note", "blocked", "waitingSince", "stallWarned", "help", "startedAt", "finishedAt", "skipped", "origin", "archived", "meta", "carriedFrom"] as const) delete task[key];
  task.carryCount = 0;
  task.rework = { count: 0 };
  task.doneWhen = task.doneWhen.map((item) => ({ id: item.id, text: item.text }));
  task.updatedAt = at;
  task.status = "backlog";
  if (!task.group && task.steps.length > 0) {
    task.status = idleStatus(project, task);
    if (task.status === "a_fazer") task.waitingSince = at;
  }
}

/** Duplica a tarefa (com as filhas, sem estado) logo depois dela; devolve a cópia da raiz. */
export function duplicateNode(project: Project, ref: string, at: string): ProjectTask {
  const original = requireTask(project, ref);
  const refs = subtreeRefs(project, ref);
  if (project.tasks.length + refs.length > PROJECT_SAFETY.nodes) throw new HttpError(400, `O projeto passaria de ${PROJECT_SAFETY.nodes} itens (rede de segurança): divida em mais de um projeto`);
  const siblings = childrenOf(project, original.parent);
  const map = new Map<string, string>();
  const copies: ProjectTask[] = [];
  // Os refs novos saem um a um, vendo as cópias já criadas (nunca repete).
  const staging: Pick<Project, "tasks"> = { tasks: [...project.tasks] };
  for (const old of refs) {
    const source = project.tasks.find((task) => task.ref === old)!;
    const copy = structuredClone(source);
    copy.ref = nextTaskRef(staging);
    staging.tasks.push(copy);
    map.set(old, copy.ref);
    copies.push(copy);
  }
  for (const copy of copies) {
    if (copy.parent && map.has(copy.parent)) copy.parent = map.get(copy.parent)!;
    copy.dependsOn = copy.dependsOn.map((dep) => map.get(dep) ?? dep);
    const sprintId = copy.group || !copy.sprintId ? undefined : inheritSprint(project, copy.sprintId);
    if (sprintId) copy.sprintId = sprintId;
    else delete copy.sprintId;
  }
  const root = copies[0]!;
  root.title = `${original.title} (cópia)`.slice(0, PROJECT_LIMITS.title);
  // A cópia nasce Planejada (criar não executa); só vira liberada se o contêiner onde entra já está liberado. Cada filha segue a mãe da cópia.
  const parentOfRoot = original.parent ? project.tasks.find((task) => task.ref === original.parent) : undefined;
  root.released = newNodeReleased(parentOfRoot);
  const copyByRef = new Map(copies.map((copy) => [copy.ref, copy]));
  for (const copy of copies.slice(1)) copy.released = newNodeReleased(copy.parent ? copyByRef.get(copy.parent) : undefined);
  // A cópia entra logo depois do original.
  const at2 = siblings.indexOf(original);
  const ordered = [...siblings.slice(0, at2 + 1), root, ...siblings.slice(at2 + 1)];
  project.tasks.push(...copies);
  reindex(project, original.parent, ordered);
  for (const copy of copies) resetRun(copy, project, at);
  assertValidTree(project);
  return root;
}

/**
 * Muda de pai e/ou de posição. `parent`: `null` = direto no projeto; ausente = o mesmo pai. `before`: a irmã
 * que fica depois dela (null/ausente = no fim); `step` anda uma casa para cima ou para baixo entre as irmãs.
 */
export function moveNode(project: Project, ref: string, move: { parent?: string | null; before?: string | null; step?: "up" | "down" }, at: string): ProjectTask {
  const task = requireTask(project, ref);
  const newParentRef = move.parent === undefined ? task.parent : (move.parent ?? undefined);
  if (move.step) {
    const siblings = childrenOf(project, task.parent);
    const index = siblings.indexOf(task);
    const target = move.step === "up" ? index - 1 : index + 1;
    if (target < 0 || target >= siblings.length) return task;
    const swapped = [...siblings];
    [swapped[index], swapped[target]] = [swapped[target]!, swapped[index]!];
    reindex(project, task.parent, swapped);
    project.updatedAt = at;
    return task;
  }
  if (newParentRef !== undefined) {
    const parent = requireTask(project, newParentRef);
    if (subtreeRefs(project, ref).includes(newParentRef)) throw new HttpError(400, "Não dá para mover uma tarefa para dentro dela mesma");
    if (parent.group === undefined && childrenOf(project, parent.ref).length === 0 && newParentRef !== task.parent) {
      if (hasStarted(parent)) throw new HttpError(409, "A tarefa de destino já começou: não dá para dividir em subtarefas");
      delete parent.sprintId;
      parent.steps = [];
      parent.ownerId = "";
      parent.current = 0;
      parent.status = "backlog";
      delete parent.note;
      clearBlocked(parent, at);
      delete parent.waitingSince;
      parent.updatedAt = at;
    }
  }
  const siblings = childrenOf(project, newParentRef).filter((candidate) => candidate.ref !== ref);
  let index = siblings.length;
  if (move.before) {
    const found = siblings.findIndex((candidate) => candidate.ref === move.before);
    if (found < 0) throw new HttpError(400, `"${move.before}" não está nesse nível`);
    index = found;
  }
  const oldParent = task.parent;
  if (newParentRef === undefined) delete task.parent;
  else task.parent = newParentRef;
  const ordered = [...siblings.slice(0, index), task, ...siblings.slice(index)];
  reindex(project, newParentRef, ordered);
  task.updatedAt = at;
  // A mãe que ficou sem filhas volta a ser uma tarefa comum, sem responsável (o dono escolhe de novo).
  if (oldParent && oldParent !== newParentRef) restoreEmptyParent(project, oldParent, at);
  assertValidTree(project);
  return task;
}

/** Uma tarefa-mãe que perdeu a última filha volta a ser folha (sem responsável: backlog, com um passo em branco). */
export function restoreEmptyParent(project: Project, ref: string, at: string): void {
  const parent = project.tasks.find((candidate) => candidate.ref === ref);
  if (!parent || parent.group || childrenOf(project, ref).length > 0 || parent.steps.length > 0) return;
  parent.steps = singleStep("", parent.briefing || parent.title);
  parent.status = "backlog";
  parent.updatedAt = at;
}

/** Acha ou cria a etiqueta pelo nome (comparando sem caixa) e devolve o id. */
export function ensureLabel(project: Project, name: string): Label {
  const clean = name.trim().replace(/\s+/g, " ");
  const labels = (project.labels ??= []);
  const found = labels.find((label) => label.name.toLowerCase() === clean.toLowerCase());
  if (found) return found;
  if (labels.length >= PROJECT_LIMITS.labels) throw new HttpError(400, `O projeto aceita até ${PROJECT_LIMITS.labels} etiquetas`);
  let n = labels.length + 1;
  while (labels.some((label) => label.id === `L${n}`)) n += 1;
  const label: Label = { id: `L${n}`, name: clean, color: LABEL_COLORS[labels.length % LABEL_COLORS.length]! };
  labels.push(label);
  return label;
}

/** Manda a folha para uma sprint (`null` = sem sprint). Só folha que ainda não terminou; sprint fechada não recebe. */
export function moveToSprint(project: Project, ref: string, sprintId: string | null, at: string): ProjectTask {
  const task = requireTask(project, ref);
  if (task.group || project.tasks.some((candidate) => candidate.parent === task.ref)) throw new HttpError(400, "Só as tarefas que executam entram numa sprint (o pai mostra as sprints das filhas)");
  if (isProjectTaskFinished(task)) throw new HttpError(409, "A tarefa já terminou: não dá para mudar de sprint");
  if (sprintId === null) delete task.sprintId;
  else {
    const sprint = requireSprint(project, sprintId);
    if (sprint.status === "fechada" || sprint.status === "fechando") throw new HttpError(409, "Essa sprint já fechou. Mova para a sprint ativa ou para uma futura.");
    task.sprintId = sprint.id;
  }
  task.updatedAt = at;
  assertValidTree(project);
  return task;
}

/**
 * Troca a lista "depois de" de uma tarefa ou módulo (a lista inteira: acrescentar ou tirar é mandar a nova). Pode citar tarefa, módulo ou
 * tarefa-mãe. Recusa, em português: item que não existe, ele mesmo, o módulo/mãe de que faz parte ou um de dentro dele, e ciclo (A espera B que
 * espera A, também por módulo ou tarefa-mãe). Só antes de começar: depois que o agente começou, a ordem já foi decidida.
 */
export function setDependsOn(project: Project, task: ProjectTask, refs: readonly string[], at: string): void {
  const wanted = [...new Set(refs.map((ref) => ref.trim()).filter(Boolean))];
  if (hasStarted(task) && isLeaf(project, task)) throw new HttpError(409, "A tarefa já começou: não dá para mudar de quem ela espera");
  const title = (ref: string) => `“${project.tasks.find((candidate) => candidate.ref === ref)?.title ?? ref}”`;
  const ancestors = new Set(pathOf(project, task.ref).map((node) => node.ref));
  const below = new Set(subtreeRefs(project, task.ref));
  for (const ref of wanted) {
    const dep = project.tasks.find((candidate) => candidate.ref === ref);
    if (!dep) throw new HttpError(404, `A tarefa "${ref}" não existe neste projeto`);
    if (ref === task.ref) throw new HttpError(400, "Uma tarefa não pode esperar por ela mesma");
    if (ancestors.has(ref)) throw new HttpError(400, `${title(ref)} é a tarefa de que esta faz parte: ela só termina depois desta. Escolha uma irmã`);
    if (below.has(ref)) throw new HttpError(400, `${title(ref)} está dentro desta tarefa: ela não pode esperar o que faz parte dela`);
  }
  const before = task.dependsOn;
  task.dependsOn = wanted;
  // Ciclo no grafo das folhas (dependência em mãe vale as folhas dela; a da mãe vale para as subtarefas de entrada).
  const graph = new Map<string, string[]>();
  for (const leaf of leavesOf(project)) graph.set(leaf.ref, [...new Set(effectiveDeps(project, leaf).flatMap((dep) => leavesOf(project, dep).map((found) => found.ref)))]);
  const cycle = findDependencyCycle(graph);
  if (cycle) {
    task.dependsOn = before;
    throw new HttpError(400, `Isso criaria um ciclo (${cycle.map(title).join(" espera ")}): uma não poderia começar antes da outra. Tire uma das ligações`);
  }
  task.updatedAt = at;
}

/** Depois de mudar dependências ou conclusões: as folhas que ainda não começaram, com responsável, voltam ao backlog ou vão para a fila. */
export function refreshIdle(project: Project, at: string): void {
  for (const leaf of leavesOf(project)) {
    if (hasStarted(leaf) || !leaf.ownerId) continue;
    const next = idleStatus(project, leaf);
    if (next === leaf.status) continue;
    leaf.status = next;
    if (next === "a_fazer") {
      leaf.waitingSince = at;
      if (releaseHold(leaf)) delete leaf.queuedAt;
      else leaf.queuedAt = at;
    } else {
      delete leaf.waitingSince;
      delete leaf.queuedAt;
    }
    leaf.updatedAt = at;
  }
}
