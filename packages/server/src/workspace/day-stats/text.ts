import { DAY_STATES, ROUTINE_TIMEZONE, type CompareMetric, type DayComparison, type DayStats, type PlatformDayStats, type StateMs } from "@cyno/shared";

/**
 * "Meu dia" em texto compacto (em inglês, para o modelo): o que a ferramenta MCP `get_day_stats` devolve ao
 * Maestro e ao Cyno. O mesmo `DayStats` da rota e da tela; calculado por código, sem acordar ninguém.
 */
const clock = new Intl.DateTimeFormat("en-GB", { timeZone: ROUTINE_TIMEZONE, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const hhmm = (ms: number): string => clock.format(new Date(ms));

/** "48 s", "12 min", "1 h 10 min". */
export function durationText(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 === 0 ? `${hours} h` : `${hours} h ${String(minutes % 60).padStart(2, "0")} min`;
}

const STATE_EN: Record<(typeof DAY_STATES)[number], string> = {
  waiting_owner: "waiting for the owner",
  working: "working",
  queued: "queued",
  waiting_agent: "waiting for another agent",
  waiting_maestro: "waiting for the Maestro",
  engine_blocked: "no quota or CLI down",
};

function statesLine(ms: StateMs): string {
  const parts = DAY_STATES.filter((state) => ms[state] > 0).map((state) => `${STATE_EN[state]} ${durationText(ms[state])}`);
  return parts.length > 0 ? parts.join(", ") : "no time recorded";
}

const METRIC_EN: Record<CompareMetric, string> = { waitingOwnerMs: "waiting for the owner", workingMs: "working", waitWallMs: "clock time with someone waiting", tokens: "tokens", costUsd: "cost (USD)", tasksDone: "tasks done" };

function compareLine(label: string, comparison: DayComparison | undefined): string | undefined {
  if (!comparison) return undefined;
  const parts: string[] = [];
  for (const metric of ["waitingOwnerMs", "workingMs", "waitWallMs", "tasksDone"] as const) {
    const delta = comparison.metrics[metric];
    if (delta.sense === "same") continue;
    const time = metric !== "tasksDone";
    const amount = time ? durationText(Math.abs(delta.delta)) : String(Math.abs(delta.delta));
    parts.push(`${METRIC_EN[metric]} ${delta.delta < 0 ? "-" : "+"}${amount}${delta.pct !== undefined ? ` (${delta.pct > 0 ? "+" : ""}${delta.pct}%)` : ""}`);
  }
  const base = comparison.day ?? `average of ${comparison.days} days`;
  return `- vs ${label} (${base}): ${parts.length > 0 ? parts.join("; ") : "no change"}`;
}

function coverageLine(coverage: DayStats["coverage"]): string | undefined {
  if (coverage.states === "full") return undefined;
  const from = coverage.clockFrom ? new Date(coverage.clockFrom).toLocaleDateString("en-GB", { timeZone: ROUTINE_TIMEZONE, day: "2-digit", month: "2-digit" }) : undefined;
  if (coverage.states === "none") return `State times (working, queued, blocked) were not recorded this day${from ? ` (records start on ${from})` : ""}: only the waiting-for-the-owner time and the spending are real.`;
  return `State times were recorded only from ${from ?? "the middle of this day"} on.`;
}

/** Um workspace: `get_day_stats` do Maestro (e do Cyno com `workspace`). */
export function renderDayStats(stats: DayStats, options: { workspace?: string; workspaceName?: string } = {}): string {
  const header = `Day ${stats.day} (America/Sao_Paulo)${options.workspace ? `, workspace ${options.workspace}${options.workspaceName ? ` "${options.workspaceName}"` : ""}` : ""}. Computed by code.`;
  const { totals } = stats;
  const out = [header];
  if (totals.waits === 0) out.push("Waiting for the owner: no agent waited for the owner this day.");
  else out.push(`Waiting for the owner: ${durationText(totals.ms.waiting_owner)} in ${totals.waits} wait${totals.waits === 1 ? "" : "s"}, longest ${durationText(totals.longestWaitMs)}; clock time with someone waiting ${durationText(totals.waitWallMs)}.`);
  out.push(`Time by state: ${statesLine(totals.ms)}.`);
  const note = coverageLine(stats.coverage);
  if (note) out.push(note);
  out.push(`Done: ${totals.tasksDone} task${totals.tasksDone === 1 ? "" : "s"}, ${totals.deliveries} deliver${totals.deliveries === 1 ? "y" : "ies"}. Spending: ${totals.turns} turn${totals.turns === 1 ? "" : "s"}${totals.unmeasuredTurns > 0 ? ` (${totals.unmeasuredTurns} unmeasured)` : ""}, ${totals.tokens.input + totals.tokens.output + totals.tokens.cacheRead + totals.tokens.cacheCreation} tokens, US$ ${totals.costUsd.toFixed(2)} (API-equivalent cost).`);
  if (stats.waits.length > 0) {
    out.push("Longest waits:");
    for (const wait of stats.waits.slice(0, 5)) out.push(`- ${durationText(wait.ms)} ${wait.agentName}${wait.projectName ? `, project "${wait.projectName}"` : ""}${wait.sprintName ? `, sprint "${wait.sprintName}"` : ""} (${hhmm(wait.start)}–${wait.open ? "now" : hhmm(wait.end)}, ${wait.type})`);
  }
  if (stats.agents.length > 0) {
    out.push("By agent:");
    for (const agent of stats.agents.slice(0, 8)) out.push(`- ${agent.name}: ${statesLine(agent.ms)}`);
  }
  if (stats.projects.length > 0) {
    out.push("By project:");
    for (const project of stats.projects.slice(0, 8)) out.push(`- ${project.name}: ${statesLine(project.ms)}${project.sprints.length > 0 ? ` [${project.sprints.length} sprint${project.sprints.length === 1 ? "" : "s"}]` : ""}`);
  }
  if (stats.compare) {
    const lines = [compareLine("yesterday", stats.compare.yesterday), compareLine("the same weekday last week", stats.compare.sameWeekday), compareLine("the 7-day average", stats.compare.avg7)].filter((line): line is string => line !== undefined);
    if (lines.length > 0) out.push("Comparison:", ...lines);
  }
  return out.join("\n");
}

/** A plataforma inteira: `get_day_stats` do Cyno sem `workspace`. */
export function renderPlatformDayStats(stats: PlatformDayStats): string {
  const { totals } = stats;
  const out = [`Day ${stats.day} (America/Sao_Paulo), all workspaces. Computed by code.`];
  if (totals.waits === 0) out.push("Waiting for the owner: no agent waited for the owner this day.");
  else out.push(`Waiting for the owner: ${durationText(totals.ms.waiting_owner)} in ${totals.waits} wait${totals.waits === 1 ? "" : "s"}, longest ${durationText(totals.longestWaitMs)}; clock time with someone waiting ${durationText(totals.waitWallMs)}.`);
  out.push(`Time by state: ${statesLine(totals.ms)}.`);
  const note = coverageLine(stats.coverage);
  if (note) out.push(note);
  if (stats.workspaces.length > 0) {
    out.push("By workspace:");
    for (const part of stats.workspaces) out.push(`- ${part.workspace} "${part.name}": waiting for the owner ${durationText(part.totals.ms.waiting_owner)} in ${part.totals.waits}, working ${durationText(part.totals.ms.working)}, ${part.totals.tasksDone} done`);
  }
  if (stats.waits.length > 0) {
    out.push("Longest waits:");
    for (const wait of stats.waits.slice(0, 5)) out.push(`- ${durationText(wait.ms)} ${wait.agentName} (${wait.workspace}${wait.projectName ? `, project "${wait.projectName}"` : ""}) ${hhmm(wait.start)}–${wait.open ? "now" : hhmm(wait.end)}`);
  }
  return out.join("\n");
}
