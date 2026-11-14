import { findMaestroAgent, type OfficeState, type Workspace } from "@cyno/shared";
import { z } from "zod";
import type { WorkspaceRuntime } from "../../workspace/runtime";
import { defineTool, type McpTool, type McpToolResult } from "../protocol";
import { agentTools } from "../agent-tools";
import { manageTools } from "../manage-tools";
import { findByRef, structureTools } from "../structure-tools";

/**
 * Adaptador "com `workspace`": as ferramentas de estrutura do Maestro (criar sala/time/agente, modelo,
 * líder, editar, mover agente de time/sala, ligar/parar terminal) viram ferramentas do Cyno que recebem o
 * `workspace` (id ou nome) e executam no workspace certo, como se o Maestro dele as tivesse chamado.
 * Nenhuma lógica é copiada: a chamada real vai para a ferramenta do próprio Maestro do workspace.
 *
 * O Cyno age em nome do dono, então a confirmação de "motor real gasta assinatura" que o Maestro exige
 * (`user_confirmed`) entra sozinha nas ferramentas que a pedem. As ferramentas perigosas (apagar, acesso,
 * conectores) NÃO entram aqui: têm versão própria que só registra o pedido de OK (`structure-tools.ts`).
 */

export type ScopedHost = {
  workspaces: { list: () => Workspace[]; find: (id: string) => WorkspaceRuntime | undefined };
  /** Modo simulado (só testes): libera o motor "mock" nos schemas. */
  simulated: boolean;
};

/** Ferramentas do Maestro que o Cyno usa sem pedir OK (o nome vira o mesmo no Cyno, com `workspace`). */
const SCOPED = ["create_room", "create_team", "create_agent", "set_agent_model", "set_team_lead", "update_room", "update_team", "update_agent", "set_room_brain_sharing", "start_agent", "stop_agent"] as const;
/** Campos que o adaptador preenche sozinho (o Cyno nunca os vê). */
const AUTO_CONFIRMED = new Set<string>(["create_agent", "set_agent_model"]);

const EMPTY: OfficeState = { rooms: [], teams: [], agents: [], tasks: [] };
const workspaceField = z.string().trim().min(1).max(120).describe("Workspace id or name (see list_workspaces)");

/** Descrições próprias onde a do Maestro manda não escolher modelo ou pedir confirmação: o Cyno monta pacotes para o dono. */
const DESCRIPTIONS: Partial<Record<(typeof SCOPED)[number], string>> = {
  create_agent:
    'Creates an agent in a team of a workspace (by team id or name) right away, no approval needed. Default avatar: drawn from the name. Choose the engine/model from get_catalog and the owner\'s defaults: Claude agents use model "sonnet" and Antigravity agents (engine "gemini") use "gemini-3.8-flash-medium" unless the owner asked for another (opus etc.). Without `engine` it follows the workspace default for agents. Access (`internet`, `browser`, `terminal`) follows the workspace policy when omitted. Giving connectors or turning the terminal on is NOT done here: those need the owner\'s approval (set_agent_connectors, set_agent_access).',
  set_agent_model:
    'Changes the engine, model and/or effort of ONE agent or of ALL agents of a team in a workspace, right away, no approval needed. Defaults: Claude = sonnet, Antigravity (gemini) = gemini-3.8-flash-medium; haiku and opus exist for Claude. Applies from each agent\'s next task. The Maestro\'s own engine does not change here.',
};

/**
 * Ferramentas com `workspace`. As cópias dos schemas vêm de instâncias sem estado (só lemos `input` e
 * `description`); a chamada real resolve o runtime e usa a ferramenta do Maestro dele.
 */
export function scopedStructureTools(host: ScopedHost): { tools: McpTool[]; roomOptions: McpTool } {
  const stubState = { read: () => EMPTY };
  const stubServices = {} as never;
  const templates: McpTool[] = [
    ...structureTools({ state: stubState, services: stubServices, simulated: host.simulated }),
    ...manageTools({ state: stubState, services: stubServices, access: () => ({}) as never, connectors: {} as never, skills: {} as never, forYouTypes: {} as never }),
    ...agentTools({ state: stubState } as never),
  ];
  const byName = new Map(templates.map((tool) => [tool.name, tool]));

  const tools = SCOPED.map((name) => {
    const template = byName.get(name);
    if (!template) throw new Error(`A ferramenta ${name} do Maestro não existe mais: o adaptador do Cyno precisa ser atualizado.`);
    const hidden = AUTO_CONFIRMED.has(name) && "user_confirmed" in template.input.shape ? ({ user_confirmed: true } as const) : undefined;
    const input = (hidden ? template.input.omit(hidden) : template.input).extend({ workspace: workspaceField });
    return defineTool({
      name,
      description: `${DESCRIPTIONS[name] ?? template.description} (Cyno: pass \`workspace\`.)`,
      input,
      call: async (args): Promise<McpToolResult> => {
        const { workspace, ...rest } = args as Record<string, unknown> & { workspace: string };
        const found = findByRef(host.workspaces.list(), workspace);
        if (!found) return { text: `No workspace "${workspace}". Use list_workspaces.`, isError: true };
        const runtime = host.workspaces.find(found.id);
        if (!runtime) return { text: `Workspace "${found.name}" is not available.`, isError: true };
        const maestro = findMaestroAgent(runtime.store.snapshot());
        const real = maestro ? runtime.officeTools(maestro.id).find((tool) => tool.name === name) : undefined;
        if (!real) return { text: `The tool ${name} is not available in workspace "${found.name}".`, isError: true };
        try {
          return await real.call({ ...rest, ...(hidden ? { user_confirmed: true } : {}) });
        } catch (error) {
          return { text: error instanceof Error ? error.message : String(error), isError: true };
        }
      },
    });
  });
  return { tools, roomOptions: byName.get("list_room_options")! };
}

/** `get_team` com `workspace`: a lista de salas, times e agentes com ids, motor e estado (a ficha resumida fica em get_workspace_card). */
export function scopedGetTeam(host: ScopedHost): McpTool {
  return defineTool({
    name: "get_team",
    description: "Lists the rooms, teams and agents of ONE workspace with ids, focus, engine/model, status and pending tasks, plus its connectors. Read-only (use get_workspace_card for the short card).",
    input: z.object({ workspace: workspaceField }),
    call: async ({ workspace }): Promise<McpToolResult> => {
      const found = findByRef(host.workspaces.list(), workspace);
      const runtime = found ? host.workspaces.find(found.id) : undefined;
      const maestro = runtime ? findMaestroAgent(runtime.store.snapshot()) : undefined;
      const real = runtime && maestro ? runtime.officeTools(maestro.id).find((tool) => tool.name === "get_team") : undefined;
      if (!real) return { text: `No workspace "${workspace}". Use list_workspaces.`, isError: true };
      return await real.call({});
    },
  });
}
