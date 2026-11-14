import { isMaestroTask, PACE_LABELS, type AgentLogEntry, type LogPhrase, type OfficeState, type TodayChange, type TodayDone, type TodayGoal, type TodayNow, type TodayProject, type TodayView } from "@cyno/shared";
import { livePhrase } from "../../store/agentLog";
import type { TaskProgressMap } from "../../store/taskProgress";

/** Funções puras do painel "Hoje": cabeçalho, horários, textos de cada linha e o que recolher. */

/** Fuso do dono: "hoje" começa e termina à meia-noite daqui. */
export const TODAY_TIME_ZONE = "America/Sao_Paulo";

const headingFormat = new Intl.DateTimeFormat("pt-BR", { timeZone: TODAY_TIME_ZONE, weekday: "long", day: "2-digit", month: "2-digit" });
const hourFormat = new Intl.DateTimeFormat("pt-BR", { timeZone: TODAY_TIME_ZONE, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

/** "Hoje · quarta, 11/11" (o dia de São Paulo). */
export function todayHeading(now: Date): string {
  const parts = Object.fromEntries(headingFormat.formatToParts(now).map((part) => [part.type, part.value]));
  const weekday = String(parts.weekday ?? "").replace("-feira", "");
  return `Hoje · ${weekday}, ${parts.day}/${parts.month}`;
}

/** "08:04" no fuso do dono; vazio se a data for inválida. */
export function hourLabel(iso: string): string {
  const time = Date.parse(iso);
  return Number.isFinite(time) ? hourFormat.format(new Date(time)) : "";
}

/** "40 s", "5 min", "1 h 05", "2 h": há quanto tempo algo começou. */
export function elapsedLabel(fromIso: string, now: Date): string {
  const from = Date.parse(fromIso);
  if (!Number.isFinite(from)) return "";
  const seconds = Math.max(0, Math.round((now.getTime() - from) / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${String(rest).padStart(2, "0")}`;
}

/** Quantas tarefas estão fazendo agora (acende o indicador "ao vivo" do item Hoje): as mesmas que a seção "Agora". */
export function runningCount(office: Pick<OfficeState, "rooms" | "teams" | "agents" | "tasks"> | null | undefined): number {
  if (!office) return 0;
  return office.tasks.filter((task) => task.status === "in_progress" && !isMaestroTask(office, task)).length;
}

/** Uma linha de "Agora" com a frase da ferramenta que o agente tem na mão ("📖 Lendo App.tsx"), quando há. */
export type NowRowView = TodayNow & { phrase?: LogPhrase };

/** Junta a cada linha de "Agora" a frase do que o agente faz neste instante (some uns segundos depois da ferramenta acabar). */
export function withLivePhrases(rows: readonly TodayNow[], logs: Readonly<Record<string, readonly AgentLogEntry[]>>, nowMs: number): NowRowView[] {
  return rows.map((row) => {
    const phrase = !row.queued && row.agentId ? livePhrase(logs[row.agentId] ?? [], nowMs) : undefined;
    return phrase ? { ...row, phrase } : row;
  });
}

/** Põe por cima das linhas de "Agora" o progresso mais novo que chegou ao vivo (sem recarregar). */
export function withLiveProgress(rows: readonly TodayNow[], progress: TaskProgressMap): TodayNow[] {
  return rows.map((row) => {
    const info = row.queued ? undefined : progress[row.taskId];
    return info ? { ...row, progress: Math.min(1, Math.max(0, info.progress)), ...(info.message ? { message: info.message } : {}) } : row;
  });
}

const BLOCK_LABELS = { voce: "esperando você", agente: "esperando outro agente", cota: "sem cota", acesso: "sem acesso", falha: "a etapa falhou" } as const;

/** "esperando você: aprove o roteiro". */
export function blockLabel(blocked: NonNullable<TodayProject["blocked"]>): string {
  const base = BLOCK_LABELS[blocked.type];
  // "Caio espera você" já diz tudo: não repete "esperando você: Caio espera você".
  if (blocked.type === "voce" && /voc[eê]/i.test(blocked.note)) return blocked.note;
  return blocked.note && blocked.note !== base ? `${base}: ${blocked.note}` : base;
}

/** "etapa 2/4: roteiro" */
export function stageLabel(project: Pick<TodayProject, "stage" | "status">): string {
  if (!project.stage) return project.status === "pausado" ? "pausado" : "sem etapa em andamento";
  return `etapa ${project.stage.index}/${project.stage.total}: ${project.stage.title}`;
}

/** Horas de hoje: "0,5 h", ou "0,5/1 h" com o limite por dia; vazio quando não trabalhou e não há limite. */
export function workedLabel(project: Pick<TodayProject, "workedMs" | "limitMs">): string {
  const hours = (ms: number) => String(Math.round((ms / 3_600_000) * 10) / 10).replace(".", ",");
  if (project.workedMs <= 0 && !project.limitMs) return "";
  return project.limitMs ? `${hours(project.workedMs)}/${hours(project.limitMs)} h` : `${hours(project.workedMs)} h`;
}

/** "Posts 1/2" */
export const goalLabel = (goal: Pick<TodayGoal, "title" | "done" | "target">): string => `${goal.title} ${goal.done}/${goal.target}`;

export type GoalTone = "ok" | "warn" | "danger" | "muted";
/** Batida (ok), atrasada (perigo), bloqueada (aviso) ou no ritmo. */
export function goalTone(goal: Pick<TodayGoal, "pace" | "done" | "target" | "blocked">): GoalTone {
  if (goal.pace === "concluida" || goal.done >= goal.target) return "ok";
  if (goal.pace === "atrasada") return "danger";
  if (goal.blocked) return "warn";
  return goal.pace === "pausada" ? "muted" : "ok";
}

/** "Batida", "Atrasada", "No ritmo"… */
export const goalStatusLabel = (goal: Pick<TodayGoal, "pace" | "done" | "target">): string => (goal.done >= goal.target ? PACE_LABELS.concluida : PACE_LABELS[goal.pace]);

/** "Empresa X: Enviado → Entrevista (hoje 08:04)". */
export function changeLabel(change: Pick<TodayChange, "item" | "from" | "to" | "at">): string {
  const hour = hourLabel(change.at);
  return `${change.item} → ${change.to}${hour ? ` (hoje ${hour})` : ""}`;
}

const DONE_KIND = { projeto: "Projeto concluído", etapa: "Etapa concluída", tarefa: "Tarefa concluída", midia: "Mídia" } as const;
export const doneKindLabel = (done: Pick<TodayDone, "kind">): string => DONE_KIND[done.kind];

/** As seções do painel, na ordem do esboço. */
export const TODAY_SECTIONS = ["agora", "projetos", "rotinas", "acompanhamentos", "metas", "agenda", "feito"] as const;
export type TodaySectionId = (typeof TODAY_SECTIONS)[number];

export const SECTION_TITLES: Record<TodaySectionId, string> = {
  agora: "Agora",
  projetos: "Projetos",
  rotinas: "Rotinas",
  acompanhamentos: "Acompanhamentos",
  metas: "Metas",
  agenda: "Sua agenda hoje",
  feito: "Feito hoje",
};

/** Texto curto da seção sem nada (aparece recolhida, em cinza). */
export const EMPTY_TEXT: Record<TodaySectionId, string> = {
  agora: "Ninguém trabalhando agora",
  projetos: "Nenhum projeto andando",
  rotinas: "Nenhuma rotina hoje",
  acompanhamentos: "Nada mudou hoje nos acompanhamentos",
  metas: "Nenhuma meta no período",
  agenda: "Nenhum compromisso hoje",
  feito: "Nada concluído ainda",
};

/** Quantas linhas cada seção tem (a recolhida tem zero). */
export function sectionCounts(view: TodayView): Record<TodaySectionId, number> {
  return {
    agora: view.now.length,
    projetos: view.projects.length,
    rotinas: view.routines.ran.length + view.routines.running.length + view.routines.upcoming.length + view.routines.skipped.length,
    acompanhamentos: view.changes.length,
    metas: view.goals.length,
    agenda: view.agenda.length,
    feito: view.done.length,
  };
}

/** Rótulo da linha de "Esperando você": "Esperando você: 3". */
export const waitingLabel = (count: number): string => (count === 0 ? "Nada esperando você" : `Esperando você: ${count}`);

/** A plataforma está toda quieta (nenhum workspace com nada para mostrar)? */
export function isPlatformQuiet(views: readonly TodayView[]): boolean {
  return views.every((view) => Object.values(sectionCounts(view)).every((count) => count === 0) && view.waiting.count === 0);
}

export type RoutineRow = {
  key: string;
  routineId: string;
  state: "ran" | "failed" | "running" | "upcoming" | "skipped";
  /** Instante que ordena a linha (ISO). */
  at: string;
  /** "08:00 E-mail" */
  label: string;
  /** Resultado curto, agente ou motivo. */
  detail?: string;
};

/** As rotinas de hoje numa linha do tempo só: o que já rodou, o que roda agora, o que vai rodar e o que foi pulado, por horário. */
export function routineTimeline(routines: TodayView["routines"]): RoutineRow[] {
  const rows: RoutineRow[] = [];
  for (const run of routines.ran) {
    const detail = run.outcome === "falhou" ? `falhou${run.summary ? `: ${run.summary}` : ""}` : run.summary;
    rows.push({ key: `ran-${run.routineId}-${run.at}`, routineId: run.routineId, state: run.outcome === "falhou" ? "failed" : "ran", at: run.at, label: `${hourLabel(run.at)} ${run.title}`, ...(detail ? { detail } : {}) });
  }
  for (const run of routines.running) {
    rows.push({ key: `run-${run.routineId}-${run.startedAt}`, routineId: run.routineId, state: "running", at: run.startedAt, label: `${hourLabel(run.startedAt)} ${run.title}`, detail: run.agent ? `rodando · ${run.agent}` : "rodando" });
  }
  for (const slot of routines.upcoming) {
    rows.push({ key: `up-${slot.routineId}-${slot.at}`, routineId: slot.routineId, state: "upcoming", at: slot.at, label: `${hourLabel(slot.at)} ${slot.title}`, ...(slot.agent ? { detail: slot.agent } : {}) });
  }
  for (const skip of routines.skipped) {
    rows.push({ key: `skip-${skip.routineId}-${skip.at}`, routineId: skip.routineId, state: "skipped", at: skip.at, label: `${hourLabel(skip.at)} ${skip.title}`, detail: `pulada: ${skip.reason}` });
  }
  return rows.sort((a, b) => a.at.localeCompare(b.at) || a.key.localeCompare(b.key));
}

/** Quantas linhas de rotina aparecem sem expandir: as últimas que já terminaram e as próximas que vão rodar. */
export const ROUTINE_VISIBLE = { past: 3, upcoming: 4 } as const;

/** Recolhe o excesso da linha do tempo (muitos horários no dia): fica o que roda agora, as últimas 3 já feitas e as 4 próximas. */
export function trimTimeline(rows: readonly RoutineRow[], expanded: boolean): { rows: RoutineRow[]; hidden: number } {
  if (expanded) return { rows: [...rows], hidden: 0 };
  const past = rows.filter((row) => row.state === "ran" || row.state === "failed" || row.state === "skipped");
  const upcoming = rows.filter((row) => row.state === "upcoming");
  const hidePast = new Set(past.slice(0, Math.max(0, past.length - ROUTINE_VISIBLE.past)).map((row) => row.key));
  const hideUpcoming = new Set(upcoming.slice(ROUTINE_VISIBLE.upcoming).map((row) => row.key));
  const kept = rows.filter((row) => !hidePast.has(row.key) && !hideUpcoming.has(row.key));
  return { rows: kept, hidden: rows.length - kept.length };
}
