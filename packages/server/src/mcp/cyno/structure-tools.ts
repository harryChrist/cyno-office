import { AGENT_EFFORTS, HOST_COMMAND_LIMITS, IMPLEMENTED_CLI_ENGINES, type ModelChoice, type Workspace } from "@cyno/shared";
import { z } from "zod";
import type { ProposalInput } from "../../platform/cyno/proposals";
import { isWindows } from "../../platform/os";
import { defineTool, type McpTool, type McpToolResult } from "../protocol";
import { ROOM_PURPOSE_INPUTS, ROOM_SIZE_INPUTS } from "../structure-tools";

/** O que as ferramentas de estrutura do Cyno pedem ao `CynoStructure` (cada uma lança `Error` com o motivo, em inglês). */
export type StructureHostDeps = {
  workspaceOf: (ref: string) => Workspace;
  findWorkspace: (ref: string) => Workspace | undefined;
  catalog: () => Promise<string>;
  createWorkspace: (input: { name: string; summary?: string; maestro?: ModelChoice }) => Promise<Workspace>;
  renameWorkspace: (ref: string, name: string) => Promise<Workspace>;
  setWorkspaceModels: (ref: string, models: { maestro?: ModelChoice; agents?: ModelChoice }) => Promise<Workspace>;
  propose: (input: ProposalInput & { replaces?: string }) => Promise<string>;
  /** As ferramentas perigosas: cada uma só REGISTRA o pedido de OK e devolve `PENDING_CONFIRMATION …`. */
  confirm: {
    deleteWorkspace: (input: { workspace: string; reason?: string }) => Promise<string>;
    deleteRoom: (input: { workspace: string; room: string; reason?: string }) => Promise<string>;
    deleteTeam: (input: { workspace: string; team: string; reason?: string }) => Promise<string>;
    deleteAgent: (input: { workspace: string; agent: string; reason?: string }) => Promise<string>;
    addConnector: (input: { workspace: string; name: string; kind: "http" | "stdio"; url?: string; command?: string; args?: string[]; reason?: string }) => Promise<string>;
    setAgentConnectors: (input: { workspace: string; agent: string; connectors: string[]; reason?: string }) => Promise<string>;
    setAgentAccess: (input: { workspace: string; agent: string; internet?: boolean; browser?: boolean; terminal?: boolean; reason?: string }) => Promise<string>;
    setWorkspaceAccess: (input: { workspace: string; internet?: boolean; browser?: boolean; terminal?: boolean; allowLocalNetwork?: boolean; allowedDomains?: string[]; blockedDomains?: string[]; reason?: string }) => Promise<string>;
    runHostCommand: (input: { command: string; args?: string[]; cwd?: string; timeoutSec?: number; reason?: string }) => Promise<string>;
  };
};

const TOOL_MAX_CHARS = 4000;
const ok = (text: string): McpToolResult => ({ text: text.length > TOOL_MAX_CHARS ? `${text.slice(0, TOOL_MAX_CHARS - 1)}…` : text });
const fail = (text: string): McpToolResult => ({ text, isError: true });

async function guarded(run: () => string | Promise<string>): Promise<McpToolResult> {
  try {
    return ok(await run());
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

const workspaceField = z.string().trim().min(1).max(120).describe("Workspace id or name (see list_workspaces)");
const reasonField = z.string().trim().max(600).optional().describe("Why, in Brazilian Portuguese: it is shown to the owner on the approval card as 'Cyno says'. Plain words, no technical ids.");
const choiceField = z.object({ engine: z.enum(IMPLEMENTED_CLI_ENGINES), model: z.string().trim().min(1).max(80).optional(), effort: z.enum(AGENT_EFFORTS).optional() });

const NEEDS_OK = "NEEDS THE OWNER'S OK: this tool does NOT do it. It registers an approval card in the chat (summary built by the server) and returns PENDING_CONFIRMATION. You get a message when the owner decides. Never say it was done before that message.";

const PURPOSES = Object.keys(ROOM_PURPOSE_INPUTS) as [keyof typeof ROOM_PURPOSE_INPUTS, ...(keyof typeof ROOM_PURPOSE_INPUTS)[]];
const SIZES = Object.keys(ROOM_SIZE_INPUTS) as [keyof typeof ROOM_SIZE_INPUTS, ...(keyof typeof ROOM_SIZE_INPUTS)[]];

/**
 * Ferramentas do Cyno que são só dele (não existem no Maestro): o catálogo, criar/renomear workspaces, a
 * proposta do pacote inteiro e as AÇÕES PERIGOSAS, que apenas registram o pedido de OK (duas fases: quem
 * executa é a rota do dono, depois do clique). Em inglês. As ferramentas de estrutura que o Maestro também
 * tem (criar sala/time/agente, modelos…) entram por `scopedStructureTools`.
 */
export function cynoStructureTools(deps: StructureHostDeps, options?: { platform?: NodeJS.Platform }): McpTool[] {
  const shellExample = isWindows(options?.platform)
    ? 'command "powershell" and args ["-Command", "..."]'
    : 'command "bash" and args ["-c", "..."]';
  return [
    defineTool({
      name: "get_catalog",
      description: "What exists to build a workspace with: the installed engines and their models (and the owner's defaults), the connectors already registered in any workspace and who uses them, and the room purposes/sizes. Read-only. Call it before propose_workspace.",
      input: z.object({}),
      call: () => guarded(() => deps.catalog()),
    }),
    defineTool({
      name: "create_workspace",
      description:
        "Creates a new EMPTY workspace (just its Maestro, no rooms or agents) right away, no approval needed. Use it only for a plain empty workspace; to build a whole package (rooms, team, agents, routines) use propose_workspace so the owner reviews it first. After it exists, add rooms/teams/agents with create_room, create_team, create_agent (pass workspace).",
      input: z.object({
        name: z.string().trim().min(1).max(40).describe("Workspace name, shown to the owner"),
        summary: z.string().trim().max(280).optional().describe("One sentence in Brazilian Portuguese: what this workspace does (shown on its card)"),
        maestro: choiceField.optional().describe("Engine/model of the workspace's Maestro. Omitted = the owner's default (Claude Sonnet)"),
      }),
      call: ({ name, summary, maestro }) =>
        guarded(async () => {
          const created = await deps.createWorkspace({ name, ...(summary ? { summary } : {}), ...(maestro ? { maestro: { engine: maestro.engine, ...(maestro.model ? { model: maestro.model } : {}), ...(maestro.effort ? { effort: maestro.effort } : {}) } } : {}) });
          return `Workspace "${created.name}" created (id: ${created.id}) with only its Maestro. Now add rooms, teams and agents with create_room / create_team / create_agent (workspace: "${created.id}").`;
        }),
    }),
    defineTool({
      name: "rename_workspace",
      description: "Renames a workspace (its id and folder do not change). No approval needed.",
      input: z.object({ workspace: workspaceField, name: z.string().trim().min(1).max(40) }),
      call: ({ workspace, name }) => guarded(async () => `Workspace renamed to "${(await deps.renameWorkspace(workspace, name)).name}".`),
    }),
    defineTool({
      name: "set_workspace_models",
      description: "Changes the workspace's default models: `maestro` (used for the Maestro of workspaces created after) and `agents` (the default for agents created later in it). It does not change agents that already exist (use set_agent_model for those). No approval needed.",
      input: z.object({ workspace: workspaceField, maestro: choiceField.optional(), agents: choiceField.optional() }),
      call: ({ workspace, maestro, agents }) =>
        guarded(async () => {
          if (!maestro && !agents) throw new Error("Nothing to change: pass maestro and/or agents.");
          const updated = await deps.setWorkspaceModels(workspace, { ...(maestro ? { maestro } : {}), ...(agents ? { agents } : {}) });
          return `Default models of "${updated.name}" updated.`;
        }),
    }),
    defineTool({
      name: "propose_workspace",
      description: [
        "Proposes a WHOLE workspace to the owner as a proposal card (nothing is created): rooms, teams, agents (with engine/model), connectors, sites that need a login and routines. The owner reviews it and presses \"Criar workspace\"; then the SERVER creates everything by code in one transaction (if something fails it is all undone) and you get a message with the result. This is the way to build any package: never create the pieces one by one for a new workspace the owner asked for.",
        "Call get_catalog first. The server validates before showing (installed engine, existing model, unique names, valid room purposes, known connectors, routine format) and returns every problem so you can fix and call again.",
        "Defaults: Claude agents use model sonnet; Antigravity agents (engine gemini) use gemini-3.8-flash-medium; use opus or others only if the owner asked. Mix engines only when it helps (e.g. the image/research agent on gemini).",
        "Each room has teams; each team has agents (the first agent leads the team). Agent `focus` = its instructions (how it works, style, limits), `role` = short job title, both in Brazilian Portuguese. `connectors` of an agent must be listed in the proposal's `connectors` (existing ones are copied into the new workspace; ones that do not exist yet are only listed with a warning: they need add_connector with the owner's OK afterwards).",
        "`sites`: domains the team will use that need the OWNER to log in (login is always manual); they become a pending-logins note in the new workspace. `routines`: recurring work, each with the SAME fields as the routine proposal tool (type \"goal\"|\"tracking\", title, owner = an agent or team NAME from this proposal, instruction, kind, site, goal:{target, period, preferred_days}, schedules:[{label, days, times, action, agent?}]; tracking needs tracking:{fields, statuses,…}); they are created as proposals waiting in the new workspace's \"Para você\" (nothing runs until the owner approves there).",
        "If the owner asks for changes, call it again with `replaces` = the previous proposal id (the old one is dropped). Ask the owner ONLY what is missing and cannot be decided by you.",
      ].join(" "),
      input: z.object({
        name: z.string().trim().min(1).max(40).describe("Workspace name"),
        summary: z.string().trim().max(280).optional().describe("One sentence in Brazilian Portuguese: what this workspace does"),
        maestro: choiceField.optional().describe("Engine/model of the Maestro (omitted = default Claude Sonnet)"),
        rooms: z
          .array(
            z.object({
              name: z.string().trim().min(1).max(40),
              purpose: z.enum(PURPOSES).optional().describe(`Room function: ${PURPOSES.join(", ")} (default general)`),
              size: z.enum(SIZES).optional().describe(`Initial floor: ${SIZES.join(", ")} (default auto)`),
              teams: z
                .array(
                  z.object({
                    name: z.string().trim().min(1).max(40),
                    focus: z.string().trim().min(1).max(120).describe("What the team works on (one short sentence, Brazilian Portuguese)"),
                    agents: z
                      .array(
                        z.object({
                          name: z.string().trim().min(1).max(24),
                          role: z.string().trim().max(60).optional().describe("Short job title, Brazilian Portuguese (e.g. Social media)"),
                          engine: z.enum(IMPLEMENTED_CLI_ENGINES).optional().describe("claude = Claude Code (default); gemini = Antigravity; freebuff, openclaw, hermes = the other installed engines (see get_catalog; Freebuff bills open hours, OpenClaw and Hermes run one process per turn)"),
                          model: z.string().trim().min(1).max(80).optional().describe("Omitted = sonnet (claude) / gemini-3.8-flash-medium (gemini)"),
                          effort: z.enum(AGENT_EFFORTS).optional(),
                          focus: z.string().trim().min(1).max(1500).describe("The agent's instructions: how it works, style, what it never does (Brazilian Portuguese)"),
                          connectors: z.array(z.string().trim().min(1).max(60)).max(10).optional().describe("Connector ids from the proposal's `connectors` this agent uses"),
                          access: z.object({ internet: z.boolean().optional(), browser: z.boolean().optional(), terminal: z.boolean().optional() }).optional().describe("false turns an access off for this agent; the workspace policy still caps it"),
                        }),
                      )
                      .min(1)
                      .max(12),
                  }),
                )
                .min(1)
                .max(6),
            }),
          )
          .min(1)
          .max(6),
        sites: z.array(z.object({ domain: z.string().trim().min(3).max(120), why: z.string().trim().max(300).optional() })).max(15).optional().describe("Sites that need the owner to log in"),
        connectors: z.array(z.object({ id: z.string().trim().min(1).max(60), why: z.string().trim().max(300).optional() })).max(10).optional().describe("Connectors the workspace uses (id or name; see get_catalog)"),
        routines: z.array(z.record(z.string(), z.unknown())).max(10).optional().describe("Routines (same fields as the routine proposal; owner = agent/team name of this proposal)"),
        notes: z.string().trim().max(1000).optional().describe("Anything the owner should know before approving (Brazilian Portuguese)"),
        replaces: z.string().trim().regex(/^P-\d{4,}$/).optional().describe("Id of the previous proposal this one replaces"),
      }),
      call: (input) => guarded(() => deps.propose(input as ProposalInput & { replaces?: string })),
    }),
    // ---------- Ações perigosas: só registram o pedido de OK ----------
    defineTool({
      name: "delete_workspace",
      description: `Asks the owner to DELETE a whole workspace (rooms, agents, tasks; the folder goes to the platform trash). ${NEEDS_OK}`,
      input: z.object({ workspace: workspaceField, reason: reasonField }),
      call: (input) => guarded(() => deps.confirm.deleteWorkspace(input)),
    }),
    defineTool({
      name: "delete_room",
      description: `Asks the owner to delete a room of a workspace WITH its teams, agents and tasks. ${NEEDS_OK}`,
      input: z.object({ workspace: workspaceField, room: z.string().trim().min(1).max(64).describe("Room id or name"), reason: reasonField }),
      call: (input) => guarded(() => deps.confirm.deleteRoom(input)),
    }),
    defineTool({
      name: "delete_team",
      description: `Asks the owner to delete a team and its agents. ${NEEDS_OK}`,
      input: z.object({ workspace: workspaceField, team: z.string().trim().min(1).max(64).describe("Team id or name"), reason: reasonField }),
      call: (input) => guarded(() => deps.confirm.deleteTeam(input)),
    }),
    defineTool({
      name: "delete_agent",
      description: `Asks the owner to delete an agent. ${NEEDS_OK}`,
      input: z.object({ workspace: workspaceField, agent: z.string().trim().min(1).max(64).describe("Agent id or name"), reason: reasonField }),
      call: (input) => guarded(() => deps.confirm.deleteAgent(input)),
    }),
    defineTool({
      name: "add_connector",
      description: `Asks the owner to register a NEW connector (an external MCP server) in a workspace, by URL (kind http) or by a command to run on this machine (kind stdio). It is created with no agent; giving it to agents is another approval (set_agent_connectors). Secrets (API keys, tokens) never go through you: tell the owner to add them in the workspace's connectors screen. ${NEEDS_OK}`,
      input: z.object({
        workspace: workspaceField,
        name: z.string().trim().min(1).max(60).describe("Connector name, shown to the owner"),
        kind: z.enum(["http", "stdio"]),
        url: z.string().trim().max(2000).optional().describe("http: the MCP server URL (Streamable HTTP)"),
        command: z.string().trim().max(300).optional().describe("stdio: the executable (no shell)"),
        args: z.array(z.string().max(500)).max(30).optional().describe("stdio: the arguments"),
        reason: reasonField,
      }),
      call: (input) => guarded(() => deps.confirm.addConnector(input)),
    }),
    defineTool({
      name: "set_agent_connectors",
      description: `Asks the owner to set which connectors of the workspace ONE agent uses: the COMPLETE list (by id or name; [] = none). ${NEEDS_OK}`,
      input: z.object({ workspace: workspaceField, agent: z.string().trim().min(1).max(64), connectors: z.array(z.string().trim().min(1).max(80)).max(50), reason: reasonField }),
      call: (input) => guarded(() => deps.confirm.setAgentConnectors(input)),
    }),
    defineTool({
      name: "set_agent_access",
      description: `Asks the owner to turn internet, the shared browser and/or the terminal on or off for ONE agent (never more than the workspace policy allows). ${NEEDS_OK}`,
      input: z.object({ workspace: workspaceField, agent: z.string().trim().min(1).max(64), internet: z.boolean().optional(), browser: z.boolean().optional(), terminal: z.boolean().optional(), reason: reasonField }),
      call: (input) => guarded(() => deps.confirm.setAgentAccess(input)),
    }),
    defineTool({
      name: "set_workspace_access",
      description: `Asks the owner to change the access POLICY of a workspace (internet, browser, terminal, local network, allowed/blocked domains), which caps every agent in it. Pass only what changes. ${NEEDS_OK}`,
      input: z.object({
        workspace: workspaceField,
        internet: z.boolean().optional(),
        browser: z.boolean().optional(),
        terminal: z.boolean().optional(),
        allow_local_network: z.boolean().optional().describe("true lets the browser/page reading open local-network addresses"),
        allowed_domains: z.array(z.string().trim().min(1).max(253)).max(100).optional().describe("Complete list; empty = all domains allowed"),
        blocked_domains: z.array(z.string().trim().min(1).max(253)).max(100).optional(),
        reason: reasonField,
      }),
      call: ({ allow_local_network, allowed_domains, blocked_domains, ...rest }) =>
        guarded(() => deps.confirm.setWorkspaceAccess({ ...rest, ...(allow_local_network !== undefined ? { allowLocalNetwork: allow_local_network } : {}), ...(allowed_domains ? { allowedDomains: allowed_domains } : {}), ...(blocked_domains ? { blockedDomains: blocked_domains } : {}) })),
    }),
    defineTool({
      name: "run_host_command",
      description: `The ONLY way for you to run something on the owner's machine (you have no shell). Give the program and its arguments separately: it runs directly with no shell (pipes, &&, redirects, globs and ~ do not work; to use them pass ${shellExample}, which the owner will see exactly). It runs in the platform work folder by default (or the absolute \`cwd\` you pass, shown on the card), with a time limit (default ${HOST_COMMAND_LIMITS.timeoutDefaultSec}s, max ${HOST_COMMAND_LIMITS.timeoutMaxSec}s) and the output cut at ${HOST_COMMAND_LIMITS.outputChars} characters. NEVER with sudo or any privilege elevation: it is refused; show the exact command to the owner in a code block so they run it themselves. ${NEEDS_OK} When the owner approves, the result (output) arrives as a message: show the useful part to the owner.`,
      input: z.object({
        command: z.string().trim().min(1).max(300).describe('The program, e.g. "ls" or "git"'),
        args: z.array(z.string().max(HOST_COMMAND_LIMITS.argLength)).max(HOST_COMMAND_LIMITS.args).optional().describe("The arguments, one per item"),
        cwd: z.string().trim().max(500).optional().describe("Absolute folder to run in. Omitted = the platform work folder"),
        timeout_seconds: z.number().int().min(1).max(HOST_COMMAND_LIMITS.timeoutMaxSec).optional(),
        reason: reasonField,
      }),
      call: ({ command, args, cwd, timeout_seconds, reason }) => guarded(() => deps.confirm.runHostCommand({ command, ...(args ? { args } : {}), ...(cwd ? { cwd } : {}), ...(timeout_seconds ? { timeoutSec: timeout_seconds } : {}), ...(reason ? { reason } : {}) })),
    }),
  ];
}
