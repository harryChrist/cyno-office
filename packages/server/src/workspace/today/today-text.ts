import { isTodayEmpty, PACE_LABELS, ROUTINE_TIMEZONE, type PlatformToday, type TodayAgendaItem, type TodayView, type TodayWaiting } from "@cyno/shared";

/**
 * O painel "Hoje" em texto compacto (em inglês, para o modelo): o mesmo conteúdo da `TodayView`, que a
 * ferramenta MCP `get_today` devolve ao Cyno e ao Maestro. Horários no fuso do dono (São Paulo).
 */
const clock = new Intl.DateTimeFormat("en-GB", { timeZone: ROUTINE_TIMEZONE, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const hhmm = (iso: string): string => clock.format(new Date(iso));
const dayHour = new Intl.DateTimeFormat("en-GB", { timeZone: ROUTINE_TIMEZONE, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
/** "11/11 23:00" no fuso do dono (o prazo não pode sair em UTC: 23:00 de hoje em São Paulo já é "amanhã" lá). */
const dayHourLabel = (iso: string): string => dayHour.format(new Date(iso)).replace(",", "");

const BLOCK_LABELS = { voce: "waiting for the owner", agente: "waiting for another agent", cota: "no quota", acesso: "no access", falha: "failed" } as const;

const hours = (ms: number): string => `${Math.round((ms / 3_600_000) * 10) / 10}h`;
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

function agendaLines(items: readonly TodayAgendaItem[], withWorkspace: boolean): string[] {
  return items.map((item) => `- ${hhmm(item.start)}–${hhmm(item.end)} "${item.title}" [${item.kind}]${withWorkspace && item.workspace ? ` (${item.workspaceName ?? item.workspace})` : ""}${item.link ? ` ${item.link}` : ""}`);
}

function waitingLine(waiting: TodayWaiting, withWorkspace: boolean): string {
  if (waiting.count === 0) return "Waiting for the owner: nothing.";
  const oldest = waiting.oldest.map((item) => `${withWorkspace && item.workspace ? `${item.workspace}/` : ""}${item.id} "${item.title}"${item.agent ? ` from ${item.agent}` : ""} since ${hhmm(item.at)}`).join("; ");
  return `Waiting for the owner: ${waiting.count} (oldest: ${oldest}).`;
}

/** As seções de um workspace (sem o cabeçalho). */
export function renderTodaySections(view: TodayView, options: { agenda?: boolean } = {}): string[] {
  const out: string[] = [];
  if (view.now.length > 0) {
    out.push("Now:");
    for (const row of view.now) {
      const bits = [row.queued ? "queued" : row.progress !== undefined ? `${Math.round(row.progress * 100)}%` : `since ${hhmm(row.since)}`, row.agent, row.projectTitle ? `project "${row.projectTitle}"` : undefined, row.routineId ? "routine" : undefined].filter(Boolean);
      out.push(`- "${row.title}" (${bits.join(", ")})${row.message && !row.queued ? ` — ${row.message}` : ""}`);
    }
  }
  if (view.projects.length > 0) {
    out.push("Projects:");
    for (const project of view.projects) {
      const parts = [
        project.stage ? `stage ${project.stage.index}/${project.stage.total} "${project.stage.title}"${project.stage.agent ? ` (${project.stage.agent})` : ""}` : project.status,
        project.next ? `next: ${project.next}` : undefined,
        project.blocked ? `BLOCKED, ${BLOCK_LABELS[project.blocked.type]}: ${project.blocked.note}` : undefined,
        project.deliveryWaiting ? `sprint delivery summary "${project.deliveryWaiting}" waits for the owner's OK` : undefined,
        project.atRisk ? `DEADLINE AT RISK${project.dueAt ? ` (due ${dayHourLabel(project.dueAt)})` : ""}` : undefined,
        project.workedMs > 0 || project.limitMs ? `${hours(project.workedMs)}${project.limitMs ? `/${hours(project.limitMs)}` : ""} today` : undefined,
        project.status === "pausado" ? "paused" : undefined,
      ].filter(Boolean);
      out.push(`- ${project.id} "${project.title}": ${parts.join("; ")}`);
    }
  }
  const { ran, running, upcoming, skipped } = view.routines;
  if (ran.length + running.length + upcoming.length + skipped.length > 0) {
    out.push("Routines:");
    for (const run of ran) out.push(`- done ${hhmm(run.at)} "${run.title}"${run.agent ? ` (${run.agent})` : ""}: ${run.outcome === "ok" ? "ok" : "FAILED"}${run.summary ? ` — ${run.summary}` : ""}`);
    for (const run of running) out.push(`- running since ${hhmm(run.startedAt)} "${run.title}"${run.agent ? ` (${run.agent})` : ""}`);
    for (const slot of upcoming) out.push(`- at ${hhmm(slot.at)} "${slot.title}"${slot.agent ? ` (${slot.agent})` : ""}`);
    for (const skip of skipped) out.push(`- skipped ${hhmm(skip.at)} "${skip.title}": ${skip.reason}`);
  }
  if (view.changes.length > 0) {
    out.push("Tracking changes today:");
    for (const change of view.changes) out.push(`- "${change.title}": ${change.item}${change.from ? ` ${change.from} →` : " →"} ${change.to} (${hhmm(change.at)})${change.alert ? " ALERT" : ""}`);
  }
  if (view.goals.length > 0) out.push(`Goals: ${view.goals.map((goal) => `${goal.title} ${goal.done}/${goal.target} per ${goal.period === "week" ? "week" : "month"} (${PACE_LABELS[goal.pace]}${goal.blocked ? `, blocked: ${goal.blocked}` : ""})`).join("; ")}`);
  if (options.agenda !== false && view.agenda.length > 0) out.push("Owner's calendar today:", ...agendaLines(view.agenda, false));
  if (view.done.length > 0) {
    out.push("Done today:");
    for (const done of view.done) out.push(`- ${hhmm(done.at)} ${done.kind} "${done.title}"${done.projectTitle ? ` (project "${done.projectTitle}")` : ""} [${done.mediaId ? `media ${done.mediaId}` : `project ${done.projectId ?? done.id}`}]`);
  }
  return out;
}

/** Um workspace: `get_today` do Maestro (e do Cyno com `workspace`). */
export function renderToday(view: TodayView): string {
  const header = `Today ${view.day} (America/Sao_Paulo), workspace ${view.workspace}${view.workspaceName ? ` "${view.workspaceName}"` : ""}. Computed by code at ${hhmm(view.at)}.`;
  if (isTodayEmpty(view)) return `${header}\nNothing is happening today: no work running, no projects moving, no routines scheduled, nothing waiting for the owner.`;
  return [header, ...renderTodaySections(view), waitingLine(view.waiting, false)].join("\n");
}

/** A plataforma inteira, agrupada por workspace: `get_today` do Cyno sem `workspace`. */
export function renderPlatformToday(today: PlatformToday): string {
  const out = [`Today ${today.day} (America/Sao_Paulo), whole platform. Computed by code at ${hhmm(today.at)}.`];
  if (today.workspaces.length === 0) return `${out[0]}\nThere are no workspaces yet.`;
  const active = today.workspaces.filter((view) => !isTodayEmpty({ ...view, agenda: [] }));
  const idle = today.workspaces.filter((view) => !active.includes(view));
  for (const view of active) {
    out.push("", `## ${view.workspace}${view.workspaceName ? ` "${view.workspaceName}"` : ""}`, ...renderTodaySections(view, { agenda: true }));
    if (view.waiting.count > 0) out.push(`Waiting for the owner here: ${view.waiting.count}.`);
  }
  if (idle.length > 0) out.push("", `Quiet today: ${idle.map((view) => view.workspaceName ?? view.workspace).join(", ")}.`);
  if (today.agenda.length > 0) out.push("", "Owner's calendar today (all workspaces):", ...agendaLines(today.agenda, true));
  out.push("", waitingLine(today.waiting, true));
  const running = today.workspaces.reduce((sum, view) => sum + view.now.filter((row) => !row.queued).length, 0);
  out.push(`Summary: ${plural(running, "task", "tasks")} running now.`);
  return out.join("\n");
}
