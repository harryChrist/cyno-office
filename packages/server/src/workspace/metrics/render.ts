import { ROUTINE_TIMEZONE, type MetricGroup, type MetricValue, type MetricsReport } from "@cyno/shared";

/**
 * O `MetricsReport` em texto compacto (em inglês, para o modelo): o que a ferramenta MCP `get_metrics`
 * devolve ao Maestro e ao Cyno. Cita sempre o `n`; com n < 5 diz "few data" e não traz seta.
 */

/** Indicadores que `get_metrics({ metrics })` sabe escolher. */
export const METRIC_NAMES = ["throughput", "cycle_time", "approval_wait", "blocked", "failure", "rejection", "rework", "edit_rate", "cost_per_delivery", "load", "quota", "forecast", "goals"] as const;
export type MetricName = (typeof METRIC_NAMES)[number];

const clock = new Intl.DateTimeFormat("en-GB", { timeZone: ROUTINE_TIMEZONE, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const dayClock = new Intl.DateTimeFormat("en-GB", { timeZone: ROUTINE_TIMEZONE, day: "2-digit", month: "2-digit" });
const weekdayClock = new Intl.DateTimeFormat("en-GB", { timeZone: ROUTINE_TIMEZONE, weekday: "short" });
/** "Thu 14/11 15:00". */
const whenText = (iso: string | undefined): string => (iso ? `${weekdayClock.format(new Date(iso))} ${dayClock.format(new Date(iso))} ${clock.format(new Date(iso))}` : "-");

/** "5h20", "45min", "1d3h". */
export function durationText(ms: number | null): string {
  if (ms === null) return "-";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours}h${String(minutes % 60).padStart(2, "0")}` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days}d${hours % 24}h` : `${days}d`;
}

const percent = (rate: number | null): string => (rate === null ? "-" : `${Math.round(rate * 100)}%`);
const usd = (value: number | null): string => (value === null ? "-" : `$${value.toFixed(value < 1 ? 3 : 2)}`);
const ARROW = { up: "↑", down: "↓", flat: "→" } as const;

/** "(n=12, prev 8 → ↑)" ou "(few data, n=3)". */
function suffix(metric: MetricValue, prevText: string): string {
  if (metric.fewData) return `(few data, n=${metric.n})`;
  const arrow = metric.trend ? ` ${ARROW[metric.trend]}` : "";
  return `(n=${metric.n}${metric.prev !== null ? `, prev ${prevText}${arrow}` : ""})`;
}

const rateText = (metric: MetricValue): string => `${percent(metric.value)}${metric.hits !== undefined ? ` (${metric.hits}/${metric.n})` : ""} ${metric.fewData ? "few data" : metric.prev !== null ? `prev ${percent(metric.prev)}${metric.trend ? ` ${ARROW[metric.trend]}` : ""}` : "no prev"}`.trim();

function groupLine(groups: readonly MetricGroup[], text: (group: MetricGroup) => string, limit = 8): string {
  return groups.slice(0, limit).map((group) => `${group.label} ${text(group)}`).join("; ");
}

const rateGroupText = (group: MetricGroup): string => `${percent(group.value)} (${group.hits ?? 0}/${group.n}${group.fewData ? ", few data" : ""})`;
const durationGroupText = (group: MetricGroup): string => `${durationText(group.value)} (n=${group.n}${group.fewData ? ", few data" : ""})`;

const range = (from: string, to: string): string => `${dayClock.format(new Date(from))}–${dayClock.format(new Date(to))}`;

const BLOCK_LABELS: Record<string, string> = { voce: "waiting for the owner", agente: "waiting for another agent", cota: "no quota", acesso: "no access", espera: "stalled waiting", falha: "failed" };

const KIND_LABELS: Record<string, string> = { agente: "agent", motor: "engine", cota: "quota", acesso: "access", cancelada: "cancelled", outro: "other", desconhecida: "unknown origin (older task)" };
const CONFIDENCE_LABELS = { baixa: "low", media: "medium", alta: "high" } as const;
const VERDICT_LABELS = { no_prazo: "on time", apertado: "tight", atrasa: "late" } as const;

type Options = { /** Só estes indicadores (padrão: todos). */ metrics?: readonly MetricName[]; workspaceName?: string };

/** O relatório em texto. As linhas por agente/tipo/projeto saem do que o relatório trouxe (veja `pickGroups`). */
export function renderMetrics(report: MetricsReport, options: Options = {}): string {
  const want = (name: MetricName): boolean => !options.metrics || options.metrics.length === 0 || options.metrics.includes(name);
  const out: string[] = [];
  const { rates, medians } = report.windows;
  const same = rates.from === medians.from && rates.to === medians.to;
  out.push(`Metrics${options.workspaceName ? ` for "${options.workspaceName}"` : ""}, America/Sao_Paulo. Window ${same ? range(rates.from, rates.to) : `rates ${range(rates.from, rates.to)}, medians ${range(medians.from, medians.to)}`}; each compared with the previous period of the same size. "few data" = fewer than 5 samples: no trend.`);

  if (want("throughput")) {
    const t = report.throughput;
    out.push(`Deliveries: ${t.value ?? 0} ${suffix(t, String(t.prev))}; ${t.weeks.map((week) => `${week.start.slice(5)} ${week.count}`).join(", ")} (weekly, last ${t.weeks.length}; 4-week avg now ${t.weeks.at(-1)?.avg4 ?? "-"}).`);
    if (t.byAgent.length > 0) out.push(`  by agent: ${groupLine(t.byAgent, (g) => `${g.value}`)}`);
    if (t.byType.length > 0) out.push(`  by type: ${groupLine(t.byType, (g) => `${g.value}`)}`);
    if (t.byProject.length > 0) out.push(`  by project: ${groupLine(t.byProject, (g) => `${g.value}`)}`);
  }
  if (want("cycle_time")) {
    const c = report.cycleTime;
    out.push(c.n === 0 ? "Time to deliver (request to delivery): no deliveries in the window (n=0)." : `Time to deliver (request to delivery): median ${durationText(c.value)}, p90 ${durationText(c.p90)} ${suffix(c, durationText(c.prev))}; working ${durationText(c.workingMs)}, stopped ${durationText(c.stoppedMs)} (waiting for the owner ${durationText(c.waitingYouMs)}, queued/no quota ${durationText(c.queuedMs)}).${c.stoppedExact ? ` Stopped by recorded reason: another agent ${durationText(c.stoppedBy.agente)}, no quota ${durationText(c.stoppedBy.cota)}, no access ${durationText(c.stoppedBy.acesso)}.` : " Stopped time by reason is approximate (older projects have no recorded blocks)."}`);
    const q = report.queueWait;
    out.push(q.n === 0 ? "Queue wait (to-do until started): no samples (n=0)." : `Queue wait (to-do until started): median ${durationText(q.value)}, p90 ${durationText(q.p90)} ${suffix(q, durationText(q.prev))}${q.approx ? "; approximate (some tasks have no queue timestamp)" : ""}.`);
    if (q.byAgent.length > 0) out.push(`  by agent: ${groupLine(q.byAgent, durationGroupText)}`);
  }
  if (want("approval_wait")) {
    const a = report.approvalWait;
    const pending = a.pending.count === 0 ? "nothing pending" : `${a.pending.count} pending now (oldest ${durationText(a.pending.oldestMs)}, ${a.pending.over24h} over 24h)`;
    out.push(`Owner's approval wait: ${a.n === 0 ? "no decided items (n=0)" : `median ${durationText(a.value)}, p90 ${durationText(a.p90)} ${suffix(a, durationText(a.prev))}`}; ${pending}${a.weightInCycle !== null ? `; ${percent(a.weightInCycle)} of the time to deliver was waiting for the owner` : ""}.`);
    if (a.byAgent.length > 0) out.push(`  by agent: ${groupLine(a.byAgent, durationGroupText)}`);
    if (a.byType.length > 0) out.push(`  by type: ${groupLine(a.byType, durationGroupText)}`);
  }
  if (want("blocked")) {
    const b = report.blockedNow;
    if (b.count === 0) out.push("Blocked now: nothing.");
    else {
      out.push(`Blocked now: ${b.count} (${Object.entries(b.byType).map(([type, count]) => `${count} ${BLOCK_LABELS[type] ?? type}`).join(", ")}).`);
      for (const item of b.items.slice(0, 8)) out.push(`  - ${item.projectId}/${item.ref} "${item.title}": ${BLOCK_LABELS[item.type] ?? item.type} for ${durationText(item.ageMs)}`);
    }
  }
  if (want("failure")) {
    const f = report.failureRate;
    out.push(`Failure rate: ${f.n === 0 ? "no finished tasks (n=0)" : `${rateText(f)}, n=${f.n}`} (cancelled tasks are not failures).`);
    if (f.n > 0) {
      const kinds = Object.entries(f.byKind).map(([kind, count]) => `${count} ${KIND_LABELS[kind] ?? kind}`).join(", ");
      out.push(`  agent-only failures (without engine, quota and access): ${rateText(f.agentOnly)}${f.approx ? " (approximate: some failures have no recorded origin)" : ""}${kinds ? `; by origin: ${kinds}` : ""}`);
    }
    if (f.byAgent.length > 0) out.push(`  by agent: ${groupLine(f.byAgent, rateGroupText)}`);
    if (f.byModel.length > 0) out.push(`  by model: ${groupLine(f.byModel, rateGroupText)}`);
  }
  if (want("rejection")) {
    const r = report.rejectionRate;
    out.push(`Rejection rate (owner's decisions on approval items): ${r.n === 0 ? "none decided (n=0)" : `${rateText(r)}, n=${r.n}`}.`);
    if (r.byAgent.length > 0) out.push(`  by agent: ${groupLine(r.byAgent, rateGroupText)}`);
    if (r.byType.length > 0) out.push(`  by type: ${groupLine(r.byType, rateGroupText)}`);
  }
  if (want("rework")) {
    const w = report.rework;
    out.push(`Redone on request: ${w.n === 0 ? "no completed tasks (n=0)" : `${rateText(w)}, n=${w.n}, avg ${w.avgCount === null ? "-" : w.avgCount.toFixed(2)} redos per task`}.`);
    if (w.byAgent.length > 0) out.push(`  by agent: ${groupLine(w.byAgent, rateGroupText)}`);
  }
  if (want("edit_rate")) {
    const e = report.editRate;
    out.push(`Owner edits: ${e.n === 0 ? "no approved items (n=0)" : `${rateText(e)} of approved items edited, n=${e.n}; intensity median ${e.intensity.value === null ? "-" : percent(e.intensity.value)} of the text changed (n=${e.intensity.n}${e.intensity.fewData ? ", few data" : ""})`}.`);
    if (e.byAgent.length > 0) out.push(`  by agent: ${groupLine(e.byAgent, (g) => `${percent(g.value)} edited (${g.hits ?? 0}/${g.n}${g.fewData ? ", few data" : ""}), changed ${g.intensity === null || g.intensity === undefined ? "-" : percent(g.intensity)}`)}`);
    if (e.byType.length > 0) out.push(`  by type: ${groupLine(e.byType, rateGroupText)}`);
  }
  if (want("cost_per_delivery")) {
    const c = report.costPerDelivery;
    out.push(`Cost per delivery (each project cost split evenly across its deliveries, API-equivalent, not what is paid and not the window spend): ${c.deliveries === 0 ? "no deliveries (n=0)" : `${usd(c.value)} (total ${usd(c.totalUsd)}) ${suffix(c, usd(c.prev))}`}.`);
    if (c.byAgent.length > 0) out.push(`  by agent: ${groupLine(c.byAgent, (g) => `${usd(g.value)} (n=${g.n}${g.fewData ? ", few data" : ""})`)}`);
    if (c.byProject.length > 0) out.push(`  by project: ${groupLine(c.byProject, (g) => `${usd(g.value)} (n=${g.n}${g.fewData ? ", few data" : ""})`)}`);
  }
  if (want("load")) {
    const l = report.load;
    out.push(`Load now: ${l.running}/${l.maxRunning} running (limit per agent ${l.perAgentLimit}), ${l.queued} queued. ${l.agents.map((agent) => `${agent.name} doing ${agent.doing}, queued ${agent.queued}, waiting ${agent.waiting}, worked ${durationText(agent.workedMs7d)} in 7d`).join("; ")}.`);
  }
  if (want("quota")) {
    const q = report.quota;
    out.push(q.windows.length === 0 ? "Quota: no readings." : `Quota: ${q.windows.map((window) => `${window.text}${window.pace !== null ? ` (pace ${window.pace}x${window.warn ? ", spending too fast" : ""})` : ""}`).join("; ")}.`);
    for (const blocked of q.blocked) out.push(`  - ${blocked.name} cannot run: ${blocked.label}`);
  }
  if (want("forecast")) {
    const f = report.forecast;
    out.push(`Forecast of open projects (pace of the last 28 days; band = p25 to p75): ${f.text}.`);
    for (const project of f.projects.slice(0, 10)) {
      if (project.state === "sem_previsao") out.push(`  - "${project.title}" (${project.remaining} tasks left): no forecast yet, not enough completed tasks (n=0)`);
      else {
        const due = project.dueAt ? `, due ${whenText(project.dueAt)} -> ${project.verdict ? VERDICT_LABELS[project.verdict] : "-"}${project.lateByMs ? ` by ${durationText(project.lateByMs)}` : ""}` : ", no deadline";
        out.push(`  - "${project.title}" (${project.remaining} tasks left): ends ${whenText(project.at)}, range ${whenText(project.low)} to ${whenText(project.high)}${due} (n=${project.n}, confidence ${CONFIDENCE_LABELS[project.confidence ?? "baixa"]}${project.borrowed ? "; no history for this agent yet, uses other agents' pace" : ""})`);
      }
    }
  }
  if (want("goals")) {
    const g = report.goals;
    out.push(`Goals this period: ${g.text}.`);
    for (const goal of g.items.slice(0, 10)) out.push(`  - "${goal.title}" ${goal.delivered}/${goal.target} (expected ${goal.expected}): ${goal.projected === null ? "no pace measured yet" : goal.closes ? "on pace to hit the target" : `projected ${goal.projected} of ${goal.target}`} (n=${goal.n}, confidence ${CONFIDENCE_LABELS[goal.confidence]}, ${goal.daysLeft} working days left)`);
  }

  out.push(`Computed by the server at ${clock.format(new Date(report.now))} (America/Sao_Paulo); do not recompute or search the Activity for these numbers.`);
  return out.join("\n");
}
