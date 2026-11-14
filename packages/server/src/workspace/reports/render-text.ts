import type { StoredReport } from "@cyno/shared";
import { durationText, renderMetrics } from "../metrics/render";
import { whenFull } from "./model";

const usd = (value: number | null): string => (value === null ? "-" : `$${value.toFixed(2)}`);
const rate = (r: { hits: number; n: number }): string => (r.n === 0 ? "none (n=0)" : `${Math.round((r.hits / r.n) * 100)}% (${r.hits}/${r.n}${r.n < 5 ? ", few data" : ""})`);

/**
 * O relatório em texto compacto, em inglês, para o modelo (a ferramenta MCP `get_report`). Os números vêm do mesmo
 * `StoredReport` congelado; o texto cita o `n` e diz que não há o que recalcular. O Markdown em português é o outro formato.
 */
export function renderReportText(report: StoredReport): string {
  const out: string[] = [];
  const kind = { day: "Day summary", week: "Week review", month: "Month summary" }[report.kind];
  out.push(`${kind} ${report.period} of "${report.workspaceName}" (America/Sao_Paulo). ${report.final ? "Closed and frozen" : "PARTIAL: the period has not closed, numbers will be redone when it does"}; generated ${whenFull(report.generatedAt)} by code.`);
  if (report.kind !== "month" && !report.sections.live && report.final) out.push(`Note: "blocked now", "waiting for the owner" and quota are as of generation time (${whenFull(report.generatedAt)}), not the end of the period.`);
  const d = report.digest;
  out.push(`Totals: ${d.deliveries} deliveries; API-equivalent spend ${usd(d.spendUsd)} (the account is a subscription: this is equivalent, not money paid; read it with the quota); cost per delivery (project cost split evenly across its deliveries, equivalent; not the period spend) ${usd(d.costPerDelivery)}; rejection ${rate(d.rejection)}; rework ${rate(d.rework)}; owner edits ${rate(d.edit)}; failures ${rate(d.failure)}; goals hit ${d.goals.hit}/${d.goals.total}.`);
  if (report.ai) out.push(`Maestro's paragraph: ${report.ai.text}`);
  if (report.sections.agents.length > 0) {
    out.push("Deliveries by agent:");
    for (const agent of report.sections.agents) out.push(`  ${agent.name} ${agent.count}: ${agent.deliveries.slice(0, 5).map((item) => `"${item.title}"`).join(", ")}${agent.count > 5 ? ", ..." : ""}`);
  } else out.push("No deliveries in the period (n=0).");
  if (report.sections.goals.length > 0) out.push(`Goals: ${report.sections.goals.map((goal) => `${goal.title} ${goal.delivered}/${goal.target} ${goal.outcome === "bateu" ? "hit" : goal.outcome === "pulada" ? "skipped" : "missed"}`).join("; ")}.`);
  if (report.sections.compare) out.push(`Same weekday last week (${report.sections.compare.day}): ${report.sections.compare.deliveries} deliveries, spend ${usd(report.sections.compare.spendUsd)}.`);
  if (report.sections.next) {
    const next = report.sections.next;
    out.push(`Next: ${next.routines.length} routine runs, ${next.tasks.length} queued tasks, ${next.agenda.length} appointments${next.routines[0] ? `; first routine ${next.routines[0].title} at ${whenFull(next.routines[0].at)}` : ""}.`);
  }
  if (report.weeks) {
    out.push(`Weeks summed (${report.weeks.length}${report.missing?.length ? `, missing ${report.missing.join(", ")}` : ""}):`);
    for (const week of report.weeks) out.push(`  ${week.period}: ${week.digest.deliveries} deliveries, spend ${usd(week.digest.spendUsd)}, median time to deliver ${durationText(week.digest.cycle.median)} (n=${week.digest.cycle.n})`);
  }
  if (report.metrics) {
    const only = report.kind === "day" ? (["throughput", "approval_wait", "blocked", "failure", "rejection", "cost_per_delivery", "quota"] as const) : undefined;
    out.push("", renderMetrics(report.metrics, { ...(only ? { metrics: only } : {}), workspaceName: report.workspaceName }));
  } else out.push("Computed by the server from the stored weekly reports; do not recompute.");
  return out.join("\n");
}
