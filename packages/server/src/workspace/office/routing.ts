import { isActiveTaskStatus, type Agent, type OfficeState } from "@cyno/shared";
import { HttpError } from "../../platform/http/errors";

export type RouteRequest = { roomId: string; teamId: string };

type Load = { pending: number; total: number };

function loadByAgent(office: Pick<OfficeState, "tasks">, agents: Agent[]): Map<string, Load> {
  const load = new Map(agents.map((agent) => [agent.id, { pending: 0, total: 0 }]));
  for (const task of office.tasks) {
    const entry = task.agentId ? load.get(task.agentId) : undefined;
    if (!entry) continue;
    entry.total += 1;
    if (isActiveTaskStatus(task.status)) entry.pending += 1;
  }
  return load;
}

/**
 * Escolhe o agente que vai receber uma tarefa (função pura). Entre os agentes do time:
 * ociosos primeiro; depois menos tarefas pendentes (queued/in_progress/waiting_approval);
 * depois menos tarefas no total; desempate pelo nome (e pelo id).
 * Erros: quarto ou time inexistente -> 404; time de outro quarto -> 400; time sem agentes -> 422.
 */
export function routeTask(office: OfficeState, { roomId, teamId }: RouteRequest): string {
  if (!office.rooms.some((ws) => ws.id === roomId)) {
    throw new HttpError(404, `Sala "${roomId}" não encontrada`);
  }
  const team = office.teams.find((candidate) => candidate.id === teamId);
  if (!team) throw new HttpError(404, `Time "${teamId}" não encontrado`);
  if (team.roomId !== roomId) {
    throw new HttpError(400, `O time "${team.name}" não pertence à sala "${roomId}"`);
  }
  const agents = office.agents.filter((agent) => agent.teamId === teamId);
  if (agents.length === 0) throw new HttpError(422, `O time "${team.name}" não tem agentes`);

  const load = loadByAgent(office, agents);
  const rank = (agent: Agent) => {
    const { pending, total } = load.get(agent.id)!;
    return [agent.status === "idle" ? 0 : 1, pending, total];
  };
  const [best] = [...agents].sort((a, b) => {
    const [ra, rb] = [rank(a), rank(b)];
    for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i]! - rb[i]!;
    return a.name.localeCompare(b.name, "pt-BR") || a.id.localeCompare(b.id);
  });
  return best!.id;
}
