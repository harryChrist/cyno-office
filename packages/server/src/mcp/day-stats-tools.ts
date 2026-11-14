import { parseDayQuery, type DayStats } from "@cyno/shared";
import { z } from "zod";
import { renderDayStats } from "../workspace/day-stats/text";
import { defineTool, type McpTool, type McpToolResult } from "./protocol";

const DESCRIPTION =
  "How the day went, computed by code (no AI, wakes nobody): how long the owner kept agents waiting ('Waiting for the owner', the main number: total, number of waits, the longest, clock time with someone waiting), time by state (working, queued, waiting for another agent, waiting for the Maestro, no quota), by agent, by project and sprint, tasks done, spending, the longest waits, and the comparison with yesterday, the same weekday last week and the 7-day average. Use it to answer 'how was the day?' or 'how long did the agents wait for me?' without recalculating. Defaults to today (America/Sao_Paulo); records go back 90 days.";

/** O campo `day` das ferramentas (o mesmo de `GET …/day-stats?day=`). */
export const dayField = z
  .string()
  .trim()
  .max(10)
  .optional()
  .describe("Day as YYYY-MM-DD (America/Sao_Paulo); defaults to today. Not in the future, at most 90 days back");

/** O dia pedido ou o texto do erro (para o modelo corrigir a chamada). */
export function dayOrError(day: string | undefined, now: Date): { day: string } | { error: McpToolResult } {
  const parsed = parseDayQuery(day, now.getTime());
  return parsed.ok ? { day: parsed.day } : { error: { text: `${parsed.error}.`, isError: true } };
}

/** `get_day_stats` do Maestro: a diária do próprio workspace, em texto compacto (só leitura, calculada por código). */
export function maestroDayStatsTool(deps: { dayStats: (day: string) => Promise<DayStats>; now: () => Date }): McpTool {
  return defineTool({
    name: "get_day_stats",
    description: DESCRIPTION,
    input: z.object({ day: dayField }),
    call: async ({ day }) => {
      const checked = dayOrError(day, deps.now());
      if ("error" in checked) return checked.error;
      return { text: renderDayStats(await deps.dayStats(checked.day)) };
    },
  });
}

export const DAY_STATS_DESCRIPTION_PLATFORM = `${DESCRIPTION} Without \`workspace\`: all workspaces added up, with one line per workspace.`;
