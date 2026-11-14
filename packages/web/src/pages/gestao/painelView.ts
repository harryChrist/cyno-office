import { METRICS_MIN_SAMPLES, type ForecastConfidence, type ForecastVerdict, type MetricsReport, type ProjectForecast } from "@cyno/shared";
import { arrowOf, formatSpan, formatUsd, isLowThroughput, missingText, NO_VALUE, plural, weeklyThroughput, formatRate, type Arrow } from "./metricsFormat";

/**
 * O "Esta semana" do Painel da Gestão (a parte do plano; o "Meu dia" continua em `painel/dayView.ts`). Funções
 * puras do `MetricsReport` para o que a tela escreve: nada aqui lê o relógio (o `now` vem de fora) nem o fuso da
 * máquina. As regras de n < 5, de seta e de contagem no lugar de taxa vêm de `metricsFormat.ts`.
 */

export type Tone = "neutral" | "warn" | "danger" | "ok";

export type KpiView = {
  id: "waiting" | "throughput" | "cycle" | "spend";
  label: string;
  /** O número grande ("5", "Nada", "5 h 20 min", "—"). */
  value: string;
  /** Texto pequeno ao lado do valor ("equivalente"). */
  unit?: string;
  tone: Tone;
  /** Linhas de apoio, na ordem. */
  lines: string[];
  arrow: Arrow | null;
  /** "+3 vs. passada" (só junto da seta). */
  delta?: string;
};

// ---------- Esperando seu OK ----------

export type PendingRow = { id: string; title: string; agentId?: string; age: string };

/** Os itens esperando o dono (os 5 mais velhos que a métrica traz), com o título de reserva pelo tipo. */
export function pendingRows(report: MetricsReport, typeName: (type: string) => string): PendingRow[] {
  return report.approvalWait.pending.items.map((item) => ({ id: item.id, title: typeName(item.type), ...(item.agentId ? { agentId: item.agentId } : {}), age: `há ${formatSpan(item.ageMs)}` }));
}

/** "+1 regra para decidir" (a regra proposta espera o seu OK, mas não é espera de agente: fica fora do número do cartão). */
export function ruleLine(count: number): string {
  return `+${count} ${count === 1 ? "regra" : "regras"} para decidir em “O que aprendemos”`;
}

function waitingTile(report: MetricsReport): KpiView {
  const { count, over24h, oldestMs } = report.approvalWait.pending;
  const lines: string[] = [];
  if (count === 0) lines.push("Tudo em dia");
  else {
    lines.push(`o mais velho há ${formatSpan(oldestMs)}`);
    if (over24h > 0) lines.push(`${plural(over24h, "passou", "passaram")} de 1 dia`);
  }
  return { id: "waiting", label: "Esperando seu OK", value: count === 0 ? "Nada" : String(count), tone: over24h > 0 ? "warn" : "neutral", lines, arrow: null };
}

// ---------- Entregas na semana ----------

function throughputTile(report: MetricsReport): KpiView {
  const { value, prev, n, prevN } = report.throughput;
  const count = value ?? 0;
  const arrow = arrowOf({ value, prev, n, prevN, trend: report.throughput.trend }, (now, before) => `eram ${before} na semana anterior, agora ${now}`);
  const delta = arrow && value !== null && prev !== null ? `${value - prev > 0 ? "+" : ""}${value - prev} vs. passada` : undefined;
  return {
    id: "throughput",
    label: "Entregas na semana",
    value: String(count),
    tone: "neutral",
    lines: [`últimos 7 dias · semana anterior: ${report.throughput.prev ?? 0}`],
    arrow,
    ...(delta ? { delta } : {}),
  };
}

export type WeekBar = { key: string; label: string; count: number; current: boolean; /** 0 a 1 da altura máxima. */ height: number; /** Média das 4 semanas (0 a 1). */ avg: number | null };
export type WeeklyBars = { bars: WeekBar[]; max: number; empty: boolean; ariaLabel: string };

/** "09/11" a partir de "2026-11-09". */
const shortDate = (day: string): string => `${day.slice(8, 10)}/${day.slice(5, 7)}`;

/** Um teto "redondo" para o eixo: 4, 5, 8, 10, 12, 15, 20, 25, 30, 40, 50... */
export function niceMax(value: number): number {
  if (value <= 4) return 4;
  const steps = [5, 8, 10, 12, 15, 20, 25, 30, 40, 50, 60, 80, 100];
  const found = steps.find((step) => step >= value);
  if (found) return found;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  return Math.ceil(value / magnitude) * magnitude;
}

/** As 8 barras de entregas por semana: a atual (tracejada na tela) e a média móvel de 4 semanas. */
export function weeklyBars(weeks: MetricsReport["throughput"]["weeks"]): WeeklyBars {
  const max = niceMax(Math.max(0, ...weeks.map((week) => Math.max(week.count, week.avg4 ?? 0))));
  const bars = weeks.map((week) => ({ key: week.key, label: shortDate(week.start), count: week.count, current: week.current, height: week.count / max, avg: week.avg4 === null ? null : week.avg4 / max }));
  const total = weeks.reduce((sum, week) => sum + week.count, 0);
  const ariaLabel = `Entregas por semana, nas últimas ${weeks.length} semanas: ${weeks.map((week) => `${shortDate(week.start)}, ${week.count}${week.current ? " (semana em andamento)" : ""}`).join("; ")}.`;
  return { bars, max, empty: total === 0, ariaLabel };
}

// ---------- Tempo até entregar ----------

function cycleTile(report: MetricsReport): KpiView {
  const cycle = report.cycleTime;
  const unit = { one: "entrega", many: "entregas" };
  if (cycle.n === 0) return { id: "cycle", label: "Tempo até entregar", value: NO_VALUE, tone: "neutral", lines: ["sem entregas de projeto nas últimas 4 semanas"], arrow: null };
  if (cycle.n < METRICS_MIN_SAMPLES || cycle.value === null) return { id: "cycle", label: "Tempo até entregar", value: NO_VALUE, tone: "neutral", lines: [missingText(cycle.n, unit)], arrow: null };
  const lines = [`mediana de ${plural(cycle.n, "entrega", "entregas")} · 90% até ${formatSpan(cycle.p90)}`];
  if (report.approvalWait.weightInCycle !== null && report.approvalWait.weightInCycle >= 0.01) lines.push(`${formatRate(report.approvalWait.weightInCycle)} desse tempo foi espera por você`);
  const arrow = arrowOf(cycle, (now, before) => `era ${formatSpan(before)}, agora ${formatSpan(now)}`);
  return { id: "cycle", label: "Tempo até entregar", value: formatSpan(cycle.value), tone: "neutral", lines, arrow };
}

export type CyclePoint = { key: string; label: string; n: number; /** O n chegou a 5. */ solid: boolean; median: number; p90: number; /** 0 a 1 da altura máxima. */ y: number; y90: number; /** 0 a 1 na largura (posição da semana). */ x: number };
export type CycleLine = { points: CyclePoint[]; max: number; ariaLabel: string };

/** A mini-linha da mediana com a faixa até o p90; só as semanas que tiveram entrega. */
export function cycleLine(weeks: MetricsReport["cycleTime"]["weeks"]): CycleLine {
  const withData = weeks.map((week, index) => ({ week, index })).filter((entry) => entry.week.median !== null && entry.week.p90 !== null);
  const max = Math.max(1, ...withData.map((entry) => entry.week.p90!));
  const last = Math.max(1, weeks.length - 1);
  const points = withData.map(({ week, index }) => ({ key: week.key, label: week.key.replace(/^\d{4}-/, ""), n: week.n, solid: week.n >= METRICS_MIN_SAMPLES, median: week.median!, p90: week.p90!, y: week.median! / max, y90: week.p90! / max, x: index / last }));
  const ariaLabel = points.length === 0 ? "Sem entregas de projeto para traçar o tempo até entregar." : `Mediana do tempo até entregar por semana: ${points.map((point) => `${point.label}, ${formatSpan(point.median)} (até ${formatSpan(point.p90)})`).join("; ")}.`;
  return { points, max, ariaLabel };
}

// ---------- Gasto e cota ----------

function spendTile(report: MetricsReport): KpiView {
  return {
    id: "spend",
    label: "Gasto da semana",
    value: formatUsd(report.spend.usd),
    unit: "equivalente",
    tone: "neutral",
    lines: [`equivalente à API, não o que se paga · semana anterior ${formatUsd(report.spend.prevUsd)}`],
    arrow: null,
  };
}

export type QuotaRow = { id: string; text: string; percent: number | null; warn: boolean };

/** As janelas da cota com leitura (a frase já vem pronta do servidor: "Claude: 5 h em 86%, volta às 15h"). */
export function quotaRows(report: MetricsReport): QuotaRow[] {
  const rows = report.quota.windows.filter((window) => window.state !== "none").map((window) => ({ id: `${window.provider}:${window.id}`, text: window.text, percent: window.percent, warn: window.warn }));
  const blocked = report.quota.blocked.map((entry) => ({ id: `block:${entry.agentId}`, text: `${entry.name}: ${entry.label}`, percent: null, warn: true }));
  return [...rows, ...blocked];
}

/** Os quatro cartões, na ordem do plano. */
export function kpiTiles(report: MetricsReport): KpiView[] {
  return [waitingTile(report), throughputTile(report), cycleTile(report), spendTile(report)];
}

// ---------- Travado ----------

export const BLOCKED_LABELS: Record<MetricsReport["blockedNow"]["items"][number]["type"], string> = {
  voce: "esperando você",
  agente: "esperando outro agente",
  cota: "sem cota",
  acesso: "sem acesso",
  espera: "parada",
  falha: "falhou",
};

export type BlockedRow = { key: string; type: string; typeLabel: string; tone: Tone; title: string; ref: string; projectId: string; projectTitle: string; agentId?: string; agentName?: string; age: string };

const BLOCKED_TONES: Record<string, Tone> = { falha: "danger", cota: "warn", voce: "warn", acesso: "warn", agente: "neutral", espera: "neutral" };

export type BlockedView = { count: number; rows: BlockedRow[]; more: number; summary: string };

/** Travado agora: a lista (mais velho primeiro, até `limit`) e o resumo por tipo. */
export function blockedView(report: MetricsReport, agentName: (id: string) => string | undefined, limit = 6): BlockedView {
  const items = report.blockedNow.items;
  const rows = items.slice(0, limit).map((item) => ({
    key: `${item.projectId}:${item.ref}`,
    type: item.type,
    typeLabel: BLOCKED_LABELS[item.type],
    tone: BLOCKED_TONES[item.type] ?? "neutral",
    title: item.title,
    ref: item.ref,
    projectId: item.projectId,
    projectTitle: item.projectTitle,
    ...(item.agentId ? { agentId: item.agentId, agentName: agentName(item.agentId) ?? item.agentId } : {}),
    age: formatSpan(item.ageMs),
  }));
  const summary = Object.entries(report.blockedNow.byType)
    .filter(([, count]) => count > 0)
    .map(([type, count]) => `${count} ${BLOCKED_LABELS[type as keyof typeof BLOCKED_LABELS] ?? type}`)
    .join(" · ");
  return { count: report.blockedNow.count, rows, more: Math.max(0, report.blockedNow.count - rows.length), summary };
}

// ---------- Prazos e previsão ----------

const VERDICT_VIEW: Record<ForecastVerdict, { label: string; tone: Tone }> = {
  no_prazo: { label: "No prazo", tone: "ok" },
  apertado: { label: "Apertado", tone: "warn" },
  atrasa: { label: "Atrasa", tone: "danger" },
};
const CONFIDENCE_LABEL: Record<ForecastConfidence, string> = { baixa: "baixa", media: "média", alta: "alta" };

const dayFormat = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", weekday: "short", day: "2-digit", month: "2-digit" });
const dayText = (ms: number): string => dayFormat.format(new Date(ms)).replace(/\./g, "");

/** A faixa de uma previsão como posições de 0 a 1 numa régua que cobre hoje, a faixa e o prazo (a tela desenha o SVG). */
export type ForecastBar = { low: number; high: number; at: number; now: number; due: number | null; startLabel: string; endLabel: string; ariaLabel: string };

export type ForecastRow = {
  id: string;
  title: string;
  /** "2 tarefas a fazer". */
  remaining: string;
  verdict: { label: string; tone: Tone } | null;
  /** A frase pronta do servidor ("No ritmo atual termina na quinta, 14 (entre quarta e sábado). Prazo: sexta, 15."). */
  sentence: string;
  /** "Sem prazo: só a previsão" ou "passa do prazo em 1 d 3 h". */
  dueNote: string | null;
  /** "confiança média · baseada em 11 tarefas". */
  confidence: string | null;
  bar: ForecastBar | null;
};

export type ForecastView = { rows: ForecastRow[]; more: number; empty: string | null; summary: string };

/** A régua: hoje, o começo da faixa, o fim da faixa e o prazo (se tiver), com 4% de folga dos lados. */
export function forecastBar(forecast: Pick<ProjectForecast, "at" | "low" | "high" | "dueAt" | "title">, now: number): ForecastBar | null {
  const at = Date.parse(forecast.at ?? "");
  const low = Date.parse(forecast.low ?? "");
  const high = Date.parse(forecast.high ?? "");
  if (![at, low, high].every(Number.isFinite)) return null;
  const due = forecast.dueAt ? Date.parse(forecast.dueAt) : Number.NaN;
  const hasDue = Number.isFinite(due);
  const from = Math.min(now, low, hasDue ? due : now);
  const to = Math.max(high, hasDue ? due : high, now + 3_600_000);
  const pad = Math.max((to - from) * 0.04, 60_000);
  const start = from - pad;
  const span = to + pad - start;
  const pos = (ms: number): number => Math.min(1, Math.max(0, (ms - start) / span));
  const dueText = hasDue ? `, prazo ${dayText(due)}` : "";
  return {
    low: pos(low),
    high: pos(high),
    at: pos(at),
    now: pos(now),
    due: hasDue ? pos(due) : null,
    startLabel: "hoje",
    endLabel: dayText(Math.max(high, hasDue ? due : high)),
    ariaLabel: `${forecast.title}: termina por volta de ${dayText(at)}, entre ${dayText(low)} e ${dayText(high)}${dueText}.`,
  };
}

/**
 * O bloco "Prazos e previsão": uma linha por projeto aberto (os com prazo primeiro, do pior veredito ao melhor),
 * com a faixa, a frase e o veredito. Sem projeto aberto ou sem tarefas concluídas para estimar, o texto diz o que falta.
 */
export function forecastView(report: Pick<MetricsReport, "forecast">, now: number, limit = 6): ForecastView {
  const all = report.forecast.projects;
  if (all.length === 0) return { rows: [], more: 0, empty: "Nenhum projeto aberto com tarefas a fazer.", summary: "" };
  const rows = all.slice(0, limit).map((forecast): ForecastRow => {
    const remaining = plural(forecast.remaining, "tarefa a fazer", "tarefas a fazer");
    if (forecast.state === "sem_previsao") {
      return { id: forecast.projectId, title: forecast.title, remaining, verdict: null, sentence: forecast.reason ?? "Faltam tarefas concluídas para estimar", dueNote: null, confidence: null, bar: null };
    }
    const verdict = forecast.verdict ? VERDICT_VIEW[forecast.verdict] : null;
    const late = forecast.lateByMs !== undefined && forecast.lateByMs > 0 ? `passa do prazo em ${formatSpan(forecast.lateByMs)}` : null;
    // Base emprestada: o agente ainda não tem tarefas concluídas, então a conta usa o ritmo dos outros (e pode errar muito).
    const confidence = !forecast.confidence
      ? null
      : forecast.borrowed
        ? `confiança baixa · sem histórico deste agente: usa o ritmo de ${forecast.basis ?? "poucas tarefas"} de outros agentes`
        : `confiança ${CONFIDENCE_LABEL[forecast.confidence]} · baseada em ${forecast.basis ?? "poucas tarefas"}${forecast.confidence === "baixa" ? ", poucos dados" : ""}`;
    return { id: forecast.projectId, title: forecast.title, remaining, verdict, sentence: forecast.text, dueNote: forecast.dueAt ? late : "Sem prazo: só a previsão", confidence, bar: forecastBar(forecast, now) };
  });
  const count = (verdict: ForecastVerdict): number => all.filter((forecast) => forecast.verdict === verdict).length;
  const parts = [
    count("atrasa") ? plural(count("atrasa"), "atrasa", "atrasam") : "",
    count("apertado") ? plural(count("apertado"), "apertado", "apertados") : "",
    count("no_prazo") ? `${count("no_prazo")} no prazo` : "",
  ].filter(Boolean);
  return { rows, more: Math.max(0, all.length - rows.length), empty: null, summary: parts.join(" · ") };
}

// ---------- Metas da semana ----------

export type GoalFact = { id: string; title: string; /** "Posts 1/2 no ritmo" ou "Conexões 3/10 ▼ fecha em 6 de 10". */ text: string; tone: Tone; /** Explicação inteira, para o `title` (a projeção e a base dela). */ detail: string };

/**
 * A linha "Metas da semana": cada meta com o que já entregou, e a projeção quando ela não fecha no ritmo atual
 * ("Conexões 3/10 ▼ fecha em 6 de 10"). As do mês levam "no mês".
 */
export function goalFacts(report: Pick<MetricsReport, "goals">): GoalFact[] {
  return report.goals.items.map((goal) => {
    const base = `${goal.title} ${goal.delivered}/${goal.target}${goal.period === "month" ? " no mês" : ""}`;
    let status: string;
    let tone: Tone;
    if (goal.delivered >= goal.target) {
      status = "batida";
      tone = "ok";
    } else if (goal.pace === "pausada") {
      status = "pausada";
      tone = "neutral";
    } else if (goal.projected === null) {
      status = "sem ritmo ainda";
      tone = "neutral";
    } else if (goal.closes) {
      status = goal.pace === "adiantada" ? "adiantada" : "no ritmo";
      tone = "ok";
    } else {
      status = `▼ fecha em ${goal.projected} de ${goal.target}`;
      tone = goal.pace === "atrasada" ? "danger" : "warn";
    }
    return { id: goal.routineId, title: goal.title, text: `${base} ${status}`, tone, detail: `${goal.text} · confiança ${CONFIDENCE_LABEL[goal.confidence]}` };
  });
}

// ---------- A linha da semana ----------

export type WeekFact = { id: "rework" | "failures" | "rejections" | "edits"; text: string };

/**
 * "Nesta semana: 2 refeitos (17%) · 1 falha · 3 recusas · você editou 40% dos textos". A porcentagem só aparece
 * com n >= 5 e com 3 ou mais entregas na semana; abaixo disso, só a contagem.
 */
export function weekFacts(report: MetricsReport): WeekFact[] {
  const low = isLowThroughput(weeklyThroughput(report.throughput.value ?? 0, report.windows.rates));
  const withRate = (metric: { n: number; value: number | null }) => (!low && metric.n >= METRICS_MIN_SAMPLES && metric.value !== null ? ` (${formatRate(metric.value)})` : "");
  const { rework, failureRate, rejectionRate, editRate } = report;
  const edits = editRate.n === 0 ? "você ainda não aprovou textos nesta semana" : !low && editRate.n >= METRICS_MIN_SAMPLES ? `você editou ${formatRate(editRate.value)} dos textos` : `você editou ${editRate.hits ?? 0} de ${plural(editRate.n, "texto", "textos")}`;
  return [
    { id: "rework", text: `${plural(rework.hits ?? 0, "refeito", "refeitos")}${withRate(rework)}` },
    { id: "failures", text: `${plural(failureRate.hits ?? 0, "falha", "falhas")}${withRate(failureRate)}` },
    { id: "rejections", text: `${plural(rejectionRate.hits ?? 0, "recusa", "recusas")}${withRate(rejectionRate)}` },
    { id: "edits", text: edits },
  ];
}

// ---------- Tudo junto ----------

export type PainelView = {
  /** Sem nenhuma entrega nas últimas 8 semanas: a tela explica o que falta. */
  empty: { title: string; text: string } | null;
  kpis: KpiView[];
  bars: WeeklyBars;
  cycle: CycleLine;
  quota: QuotaRow[];
};

export function painelView(report: MetricsReport): PainelView {
  const bars = weeklyBars(report.throughput.weeks);
  return {
    empty: bars.empty ? { title: "Sem entregas ainda", text: "Os números aparecem depois da primeira tarefa concluída." } : null,
    kpis: kpiTiles(report),
    bars,
    cycle: cycleLine(report.cycleTime.weeks),
    quota: quotaRows(report),
  };
}
