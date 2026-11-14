import {
  agentFieldsFromChoice,
  IMPLEMENTED_CLI_ENGINES,
  isMaestroAgent,
  maestroTeamIds,
  modelUsesEffort,
  uniqueSlug,
  type Agent,
  type createAgentBodySchema,
  type ServerEvent,
  type Team,
  type updateAgentBodySchema,
} from "@cyno/shared";
import type { z } from "zod";
import { dropForYouItems } from "../for-you/service";
import { HttpError } from "../../platform/http/errors";
import { officeStructure } from "../../store/state-manager";
import { CANCEL_REASONS, failActiveTasks, hasActiveTasks } from "./cancel";
import type { ServiceDeps } from "./deps";
import { definedFields, requireAgent, requireTeam } from "./lookup";
import { MAESTRO_RULES, maestroConflict } from "./maestro";

type CreateInput = z.output<typeof createAgentBodySchema>;
type UpdateInput = z.output<typeof updateAgentBodySchema>;

export class AgentService {
  constructor(private readonly deps: ServiceDeps) {}

  /**
   * Todo agente nasce idle; só o orquestrador muda o status. O id nunca reaproveita o de um
   * agente removido que ainda aparece no histórico de tarefas (senão herdaria esse histórico).
   */
  async create(input: CreateInput): Promise<Agent> {
    const state = this.deps.state.read();
    requireTeam(state.teams, input.teamId);
    if (maestroTeamIds(state).has(input.teamId)) throw maestroConflict(MAESTRO_RULES.agentInRoom);
    this.requireRealEngine(input.engine);
    // Sem `engine`: nasce com o padrão de agentes do workspace (claude/sonnet numa instalação nova).
    const fromDefault = input.engine === undefined ? agentFieldsFromChoice(this.deps.agentDefaults?.() ?? { engine: "mock" }) : {};
    const engine = input.engine ?? fromDefault.engine;
    const model = input.model ?? fromDefault.model;
    // O esforço só fica se o motor e o modelo o aceitam (nos Gemini o nível vai no nome do modelo).
    const effort = modelUsesEffort(engine, model) ? (input.effort ?? fromDefault.effort) : undefined;
    const taken = [
      ...state.agents.map((candidate) => candidate.id),
      ...state.tasks.flatMap((task) => (task.agentId ? [task.agentId] : [])),
    ];
    const agent: Agent = {
      id: uniqueSlug(input.name, taken),
      teamId: input.teamId,
      name: input.name,
      role: input.role,
      instructions: input.instructions,
      avatar: input.avatar,
      status: "idle",
      ...(engine && engine !== "mock" ? { engine } : {}),
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      // Acesso do agente: ausente = segue o workspace.
      ...(input.internet !== undefined ? { internet: input.internet } : {}),
      ...(input.browser !== undefined ? { browser: input.browser } : {}),
      ...(input.terminal !== undefined ? { terminal: input.terminal } : {}),
    };
    state.agents.push(agent);
    await this.deps.state.commit({ office: officeStructure(state), events: [{ type: "agent:upserted", agent }] });
    return agent;
  }

  /** O motor "mock" (simulado) só existe com o modo simulado ligado (testes); motor sem adaptador de CLI (codex, opencode) não é aceito; fora disso, 400. */
  private requireRealEngine(engine: Agent["engine"] | undefined): void {
    if (engine === "mock" && !this.deps.simulated) throw new HttpError(400, 'O motor "mock" (simulado) não está disponível: escolha Claude Code, Antigravity ou Freebuff');
    if (engine && engine !== "mock" && !(IMPLEMENTED_CLI_ENGINES as readonly string[]).includes(engine)) {
      throw new HttpError(400, `O motor "${engine}" ainda não tem adaptador de CLI instalado: escolha Claude Code, Antigravity ou Freebuff`);
    }
  }

  /** Mudar de time só sem tarefas em andamento (409). */
  async update(id: string, input: UpdateInput): Promise<Agent> {
    const state = this.deps.state.read();
    const agent = requireAgent(state.agents, id);
    this.requireRealEngine(input.engine);
    const maestroTeams = maestroTeamIds(state);
    if (maestroTeams.has(agent.teamId) && input.role !== undefined && input.role !== agent.role) {
      throw maestroConflict(MAESTRO_RULES.changeRole);
    }
    if (input.teamId !== undefined && input.teamId !== agent.teamId) {
      requireTeam(state.teams, input.teamId);
      if (maestroTeams.has(agent.teamId)) throw maestroConflict(MAESTRO_RULES.moveAgent);
      if (maestroTeams.has(input.teamId)) throw maestroConflict(MAESTRO_RULES.agentInRoom);
      if (hasActiveTasks(state.tasks, (task) => task.agentId === id)) {
        throw new HttpError(409, "O agente tem tarefas em andamento; espere terminarem para mudar de time");
      }
    }
    const { model, effort, ...rest } = input;
    const previousTeamId = agent.teamId;
    const engineBefore = agent.engine ?? "mock";
    Object.assign(agent, definedFields(rest));
    // null = volta ao padrão (tira o campo); "mock" também não precisa ficar gravado.
    if (model === null) delete agent.model;
    else if (model !== undefined) agent.model = model;
    if (effort === null) delete agent.effort;
    else if (effort !== undefined) agent.effort = effort;
    // Trocou só o motor: o modelo e o esforço do motor anterior não valem no novo (o agente usa o padrão dele).
    if ((agent.engine ?? "mock") !== engineBefore) {
      if (model === undefined) delete agent.model;
      if (effort === undefined) delete agent.effort;
    }
    // O esforço só fica onde o motor e o modelo o aceitam (nos Gemini o nível vai no nome do modelo).
    if (agent.effort !== undefined && !modelUsesEffort(agent.engine, agent.model)) delete agent.effort;
    if (agent.engine === "mock") delete agent.engine;
    // Quem muda de time deixa de liderar o time antigo.
    const unled = agent.teamId !== previousTeamId ? clearLeadership(state.teams, id) : [];
    await this.deps.state.commit({ office: officeStructure(state), events: [{ type: "agent:upserted", agent }, ...unled] });
    // Trocou de motor: a pasta de motor do antigo (token do MCP, configuração, sessões) não fica em disco.
    if ((agent.engine ?? "mock") !== engineBefore && (engineBefore === "hermes" || engineBefore === "openclaw")) await this.deps.cleanup.removeEngineData([id]);
    return agent;
  }

  /**
   * Remove o agente; as tarefas ativas dele viram failed (o histórico de tarefas e os logs delas
   * ficam). Saem também os pedidos pendentes dele no "Para você" (a tarefa já foi cancelada) e,
   * no disco, a pasta do agente (o terminal para antes).
   */
  async remove(id: string): Promise<void> {
    const state = this.deps.state.read();
    const agent = requireAgent(state.agents, id);
    if (isMaestroAgent(state, agent)) throw maestroConflict(MAESTRO_RULES.deleteAgent);
    this.deps.orchestrator.detachAgents([id], CANCEL_REASONS.agent);
    const at = this.deps.now().toISOString();
    const forYou = dropForYouItems(this.deps.state.readForYou(), (item) => item.agentId === id && item.status === "pendente");
    const events: ServerEvent[] = [
      ...failActiveTasks(state.tasks, (task) => task.agentId === id, CANCEL_REASONS.agent, at),
      ...forYou.events,
      ...clearLeadership(state.teams, id),
      { type: "agent:deleted", id },
    ];
    state.agents = state.agents.filter((agent) => agent.id !== id);
    await this.deps.state.commit({ office: officeStructure(state), tasks: state.tasks, forYou: forYou.forYou, events });
    await this.deps.cleanup.removeLeftovers({ agentIds: [id] });
  }
}

/** Tira o agente da liderança dos times que ele lidera; devolve os eventos dos times alterados. */
function clearLeadership(teams: Team[], agentId: string): ServerEvent[] {
  return teams
    .filter((team) => team.leadAgentId === agentId)
    .map((team): ServerEvent => {
      delete team.leadAgentId;
      return { type: "team:upserted", team };
    });
}
