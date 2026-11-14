import type { TodayView } from "@cyno/shared";
import { z } from "zod";
import { renderToday } from "../workspace/today/today-text";
import { defineTool, type McpTool } from "./protocol";

/** `get_today` do Maestro: o painel "Hoje" do próprio workspace, em texto compacto (só leitura, calculado por código). */
export function maestroTodayTool(today: () => TodayView): McpTool {
  return defineTool({
    name: "get_today",
    description:
      "What is happening today in this workspace, computed by code (no AI, wakes nobody): what is running now with progress, projects in motion (current stage N/M, next step, blockers, deadline risk, hours today), routines that ran with their short result / are running / will run today with time and agent / were skipped, tracking changes, goal progress for the period, the owner's calendar commitments, how many items wait for the owner and what was delivered today. Use it to answer 'what is going on today?' without polling agents.",
    input: z.object({}),
    call: () => ({ text: renderToday(today()) }),
  });
}
