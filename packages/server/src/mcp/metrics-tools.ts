import { METRICS_GROUP_BY, type MetricsGroupBy, type MetricsReport } from "@cyno/shared";
import { z } from "zod";
import { pickGroups } from "../workspace/metrics/compute";
import { METRIC_NAMES, renderMetrics, type MetricName } from "../workspace/metrics/render";
import { METRICS_WINDOWS, windowFromPreset, type MetricsWindowPreset, type RequestedWindow } from "../workspace/metrics/window";
import { defineTool, type McpTool } from "./protocol";

const DESCRIPTION =
  "Management numbers computed by code (no AI, wakes nobody), each with its sample size n and the comparison with the previous period of the same size: deliveries per week (throughput), time to deliver (median and p90, split into working and stopped), how long the owner takes to approve (and how much of the time to deliver that is), what is blocked now, failure rate, rejection rate (who the owner refuses most), work redone on request, how much the owner edits texts (rate and intensity), cost per delivery (each project cost split evenly across its deliveries, API-equivalent; not the window spend), load per agent, quota, the delivery forecast of each open project ('forecast': when it ends at the current pace, with a p25-p75 band and the verdict against its deadline) and whether each goal will close ('goals': projected deliveries by the end of the period at the current pace). With fewer than 5 samples a number says 'few data' and carries no trend: do not draw conclusions from it. The text ends with the time the server computed it: there is nothing to recalculate and nothing to search in the Activity. Use it for 'who was refused most?', 'how long do I take to approve?', 'are we on pace?', 'when will it be ready?'.";

export const METRICS_DESCRIPTION_PLATFORM = `${DESCRIPTION} Without \`workspace\`: one short block per workspace (deliveries, approval wait, blocked, rejection); with it, the full report of that workspace.`;

/** Os campos do `get_metrics` (iguais no Maestro e no Cyno; o Cyno soma `workspace`). */
export const metricsFields = {
  window: z.enum(METRICS_WINDOWS).optional().describe("Period: '7d', '28d' (default), 'week' (this week so far, Monday start) or 'month' (this month so far); compared with the previous period of the same size"),
  group_by: z.enum(METRICS_GROUP_BY).optional().describe("Break the numbers down by 'agent' (default), 'project', 'routine', 'type' (approval type) or 'none'"),
  metrics: z
    .array(z.enum(METRIC_NAMES))
    .max(METRIC_NAMES.length)
    .optional()
    .describe("Only these indicators (default: all). 'rejection' answers 'who is refused most?'; 'approval_wait' answers 'how long do I take?'; 'forecast' answers 'when will project X be done?'; 'goals' answers 'will the weekly goals close?'"),
};

export type MetricsInput = { window?: MetricsWindowPreset | undefined; group_by?: MetricsGroupBy | undefined; metrics?: MetricName[] | undefined };

/** O texto do `get_metrics` de um workspace: pede o cálculo, escolhe grupos e indicadores e escreve. */
export async function metricsText(compute: (window: RequestedWindow) => Promise<MetricsReport>, input: MetricsInput, now: Date, options: { workspaceName?: string; defaultMetrics?: readonly MetricName[] } = {}): Promise<string> {
  const report = pickGroups(await compute(windowFromPreset(input.window ?? "28d", now.getTime())), input.group_by ?? "agent");
  const metrics = input.metrics && input.metrics.length > 0 ? input.metrics : options.defaultMetrics;
  return renderMetrics(report, { ...(metrics ? { metrics } : {}), ...(options.workspaceName ? { workspaceName: options.workspaceName } : {}) });
}

/** `get_metrics` do Maestro: as métricas do próprio workspace, em texto compacto (só leitura, calculadas por código). */
export function maestroMetricsTool(deps: { metrics: (window: RequestedWindow) => Promise<MetricsReport>; now: () => Date }): McpTool {
  return defineTool({
    name: "get_metrics",
    description: DESCRIPTION,
    input: z.object(metricsFields),
    call: async (input) => ({ text: await metricsText(deps.metrics, input, deps.now()) }),
  });
}
