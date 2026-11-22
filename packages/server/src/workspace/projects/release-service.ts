import {
  isLeaf,
  leavesOf,
  nextReleaseBatch,
  nextWorkDayStart,
  pathOf,
  plannedLeafCount,
  PLANNED_NOTE,
  prerequisiteClosure,
  RELEASE_PACE_LIMITS,
  RELEASE_PACE_UNITS,
  releaseState,
  subtreeRefs,
  windowState,
  workClock,
  type Project,
  type ProjectTask,
  type ReleasePace,
} from "@cyno/shared";
import { HttpError } from "../../platform/http/errors";
import { hasStarted, requireTask } from "./project-edit";

/**
 * LIBERAÇÃO ("criar não executa"): funções que mexem no `Project` em memória (o `ProjectService` grava, registra na Atividade e põe a fila
 * para andar). `released: false` = Planejada (existe, mas o agendador não a despacha); ausente ou `true` = liberada. A folha continua
 * `backlog`/`a_fazer`: o freio é o `releaseHold` do agendador. Módulo e tarefa-mãe também guardam o campo, só para a herança: o item novo
 * dentro de um contêiner com `released === true` nasce liberado. Erros em português (a tela mostra).
 */

/** Uma folha que o `holdNodes` deixou como estava, e por quê. */
export type HoldIgnored = { ref: string; title: string; reason: string };

/** A folha terminou (concluída, cancelada ou arquivada). */
const finished = (task: ProjectTask) => task.archived === true || task.status === "concluida" || task.status === "cancelada";

/** Os contêineres da subárvore de `ref` (ele mesmo incluído, se for contêiner). */
function containersIn(project: Project, ref: string): ProjectTask[] {
  const out: ProjectTask[] = [];
  for (const found of subtreeRefs(project, ref)) {
    const node = project.tasks.find((task) => task.ref === found);
    if (node && !isLeaf(project, node)) out.push(node);
  }
  return out;
}

/** Os contêineres acima de `ref` (do mais próximo ao mais alto). */
function containersAbove(project: Project, ref: string): ProjectTask[] {
  return pathOf(project, ref)
    .filter((node) => node.ref !== ref)
    .reverse();
}

/**
 * Depois de liberar ou segurar folhas, o módulo (ou a mãe) acima delas acompanha: tudo liberado vira `released: true`, tudo Planejado vira
 * `false`; misto fica como está. É isso que faz a tarefa nova num módulo já em execução entrar liberada.
 */
function syncContainers(project: Project, leafRefs: string[], at: string): void {
  const seen = new Set<string>();
  for (const leafRef of leafRefs) {
    for (const container of containersAbove(project, leafRef)) {
      if (seen.has(container.ref)) continue;
      seen.add(container.ref);
      const state = releaseState(project, container.ref);
      const next = state === "liberada" ? true : state === "planejada" ? false : undefined;
      if (next === undefined || container.released === next) continue;
      container.released = next;
      container.updatedAt = at;
    }
  }
}

/**
 * Libera as folhas de `refs` (contêiner = todas as folhas dele; "all" = o projeto inteiro). O módulo e os módulos dentro dele ficam
 * `released: true` (a herança dos filhos novos). `withPrerequisites`: leva junto as Planejadas de que elas dependem (`prerequisiteClosure`).
 * Folha terminada, em andamento ou já liberada fica como está. Devolve os `ref` das folhas que passaram de Planejada a liberada.
 */
export function releaseNodes(project: Project, refs: string[] | "all", options: { withPrerequisites: boolean }, at: string): string[] {
  const leaves = new Map<string, ProjectTask>();
  const containers: ProjectTask[] = [];
  if (refs === "all") {
    for (const leaf of leavesOf(project)) leaves.set(leaf.ref, leaf);
    for (const node of project.tasks) if (!isLeaf(project, node)) containers.push(node);
  } else {
    for (const ref of refs) {
      requireTask(project, ref);
      for (const leaf of leavesOf(project, ref)) leaves.set(leaf.ref, leaf);
      containers.push(...containersIn(project, ref));
    }
    if (options.withPrerequisites) {
      for (const ref of prerequisiteClosure(project, refs)) leaves.set(ref, requireTask(project, ref));
    }
  }
  const changed: string[] = [];
  for (const leaf of leaves.values()) {
    if (leaf.released !== false || finished(leaf) || leaf.status === "em_andamento") continue;
    leaf.released = true;
    if (leaf.note === PLANNED_NOTE) delete leaf.note;
    // Entra na fila agora: a espera da fila conta daqui, não de quando a tarefa foi criada.
    if (leaf.status === "a_fazer") Object.assign(leaf, { queuedAt: at, waitingSince: at });
    leaf.updatedAt = at;
    changed.push(leaf.ref);
  }
  for (const container of containers) {
    if (container.released === true) continue;
    container.released = true;
    container.updatedAt = at;
  }
  syncContainers(project, changed, at);
  return changed;
}

/**
 * Volta a Planejada o que ainda NÃO começou (backlog ou a fazer; contêiner = as folhas dele). Quem já roda, espera o dono, falhou ou
 * terminou fica como está e vai em `ignored` com o motivo (de um contêiner, só as que já começaram; as terminadas passam em silêncio).
 * A folha a fazer sai da fila do agendador (a nota muda para "Planejada"). Devolve as folhas seguradas e as ignoradas.
 */
export function holdNodes(project: Project, refs: string[], at: string): { held: string[]; ignored: HoldIgnored[] } {
  const held: string[] = [];
  const ignored: HoldIgnored[] = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    const node = requireTask(project, ref);
    const direct = isLeaf(project, node);
    for (const leaf of leavesOf(project, ref)) {
      if (seen.has(leaf.ref)) continue;
      seen.add(leaf.ref);
      if (finished(leaf)) {
        if (direct) ignored.push({ ref: leaf.ref, title: leaf.title, reason: "já terminou" });
        continue;
      }
      if (hasStarted(leaf)) {
        ignored.push({ ref: leaf.ref, title: leaf.title, reason: leaf.status === "em_andamento" ? "já está em andamento" : "já começou" });
        continue;
      }
      if (leaf.released === false) continue;
      leaf.released = false;
      if (leaf.status === "a_fazer") {
        delete leaf.queuedAt;
        leaf.note = PLANNED_NOTE;
      }
      leaf.updatedAt = at;
      held.push(leaf.ref);
    }
    if (!direct) {
      for (const container of containersIn(project, ref)) {
        if (container.released === false) continue;
        container.released = false;
        container.updatedAt = at;
      }
    }
  }
  syncContainers(project, held, at);
  return { held, ignored };
}

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** `startsOn` é um dia de calendário de verdade (AAAA-MM-DD)? */
function validDay(day: string): boolean {
  if (!DAY_PATTERN.test(day)) return false;
  const date = new Date(`${day}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(day);
}

/**
 * Valida a liberação diária pedida (erros em português, o dono vê). `existing` mantém a conta do dia (`given`): mudar o `perDay` no meio do
 * dia não zera o que já saiu.
 */
export function normalizeReleasePace(input: { perDay: number; unit: string; startsOn?: string | undefined }, existing?: ReleasePace): ReleasePace {
  const { min, max } = RELEASE_PACE_LIMITS.perDay;
  if (!Number.isInteger(input.perDay) || input.perDay < min || input.perDay > max) throw new HttpError(400, `Liberação diária: use um número inteiro de ${min} a ${max} por dia`);
  if (!(RELEASE_PACE_UNITS as readonly string[]).includes(input.unit)) throw new HttpError(400, "Liberação diária: a unidade é tarefas ou módulos");
  if (input.startsOn !== undefined && !validDay(input.startsOn)) throw new HttpError(400, "Liberação diária: o dia de começo precisa ser AAAA-MM-DD");
  return { perDay: input.perDay, unit: input.unit as ReleasePace["unit"], ...(input.startsOn ? { startsOn: input.startsOn } : {}), ...(existing?.given ? { given: { ...existing.given } } : {}) };
}

/** O que a liberação diária fez neste instante: as folhas liberadas, as unidades gastas e quando acordar de novo (undefined = nada a esperar). */
export type PaceRun = { released: string[]; units: number; wakeAt?: number };

/**
 * A liberação diária de um projeto (código, sem acordar o Maestro): se o projeto está ativo, o dia de hoje já chegou em `startsOn`, a janela
 * de horário do ritmo (`project.pace.window`) está aberta e ainda falta para o `perDay` de hoje, solta o próximo lote (`nextReleaseBatch`)
 * e soma em `given` (que zera na virada do dia local). Idempotente: depois de completar o dia, não solta mais nada até a virada. O primeiro
 * item do dia sai inteiro com o fecho de pré-requisitos mesmo que passe do `perDay`. Projeto pausado não libera.
 */
export function applyReleasePace(project: Project, nowMs: number, at: string): PaceRun {
  const pace = project.releasePace;
  if (!pace || project.status !== "ativo") return { released: [], units: 0 };
  const { day } = workClock(nowMs);
  if (pace.startsOn && pace.startsOn > day) return { released: [], units: 0, wakeAt: nextWorkDayStart(nowMs) };
  if (plannedLeafCount(project) === 0) return { released: [], units: 0 };
  const given = pace.given?.day === day ? pace.given.count : 0;
  if (given >= pace.perDay) return { released: [], units: 0, wakeAt: nextWorkDayStart(nowMs) };
  const window = windowState(project.pace?.window, nowMs);
  if (!window.open) return { released: [], units: 0, wakeAt: window.opensAt };
  const batch = nextReleaseBatch(project, pace.unit, pace.perDay - given, { guaranteeFirst: given === 0 }, nowMs);
  if (batch.refs.length === 0) return { released: [], units: 0, wakeAt: nextWorkDayStart(nowMs) };
  const released = releaseNodes(project, batch.refs, { withPrerequisites: false }, at);
  // `syncContainers` (dentro de `releaseNodes`) já marcou como liberado o módulo cujas folhas todas saíram.
  pace.given = { day, count: given + batch.units };
  return { released, units: batch.units, ...(plannedLeafCount(project) > 0 ? { wakeAt: nextWorkDayStart(nowMs) } : {}) };
}
