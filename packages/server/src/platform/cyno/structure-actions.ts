import {
  createConnectorBodySchema,
  effectiveAccess,
  isActiveTaskStatus,
  isMaestroAgent,
  isMaestroRoom,
  maestroTeamIds,
  normalizeDomain,
  updateAgentBodySchema,
  workspaceAccess,
  type Agent,
  type DangerousAction,
  type OfficeState,
  type Workspace,
} from "@cyno/shared";
import { findByRef } from "../../mcp/structure-tools";
import { HttpError } from "../http/errors";
import type { WorkspaceManager } from "../workspaces/manager";
import type { WorkspaceRuntime } from "../../workspace/runtime";
import { HOST_COMMAND_LIMITS } from "@cyno/shared";
import { errorMessage } from "../../util/text";
import type { ConfirmationRequest } from "./confirmations";
import { commandLine, HostCommandRunner, refuseHostCommand } from "./host-command";

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
const onOff = (value: boolean) => (value ? "ligado" : "desligado");

type ManagerLike = Pick<WorkspaceManager, "list" | "find" | "remove" | "update">;

/** Os parâmetros que cada ação grava (ids resolvidos + os nomes vistos no pedido, para conferir na execução). */
type Frozen = Record<string, unknown>;

/**
 * Ações perigosas do Cyno, em duas partes:
 * - `prepare*`: valida a entrada contra o estado de agora, resolve nomes em ids e monta, POR CÓDIGO, o
 *   resumo, o impacto e os detalhes do cartão (o que o dono lê). Não muda nada.
 * - `execute`: roda a ação com SÓ os parâmetros congelados, depois do clique do dono. Antes de mexer,
 *   confere que o alvo ainda é o mesmo que foi mostrado (mesmo nome); se mudou, não executa.
 * Os erros das duas são `Error` com texto em inglês (o Cyno lê); a rota do dono os devolve ao navegador.
 */
export class StructureActions {
  constructor(
    private readonly deps: {
      workspaces: ManagerLike;
      hostCommands: HostCommandRunner;
    },
  ) {}

  // ---------- Resolver o alvo ----------

  workspaceOf(ref: string): Workspace {
    const found = findByRef(this.deps.workspaces.list(), ref);
    if (!found) throw new Error(`No workspace "${ref}". Use list_workspaces.`);
    return found;
  }

  runtimeOf(ref: string): { workspace: Workspace; runtime: WorkspaceRuntime } {
    const workspace = this.workspaceOf(ref);
    const runtime = this.deps.workspaces.find(workspace.id);
    if (!runtime) throw new Error(`Workspace "${workspace.name}" is not available.`);
    return { workspace, runtime };
  }

  private agentOf(state: OfficeState, ref: string): Agent {
    const agent = findByRef(state.agents, ref);
    if (!agent) throw new Error(`Agent "${ref}" not found in that workspace. See get_workspace_card.`);
    return agent;
  }

  // ---------- Preparar (monta o cartão) ----------

  async prepareDeleteWorkspace(input: { workspace: string }): Promise<ConfirmationRequest> {
    const { workspace, runtime } = this.runtimeOf(input.workspace);
    const state = runtime.store.snapshot();
    const rooms = state.rooms.filter((room) => !isMaestroRoom(room)).length;
    const agents = state.agents.filter((agent) => !isMaestroAgent(state, agent)).length;
    const media = runtime.media.list().length;
    const active = state.tasks.filter((task) => isActiveTaskStatus(task.status)).length;
    const impact = [plural(rooms, "sala", "salas"), plural(agents, "agente", "agentes"), plural(state.tasks.length, "tarefa", "tarefas"), plural(media, "mídia", "mídias")].join(", ");
    return {
      action: "delete_workspace",
      params: { workspace: workspace.id, name: workspace.name },
      summary: `Apagar o workspace "${workspace.name}": ${impact}`,
      impact,
      workspace: workspace.name,
      details: [
        "Os terminais dos agentes e do Maestro param e o workspace sai da plataforma.",
        "A pasta não é apagada do disco: vai para a lixeira da plataforma (excluidos/workspaces).",
        ...(active > 0 ? [`Há ${plural(active, "tarefa em andamento", "tarefas em andamento")}: o servidor só apaga quando terminarem.`] : []),
      ],
    };
  }

  async prepareDeleteRoom(input: { workspace: string; room: string }): Promise<ConfirmationRequest> {
    const { workspace, runtime } = this.runtimeOf(input.workspace);
    const state = runtime.store.snapshot();
    const room = findByRef(state.rooms, input.room);
    if (!room) throw new Error(`Room "${input.room}" not found in ${workspace.name}. See get_workspace_card.`);
    if (isMaestroRoom(room)) throw new Error("The Maestro's room cannot be deleted.");
    const preview = await runtime.services.rooms.deletionPreview(room.id);
    const impact = [plural(preview.teams, "time", "times"), plural(preview.agents, "agente", "agentes"), plural(preview.tasks, "tarefa", "tarefas"), plural(preview.brainNotes, "nota do Cérebro", "notas do Cérebro")].join(", ");
    return {
      action: "delete_room",
      params: { workspace: workspace.id, room: room.id, name: room.name },
      summary: `Apagar a sala "${room.name}" do workspace ${workspace.name}: ${impact}`,
      impact,
      workspace: workspace.name,
      details: [`${plural(preview.forYouItems, "item do Para você", "itens do Para você")} e ${plural(preview.calendarEvents, "evento do calendário", "eventos do calendário")} da sala também saem.`, ...(preview.activeTasks > 0 ? [`${plural(preview.activeTasks, "tarefa ativa será cancelada", "tarefas ativas serão canceladas")}.`] : []), "Não dá para desfazer."],
    };
  }

  prepareDeleteTeam(input: { workspace: string; team: string }): ConfirmationRequest {
    const { workspace, runtime } = this.runtimeOf(input.workspace);
    const state = runtime.store.snapshot();
    const team = findByRef(state.teams, input.team);
    if (!team) throw new Error(`Team "${input.team}" not found in ${workspace.name}. See get_workspace_card.`);
    if (maestroTeamIds(state).has(team.id)) throw new Error("The Maestro's team (Gerência) cannot be deleted.");
    const agents = state.agents.filter((agent) => agent.teamId === team.id);
    const active = state.tasks.filter((task) => task.teamId === team.id && isActiveTaskStatus(task.status)).length;
    const impact = `${plural(agents.length, "agente", "agentes")}${agents.length > 0 ? ` (${agents.map((agent) => agent.name).join(", ")})` : ""}, ${plural(active, "tarefa ativa", "tarefas ativas")}`;
    return {
      action: "delete_team",
      params: { workspace: workspace.id, team: team.id, name: team.name },
      summary: `Apagar o time "${team.name}" do workspace ${workspace.name}: ${impact}`,
      impact,
      workspace: workspace.name,
      details: [...(active > 0 ? [`${plural(active, "tarefa ativa será cancelada", "tarefas ativas serão canceladas")}; o histórico das tarefas fica.`] : []), "Não dá para desfazer."],
    };
  }

  prepareDeleteAgent(input: { workspace: string; agent: string }): ConfirmationRequest {
    const { workspace, runtime } = this.runtimeOf(input.workspace);
    const state = runtime.store.snapshot();
    const agent = this.agentOf(state, input.agent);
    if (isMaestroAgent(state, agent)) throw new Error("The Maestro cannot be deleted.");
    const active = state.tasks.filter((task) => task.agentId === agent.id && isActiveTaskStatus(task.status)).length;
    const impact = `${agent.name} (${agent.role}), ${plural(active, "tarefa ativa", "tarefas ativas")}`;
    return {
      action: "delete_agent",
      params: { workspace: workspace.id, agent: agent.id, name: agent.name },
      summary: `Apagar o agente "${agent.name}" do workspace ${workspace.name}`,
      impact,
      workspace: workspace.name,
      details: [`Função: ${agent.role}.`, ...(active > 0 ? [`${plural(active, "tarefa ativa será cancelada", "tarefas ativas serão canceladas")}; o histórico fica.`] : []), "Não dá para desfazer."],
    };
  }

  prepareAddConnector(input: { workspace: string; name: string; kind: "http" | "stdio"; url?: string; command?: string; args?: string[] }): ConfirmationRequest {
    const { workspace, runtime } = this.runtimeOf(input.workspace);
    const parsed = createConnectorBodySchema.safeParse({ name: input.name, kind: input.kind, ...(input.url ? { url: input.url } : {}), ...(input.command ? { command: input.command } : {}), ...(input.args?.length ? { args: input.args } : {}), origin: "manual" });
    if (!parsed.success) throw new Error(`Invalid connector: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`).join("; ")}`);
    const body = parsed.data;
    if (runtime.connectors.list().some((connector) => connector.name.toLowerCase() === body.name.toLowerCase())) throw new Error(`${workspace.name} already has a connector named "${body.name}".`);
    const where = body.kind === "http" ? `servidor MCP em ${body.url}` : `comando local \`${commandLine(body.command ?? "", body.args ?? [])}\``;
    return {
      action: "install_connector",
      params: { workspace: workspace.id, body },
      summary: `Cadastrar o conector "${body.name}" no workspace ${workspace.name}: ${where}`,
      impact: body.kind === "stdio" ? "Roda um programa nesta máquina quando um agente usar o conector." : "Os agentes que receberem o conector poderão chamar as ferramentas desse servidor.",
      workspace: workspace.name,
      details: ["Segredos (chaves, tokens) não passam pelo Cyno: você os coloca na tela de conectores do workspace.", "O conector nasce sem nenhum agente: dar acesso a um agente é outro pedido de OK."],
    };
  }

  prepareSetAgentConnectors(input: { workspace: string; agent: string; connectors: string[] }): ConfirmationRequest {
    const { workspace, runtime } = this.runtimeOf(input.workspace);
    const state = runtime.store.snapshot();
    const agent = this.agentOf(state, input.agent);
    const all = runtime.connectors.list();
    const picked = input.connectors.map((ref) => {
      const found = findByRef(all, ref);
      if (!found) throw new Error(`Connector "${ref}" not found in ${workspace.name}. Connectors there: ${all.map((connector) => `${connector.name} (${connector.id})`).join(", ") || "none (use add_connector)"}.`);
      return found;
    });
    const before = all.filter((connector) => connector.agentIds.includes(agent.id));
    const names = (list: readonly { name: string }[]) => (list.length > 0 ? list.map((connector) => connector.name).join(", ") : "nenhum");
    return {
      action: "set_agent_connectors",
      params: { workspace: workspace.id, agent: agent.id, name: agent.name, connectors: picked.map((connector) => ({ id: connector.id, name: connector.name })) },
      summary: `Dar ao agente "${agent.name}" (${workspace.name}) acesso aos conectores: ${names(picked)}`,
      impact: `Antes: ${names(before)}. Depois: ${names(picked)}.`,
      workspace: workspace.name,
      details: ["A lista inteira substitui a atual do agente.", "Conectores dão ao agente ferramentas de servidores externos (podem ler e agir fora da plataforma)."],
    };
  }

  prepareSetAgentAccess(input: { workspace: string; agent: string; internet?: boolean; browser?: boolean; terminal?: boolean }): ConfirmationRequest {
    const { workspace, runtime } = this.runtimeOf(input.workspace);
    const state = runtime.store.snapshot();
    const agent = this.agentOf(state, input.agent);
    const change = { ...(input.internet !== undefined ? { internet: input.internet } : {}), ...(input.browser !== undefined ? { browser: input.browser } : {}), ...(input.terminal !== undefined ? { terminal: input.terminal } : {}) };
    if (Object.keys(change).length === 0) throw new Error("Nothing to change: pass internet, browser and/or terminal.");
    const policy = runtime.access();
    const before = effectiveAccess(policy, agent);
    const after = effectiveAccess(policy, { ...agent, ...change });
    const names = { internet: "internet", browser: "navegador", terminal: "terminal" } as const;
    const capped = (Object.keys(change) as (keyof typeof change)[]).filter((key) => change[key] === true && !after[key]);
    if (capped.length > 0) {
      throw new Error(`The workspace policy of ${workspace.name} does not allow ${capped.join(" / ")}, so the agent cannot get it (an agent never has more than its workspace). Nothing was asked. If the owner wants it, first ask for the workspace policy to change with set_workspace_access (it needs the owner's OK), then ask for the agent again.`);
    }
    const lines = (Object.keys(change) as (keyof typeof change)[]).map((key) => `${names[key]}: ${onOff(before[key])} -> ${onOff(after[key])}`);
    return {
      action: "set_agent_access",
      params: { workspace: workspace.id, agent: agent.id, name: agent.name, ...change },
      summary: `Mudar o acesso do agente "${agent.name}" (${workspace.name}): ${lines.join("; ")}`,
      impact: lines.join("; "),
      workspace: workspace.name,
      details: ["O agente nunca recebe mais do que a política do workspace permite.", ...(change.terminal === true ? ["Terminal: o agente roda comandos nesta máquina, dentro da pasta dele."] : [])],
    };
  }

  prepareSetWorkspaceAccess(input: { workspace: string; internet?: boolean; browser?: boolean; terminal?: boolean; allowLocalNetwork?: boolean; allowedDomains?: string[]; blockedDomains?: string[] }): ConfirmationRequest {
    const { workspace, runtime } = this.runtimeOf(input.workspace);
    const domains = (list: string[] | undefined) => list?.map((domain) => normalizeDomain(domain) ?? (() => { throw new Error(`Invalid domain "${domain}".`); })());
    const change = {
      ...(input.internet !== undefined ? { internet: input.internet } : {}),
      ...(input.browser !== undefined ? { browser: input.browser } : {}),
      ...(input.terminal !== undefined ? { terminal: input.terminal } : {}),
      ...(input.allowLocalNetwork !== undefined ? { allowLocalNetwork: input.allowLocalNetwork } : {}),
      ...(input.allowedDomains !== undefined ? { allowedDomains: domains(input.allowedDomains)! } : {}),
      ...(input.blockedDomains !== undefined ? { blockedDomains: domains(input.blockedDomains)! } : {}),
    };
    if (Object.keys(change).length === 0) throw new Error("Nothing to change: pass at least one access field.");
    const before = runtime.access();
    const labels: Record<string, string> = { internet: "internet", browser: "navegador", terminal: "terminal", allowLocalNetwork: "rede local" };
    const lines = Object.entries(change).map(([key, value]) =>
      typeof value === "boolean" ? `${labels[key]}: ${onOff(before[key as "internet"])} -> ${onOff(value)}` : `${key === "allowedDomains" ? "domínios permitidos" : "domínios bloqueados"}: ${(value as string[]).join(", ") || "(vazio)"}`,
    );
    return {
      action: "set_workspace_access",
      params: { workspace: workspace.id, name: workspace.name, change },
      summary: `Mudar o acesso de TODOS os agentes do workspace ${workspace.name}: ${lines.join("; ")}`,
      impact: lines.join("; "),
      workspace: workspace.name,
      details: ["É a política do workspace: vale para todos os agentes dele (cada agente ainda pode ficar abaixo dela).", "Os terminais abertos reiniciam quando estiverem livres."],
    };
  }

  prepareRunHostCommand(input: { command: string; args?: string[]; cwd?: string; timeoutSec?: number }): ConfirmationRequest {
    const args = input.args ?? [];
    const refusal = refuseHostCommand({ command: input.command, args });
    if (refusal) throw new Error(refusal);
    const cwd = this.deps.hostCommands.cwdOf(input.cwd);
    const timeoutSec = Math.min(input.timeoutSec ?? HOST_COMMAND_LIMITS.timeoutDefaultSec, HOST_COMMAND_LIMITS.timeoutMaxSec);
    const line = commandLine(input.command, args);
    return {
      action: "run_host_command",
      params: { command: input.command, args, cwd, timeoutSec },
      summary: `Rodar na máquina: ${line}`,
      impact: `Pasta: ${cwd}`,
      details: [`Comando exato: ${line}`, `Pasta de trabalho: ${cwd}`, `Roda direto, sem shell; tempo limite de ${timeoutSec} s e saída cortada em ${HOST_COMMAND_LIMITS.outputChars} caracteres.`, "Nunca com sudo."],
    };
  }

  // ---------- Executar (só depois do OK, só com os parâmetros congelados) ----------

  /** Roda a ação e devolve o texto do resultado (o dono vê no cartão e o Cyno recebe). Erro = falhou. */
  async execute(action: DangerousAction, params: Frozen): Promise<string> {
    switch (action) {
      case "delete_workspace":
        return this.doDeleteWorkspace(params);
      case "delete_room":
        return this.doDeleteRoom(params);
      case "delete_team":
        return this.doDeleteTeam(params);
      case "delete_agent":
        return this.doDeleteAgent(params);
      case "install_connector":
        return this.doAddConnector(params);
      case "set_agent_connectors":
        return this.doSetAgentConnectors(params);
      case "set_agent_access":
        return this.doSetAgentAccess(params);
      case "set_workspace_access":
        return this.doSetWorkspaceAccess(params);
      case "run_host_command":
        return this.doRunHostCommand(params);
      default:
        throw new Error(`The action ${action} is not available yet.`);
    }
  }

  /** Acha o runtime pelo id congelado; erra se o workspace não existe mais. */
  private frozenRuntime(params: Frozen): WorkspaceRuntime {
    const runtime = this.deps.workspaces.find(String(params.workspace));
    if (!runtime) throw new Error("O workspace não existe mais: nada foi feito.");
    return runtime;
  }

  private async doDeleteWorkspace(params: Frozen): Promise<string> {
    const id = String(params.workspace);
    const workspace = this.deps.workspaces.list().find((item) => item.id === id);
    if (!workspace) throw new Error("O workspace não existe mais: nada foi feito.");
    if (workspace.name !== params.name) throw new Error(`O workspace foi renomeado ("${String(params.name)}" agora é "${workspace.name}"): nada foi feito, peça de novo.`);
    await this.deps.workspaces.remove(id);
    return `Workspace "${workspace.name}" apagado (a pasta foi para a lixeira da plataforma).`;
  }

  private async doDeleteRoom(params: Frozen): Promise<string> {
    const runtime = this.frozenRuntime(params);
    const room = runtime.store.snapshot().rooms.find((item) => item.id === params.room);
    if (!room || room.name !== params.name) throw new Error(`A sala "${String(params.name)}" não existe mais ou mudou de nome: nada foi feito, peça de novo.`);
    await runtime.services.rooms.remove(room.id);
    return `Sala "${room.name}" apagada.`;
  }

  private async doDeleteTeam(params: Frozen): Promise<string> {
    const runtime = this.frozenRuntime(params);
    const team = runtime.store.snapshot().teams.find((item) => item.id === params.team);
    if (!team || team.name !== params.name) throw new Error(`O time "${String(params.name)}" não existe mais ou mudou de nome: nada foi feito, peça de novo.`);
    await runtime.services.teams.remove(team.id);
    return `Time "${team.name}" apagado.`;
  }

  private async doDeleteAgent(params: Frozen): Promise<string> {
    const runtime = this.frozenRuntime(params);
    const agent = runtime.store.snapshot().agents.find((item) => item.id === params.agent);
    if (!agent || agent.name !== params.name) throw new Error(`O agente "${String(params.name)}" não existe mais ou mudou de nome: nada foi feito, peça de novo.`);
    await runtime.services.agents.remove(agent.id);
    return `Agente "${agent.name}" apagado.`;
  }

  private async doAddConnector(params: Frozen): Promise<string> {
    const runtime = this.frozenRuntime(params);
    const connector = await runtime.connectors.create(createConnectorBodySchema.parse(params.body));
    return `Conector "${connector.name}" cadastrado (id: ${connector.id}; estado: ${connector.status.state}${connector.status.reason ? `, ${connector.status.reason}` : ""}). Nenhum agente o usa ainda.`;
  }

  private async doSetAgentConnectors(params: Frozen): Promise<string> {
    const runtime = this.frozenRuntime(params);
    const agent = runtime.store.snapshot().agents.find((item) => item.id === params.agent);
    if (!agent || agent.name !== params.name) throw new Error(`O agente "${String(params.name)}" não existe mais ou mudou de nome: nada foi feito, peça de novo.`);
    const frozen = params.connectors as { id: string; name: string }[];
    const current = runtime.connectors.list();
    for (const item of frozen) {
      const found = current.find((connector) => connector.id === item.id);
      if (!found || found.name !== item.name) throw new Error(`O conector "${item.name}" não existe mais ou mudou de nome: nada foi feito, peça de novo.`);
    }
    const now = await runtime.connectors.setAgentConnectors(agent.id, frozen.map((item) => item.id));
    return `${agent.name} agora usa: ${now.map((connector) => connector.name).join(", ") || "nenhum conector"}.`;
  }

  private async doSetAgentAccess(params: Frozen): Promise<string> {
    const runtime = this.frozenRuntime(params);
    const agent = runtime.store.snapshot().agents.find((item) => item.id === params.agent);
    if (!agent || agent.name !== params.name) throw new Error(`O agente "${String(params.name)}" não existe mais ou mudou de nome: nada foi feito, peça de novo.`);
    const change = Object.fromEntries((["internet", "browser", "terminal"] as const).flatMap((key) => (typeof params[key] === "boolean" ? [[key, params[key]]] : [])));
    const updated = await runtime.services.agents.update(agent.id, updateAgentBodySchema.parse(change));
    const effective = effectiveAccess(runtime.access(), updated);
    return `Acesso efetivo de ${updated.name}: internet ${onOff(effective.internet)}, navegador ${onOff(effective.browser)}, terminal ${onOff(effective.terminal)}.`;
  }

  private async doSetWorkspaceAccess(params: Frozen): Promise<string> {
    const id = String(params.workspace);
    const workspace = this.deps.workspaces.list().find((item) => item.id === id);
    if (!workspace) throw new Error("O workspace não existe mais: nada foi feito.");
    if (workspace.name !== params.name) throw new Error(`O workspace foi renomeado ("${String(params.name)}" agora é "${workspace.name}"): nada foi feito, peça de novo.`);
    const updated = await this.deps.workspaces.update(id, { access: params.change as never });
    const access = workspaceAccess(updated.access);
    return `Acesso do workspace ${updated.name}: internet ${onOff(access.internet)}, navegador ${onOff(access.browser)}, terminal ${onOff(access.terminal)}, rede local ${onOff(access.allowLocalNetwork)}.`;
  }

  private async doRunHostCommand(params: Frozen): Promise<string> {
    const command = String(params.command);
    const args = (params.args as string[] | undefined) ?? [];
    const result = await this.deps.hostCommands.run({ command, args, cwd: String(params.cwd), timeoutSec: Number(params.timeoutSec) || undefined, requestedBy: "cyno" });
    const head = result.timedOut ? `O comando passou do tempo limite e foi cortado (${Math.round(result.durationMs / 1000)} s).` : result.ok ? `Terminou com sucesso em ${result.durationMs} ms.` : `Terminou com erro (código ${result.exitCode ?? "?"}${result.signal ? `, sinal ${result.signal}` : ""}).`;
    const text = `${head}\n${result.output || "(sem saída)"}`;
    // Falha do comando não é falha da ação: o dono e o Cyno veem a saída; mas o status do cartão reflete.
    if (!result.ok) throw new HostCommandFailed(text);
    return text;
  }
}

/** O comando rodou e terminou com erro: o resultado (com a saída) vai ao cartão como "falhou". */
export class HostCommandFailed extends Error {}

export function describeFailure(error: unknown): string {
  if (error instanceof HttpError) return error.message;
  return errorMessage(error);
}
