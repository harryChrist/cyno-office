import { agentEngine, describeModelChoice, effectiveAccess, engineBlockLabel, findMaestroRoom, isActiveTaskStatus, isCliEngine, workspaceAccess } from "@cyno/shared";
import { describeAccess, roomPurposeInput, roomSizeInput } from "../../mcp/structure-tools";
import type { CliMaestroDeps } from "./maestro-core";

/** `get_team`: quartos, times e agentes do workspace (sem a Sala do Maestro). Em inglês (é para o modelo); nomes e focos ficam como o usuário escreveu. */
export function describeTeam(deps: CliMaestroDeps, now: () => Date): string {
  const state = deps.state.read();
  const maestroRoom = findMaestroRoom(state);
  const access = workspaceAccess(deps.access?.());
  const lines: string[] = [];
  for (const room of state.rooms) {
    if (room.id === maestroRoom?.id) continue;
    lines.push(`## Room ${room.name} (${room.id}) — purpose: ${roomPurposeInput(room.purpose ?? "geral")}; size: ${roomSizeInput(room.size ?? "auto")}`);
    const teams = state.teams.filter((team) => team.roomId === room.id);
    if (teams.length === 0) lines.push("(no teams)");
    for (const team of teams) {
      const lead = team.leadAgentId ? state.agents.find((agent) => agent.id === team.leadAgentId) : undefined;
      lines.push(`- Team ${team.name} (team_id: ${team.id}) — focus: ${team.focus}${lead ? `; lead: ${lead.name}` : ""}`);
      const agents = state.agents.filter((agent) => agent.teamId === team.id);
      if (agents.length === 0) lines.push("  - (no agents)");
      for (const agent of agents) {
        const pending = state.tasks.filter((task) => task.agentId === agent.id && isActiveTaskStatus(task.status)).length;
        const model = describeModelChoice({ engine: agentEngine(agent), model: agent.model, effort: agent.effort });
        const block = deps.availability?.(agent);
        const unavailable = block ? `; UNAVAILABLE (${engineBlockLabel(block, now().getTime())}): do not delegate, tell the user` : "";
        const session = deps.engineSession?.(agent);
        const hour = agentEngine(agent) === "freebuff" ? `; engine_session: ${session ? `{open: true, minutes_left: ${session.minutesLeft}}` : "{open: false}"}` : "";
        const web = isCliEngine(agentEngine(agent)) ? `; access: ${describeAccess(effectiveAccess(access, agent))}` : "";
        lines.push(`  - ${agent.name} (agent_id: ${agent.id}) — ${agent.role}; engine: ${model}${hour}${web}; status: ${agent.status}; pending tasks: ${pending}${unavailable}`);
      }
    }
  }
  if (state.agents.some((agent) => agentEngine(agent) === "freebuff")) {
    lines.push("", "Freebuff agents are billed per OPEN HOUR (the hour starts at the agent's first message and costs several hours of the daily balance). Give work first to an agent whose engine_session is open: it uses the hour already paid. Do not spread work across Freebuff agents without need: only one hour is open at a time by default, and another agent waits for it to end.");
  }
  const defaults = deps.agentDefaults?.();
  if (lines.length > 0 && defaults) lines.push("", `New agents (create_agent without engine) are created with the workspace default: ${describeModelChoice(defaults)}.`);
  if (lines.length > 0) lines.push(`Workspace agent access policy (agents can only be restricted below it): ${describeAccess(effectiveAccess(access, {}))}.`);
  return lines.length > 0 ? lines.join("\n") : "This workspace has no rooms or teams yet. If the user wants to build a team, create it with create_room/create_team/create_agent; otherwise, tell them.";
}
