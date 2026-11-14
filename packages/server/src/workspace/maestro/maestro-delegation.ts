import { randomUUID } from "node:crypto";
import { AGENT_LOG_LIMITS, clampLogText, engineBlockLabel, findMaestroRoom, isMaestroAgent, type Agent, type Task } from "@cyno/shared";
import { routeTask } from "../office/routing";
import type { CliMaestroDeps } from "./maestro-core";
import { doneWhenBlock } from "../projects/work-scheduler";
import type { MaestroRequests } from "./maestro-requests";

/** O briefing da tarefa avulsa leva o prazo e o "Done when" (o agente confere e manda `checklist`). */
function withDoneWhen(task: string, input: { dueAt?: string; doneWhen?: string[] }): string {
  const items = (input.doneWhen ?? []).map((text) => text.trim()).filter(Boolean);
  const parts = [
    task,
    items.length > 0 ? doneWhenBlock({ doneWhen: items.map((text, index) => ({ id: `d${index + 1}`, text })) }) : "",
    input.dueAt ? `Prazo: ${input.dueAt}` : "",
    items.length > 0 ? 'Antes de entregar, confira cada item de "Done when" e mande `checklist` (index, met, note) junto do submit_result (ou do request_approval).' : "",
  ];
  return parts.filter(Boolean).join("\n\n");
}

/**
 * `delegate_task`: cria a subtarefa para o agente (ou o melhor agente do time) e volta na hora.
 * `reason` (por que este agente/time) vira o `reason` da delegação no log e o `routeReason` da
 * subtarefa; sem ele, fica o texto genérico.
 */
export function delegateTask(
  deps: CliMaestroDeps,
  now: () => Date,
  requests: MaestroRequests,
  input: { agentId?: string; teamId?: string; task: string; reason?: string; requestId?: string; dueAt?: string; priority?: "high" | "normal" | "low"; doneWhen?: string[]; approvalType?: string },
): string {
  const state = deps.state.read();
  const request = requests.request(state, input.requestId);
  requests.unwait(state, request);
  let agent: Agent | undefined;
  if (input.agentId) {
    agent = state.agents.find((candidate) => candidate.id === input.agentId);
    if (!agent) throw new Error(`Agent "${input.agentId}" does not exist (see get_team)`);
    if (isMaestroAgent(state, agent)) throw new Error("You cannot delegate to yourself");
    const block = deps.availability?.(agent);
    if (block) throw new Error(`${agent.name} is unavailable (${engineBlockLabel(block, now().getTime())}). Do not delegate to them: pick another available agent or tell the user (nothing switches engine by itself).`);
  } else if (input.teamId) {
    const team = state.teams.find((candidate) => candidate.id === input.teamId);
    if (!team) throw new Error(`Team "${input.teamId}" does not exist (see get_team)`);
    // Só agentes disponíveis entram na escolha do time (sem cota = fora).
    const available = { ...state, agents: state.agents.filter((candidate) => candidate.teamId !== team.id || !deps.availability?.(candidate)) };
    if (!available.agents.some((candidate) => candidate.teamId === team.id)) {
      throw new Error(`No agent of team ${team.name} is available right now (out of quota or engine unavailable). Do not delegate: tell the user.`);
    }
    const agentId = routeTask(available, { roomId: team.roomId, teamId: team.id });
    agent = state.agents.find((candidate) => candidate.id === agentId);
  } else {
    throw new Error("Say to whom: agent_id or team_id");
  }
  const team = state.teams.find((candidate) => candidate.id === agent!.teamId);
  if (!agent || !team) throw new Error("Agent without a team");
  if (findMaestroRoom(state)?.id === team.roomId) throw new Error("You cannot delegate to the Maestro's room");
  const at = now().toISOString();
  const reason = clampLogText(input.reason?.trim() ?? "", AGENT_LOG_LIMITS.line) || `Delegado pelo Maestro para ${agent.name}`;
  const subtask: Task = {
    id: randomUUID(),
    roomId: team.roomId,
    teamId: team.id,
    agentId: agent.id,
    projectId: request.id,
    routeReason: reason,
    prompt: withDoneWhen(input.task.trim() || request.prompt, input),
    status: "queued",
    createdAt: at,
    updatedAt: at,
  };
  deps.plans?.()?.adopt(request, subtask, { ...(input.dueAt ? { dueAt: input.dueAt } : {}), ...(input.priority ? { priority: input.priority } : {}), ...(input.doneWhen?.length ? { doneWhen: input.doneWhen } : {}), ...(input.approvalType ? { approvalType: input.approvalType } : {}) });
  state.tasks.push(subtask);
  requests.commit(state, [subtask]);
  requests.logEntry(request, { kind: "delegation", teamId: team.id, teamName: team.name, toAgentId: agent.id, toAgentName: agent.name, reason, subtaskId: subtask.id });
  requests.setProgress(request, 0.3, `Delegada a ${agent.name} (time ${team.name})`);
  deps.log.info({ taskId: request.id, subtaskId: subtask.id, agentId: agent.id }, "Maestro (CLI) delegou");
  deps.orchestrator.enqueue(agent.id);
  return `Subtask ${subtask.id} of request ${request.id} created for ${agent.name} (team ${team.name}). Tell the user, in one sentence, who got it and end this turn: the result arrives in a message.`;
}
