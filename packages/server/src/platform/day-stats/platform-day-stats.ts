import { buildPlatformDayStats, type PlatformDayStats } from "@cyno/shared";
import type { WorkspaceManager } from "../workspaces/manager";

/** O dia de todos os workspaces somado (também é o que o `get_day_stats` do Cyno usa). */
export async function platformDayStatsOf(manager: Pick<WorkspaceManager, "list" | "find">, day: string, usdBrl?: number): Promise<PlatformDayStats> {
  const parts = [];
  for (const workspace of manager.list()) {
    const runtime = manager.find(workspace.id);
    if (!runtime) continue;
    parts.push({ workspace: workspace.id, name: workspace.name, stats: await runtime.dayStats(day, { compare: false, ...(usdBrl !== undefined ? { usdBrl } : {}) }) });
  }
  return buildPlatformDayStats(day, parts);
}
