import {
  isMaestroRoom,
  maestroTeamIds,
  uniqueSlug,
  type createTeamBodySchema,
  type ServerEvent,
  type Team,
  type updateTeamBodySchema,
} from "@cyno/shared";
import type { z } from "zod";
import { dropForYouItems } from "../for-you/service";
import { HttpError } from "../../platform/http/errors";
import { officeStructure } from "../../store/state-manager";
import { CANCEL_REASONS, failActiveTasks, hasActiveTasks } from "./cancel";
import type { ServiceDeps } from "./deps";
import { definedFields, requireTeam, requireRoom } from "./lookup";
import { MAESTRO_RULES, maestroConflict } from "./maestro";

type CreateInput = z.output<typeof createTeamBodySchema>;
type UpdateInput = z.output<typeof updateTeamBodySchema>;

export class TeamService {
  constructor(private readonly deps: ServiceDeps) {}

  /** O id nunca reaproveita o de um time removido que ainda aparece no histórico de tarefas. */
  async create(input: CreateInput): Promise<Team> {
    const state = this.deps.state.read();
    const room = requireRoom(state.rooms, input.roomId);
    if (isMaestroRoom(room)) throw maestroConflict(MAESTRO_RULES.teamInRoom);
    const taken = [...state.teams.map((team) => team.id), ...state.tasks.map((task) => task.teamId)];
    const id = uniqueSlug(`${input.roomId} ${input.name}`, taken);
    const team: Team = { id, roomId: input.roomId, name: input.name, focus: input.focus };
    state.teams.push(team);
    await this.deps.state.commit({ office: officeStructure(state), events: [{ type: "team:upserted", team }] });
    return team;
  }

  /** Mudar de quarto só sem tarefas em andamento (409), para a fila não cruzar quartos. */
  async update(id: string, input: UpdateInput): Promise<Team> {
    const state = this.deps.state.read();
    const team = requireTeam(state.teams, id);
    if (input.roomId !== undefined && input.roomId !== team.roomId) {
      const target = requireRoom(state.rooms, input.roomId);
      if (maestroTeamIds(state).has(id)) throw maestroConflict(MAESTRO_RULES.moveTeam);
      if (isMaestroRoom(target)) throw maestroConflict(MAESTRO_RULES.teamInRoom);
      if (hasActiveTasks(state.tasks, (task) => task.teamId === id)) {
        throw new HttpError(409, "O time tem tarefas em andamento; espere terminarem para mudar de sala");
      }
    }
    const { leadAgentId, ...rest } = input;
    if (leadAgentId) {
      const lead = state.agents.find((agent) => agent.id === leadAgentId);
      if (!lead || lead.teamId !== id) throw new HttpError(400, `O líder precisa ser um agente do time "${team.name}"`);
    }
    Object.assign(team, definedFields(rest));
    // null tira o líder; um id (já validado) troca.
    if (leadAgentId === null) delete team.leadAgentId;
    else if (leadAgentId !== undefined) team.leadAgentId = leadAgentId;
    await this.deps.state.commit({ office: officeStructure(state), events: [{ type: "team:upserted", team }] });
    return team;
  }

  /**
   * Remove o time e os agentes dele; as tarefas ativas do time viram failed (o histórico de
   * tarefas e os logs delas ficam). Saem também os pedidos pendentes do time no "Para você" e, no
   * disco, as pastas dos agentes (os terminais param antes).
   */
  async remove(id: string): Promise<void> {
    const state = this.deps.state.read();
    requireTeam(state.teams, id);
    if (maestroTeamIds(state).has(id)) throw maestroConflict(MAESTRO_RULES.deleteTeam);
    const agentIds = state.agents.filter((agent) => agent.teamId === id).map((agent) => agent.id);
    this.deps.orchestrator.detachAgents(agentIds, CANCEL_REASONS.team);
    const at = this.deps.now().toISOString();
    const teamTasks = new Set(state.tasks.filter((task) => task.teamId === id).map((task) => task.id));
    const agents = new Set(agentIds);
    const forYou = dropForYouItems(
      this.deps.state.readForYou(),
      (item) => item.status === "pendente" && (agents.has(item.agentId) || (item.taskId !== undefined && teamTasks.has(item.taskId))),
    );
    const events: ServerEvent[] = [
      ...failActiveTasks(state.tasks, (task) => task.teamId === id, CANCEL_REASONS.team, at),
      ...forYou.events,
      ...agentIds.map((agentId): ServerEvent => ({ type: "agent:deleted", id: agentId })),
      { type: "team:deleted", id },
    ];
    state.agents = state.agents.filter((agent) => agent.teamId !== id);
    state.teams = state.teams.filter((team) => team.id !== id);
    await this.deps.state.commit({ office: officeStructure(state), tasks: state.tasks, forYou: forYou.forYou, events });
    await this.deps.cleanup.removeLeftovers({ agentIds });
  }
}
