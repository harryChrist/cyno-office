import { findMaestroAgent, type OfficeState, type Workspace } from "@cyno/shared";
import { z } from "zod";
import type { WorkspaceRuntime } from "../../workspace/runtime";
import { defineTool, toolInputSchema, type McpTool, type McpToolResult } from "../protocol";
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

// ---------- A ponte para TODAS as ferramentas do Maestro de um workspace ----------

/**
 * Ferramentas do Maestro que a ponte NÃO oferece ao Cyno: as que ele já tem como ferramenta direta (acima, ou
 * com versão própria na plataforma) e as que só existem para a conversa Maestro ↔ Cyno ↔ dono. O resto do que
 * o Maestro faz (Cérebro, mídia, projetos, tarefas, rotinas, quadros, eventos, scripts, navegador…) passa por aqui.
 */
const BRIDGE_EXCLUDED = new Set<string>([
  ...SCOPED,
  "get_team",
  "list_room_options",
  "ask_cyno",
  "request_help",
  "ask_user",
  "delete_room",
  "delete_team",
  "delete_agent",
  "set_agent_access",
  "set_agent_connectors",
  "agenda_book",
  "agenda_cancel",
  "agenda_free_slots",
  "agenda_list",
  "agenda_move",
  "mural_list",
  "mural_share",
  "mural_unshare",
  "mural_use",
  "get_usage",
  "get_metrics",
  "get_report",
  "get_today",
  "get_day_stats",
  "set_workspace_summary",
  "message_agent",
  "cancel_request",
]);

const BRIDGE_LIST_MAX_CHARS = 9000;
const BRIDGE_RESULT_MAX_CHARS = 12000;

/** Primeira frase da descrição (para a lista curta). */
function firstSentence(text: string, max = 150): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const end = flat.search(/[.!?](\s|$)/);
  const sentence = end > 0 ? flat.slice(0, end + 1) : flat;
  return sentence.length > max ? `${sentence.slice(0, max - 1)}…` : sentence;
}

type Bridge = { workspace: Workspace; tools: McpTool[] };

function bridgeOf(host: ScopedHost, ref: string): Bridge | { error: string } {
  const found = findByRef(host.workspaces.list(), ref);
  if (!found) return { error: `No workspace "${ref}". Use list_workspaces.` };
  const runtime = host.workspaces.find(found.id);
  if (!runtime) return { error: `Workspace "${found.name}" is not available.` };
  const maestro = findMaestroAgent(runtime.store.snapshot());
  if (!maestro) return { error: `Workspace "${found.name}" has no Maestro.` };
  return { workspace: found, tools: runtime.officeTools(maestro.id).filter((tool) => tool.listed !== false && !BRIDGE_EXCLUDED.has(tool.name)) };
}

/**
 * `workspace_tools` e `use_workspace_tool`: dão ao Cyno tudo o que o Maestro de um workspace faz, sem copiar os
 * schemas (a lista e os schemas vêm do Maestro real, então o que for criado depois já vale). O Cyno age em nome
 * do dono: a confirmação "user_confirmed" que algumas ferramentas do Maestro pedem entra sozinha.
 */
export function maestroToolBridge(host: ScopedHost): McpTool[] {
  const help = defineTool({
    name: "workspace_tools",
    description:
      "Everything the Maestro of ONE workspace can do (notes of the Brain, media library, projects, tasks, sprints, routines, boards, events, scripts, browser, plans and more) is reachable through this pair: workspace_tools to look, use_workspace_tool to do. Without `tool` it lists the tools (name and one line; `query` filters by word). With `tool` it shows that tool's full description and its JSON input schema, which you need before the first use_workspace_tool call of it.",
    input: z.object({
      workspace: workspaceField,
      tool: z.string().trim().min(1).max(80).optional().describe("Tool name: shows its full description and input schema"),
      query: z.string().trim().min(1).max(60).optional().describe("Only the tools whose name or description has this word"),
    }),
    call: ({ workspace, tool, query }): McpToolResult => {
      const bridge = bridgeOf(host, workspace);
      if ("error" in bridge) return { text: bridge.error, isError: true };
      if (tool) {
        const found = bridge.tools.find((candidate) => candidate.name === tool);
        if (!found) return { text: `No tool "${tool}" for workspace "${bridge.workspace.name}". Call workspace_tools without \`tool\` to list them.`, isError: true };
        return { text: `${found.name}\n${found.description}\n\nInput schema:\n${JSON.stringify(found.jsonSchema ?? toolInputSchema(found.input))}` };
      }
      const needle = query?.toLowerCase();
      const lines = bridge.tools
        .filter((candidate) => !needle || candidate.name.toLowerCase().includes(needle) || candidate.description.toLowerCase().includes(needle))
        .map((candidate) => `- ${candidate.name}: ${firstSentence(candidate.description)}`);
      const text = lines.length > 0 ? `Tools of workspace "${bridge.workspace.name}" (${lines.length}):\n${lines.join("\n")}` : `No tools${query ? ` matching "${query}"` : ""} for workspace "${bridge.workspace.name}".`;
      return { text: text.length > BRIDGE_LIST_MAX_CHARS ? `${text.slice(0, BRIDGE_LIST_MAX_CHARS - 1)}…` : text };
    },
  });

  const use = defineTool({
    name: "use_workspace_tool",
    description:
      "Runs ONE tool of the Maestro of a workspace, as that Maestro would (see workspace_tools for the names and each input schema). Pass the tool's arguments in `args`. Use it for what the owner asked; anything beyond what they asked, ask them in the chat first.",
    input: z.object({
      workspace: workspaceField,
      tool: z.string().trim().min(1).max(80).describe("Tool name from workspace_tools"),
      args: z.record(z.string(), z.unknown()).optional().describe("The tool's arguments, exactly as its input schema says"),
    }),
    call: async ({ workspace, tool, args }): Promise<McpToolResult> => {
      const bridge = bridgeOf(host, workspace);
      if ("error" in bridge) return { text: bridge.error, isError: true };
      const real = bridge.tools.find((candidate) => candidate.name === tool);
      if (!real) return { text: `No tool "${tool}" for workspace "${bridge.workspace.name}". Call workspace_tools to list them (some Maestro tools already exist directly in your own list).`, isError: true };
      const given = { ...(args ?? {}) };
      if ("user_confirmed" in real.input.shape && given.user_confirmed === undefined) given.user_confirmed = true;
      const parsed = real.input.safeParse(given);
      if (!parsed.success) {
        const problems = parsed.error.issues.map((issue) => `${issue.path.join(".") || "(args)"}: ${issue.message}`).join("; ");
        return { text: `Invalid arguments for ${tool}: ${problems}. See workspace_tools(tool: "${tool}") for the schema.`, isError: true };
      }
      try {
        const result = await real.call(parsed.data);
        return result.text.length > BRIDGE_RESULT_MAX_CHARS ? { ...result, text: `${result.text.slice(0, BRIDGE_RESULT_MAX_CHARS - 1)}…` } : result;
      } catch (error) {
        return { text: error instanceof Error ? error.message : String(error), isError: true };
      }
    },
  });

  return [help, use];
}
