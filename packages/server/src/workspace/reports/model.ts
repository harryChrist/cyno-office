import { METRICS_MIN_SAMPLES, ROUTINE_TIMEZONE, usageWindowLabel as sharedWindowLabel, type MetricTrend, type MetricValue, type ReportDelivery, type StoredReport } from "@cyno/shared";

/**
 * O modelo de um relatório já em texto de gente (pt-BR): é daqui que saem o HTML, o Markdown e o texto do MCP, para os
 * três dizerem a mesma coisa. Nenhum número é calculado aqui: tudo vem do `StoredReport` (que vem do `computeMetrics`).
 * Todo valor em dólar é "equivalente à API" (a conta é assinatura) e vem ao lado da cota.
 */

// ---------- Texto ----------

const WEEKDAY = new Intl.DateTimeFormat("pt-BR", { timeZone: ROUTINE_TIMEZONE, weekday: "short" });
const DAY = new Intl.DateTimeFormat("pt-BR", { timeZone: ROUTINE_TIMEZONE, day: "2-digit", month: "2-digit" });
const CLOCK = new Intl.DateTimeFormat("pt-BR", { timeZone: ROUTINE_TIMEZONE, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const LONG = new Intl.DateTimeFormat("pt-BR", { timeZone: ROUTINE_TIMEZONE, day: "numeric", month: "long", year: "numeric" });
const LONG_DAY = new Intl.DateTimeFormat("pt-BR", { timeZone: ROUTINE_TIMEZONE, weekday: "long", day: "numeric", month: "long", year: "numeric" });
const SHORT_MONTH = new Intl.DateTimeFormat("pt-BR", { timeZone: ROUTINE_TIMEZONE, day: "numeric", month: "short" });
const MONTH_NAME = new Intl.DateTimeFormat("pt-BR", { timeZone: ROUTINE_TIMEZONE, month: "long", year: "numeric" });

const strip = (text: string): string => text.replace(/\./g, "");
export const whenDay = (iso: string): string => `${strip(WEEKDAY.format(new Date(iso)))} ${DAY.format(new Date(iso))}`;
export const whenClock = (iso: string): string => CLOCK.format(new Date(iso));
export const whenFull = (iso: string): string => `${whenDay(iso)} ${whenClock(iso)}`;

/** "5 h 20 min", "45 min", "1 d 3 h". */
export function ptDuration(ms: number | null): string {
  if (ms === null) return "—";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days} d ${hours % 24} h` : `${days} d`;
}

/** "US$ 6,40" (equivalente à API: quem lê isto escreve "equivalente" ao lado). */
export function ptUsd(value: number | null): string {
  if (value === null) return "—";
  if (value > 0 && value < 0.01) return "< US$ 0,01";
  return `US$ ${value.toFixed(2).replace(".", ",")}`;
}

export const ptPercent = (rate: number | null): string => (rate === null ? "—" : `${Math.round(rate * 100)}%`);
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

export const ARROWS: Record<MetricTrend, string> = { up: "↑", down: "↓", flat: "→" };


// ---------- Cota ----------

const GEMINI_GROUP = "Modelos Gemini";
type QuotaWindow = NonNullable<StoredReport["metrics"]>["quota"]["windows"][number];

/** Grupos de modelos conhecidos (o relatório guardado só tem o id da janela, não o grupo). */
const MODEL_GROUPS: Record<string, string> = { claude_gpt: "Claude e GPT" };
const titled = (text: string): string => text.replace(/_/g, " ").replace(/\b\p{L}/gu, (letter) => letter.toUpperCase());
const looksLikeId = (text: string): boolean => /^[a-z0-9]+(_[a-z0-9]+)+$/.test(text);

/**
 * O nome de gente de uma janela de cota: "Sessão 5h", "Semana", "Semana · Fable", "Semana · Claude e GPT". O id cru
 * (`seven_day_fable`) nunca chega ao dono: o que vem depois de `five_hour_`/`seven_day_` vira o escopo (modelo ou grupo de modelos).
 */
export function quotaWindowLabel(window: Pick<QuotaWindow, "id" | "label"> & Partial<Pick<QuotaWindow, "provider">>): string {
  const scoped = /^(five_hour|seven_day)(?:_(.+))?$/.exec(window.id);
  if (scoped) {
    const base = scoped[1] === "five_hour" ? "Sessão 5h" : "Semana";
    const scope = scoped[2];
    // Antigravity divide a cota por grupo de modelos (o grupo principal, o dos Gemini, não leva sufixo no id): o grupo vai na frente.
    if (window.provider === "Antigravity") return `${scope ? (MODEL_GROUPS[scope] ?? titled(scope)) : GEMINI_GROUP} · ${base}`;
    return scope ? `${base} · ${MODEL_GROUPS[scope] ?? titled(scope)}` : base;
  }
  const label = window.label.trim();
  if (label && label !== window.id && !looksLikeId(label)) return label.charAt(0).toUpperCase() + label.slice(1);
  return titled(sharedWindowLabel(window.id));
}

const quotaReset = (text: string): string => /, volta (.+)$/.exec(text)?.[1] ?? "";

/** Texto de uma janela quente para "O que pede atenção". */
function quotaLine(window: QuotaWindow): string {
  const reset = quotaReset(window.text);
  const used = window.percent !== null && window.percent >= 100 ? "esgotada" : `em ${window.percent}%`;
  return `${/^([^:]+): /.exec(window.text)?.[1] ?? window.provider}: ${quotaWindowLabel(window)} ${used}${reset ? `, volta ${reset}` : ""}`;
}

export function quotaModel(windows: readonly QuotaWindow[]): QuotaModel {
  type Entry = { provider: string; label: string; percent: number; reset: string; fast: boolean };
  const seen = new Set<string>();
  const all: Entry[] = [];
  for (const window of windows) {
    const entry: Entry = { provider: /^([^:]+): /.exec(window.text)?.[1] ?? window.provider, label: quotaWindowLabel(window), percent: window.state === "renewed" ? 0 : (window.percent ?? 0), reset: window.state === "renewed" ? "renovada" : quotaReset(window.text), fast: window.warn };
    // A mesma janela lida duas vezes (um grupo de modelos por conta) aparece uma vez só.
    const key = `${entry.provider}|${entry.label}|${entry.percent}|${entry.reset}`;
    if (seen.has(key)) continue;
    seen.add(key);
    all.push(entry);
  }
  const used = all.filter((entry) => entry.percent > 0);
  const shown = used.length > 0 ? used : all;
  const idleEntries = used.length > 0 ? all.filter((entry) => entry.percent === 0) : [];
  const byEngine = new Map<string, QuotaRow[]>();
  for (const entry of shown) byEngine.set(entry.provider, [...(byEngine.get(entry.provider) ?? []), { label: entry.label, percent: entry.percent, reset: entry.reset, fast: entry.fast }]);
  const engines = [...byEngine].map(([name, rows]) => ({ name, rows: [...rows].sort((a, b) => b.percent - a.percent) })).sort((a, b) => b.rows[0]!.percent - a.rows[0]!.percent);
  const idleBy = new Map<string, string[]>();
  for (const entry of idleEntries) {
    const parts = entry.label.split(" · ");
    const scope = entry.provider === "Antigravity" ? parts[0]! : entry.label;
    const list = idleBy.get(entry.provider) ?? [];
    if (!list.includes(scope)) list.push(scope);
    idleBy.set(entry.provider, list);
  }
  const idle = idleBy.size === 0 ? "" : `Sem uso no período: ${[...idleBy].map(([provider, scopes]) => `${provider} (${scopes.join(", ")})`).join("; ")}.`;
  return { engines, idle, note: "" };
}

/** Linhas de texto da cota (Markdown e texto simples): um motor por linha. */
export const quotaLines = (quota: QuotaModel): string[] => [
  ...quota.engines.map((engine) => `${engine.name}: ${engine.rows.map((row) => `${row.label} ${row.percent}%${row.reset ? ` (volta ${row.reset})` : ""}`).join("; ")}`),
  ...(quota.idle ? [quota.idle] : []),
  ...(quota.note ? [quota.note] : []),
];

// ---------- Modelo ----------

export type Arrow = MetricTrend | undefined;
export type ModelLink = { kind: "task"; projectId: string; ref: string } | { kind: "url"; url: string };
export type ModelItem = { title: string; meta: string; link?: ModelLink };
export type CompareRow = { label: string; now: string; prev: string; arrow: Arrow; note: string };
export type QuotaRow = { label: string; percent: number; reset: string; fast: boolean };
export type QuotaEngine = { name: string; rows: QuotaRow[] };
/** A cota do relatório já arrumada: por motor, com rótulos de gente, sem repetição e sem janela parada em 0%. */
export type QuotaModel = { engines: QuotaEngine[]; /** "Sem uso no período: …" (vazio quando não há). */ idle: string; /** Uma frase solta (mensal). */ note: string };
export type Kpi = { label: string; value: string; sub: string; arrow: Arrow };

export type ReportModel = {
  kind: StoredReport["kind"];
  title: string;
  /** "Semana 46 · 9 a 15 de nov". */
  subtitle: string;
  workspaceName: string;
  /** "Gerado por código em seg 16/11 08:30". */
  generated: string;
  /** Período ainda não fechado ("parcial") ou posição de agora que não é a daquele período. */
  warnings: string[];
  headline: string;
  kpis: Kpi[];
  compareTitle: string;
  compare: CompareRow[];
  /** Barras por semana (revisão e mensal) com a média de 4 semanas por cima. */
  series?: { title: string; bars: { label: string; value: number; current: boolean }[]; avg: (number | null)[] };
  agents: { name: string; count: number; items: ModelItem[]; more: number }[];
  goals: { title: string; text: string; ok: boolean; skipped: boolean }[];
  next?: { title: string; lines: string[] }[];
  attention: { title: string; lines: string[] }[];
  /** Quando a série não tem nada a desenhar (nenhuma entrega em nenhuma semana): uma frase no lugar do gráfico. */
  seriesNote?: { title: string; text: string };
  /** Quando não há com o que comparar: uma frase no lugar da tabela. */
  compareNote?: string;
  /** Custo e cota, juntos (o dólar é equivalente à API, nunca "gasto do mês" solto). */
  cost: { lines: string[]; quota: QuotaModel };
  weeks?: { period: string; label: string; deliveries: number; costUsd: number; rejection: string; goals: string }[];
  ai?: { text: string; by: string };
  footer: string;
};

/** Só `http:` e `https:` viram link (um arquivo adulterado ou antigo pode trazer `javascript:`, `data:`…); o resto aparece como texto. */
export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

const link = (delivery: ReportDelivery): ModelLink | undefined => (delivery.url ? { kind: "url", url: delivery.url } : delivery.projectId && delivery.ref ? { kind: "task", projectId: delivery.projectId, ref: delivery.ref } : undefined);

function itemOf(delivery: ReportDelivery): ModelItem {
  const l = link(delivery);
  return { title: delivery.title, meta: whenFull(delivery.at), ...(l ? { link: l } : {}) };
}

function rateCell(metric: MetricValue): string {
  return metric.n === 0 ? "—" : `${ptPercent(metric.value)} (${metric.hits ?? 0}/${metric.n})`;
}

function noteOf(metric: MetricValue): string {
  if (metric.n === 0) return "sem amostras";
  return metric.fewData ? "poucos dados" : "";
}

/** A linha só entra na tabela quando há valor em pelo menos um dos dois períodos. */
const hasValue = (row: CompareRow): boolean => row.now !== "—" || row.prev !== "—";

function row(label: string, metric: MetricValue, show: (value: number | null) => string, rate = false): CompareRow {
  return {
    label,
    now: rate ? rateCell(metric) : metric.n === 0 ? "—" : show(metric.value),
    prev: metric.prevN === 0 || metric.prev === null ? "—" : rate ? ptPercent(metric.prev) : show(metric.prev),
    arrow: metric.trend,
    note: noteOf(metric),
  };
}

function periodTitle(report: StoredReport): { title: string; subtitle: string } {
  const from = new Date(report.from);
  const lastDay = new Date(Date.parse(report.to) - 3_600_000);
  if (report.kind === "day") return { title: "Resumo do dia", subtitle: LONG_DAY.format(from) };
  if (report.kind === "week") {
    const number = Number(/-W(\d+)$/.exec(report.period)?.[1] ?? 0);
    const sameMonth = DAY.format(from).slice(3) === DAY.format(lastDay).slice(3);
    const start = sameMonth ? String(Number(DAY.format(from).slice(0, 2))) : strip(SHORT_MONTH.format(from));
    return { title: "Revisão da semana", subtitle: `Semana ${number} · ${start} a ${strip(SHORT_MONTH.format(lastDay))} de ${LONG.format(lastDay).split(" de ").at(-1)}` };
  }
  const first = report.weeks?.[0]?.period ?? "";
  const last = report.weeks?.at(-1)?.period ?? "";
  const nums = [first, last].map((key) => Number(/-W(\d+)$/.exec(key)?.[1] ?? 0)).filter(Boolean);
  const name = MONTH_NAME.format(new Date(Date.parse(report.from) + 3 * 24 * 3_600_000 + 3_600_000));
  return { title: "Resumo do mês", subtitle: `${name}${nums.length === 2 ? ` · semanas ${nums[0]} a ${nums[1]}` : ""}` };
}

/** "rotina" -> "Rotina": o item sem tipo cadastrado (plano, rotina, regra) aparece pelo nome do que é, com inicial maiúscula. */
const capitalize = (text: string): string => (text ? text[0]!.toLocaleUpperCase("pt-BR") + text.slice(1) : text);

export function reportModel(report: StoredReport): ReportModel {
  const { title, subtitle } = periodTitle(report);
  const { digest, sections } = report;
  const metrics = report.metrics;
  const names = sections.names;
  const nameOf = (id: string | undefined): string => (id ? (names[id] ?? id) : "—");
  const warnings: string[] = [];
  if (!report.final) warnings.push(`${report.kind === "day" ? "Dia" : report.kind === "week" ? "Semana" : "Mês"} ainda não fechou: estes números são parciais e serão refeitos quando fechar.`);
  // A revisão de segunda de manhã é "de agora" para efeito de leitura; só avisa quando foi gerada bem depois (12 h) do fim do período.
  if (report.kind !== "month" && !sections.live && report.final && Date.parse(report.generatedAt) - Date.parse(report.to) > 12 * 3_600_000) warnings.push(`Gerado depois do período: "travado agora", "esperando você" e a cota são de ${whenFull(report.generatedAt)}, não do fim do período.`);
  if (report.kind === "month" && (report.missing?.length ?? 0) > 0) warnings.push(`Faltam ${plural(report.missing!.length, "semana guardada", "semanas guardadas")} (${report.missing!.join(", ")}): o mês soma só as que existem.`);

  // Números principais.
  const kpis: Kpi[] = [];
  const compare: CompareRow[] = [];
  let compareTitle = "";
  let series: ReportModel["series"];
  const attention: ReportModel["attention"] = [];
  let quota: QuotaModel = { engines: [], idle: "", note: "" };

  if (metrics) {
    const t = metrics.throughput;
    kpis.push({ label: "Entregas", value: String(digest.deliveries), sub: t.n === 0 ? "nenhuma entrega no período" : t.fewData || t.prev === null ? "poucos dados" : `antes: ${t.prev}`, arrow: t.trend });
    kpis.push({ label: "Tempo até entregar", value: ptDuration(metrics.cycleTime.value), sub: metrics.cycleTime.n === 0 ? "sem entregas com início registrado" : `90% até ${ptDuration(metrics.cycleTime.p90)}${metrics.cycleTime.fewData ? " · poucos dados" : ""}`, arrow: metrics.cycleTime.trend });
    const pending = metrics.approvalWait.pending;
    kpis.push({
      label: "Esperando seu OK",
      value: String(pending.count),
      sub: pending.count === 0 ? "nada pendente" : `o mais antigo há ${ptDuration(pending.oldestMs)}${pending.over24h > 0 ? ` · ${pending.over24h} há mais de 24 h` : ""}`,
      arrow: undefined,
    });
    kpis.push({ label: "Custo equivalente", value: ptUsd(digest.spendUsd), sub: `custo dos projetos rateado por entrega: ${ptUsd(digest.costPerDelivery)} (equivalente)`, arrow: undefined });

    compareTitle = report.kind === "week" ? "Comparado com a semana passada" : "Comparado com o dia anterior";
    if (report.kind === "day" && sections.compare) {
      compareTitle = `Comparado com o mesmo dia da semana passada (${whenDay(`${sections.compare.day}T12:00:00-03:00`)})`;
      const bothEnough = digest.deliveries >= METRICS_MIN_SAMPLES && sections.compare.deliveries >= METRICS_MIN_SAMPLES;
      const direction: Arrow = bothEnough ? (digest.deliveries === sections.compare.deliveries ? "flat" : digest.deliveries > sections.compare.deliveries ? "up" : "down") : undefined;
      if (digest.deliveries > 0 || sections.compare.deliveries > 0) compare.push({ label: "Entregas", now: String(digest.deliveries), prev: String(sections.compare.deliveries), arrow: direction, note: bothEnough ? "" : "poucos dados: sem seta" });
      if (digest.spendUsd > 0 || sections.compare.spendUsd > 0) compare.push({ label: "Gasto equivalente à API", now: ptUsd(digest.spendUsd), prev: ptUsd(sections.compare.spendUsd), arrow: undefined, note: "" });
    } else if (report.kind === "week") {
      compare.push(row("Entregas", t, (v) => String(v ?? 0)));
      compare.push(row("Tempo até entregar (mediana)", metrics.cycleTime, ptDuration));
      compare.push(row("Espera pelo seu OK (mediana)", metrics.approvalWait, ptDuration));
      compare.push(row("Recusado por você", metrics.rejectionRate, ptPercent, true));
      compare.push(row("Refeito a pedido", metrics.rework, ptPercent, true));
      compare.push(row("Você editou o texto", metrics.editRate, ptPercent, true));
      compare.push(row("Falhas das tarefas", metrics.failureRate, ptPercent, true));
      compare.push(row("Custo por entrega (rateado, equivalente)", metrics.costPerDelivery, ptUsd));
      if (metrics.spend.usd > 0 || metrics.spend.prevUsd > 0) compare.push({ label: "Gasto equivalente à API", now: ptUsd(metrics.spend.usd), prev: ptUsd(metrics.spend.prevUsd), arrow: undefined, note: "" });
      series = {
        title: "Entregas por semana",
        bars: t.weeks.map((week) => ({ label: DAY.format(new Date(`${week.start}T12:00:00-03:00`)), value: week.count, current: week.key === report.period })),
        avg: t.weeks.map((week) => week.avg4),
      };
    }

    // O que pede atenção (a posição é a da hora de gerar).
    const blocked = metrics.blockedNow;
    if (blocked.count > 0) {
      const label: Record<string, string> = { voce: "esperando você", agente: "esperando outro agente", cota: "sem cota", acesso: "sem acesso", espera: "parado", falha: "falhou" };
      attention.push({ title: `Travado (${blocked.count})`, lines: blocked.items.slice(0, 6).map((item) => `${item.projectTitle === item.title ? item.title : `${item.projectTitle} · ${item.title}`}: ${label[item.type] ?? item.type} há ${ptDuration(item.ageMs)}${item.agentId ? ` (${nameOf(item.agentId)})` : ""}`) });
    }
    const waiting = metrics.approvalWait.pending;
    if (waiting.count > 0) attention.push({ title: `Esperando seu OK (${waiting.count})`, lines: waiting.items.slice(0, 5).map((item) => `${names[`tipo:${item.type}`] ?? capitalize(item.type)}${item.agentId ? ` · ${nameOf(item.agentId)}` : ""}: há ${ptDuration(item.ageMs)}`) });
    if (metrics.failureRate.hits) attention.push({ title: "Falhas no período", lines: [`${plural(metrics.failureRate.hits, "tarefa falhou", "tarefas falharam")} de ${metrics.failureRate.n} terminadas (${ptPercent(metrics.failureRate.value)}); cancelada não conta.`] });
    const risky = metrics.forecast.projects.filter((project) => project.verdict === "apertado" || project.verdict === "atrasa");
    if (risky.length > 0) attention.push({ title: "Prazos em risco", lines: risky.slice(0, 5).map((project) => `${project.title}: ${project.verdict === "atrasa" ? "atrasa" : "apertado"}. ${project.text}`) });
    const hot = metrics.quota.windows.filter((window) => window.percent !== null && window.percent >= 85);
    if (hot.length > 0) attention.push({ title: "Cota acima de 85%", lines: hot.map(quotaLine) });
    quota = quotaModel(metrics.quota.windows);
  } else if (report.weeks) {
    kpis.push({ label: "Entregas", value: String(digest.deliveries), sub: `em ${plural(report.weeks.length, "semana", "semanas")}`, arrow: undefined });
    kpis.push({ label: "Metas", value: digest.goals.total === 0 ? "—" : `${digest.goals.hit}/${digest.goals.total}`, sub: digest.goals.total === 0 ? "sem metas fechadas" : "batidas no mês", arrow: undefined });
    kpis.push({ label: "Recusado por você", value: digest.rejection.n === 0 ? "—" : `${ptPercent(digest.rejection.hits / digest.rejection.n)}`, sub: `${digest.rejection.hits} de ${digest.rejection.n} decididos`, arrow: undefined });
    kpis.push({ label: "Custo equivalente", value: ptUsd(digest.spendUsd), sub: `custo dos projetos rateado por entrega: ${ptUsd(digest.costPerDelivery)} (equivalente)`, arrow: undefined });
    series = { title: "Entregas por semana", bars: report.weeks.map((week) => ({ label: week.period.slice(5), value: week.digest.deliveries, current: false })), avg: report.weeks.map(() => null) };
    const peaks = report.weeks.map((week) => week.digest.quotaPeak).filter((value): value is number => value !== null);
    if (peaks.length > 0) quota = { ...quota, note: `Maior uso de cota lido ao fechar uma semana: ${Math.max(...peaks)}%` };
  }

  // Quiet period: sem nada a mostrar, uma frase no lugar da tabela e do gráfico (não uma caixa vazia).
  const shownCompare = compare.filter(hasValue);
  const comparable = metrics !== undefined && (report.kind === "week" || (report.kind === "day" && sections.compare !== undefined));
  const compareNote = comparable && shownCompare.length === 0 ? `Sem entregas ${report.kind === "week" ? "nesta semana" : "neste dia"}: ainda não há o que comparar.` : undefined;
  const emptySeries = series !== undefined && series.bars.every((bar) => bar.value === 0);
  const seriesNote = series && emptySeries ? { title: series.title, text: `Nenhuma entrega ${series.bars.length > 1 ? `nas últimas ${series.bars.length} semanas` : "na semana"}: ainda não há série para desenhar.` } : undefined;
  if (emptySeries) series = undefined;

  const goals = sections.goals.map((goal) => ({ title: goal.title, text: `${goal.delivered} de ${goal.target}`, ok: goal.outcome === "bateu", skipped: goal.outcome === "pulada" }));

  const next: ReportModel["next"] = [];
  if (sections.next) {
    if (sections.next.routines.length > 0) next.push({ title: "Rotinas de hoje", lines: sections.next.routines.map((slot) => `${whenClock(slot.at)} · ${slot.title}${slot.agent ? ` (${slot.agent})` : ""}`) });
    if (sections.next.tasks.length > 0) next.push({ title: "Próximas tarefas", lines: sections.next.tasks.map((task) => `${task.title}${task.project ? ` · ${task.project}` : ""}${task.agent ? ` (${task.agent})` : ""}`) });
    if (sections.next.agenda.length > 0) next.push({ title: "Compromissos", lines: sections.next.agenda.map((event) => `${whenClock(event.start)} · ${event.title}`) });
  }

  const cost: string[] = [];
  cost.push(`Gasto no período: ${ptUsd(digest.spendUsd)} (equivalente à API, medida do uso da assinatura; não é dinheiro pago).`);
  if (digest.deliveries > 0) cost.push(`Custo dos projetos rateado por entrega: ${ptUsd(digest.costPerDelivery)} (equivalente, não é o gasto do período) em ${plural(digest.deliveries, "entrega", "entregas")}.`);

  const headline = [
    `${plural(digest.deliveries, "entrega", "entregas")}`,
    ...(digest.goals.total > 0 ? [`metas ${digest.goals.hit}/${digest.goals.total}`] : []),
    `custo equivalente ${ptUsd(digest.spendUsd)}`,
    ...(digest.quotaPeak !== null ? [`cota até ${digest.quotaPeak}%`] : []),
  ].join(" · ");

  const agents = sections.agents.map((agent) => ({ name: agent.name, count: agent.count, items: agent.deliveries.map(itemOf), more: Math.max(0, agent.count - agent.deliveries.length) }));
  if (sections.otherDeliveries.length > 0) agents.push({ name: "Sem agente registrado", count: sections.otherDeliveries.length, items: sections.otherDeliveries.map(itemOf), more: 0 });

  return {
    kind: report.kind,
    title,
    subtitle,
    workspaceName: report.workspaceName,
    generated: `Calculado por código em ${whenFull(report.generatedAt)}, sem IA`,
    warnings,
    headline,
    kpis,
    compareTitle,
    compare: shownCompare,
    ...(compareNote ? { compareNote } : {}),
    ...(series ? { series } : {}),
    ...(seriesNote ? { seriesNote } : {}),
    agents,
    goals,
    ...(next.length > 0 ? { next } : {}),
    attention,
    cost: { lines: cost, quota },
    ...(report.weeks
      ? {
          weeks: report.weeks.map((week) => ({
            period: week.period,
            label: `${strip(SHORT_MONTH.format(new Date(week.from)))} a ${strip(SHORT_MONTH.format(new Date(Date.parse(week.to) - 3_600_000)))}`,
            deliveries: week.digest.deliveries,
            costUsd: week.digest.spendUsd,
            rejection: week.digest.rejection.n === 0 ? "—" : `${ptPercent(week.digest.rejection.hits / week.digest.rejection.n)} (${week.digest.rejection.hits}/${week.digest.rejection.n})`,
            goals: week.digest.goals.total === 0 ? "—" : `${week.digest.goals.hit}/${week.digest.goals.total}`,
          })),
        }
      : {}),
    ...(report.ai ? { ai: { text: report.ai.text, by: report.ai.by ?? "Maestro" } } : {}),
    footer: "Valores em dólar são equivalentes à tabela de preços da API: a conta é uma assinatura, então leia sempre junto da cota. Seta só quando há 5 ou mais amostras nos dois períodos.",
  };
}
