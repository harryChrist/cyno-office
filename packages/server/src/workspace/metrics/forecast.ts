import {
  agentEngine,
  DAY_MS,
  effectiveDeps,
  expandAvulsas,
  HOUR_MS,
  isLeaf,
  leavesOf,
  nextWorkDayStart,
  parseClock,
  usageWindowState,
  windowState,
  workClock,
  workDayStart,
  WORK_TIME_ZONE,
  type ForecastConfidence,
  type MetricsReport,
  type Pace,
  type Project,
  type ProjectForecast,
  type ProjectTask,
} from "@cyno/shared";
import { median, nearestRank, sum } from "./stats";
import type { MetricsSnapshot } from "./compute";

/**
 * Previsão de entrega por projeto (plano da Gestão, seção 2), em oito passos, sem relógio escondido (`now` vem de fora):
 * (1) o que falta; (2) tempo por etapa (mediana do mesmo agente, senão do workspace, senão a média geral, senão "sem previsão");
 * (3) trabalho total, descontando o que a etapa em andamento já fez; (4) caminho crítico por `dependsOn`; (5) paralelismo;
 * (6) espera pelo OK do dono; (7) conversão para o calendário (ritmo, janela de horário, cota); (8) a faixa com p25 e p75.
 */

/** Amostras mínimas de um agente (ou do workspace) para valer como base do tempo por etapa. */
export const FORECAST_MIN_SAMPLES = 3;
/** Janela das amostras do tempo por etapa e das esperas. */
export const FORECAST_WINDOW_DAYS = 28;
/** Espera padrão pelo OK do dono, quando o tipo tem menos de 5 decisões na janela. */
export const FORECAST_DEFAULT_APPROVAL_WAIT_MS = 4 * HOUR_MS;
/** A etapa em andamento nunca "falta" menos que isto do tempo dela. */
const MIN_REMAINING_FRACTION = 0.1;
/** Sem distribuição (só a média geral): a faixa rápida e a lenta são estas frações dela. */
const AVERAGE_BAND = { low: 0.7, high: 1.5 } as const;
// A cota acima disto empurra o começo para a hora em que ela volta.
const QUOTA_PUSH_UTILIZATION = 0.9;

/** O que a previsão precisa saber do workspace (montado por `buildForecastStats`; nos testes, à mão). */
export type ForecastStats = {
  /** Tempo de trabalho (ms) das etapas concluídas na janela, por agente. */
  stepMs: ReadonlyMap<string, readonly number[]>;
  /** O mesmo, de todos os agentes. */
  workspaceMs: readonly number[];
  /** Média das tarefas concluídas de todos os tempos (≥ 3 amostras), a última rede de segurança. */
  average?: { ms: number; n: number };
  /** Esperas do dono (ms) por tipo de aprovação, na janela. */
  approvalWaits: ReadonlyMap<string, readonly number[]>;
  dispatch: { maxRunning: number; perAgent: number };
  /** Quando o agente volta a poder rodar (ms), se a cota dele passou de 90% ou acabou. */
  quotaResumeAt: ReadonlyMap<string, number>;
};

type Pick3 = "low" | "mid" | "high";
const PICK_P: Record<Pick3, number> = { low: 0.25, mid: 0.5, high: 0.75 };

type Source = { samples: readonly number[]; n: number; average: boolean; own: boolean };

// ---------- Estatísticas do workspace ----------

const ms = (text: string | undefined): number => (text ? Date.parse(text) : Number.NaN);

/** Lê o que a previsão precisa do que a Gestão já tem em memória. */
export function buildForecastStats(snapshot: Pick<MetricsSnapshot, "projects" | "forYou" | "dispatch" | "agents" | "quota" | "engineBlocks">, now: number): ForecastStats {
  const since = now - FORECAST_WINDOW_DAYS * DAY_MS;
  const projects = expandAvulsas(snapshot.projects);
  // A espera do dono dentro da etapa (a etapa fica "em andamento" enquanto o item espera o OK) sai do tempo de trabalho.
  const waitByTask = new Map<string, number>();
  const approvalWaits = new Map<string, number[]>();
  for (const item of snapshot.forYou) {
    if ((item.status !== "aprovado" && item.status !== "rejeitado" && item.status !== "respondido") || item.decidedBy === "automatico" || item.decidedAt === undefined) continue;
    const wait = ms(item.decidedAt) - ms(item.createdAt);
    if (!Number.isFinite(wait) || wait < 0) continue;
    if (item.taskId) waitByTask.set(item.taskId, (waitByTask.get(item.taskId) ?? 0) + wait);
    if (ms(item.decidedAt) >= since && (item.kind === undefined || item.kind === "aprovacao")) {
      const list = approvalWaits.get(item.type) ?? [];
      list.push(wait);
      approvalWaits.set(item.type, list);
    }
  }
  const stepMs = new Map<string, number[]>();
  const workspaceMs: number[] = [];
  let averageTotal = 0;
  let averageCount = 0;
  for (const project of projects) {
    for (const task of project.tasks) {
      if (task.skipped || task.group) continue;
      if (task.status === "concluida" && task.startedAt && task.finishedAt) {
        const span = ms(task.finishedAt) - ms(task.startedAt);
        if (span > 0) {
          averageTotal += span;
          averageCount += 1;
        }
      }
      for (const step of task.steps) {
        if (step.status !== "feita" || !step.startedAt || !step.finishedAt || !step.agentId) continue;
        const finished = ms(step.finishedAt);
        if (!(finished >= since && finished <= now)) continue;
        const work = finished - ms(step.startedAt) - (step.taskId ? (waitByTask.get(step.taskId) ?? 0) : 0);
        if (!(work > 0)) continue;
        const list = stepMs.get(step.agentId) ?? [];
        list.push(work);
        stepMs.set(step.agentId, list);
        workspaceMs.push(work);
      }
    }
  }
  const quotaResumeAt = new Map<string, number>();
  const engineOf = new Map(snapshot.agents.map((agent) => [agent.id, agentEngine({ ...(agent.engine ? { engine: agent.engine } : {}) })]));
  for (const usage of snapshot.quota) {
    for (const window of usage.windows) {
      const state = usageWindowState(window, { updatedAt: usage.updatedAt, ...(usage.fetchedAt ? { fetchedAt: usage.fetchedAt } : {}), ...(usage.stale ? { stale: usage.stale } : {}) }, now);
      const resets = ms(window.resetsAt);
      if (state.kind !== "value" || window.utilization <= QUOTA_PUSH_UTILIZATION || !(resets > now)) continue;
      for (const [agentId, engine] of engineOf) if (engine === usage.provider) quotaResumeAt.set(agentId, Math.max(quotaResumeAt.get(agentId) ?? 0, resets));
    }
  }
  for (const { agentId, block } of snapshot.engineBlocks ?? []) {
    if (block.reason !== "quota") continue;
    const resets = ms("resetsAt" in block ? block.resetsAt : undefined);
    if (resets > now) quotaResumeAt.set(agentId, Math.max(quotaResumeAt.get(agentId) ?? 0, resets));
  }
  return {
    stepMs,
    workspaceMs,
    ...(averageCount >= FORECAST_MIN_SAMPLES ? { average: { ms: averageTotal / averageCount, n: averageCount } } : {}),
    approvalWaits,
    dispatch: { maxRunning: snapshot.dispatch.maxRunning, perAgent: snapshot.dispatch.perAgent },
    quotaResumeAt,
  };
}

// ---------- Tempo por etapa ----------

/** De onde sai o tempo de uma etapa deste agente: o próprio agente, o workspace ou a média geral (null = sem base). */
function sourceFor(stats: ForecastStats, agentId: string): Source | null {
  const own = stats.stepMs.get(agentId);
  if (own && own.length >= FORECAST_MIN_SAMPLES) return { samples: own, n: own.length, average: false, own: true };
  if (stats.workspaceMs.length >= FORECAST_MIN_SAMPLES) return { samples: stats.workspaceMs, n: stats.workspaceMs.length, average: false, own: false };
  if (stats.average) return { samples: [stats.average.ms], n: stats.average.n, average: true, own: false };
  return null;
}

function stepTime(source: Source, pick: Pick3): number {
  if (source.average) return source.samples[0]! * (pick === "low" ? AVERAGE_BAND.low : pick === "high" ? AVERAGE_BAND.high : 1);
  return pick === "mid" ? median(source.samples)! : nearestRank(source.samples, PICK_P[pick])!;
}

// ---------- Calendário ----------

/** Quanto falta (ms) para a janela de horário fechar, a partir de `t` (dentro dela). Infinito sem janela. */
function untilWindowClose(window: Pace["window"], t: number): number {
  const to = window ? parseClock(window.to) : undefined;
  if (!window || to === undefined || parseClock(window.from) === undefined || parseClock(window.from) === to) return Number.POSITIVE_INFINITY;
  const sinceMidnight = t - workDayStart(t);
  const left = (to * 60_000 - sinceMidnight + DAY_MS) % DAY_MS;
  return left === 0 ? Number.POSITIVE_INFINITY : left;
}

/**
 * Anda `workMs` de trabalho a partir de `from`, só dentro da janela de horário do ritmo e dentro do limite de horas
 * por dia (descontando o que já foi trabalhado hoje). Sem ritmo, anda direto (24 h por dia).
 */
export function advanceWork(from: number, workMs: number, pace: Pace | undefined, worked: Readonly<Record<string, number>> = {}): number {
  const hours = pace?.hoursPerDay;
  const limit = hours !== undefined && hours > 0 ? hours * HOUR_MS : undefined;
  const spent: Record<string, number> = { ...worked };
  let t = from;
  let left = workMs;
  for (let guard = 0; guard < 4000 && left > 0; guard += 1) {
    const state = windowState(pace?.window, t);
    if (!state.open) {
      t = state.opensAt;
      continue;
    }
    const day = workClock(t).day;
    const budget = limit === undefined ? Number.POSITIVE_INFINITY : limit - (spent[day] ?? 0);
    if (budget <= 0) {
      t = nextWorkDayStart(t);
      continue;
    }
    const chunk = Math.min(left, budget, untilWindowClose(pace?.window, t), nextWorkDayStart(t) - t);
    if (!(chunk > 0)) {
      t = nextWorkDayStart(t);
      continue;
    }
    t += chunk;
    left -= chunk;
    spent[day] = (spent[day] ?? 0) + chunk;
  }
  return t;
}

// ---------- Texto ----------

const weekdayFormat = new Intl.DateTimeFormat("pt-BR", { timeZone: WORK_TIME_ZONE, weekday: "long" });
const dayFormat = new Intl.DateTimeFormat("pt-BR", { timeZone: WORK_TIME_ZONE, day: "numeric" });
const monthFormat = new Intl.DateTimeFormat("pt-BR", { timeZone: WORK_TIME_ZONE, month: "short" });
const hourFormat = new Intl.DateTimeFormat("pt-BR", { timeZone: WORK_TIME_ZONE, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

/** "15h" ou "15h30". */
const hourLabel = (at: number): string => hourFormat.format(new Date(at)).replace(":00", "h").replace(":", "h");

/** "quinta" (sem o "-feira"). */
const weekdayName = (at: number): string => weekdayFormat.format(new Date(at)).split("-")[0]!;

/** "hoje", "amanhã" ou "quinta, 14" (com o mês quando passa de duas semanas). */
export function dayLabel(at: number, now: number): string {
  const today = workClock(now).day;
  const day = workClock(at).day;
  if (day === today) return "hoje";
  if (day === workClock(now + DAY_MS).day) return "amanhã";
  const far = at - now > 14 * DAY_MS;
  return `${weekdayName(at)}, ${dayFormat.format(new Date(at))}${far ? ` de ${monthFormat.format(new Date(at)).replace(".", "")}` : ""}`;
}

/** "No ritmo atual termina na quinta, 14 (entre quarta e sábado). Prazo: sexta, 15." */
export function forecastSentence(input: { at: number; low: number; high: number; dueAt?: number; now: number }): string {
  const { at, low, high, now } = input;
  const label = dayLabel(at, now);
  const hoje = label === "hoje" || label === "amanhã";
  const when = hoje ? `${label} às ${hourLabel(at)}` : `n${/^(sábado|domingo)/.test(label) ? "o" : "a"} ${label}`;
  const sameDay = workClock(low).day === workClock(high).day;
  const band = sameDay ? "" : ` (entre ${dayLabel(low, now) === "hoje" || dayLabel(low, now) === "amanhã" ? dayLabel(low, now) : weekdayName(low)} e ${dayLabel(high, now) === "hoje" || dayLabel(high, now) === "amanhã" ? dayLabel(high, now) : weekdayName(high)})`;
  const dueLabel = input.dueAt === undefined || !Number.isFinite(input.dueAt) ? "" : dayLabel(input.dueAt, now);
  const due = dueLabel ? ` Prazo: ${dueLabel === "hoje" || dueLabel === "amanhã" ? `${dueLabel} às ${hourLabel(input.dueAt!)}` : dueLabel}.` : "";
  return `No ritmo atual termina ${when}${band}.${due}`;
}

// ---------- A previsão ----------

type Remaining = { task: ProjectTask; steps: { agentId: string; elapsed: number }[]; approval: boolean; waiting: boolean };

/** As folhas que ainda faltam: não concluídas, não canceladas, não arquivadas. */
function remainingLeaves(project: Project): ProjectTask[] {
  return leavesOf(project).filter((task) => task.group !== true && !task.archived && task.status !== "concluida" && task.status !== "cancelada");
}

/** Dependências de uma folha que ainda faltam (uma dependência numa mãe espera as folhas dela que faltam). */
function pendingDeps(project: Project, task: ProjectTask, open: ReadonlySet<string>): string[] {
  const out = new Set<string>();
  for (const ref of effectiveDeps(project, task)) {
    const node = project.tasks.find((candidate) => candidate.ref === ref);
    if (!node) continue;
    for (const leaf of isLeaf(project, node) ? [node] : leavesOf(project, node.ref)) if (open.has(leaf.ref) && leaf.ref !== task.ref) out.add(leaf.ref);
  }
  return [...out];
}

function describe(project: Project, stats: ForecastStats, now: number): { remaining: Remaining[]; agents: string[] } {
  const remaining: Remaining[] = remainingLeaves(project).map((task) => {
    const steps: Remaining["steps"] = [];
    task.steps.forEach((step, index) => {
      if (index < task.current || step.status === "feita" || !step.agentId) return;
      const running = step.status === "em_andamento" && step.startedAt !== undefined;
      steps.push({ agentId: step.agentId, elapsed: running ? Math.max(0, now - ms(step.startedAt)) : 0 });
    });
    if (steps.length === 0 && task.ownerId) steps.push({ agentId: task.ownerId, elapsed: 0 });
    return { task, steps, approval: task.approvalType !== undefined || task.status === "esperando_voce", waiting: task.status === "esperando_voce" };
  });
  return { remaining, agents: [...new Set(remaining.flatMap((entry) => entry.steps.map((step) => step.agentId)))] };
}

/** O fim previsto do projeto com o tempo por etapa escolhido (`low`, `mid` ou `high`); null = faltam amostras. */
function simulate(project: Project, stats: ForecastStats, now: number, pick: Pick3): { at: number; workMs: number; criticalMs: number; n: number; borrowed: boolean } | null {
  const { remaining } = describe(project, stats, now);
  if (remaining.length === 0) return { at: now, workMs: 0, criticalMs: 0, n: Number.POSITIVE_INFINITY, borrowed: false };
  let nMin = Number.POSITIVE_INFINITY;
  // Alguma etapa usou o tempo de outros agentes (este ainda não tem histórico próprio)?
  let borrowed = false;
  const time = new Map<string, number>();
  const agentWork = new Map<string, number>();
  for (const entry of remaining) {
    let total = 0;
    for (const step of entry.steps) {
      const source = sourceFor(stats, step.agentId);
      if (!source) return null;
      nMin = Math.min(nMin, source.n);
      if (!source.own) borrowed = true;
      const full = stepTime(source, pick);
      // A etapa em andamento só falta o que não fez (no mínimo 10%); esperando o OK já fez o trabalho dela.
      const left = entry.waiting ? 0 : step.elapsed > 0 ? Math.max(full - step.elapsed, full * MIN_REMAINING_FRACTION) : full;
      total += left;
      agentWork.set(step.agentId, (agentWork.get(step.agentId) ?? 0) + left);
    }
    time.set(entry.task.ref, total);
  }
  // Espera pelo OK do dono, por tarefa que passa por aprovação (a que já espera só falta o que resta da espera típica).
  // A espera pertence ao fim da própria tarefa: quem depende dela começa depois, e ramos paralelos esperam ao mesmo tempo.
  const waitOf = new Map<string, number>();
  for (const entry of remaining) {
    if (!entry.approval) continue;
    const samples = stats.approvalWaits.get(entry.task.approvalType ?? "") ?? [];
    const typical = samples.length >= 5 ? (pick === "mid" ? median(samples)! : nearestRank(samples, PICK_P[pick])!) : FORECAST_DEFAULT_APPROVAL_WAIT_MS;
    waitOf.set(entry.task.ref, entry.waiting && entry.task.waitingSince ? Math.max(typical - Math.max(0, now - ms(entry.task.waitingSince)), typical * MIN_REMAINING_FRACTION) : typical);
  }
  const open = new Set(remaining.map((entry) => entry.task.ref));
  // O fim de cada tarefa no grafo: depois das dependências, mais o trabalho dela (e, em `withWaits`, a espera pelo OK).
  const criticalOf = (withWaits: boolean): number => {
    const finish = new Map<string, number>();
    const visiting = new Set<string>();
    const finishOf = (ref: string): number => {
      const known = finish.get(ref);
      if (known !== undefined) return known;
      if (visiting.has(ref)) return 0;
      visiting.add(ref);
      const task = remaining.find((entry) => entry.task.ref === ref)!.task;
      const before = Math.max(0, ...pendingDeps(project, task, open).map(finishOf));
      visiting.delete(ref);
      const value = before + (time.get(ref) ?? 0) + (withWaits ? (waitOf.get(ref) ?? 0) : 0);
      finish.set(ref, value);
      return value;
    };
    return Math.max(...remaining.map((entry) => finishOf(entry.task.ref)));
  };
  const criticalMs = criticalOf(false);
  const criticalWithWaitsMs = criticalOf(true);
  const workMs = sum([...time.values()]);
  const workingAgents = [...agentWork].filter(([, value]) => value > 0).length;
  const parallel = Math.max(1, Math.min(stats.dispatch.maxRunning, workingAgents || 1, project.pace?.maxParallel ?? Number.POSITIVE_INFINITY));
  const agentBound = Math.max(0, ...[...agentWork.values()].map((value) => value / Math.max(1, stats.dispatch.perAgent)));
  const duration = Math.max(criticalMs, workMs / parallel, agentBound);
  // As esperas só alongam o projeto no que passa do tempo de trabalho: o caminho mais longo (esperas somam numa cadeia, não entre ramos).
  const waitMs = Math.max(0, criticalWithWaitsMs - duration);
  // Calendário: a cota esgotada empurra o começo; o ritmo do projeto limita as horas e a janela de horário.
  const resumes = remaining.flatMap((entry) => entry.steps.map((step) => stats.quotaResumeAt.get(step.agentId) ?? 0));
  const start = Math.max(now, ...resumes);
  const worked = project.worked ?? {};
  const end = advanceWork(start, duration, project.pace, worked);
  return { at: end + waitMs, workMs, criticalMs, n: nMin, borrowed };
}

const confidenceOf = (n: number): ForecastConfidence => (n < 5 ? "baixa" : n < 15 ? "media" : "alta");

/**
 * Previsão de um projeto. Pura: `stats` traz o histórico e `now` o instante. Sem prazo (`dueAt`), não há veredito.
 * `apertado` = o fim lento (p75) passa do prazo, o provável não; `atrasa` = o provável já passa.
 */
export function forecastProject(project: Project, stats: ForecastStats, now: number): ProjectForecast {
  const { remaining, agents } = describe(project, stats, now);
  const base = { projectId: project.id, title: project.title, ...(project.dueAt ? { dueAt: project.dueAt } : {}), remaining: remaining.length };
  if (remaining.length === 0) return { ...base, state: "previsto", at: new Date(now).toISOString(), low: new Date(now).toISOString(), high: new Date(now).toISOString(), text: "Nada a fazer: todas as tarefas já terminaram." };
  const mid = simulate(project, stats, now, "mid");
  if (!mid) {
    const missing = agents.find((id) => !sourceFor(stats, id));
    return { ...base, state: "sem_previsao", reason: "Faltam tarefas concluídas deste agente para estimar", text: `Sem previsão ainda: faltam tarefas concluídas${missing ? " deste agente" : ""} para estimar.` };
  }
  const low = simulate(project, stats, now, "low")!;
  const high = simulate(project, stats, now, "high")!;
  const at = mid.at;
  const lowAt = Math.min(low.at, at);
  const highAt = Math.max(high.at, at);
  const due = project.dueAt ? ms(project.dueAt) : Number.NaN;
  const hasDue = Number.isFinite(due);
  const verdict = !hasDue ? undefined : at > due ? "atrasa" : highAt > due ? "apertado" : "no_prazo";
  // Sem histórico do próprio agente a base é o ritmo dos outros (visto de verdade: um agente novo de Gemini fez em 81 s o que a mediana do
  // workspace previa para 1 h 40). Muitas amostras alheias não dão confiança: ela fica em baixa e a tela diz de onde veio a base.
  const confidence = mid.borrowed ? "baixa" : confidenceOf(mid.n);
  const n = Number.isFinite(mid.n) ? mid.n : 0;
  return {
    ...base,
    state: "previsto",
    at: new Date(at).toISOString(),
    low: new Date(lowAt).toISOString(),
    high: new Date(highAt).toISOString(),
    basis: `${n} ${n === 1 ? "tarefa" : "tarefas"}`,
    n,
    ...(mid.borrowed ? { borrowed: true } : {}),
    confidence,
    ...(verdict ? { verdict } : {}),
    ...(verdict === "atrasa" ? { lateByMs: at - due } : {}),
    workMs: Math.round(mid.workMs),
    criticalMs: Math.round(mid.criticalMs),
    text: forecastSentence({ at, low: lowAt, high: highAt, ...(hasDue ? { dueAt: due } : {}), now }),
  };
}

const SEVERITY: Record<string, number> = { atrasa: 0, apertado: 1, no_prazo: 2 };

/** A previsão dos projetos abertos do workspace: os com prazo primeiro, do pior veredito ao melhor; depois os sem prazo pelo fim previsto. */
export function forecastAll(snapshot: Pick<MetricsSnapshot, "projects" | "forYou" | "dispatch" | "agents" | "quota" | "engineBlocks">, now: number): MetricsReport["forecast"] {
  const stats = buildForecastStats(snapshot, now);
  const eligible = snapshot.projects.filter((project) => project.status === "ativo" && project.kind === "projeto" && project.system === undefined && project.origin !== "rotina" && !project.routineRef);
  const projects = eligible
    .map((project) => forecastProject(project, stats, now))
    .filter((forecast) => forecast.remaining > 0)
    .sort((a, b) => {
      const rank = (forecast: ProjectForecast): number => (forecast.verdict ? SEVERITY[forecast.verdict]! : forecast.state === "sem_previsao" ? 4 : 3);
      return rank(a) - rank(b) || Date.parse(a.at ?? "") - Date.parse(b.at ?? "") || a.title.localeCompare(b.title, "pt-BR");
    });
  const count = (verdict: string): number => projects.filter((forecast) => forecast.verdict === verdict).length;
  const parts = [count("atrasa") ? `${count("atrasa")} atrasa` : "", count("apertado") ? `${count("apertado")} apertado` : "", count("no_prazo") ? `${count("no_prazo")} no prazo` : "", projects.some((forecast) => forecast.verdict === undefined) ? `${projects.filter((forecast) => forecast.verdict === undefined).length} sem prazo ou sem previsão` : ""].filter(Boolean);
  return { projects, text: projects.length === 0 ? "nenhum projeto aberto com tarefas a fazer" : `${projects.length} projeto(s): ${parts.join(", ")}` };
}
