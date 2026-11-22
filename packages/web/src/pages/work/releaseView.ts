import {
  addDays,
  dayKeyOf,
  effectiveDeps,
  isReleased,
  joinNames,
  leavesOf,
  nodeDone,
  plannedLeafCount,
  prerequisiteClosure,
  releaseHold,
  releaseState,
  type Project,
  type ProjectTask,
  type ProjectTaskStatus,
  type ReleasePace,
  type ReleaseState,
} from "@cyno/shared";

/**
 * "Criar não executa": a visão da liberação na tela do projeto. Funções puras (o React só desenha): o estado de cada
 * linha (Planejada, Na fila, Em andamento…), o aviso de dependência Planejada, a seleção em lote, o filtro
 * "Mostrar", o resumo e o ritmo do cabeçalho e os botões de aprovar o plano.
 */

type Tasks = Pick<Project, "tasks">;

// ---------------------------------------------------------------- estado da linha

export type StateTone = "planned" | "queued" | "running" | "waiting" | "done" | "off" | "blocked" | "failed" | "neutral";
export type RowState = { label: string; tone: StateTone; planned: boolean };

/** Estado de uma folha: "Planejada" tem prioridade (o freio de liberação segura a folha que ainda não começou). */
export function leafState(input: { status: ProjectTaskStatus; hold: boolean; blocked: boolean }): RowState {
  if (input.hold) return { label: "Planejada", tone: "planned", planned: true };
  if (input.status === "concluida") return { label: "Concluída", tone: "done", planned: false };
  if (input.status === "cancelada") return { label: "Cancelada", tone: "off", planned: false };
  if (input.status === "falhou") return { label: "Falhou", tone: "failed", planned: false };
  if (input.blocked) return { label: "Parada", tone: "blocked", planned: false };
  if (input.status === "em_andamento") return { label: "Em andamento", tone: "running", planned: false };
  if (input.status === "esperando_voce") return { label: "Esperando você", tone: "waiting", planned: false };
  if (input.status === "a_fazer") return { label: "Na fila", tone: "queued", planned: false };
  return { label: "Backlog", tone: "neutral", planned: false };
}

/** Estado de um módulo ou mãe: Planejado / Misto pela liberação das folhas abertas; liberado, pelo estado calculado delas. */
export function containerState(input: { status: ProjectTaskStatus; release: ReleaseState | undefined }): RowState {
  if (input.release === "planejada") return { label: "Planejado", tone: "planned", planned: true };
  if (input.release === "mista") return { label: "Misto", tone: "neutral", planned: false };
  if (input.status === "concluida") return { label: "Concluído", tone: "done", planned: false };
  if (input.status === "cancelada") return { label: "Cancelado", tone: "off", planned: false };
  if (input.status === "falhou") return { label: "Falhou", tone: "failed", planned: false };
  if (input.status === "esperando_voce") return { label: "Esperando você", tone: "waiting", planned: false };
  if (input.status === "em_andamento") return { label: "Em execução", tone: "running", planned: false };
  if (input.status === "a_fazer") return { label: "Na fila", tone: "queued", planned: false };
  return { label: "Liberado", tone: "neutral", planned: false };
}

const finishedStatus = (status: ProjectTaskStatus): boolean => status === "concluida" || status === "cancelada" || status === "falhou";

/** A folha foi liberada e ainda está na fila (não começou): dá para segurar de volta. */
export const isHoldable = (task: Pick<ProjectTask, "released" | "status" | "archived">): boolean => !task.archived && releaseHold(task) === undefined && (task.status === "backlog" || task.status === "a_fazer");

// ---------------------------------------------------------------- dependência Planejada

export type PlannedWait = { ref: string; title: string; container: boolean; state: "planejada" | "mista" };

/**
 * O que este item liberado espera e ainda está Planejado (ou tem partes Planejadas): nada a mostrar se o próprio item
 * está Planejado ou já terminou (aí o aviso é outro: ele só entra na fila quando for liberado).
 */
export function plannedWaits(project: Tasks, node: ProjectTask): PlannedWait[] {
  const live = { tasks: project.tasks.filter((task) => !task.archived) };
  const own = releaseState(live, node.ref);
  const leaf = !live.tasks.some((task) => task.parent === node.ref) && node.group !== true;
  if (leaf ? releaseHold(node) !== undefined || finishedStatus(node.status) : own === undefined || own === "planejada") return [];
  const out: PlannedWait[] = [];
  const covered = new Set(leavesOf(live, node.ref).map((item) => item.ref));
  for (const dep of effectiveDeps(live, node)) {
    if (out.some((item) => item.ref === dep)) continue;
    const target = live.tasks.find((task) => task.ref === dep);
    if (!target || nodeDone(live, dep)) continue;
    const state = releaseState(live, dep);
    if (state !== "planejada" && state !== "mista") continue;
    out.push({ ref: dep, title: target.title, container: target.group === true || live.tasks.some((task) => task.parent === dep), state });
    for (const item of leavesOf(live, dep)) covered.add(item.ref);
  }
  // Pré-requisitos indiretos Planejados (ex.: T10 liberada -> T8 liberada -> T7 Planejada) vêm pelo fecho.
  for (const ref of prerequisiteClosure(live, [node.ref])) {
    if (covered.has(ref) || out.some((item) => item.ref === ref)) continue;
    const target = live.tasks.find((task) => task.ref === ref);
    if (!target || nodeDone(live, ref)) continue;
    covered.add(ref);
    out.push({ ref, title: target.title, container: false, state: "planejada" });
  }
  return out;
}

const plannedAdjective = (items: readonly PlannedWait[]): string => {
  if (items.every((item) => item.state === "mista")) return "com partes Planejadas";
  const plural = items.length > 1;
  return items.every((item) => !item.container) ? (plural ? "Planejadas" : "Planejada") : plural ? "Planejados" : "Planejado";
};

/** "espera T7, que está Planejada" / "espera T7 e T9, que estão Planejadas" / "espera T7 e mais 2, que estão Planejadas". */
export function plannedWaitText(items: readonly PlannedWait[]): string {
  if (items.length === 0) return "";
  const refs = items.map((item) => item.ref);
  const names = refs.length <= 2 ? joinNames(refs) : `${refs[0]} e mais ${refs.length - 1}`;
  return `espera ${names}, ${items.length === 1 ? "que está" : "que estão"} ${plannedAdjective(items)}`;
}

/** O botão do aviso: "Liberar T7" (um) ou "Liberar 3 itens". */
export function plannedWaitButton(items: readonly PlannedWait[]): string {
  return items.length === 1 ? `Liberar ${items[0]!.ref}` : `Liberar ${items.length} itens`;
}

// ---------------------------------------------------------------- seleção em lote

const parentMap = (project: Tasks): Map<string, string | undefined> => new Map(project.tasks.filter((task) => !task.archived).map((task) => [task.ref, task.parent]));

/** A seleção sem repetição: some quem já está dentro de um módulo selecionado (selecionar o módulo é ele inteiro). Na ordem do projeto. */
export function normalizeSelection(project: Tasks, selected: Iterable<string>): string[] {
  const parents = parentMap(project);
  const chosen = new Set([...selected].filter((ref) => parents.has(ref)));
  const insideChosen = (ref: string): boolean => {
    const seen = new Set<string>();
    for (let parent = parents.get(ref); parent !== undefined && !seen.has(parent); parent = parents.get(parent)) {
      if (chosen.has(parent)) return true;
      seen.add(parent);
    }
    return false;
  };
  return project.tasks.filter((task) => chosen.has(task.ref) && !insideChosen(task.ref)).map((task) => task.ref);
}

/** Quem aparece marcado por causa de um módulo selecionado (os de dentro; o módulo em si fica de fora). */
export function impliedSelection(project: Tasks, selected: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  if (selected.size === 0) return out;
  const parents = parentMap(project);
  for (const ref of parents.keys()) {
    const seen = new Set<string>();
    for (let parent = parents.get(ref); parent !== undefined && !seen.has(parent); parent = parents.get(parent)) {
      if (selected.has(parent)) {
        out.add(ref);
        break;
      }
      seen.add(parent);
    }
  }
  return out;
}

const leavesUnder = (project: Tasks, refs: readonly string[]): ProjectTask[] => {
  const seen = new Set<string>();
  const out: ProjectTask[] = [];
  for (const ref of refs) {
    for (const leaf of leavesOf(project, ref)) {
      if (leaf.archived || seen.has(leaf.ref)) continue;
      seen.add(leaf.ref);
      out.push(leaf);
    }
  }
  return out;
};

/** "1 selecionada" / "3 selecionadas" e, com módulo no meio, o total de tarefas: "2 selecionadas (14 tarefas)". */
export function selectionSummary(project: Tasks, selected: Iterable<string>): string {
  const refs = normalizeSelection(project, selected);
  const base = refs.length === 1 ? "1 selecionada" : `${refs.length} selecionadas`;
  const leaves = leavesUnder(project, refs).length;
  return leaves !== refs.length && leaves > 0 ? `${base} (${leaves} ${leaves === 1 ? "tarefa" : "tarefas"})` : base;
}

/** Quais botões da barra de seleção fazem alguma coisa para estes itens. */
export function selectionCan(project: Tasks, selected: Iterable<string>): { release: boolean; releaseWith: boolean; hold: boolean } {
  const refs = normalizeSelection(project, selected);
  if (refs.length === 0) return { release: false, releaseWith: false, hold: false };
  const leaves = leavesUnder(project, refs);
  const own = new Set(leaves.map((leaf) => leaf.ref));
  return {
    release: leaves.some((leaf) => releaseHold(leaf) !== undefined),
    releaseWith: prerequisiteClosure(project, refs).some((ref) => !own.has(ref)),
    hold: leaves.some(isHoldable),
  };
}

// ---------------------------------------------------------------- filtro "Mostrar"

export type ReleaseFilter = "tudo" | "liberadas" | "planejadas";
export const RELEASE_FILTERS: readonly ReleaseFilter[] = ["tudo", "liberadas", "planejadas"];
export const RELEASE_FILTER_LABELS: Record<ReleaseFilter, string> = { tudo: "Tudo", liberadas: "Liberadas", planejadas: "Planejadas" };

/**
 * As linhas que o filtro deixa: as folhas que batem e os ancestrais delas (o módulo continua aparecendo). `null` = "Tudo" (sem filtro).
 * Planejada = folha que ainda não começou e foi segurada; o resto das folhas conta como liberada (inclui as terminadas).
 */
export function releaseFilterRefs(project: Tasks, filter: ReleaseFilter): Set<string> | null {
  if (filter === "tudo") return null;
  const live = { tasks: project.tasks.filter((task) => !task.archived) };
  const parents = parentMap(live);
  const show = new Set<string>();
  for (const leaf of leavesOf(live)) {
    if ((releaseHold(leaf) !== undefined) !== (filter === "planejadas")) continue;
    show.add(leaf.ref);
    const seen = new Set<string>();
    for (let parent = parents.get(leaf.ref); parent !== undefined && !seen.has(parent); parent = parents.get(parent)) {
      show.add(parent);
      seen.add(parent);
    }
  }
  return show;
}

// ---------------------------------------------------------------- cabeçalho: contagem e ritmo

/** Folhas em jogo (liberadas e ainda abertas) e folhas Planejadas. */
export function releaseCounts(project: Tasks): { released: number; planned: number } {
  const live = { tasks: project.tasks.filter((task) => !task.archived) };
  const planned = plannedLeafCount(live);
  const released = leavesOf(live).filter((leaf) => leaf.status !== "concluida" && leaf.status !== "cancelada" && releaseHold(leaf) === undefined).length;
  return { released, planned };
}

/** "12 liberadas · 133 planejadas"; só aparece quando há alguma Planejada (projeto antigo, tudo liberado, não mostra nada). */
export function releaseSummaryText(project: Tasks): string | null {
  const { released, planned } = releaseCounts(project);
  if (planned === 0) return null;
  return `${released} ${released === 1 ? "liberada" : "liberadas"} · ${planned} ${planned === 1 ? "planejada" : "planejadas"}`;
}

/** O dia de hoje (AAAA-MM-DD, relógio de São Paulo) a partir de `now`. */
export const todayKey = (now: number): string => dayKeyOf(now);

const dayMonth = (day: string): string => `${day.slice(8, 10)}/${day.slice(5, 7)}`;
const unitWord = (unit: ReleasePace["unit"], count: number): string => (unit === "modulos" ? (count === 1 ? "módulo" : "módulos") : count === 1 ? "tarefa" : "tarefas");

/** Quando sai a próxima liberação do ritmo: "hoje", "amanhã", "em 25/11" ou que não sobrou nada Planejado. */
export function paceNextText(pace: ReleasePace, planned: number, today: string): string {
  if (planned === 0) return "nada Planejado para liberar";
  const tomorrow = addDays(today, 1);
  if (pace.startsOn && pace.startsOn > today) return pace.startsOn === tomorrow ? "próxima liberação amanhã" : `próxima liberação em ${dayMonth(pace.startsOn)}`;
  if (pace.given && pace.given.day === today && pace.given.count >= pace.perDay) return "próxima liberação amanhã";
  return "próxima liberação hoje";
}

/** "Ritmo: liberar 3 tarefas por dia (próxima liberação amanhã)" ou "Ritmo desligado". */
export function paceText(project: Pick<Project, "tasks" | "releasePace">, today: string): string {
  const pace = project.releasePace;
  if (!pace || !(pace.perDay > 0)) return "Ritmo desligado";
  const live = { tasks: project.tasks.filter((task) => !task.archived) };
  return `Ritmo: liberar ${pace.perDay} ${unitWord(pace.unit, pace.perDay)} por dia (${paceNextText(pace, plannedLeafCount(live), today)})`;
}

export type PaceStart = "hoje" | "amanha" | "data";
export type PaceForm = { enabled: boolean; perDay: string; unit: ReleasePace["unit"]; start: PaceStart; date: string };

/** O formulário do ritmo, preenchido com o que o projeto tem hoje (padrão: desligado, 3 tarefas, começando hoje). */
export function paceFormOf(pace: ReleasePace | undefined, today: string): PaceForm {
  if (!pace) return { enabled: false, perDay: "3", unit: "tarefas", start: "hoje", date: addDays(today, 2) };
  const start: PaceStart = !pace.startsOn || pace.startsOn <= today ? "hoje" : pace.startsOn === addDays(today, 1) ? "amanha" : "data";
  return { enabled: true, perDay: String(pace.perDay), unit: pace.unit, start, date: pace.startsOn && pace.startsOn > today ? pace.startsOn : addDays(today, 2) };
}

export const PACE_MAX_PER_DAY = 100;

/** O corpo do ritmo a gravar (`null` desliga) ou o que está errado no formulário. */
export function paceBodyOf(form: PaceForm, today: string): { ok: true; releasePace: ReleasePace | null } | { ok: false; error: string } {
  if (!form.enabled) return { ok: true, releasePace: null };
  const perDay = Number(form.perDay.trim());
  if (!Number.isInteger(perDay) || perDay < 1 || perDay > PACE_MAX_PER_DAY) return { ok: false, error: `Quantidade por dia: um número inteiro de 1 a ${PACE_MAX_PER_DAY}.` };
  if (form.start === "data" && (!/^\d{4}-\d{2}-\d{2}$/.test(form.date) || form.date < today)) return { ok: false, error: "Escolha uma data de hoje em diante." };
  const startsOn = form.start === "amanha" ? addDays(today, 1) : form.start === "data" ? form.date : undefined;
  return { ok: true, releasePace: { perDay, unit: form.unit, ...(startsOn ? { startsOn } : {}) } };
}

// ---------------------------------------------------------------- menu da linha

export type ReleaseMenuItem = { id: "release" | "release_with" | "hold"; label: string };

/** Os itens de liberação do menu da linha: módulo ou mãe (liberar e segurar o conjunto) ou folha (liberar, liberar com o que precisa, segurar). */
export function releaseMenu(project: Tasks, node: ProjectTask): ReleaseMenuItem[] {
  const live = { tasks: project.tasks.filter((task) => !task.archived) };
  const container = node.group === true || live.tasks.some((task) => task.parent === node.ref);
  const out: ReleaseMenuItem[] = [];
  if (container) {
    const state = releaseState(live, node.ref);
    if (state === "planejada" || state === "mista") out.push({ id: "release", label: "Liberar módulo inteiro" });
    if ((state === "liberada" || state === "mista") && leavesOf(live, node.ref).some(isHoldable)) out.push({ id: "hold", label: "Segurar módulo" });
    return out;
  }
  if (releaseHold(node) !== undefined) {
    out.push({ id: "release", label: "Liberar" });
    if (prerequisiteClosure(live, [node.ref]).some((ref) => ref !== node.ref)) out.push({ id: "release_with", label: "Liberar com o que precisa" });
  } else if (isHoldable(node)) out.push({ id: "hold", label: "Segurar" });
  return out;
}

// ---------------------------------------------------------------- projeto e plano

/** O projeto tem folhas e nenhuma foi liberada (chip "Planejado" na lista de projetos). */
export function isUnreleasedProject(project: Tasks): boolean {
  const leaves = leavesOf({ tasks: project.tasks.filter((task) => !task.archived) });
  return leaves.length > 0 && leaves.every((leaf) => !isReleased(leaf));
}

/** Os botões de decidir o plano: aprovar liberando tudo (primário) ou deixando tudo Planejado. */
export const PLAN_APPROVALS = [
  { release: "all", label: "Aprovar e começar", testId: "plan-approve" },
  { release: "none", label: "Aprovar e deixar planejado", testId: "plan-approve-planned" },
] as const;
