import {
  effectiveAccess,
  isMaestroAgent,
  isMaestroRoom,
  isActiveTaskStatus,
  maestroTeamIds,
  ROOM_PURPOSE_SPECS,
  ROOM_THEME_IDS,
  THEME_LABELS,
  updateAgentBodySchema,
  updateBrainSharingBodySchema,
  updateRoomBodySchema,
  updateTeamBodySchema,
  type Agent,
  type OfficeState,
  type Room,
  type RoomThemeId,
  type WorkspaceAccess,
} from "@cyno/shared";
import { z } from "zod";
import type { ConnectorsService } from "../library/connectors/service";
import type { SkillsService } from "../library/skills/service";
import type { ForYouTypesService } from "../workspace/for-you/types-service";
import type { Services } from "../workspace/office";
import { defineTool, type McpTool, type McpToolResult } from "./protocol";
import { describeAccess, describeRoomSize, findByRef, ROOM_PURPOSE_INPUTS, ROOM_SIZE_INPUTS, roomPurposeInput, roomSizeInput } from "./structure-tools";

/**
 * Ferramentas de gestão do Maestro (além de criar): editar e remover salas, times e agentes,
 * compartilhamento do Cérebro, acesso e conectores de um agente e excluir tipos de aprovação. Tudo
 * pelos mesmos serviços das rotas (os eventos saem iguais e o escritório atualiza ao vivo).
 * Remover, mexer no acesso ou nos conectores só com `user_confirmed: true` (o usuário pediu). A
 * política de acesso do WORKSPACE não muda por aqui: só o usuário, nas Configurações.
 */

export type ManageToolsDeps = {
  state: { read(): OfficeState };
  services: {
    rooms: Pick<Services["rooms"], "update" | "remove" | "deletionPreview" | "setBrainSharing">;
    teams: Pick<Services["teams"], "update" | "remove">;
    agents: Pick<Services["agents"], "update" | "remove">;
  };
  /** Política de acesso do workspace (com os padrões). */
  access: () => WorkspaceAccess;
  connectors: Pick<ConnectorsService, "list" | "setAgentConnectors">;
  skills: Pick<SkillsService, "list" | "setAgentSkills" | "warnings">;
  forYouTypes: Pick<ForYouTypesService, "list" | "remove">;
  /**
   * O Maestro respondeu a um pedido de ajuda (`request_help`) sem usar `message_agent`: liberou um acesso, conector ou skill.
   * Solta a espera do agente na hora e entrega o texto a ele como nota (só se ele estiver esperando).
   */
  helpAnswered?: (agentId: string, text: string) => void;
};

const error = (text: string): McpToolResult => ({ text, isError: true });
const ok = (text: string): McpToolResult => ({ text });

type PurposeInput = keyof typeof ROOM_PURPOSE_INPUTS;
type SizeInput = keyof typeof ROOM_SIZE_INPUTS;
const PURPOSES = Object.keys(ROOM_PURPOSE_INPUTS) as [PurposeInput, ...PurposeInput[]];
const SIZES = Object.keys(ROOM_SIZE_INPUTS) as [SizeInput, ...SizeInput[]];

const ref = (what: string) => z.string().trim().min(1).max(64).describe(`${what} id (or name)`);
/** Remoção: sem `true` a ferramenta só mostra o que sairia. */
const deleteConfirm = z
  .boolean()
  .optional()
  .describe("true ONLY when the user explicitly asked to delete it (and saw what goes with it). Without it, nothing is deleted: you get the preview to show the user.");
/** Acesso e conectores: sempre true (só se chama quando o usuário pediu). */
const userConfirmed = z.literal(true).describe("Always true: only call it when the user explicitly asked for this change");

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** Acha o agente (id ou nome) ou devolve o erro pronto. */
function findAgent(state: OfficeState, agentRef: string): Agent | McpToolResult {
  return findByRef(state.agents, agentRef) ?? error(`Agent "${agentRef}" not found. See the ids with get_team.`);
}
const isResult = (value: Agent | McpToolResult): value is McpToolResult => "isError" in value;

export function manageTools(deps: ManageToolsDeps): McpTool[] {
  return [...structureEditTools(deps), ...accessTools(deps), deleteApprovalTypeTool(deps)];
}

function structureEditTools(deps: ManageToolsDeps): McpTool[] {
  return [
    defineTool({
      name: "update_room",
      description: "Renames a room or changes its purpose (furniture), size (initial floor) or theme (colors). Only the fields you pass change. See list_room_options.",
      input: z.object({
        room: ref("Room"),
        name: z.string().trim().min(1).max(40).optional().describe("New name, shown to the user"),
        purpose: z.enum(PURPOSES).optional().describe(`New function: ${PURPOSES.join(", ")}`),
        size: z.enum(SIZES).optional().describe(`New initial floor: ${SIZES.join(", ")} (the room still grows if needed)`),
        theme: z.enum(ROOM_THEME_IDS).optional().describe(`New colors: ${ROOM_THEME_IDS.join(", ")}`),
      }),
      call: async ({ room: roomRef, name, purpose, size, theme }) => {
        const room = findByRef(deps.state.read().rooms, roomRef);
        if (!room) return error(`Room "${roomRef}" not found. See the ids with get_team.`);
        if (name === undefined && purpose === undefined && size === undefined && theme === undefined) return error("Nothing to change: pass name, purpose, size and/or theme.");
        if (isMaestroRoom(room) && (purpose !== undefined || size !== undefined)) return error("The Maestro's room has a fixed layout: only its name and theme change.");
        const body = updateRoomBodySchema.parse({
          ...(name !== undefined ? { name } : {}),
          ...(purpose !== undefined ? { purpose: ROOM_PURPOSE_INPUTS[purpose].id } : {}),
          ...(size !== undefined ? { size: ROOM_SIZE_INPUTS[size] } : {}),
          ...(theme !== undefined ? { theme } : {}),
        });
        const updated = await deps.services.rooms.update(room.id, body);
        const purposeId = updated.purpose ?? "geral";
        return ok(
          `Room ${updated.name} (id: ${updated.id}) updated — purpose ${roomPurposeInput(purposeId)} (${ROOM_PURPOSE_SPECS[purposeId].label}), size ${roomSizeInput(updated.size ?? "auto")} (${describeRoomSize(updated.size ?? "auto")}), theme ${THEME_LABELS[updated.theme as RoomThemeId] ?? updated.theme}. The id does not change.`,
        );
      },
    }),
    defineTool({
      name: "update_team",
      description: "Renames a team, changes its focus (what triage reads) or moves it to another room (only when it has no task in progress). Only the fields you pass change.",
      input: z.object({
        team: ref("Team"),
        name: z.string().trim().min(1).max(40).optional().describe("New name"),
        focus: z.string().trim().min(1).max(120).optional().describe("New focus (one short sentence in Brazilian Portuguese)"),
        room: z.string().trim().min(1).max(64).optional().describe("Room id (or name) to move the team to"),
      }),
      call: async ({ team: teamRef, name, focus, room: roomRef }) => {
        const state = deps.state.read();
        const team = findByRef(state.teams, teamRef);
        if (!team) return error(`Team "${teamRef}" not found. See the ids with get_team.`);
        if (name === undefined && focus === undefined && roomRef === undefined) return error("Nothing to change: pass name, focus and/or room.");
        if (maestroTeamIds(state).has(team.id)) return error("The Maestro's own team (Gerência) does not change here.");
        let roomId: string | undefined;
        if (roomRef !== undefined) {
          const room = findByRef(state.rooms, roomRef);
          if (!room) return error(`Room "${roomRef}" not found. See the ids with get_team.`);
          if (isMaestroRoom(room)) return error("The Maestro's room does not take teams.");
          if (room.id !== team.roomId && state.tasks.some((task) => task.teamId === team.id && isActiveTaskStatus(task.status))) {
            return error(`Team ${team.name} has tasks in progress: it can only change rooms after they finish.`);
          }
          roomId = room.id;
        }
        const body = updateTeamBodySchema.parse({ ...(name !== undefined ? { name } : {}), ...(focus !== undefined ? { focus } : {}), ...(roomId !== undefined ? { roomId } : {}) });
        const updated = await deps.services.teams.update(team.id, body);
        const room = deps.state.read().rooms.find((candidate) => candidate.id === updated.roomId);
        return ok(`Team ${updated.name} (id: ${updated.id}) updated — focus: ${updated.focus}; room: ${room?.name ?? updated.roomId}. The id does not change.`);
      },
    }),
    defineTool({
      name: "update_agent",
      description: [
        "Renames an agent, changes their role or instructions, or moves them to another team (only with no task in progress; they stop leading the old team).",
        "The id never changes (delegations and history keep working). Instructions apply from the agent's next task.",
        "Engine/model/effort: use set_agent_model; access: set_agent_access.",
      ].join(" "),
      input: z.object({
        agent: ref("Agent"),
        name: z.string().trim().min(1).max(24).optional().describe("New name"),
        role: z.string().trim().min(1).max(60).optional().describe("New role, in Brazilian Portuguese"),
        instructions: z.string().trim().max(2000).optional().describe("New instructions (replaces the old ones entirely)"),
        team: z.string().trim().min(1).max(64).optional().describe("Team id (or name) to move the agent to"),
      }),
      call: async ({ agent: agentRef, name, role, instructions, team: teamRef }) => {
        const state = deps.state.read();
        const agent = findAgent(state, agentRef);
        if (isResult(agent)) return agent;
        if (name === undefined && role === undefined && instructions === undefined && teamRef === undefined) return error("Nothing to change: pass name, role, instructions and/or team.");
        if (isMaestroAgent(state, agent) && (role !== undefined || instructions !== undefined || teamRef !== undefined)) {
          return error("Your own role, instructions and team do not change here (the user edits them in your panel). Only your name can change.");
        }
        let teamId: string | undefined;
        if (teamRef !== undefined) {
          const team = findByRef(state.teams, teamRef);
          if (!team) return error(`Team "${teamRef}" not found. See the ids with get_team.`);
          if (maestroTeamIds(state).has(team.id)) return error("The Maestro's room has only the Maestro.");
          if (team.id !== agent.teamId && state.tasks.some((task) => task.agentId === agent.id && isActiveTaskStatus(task.status))) {
            return error(`${agent.name} has tasks in progress: they can only change teams after they finish.`);
          }
          teamId = team.id;
        }
        const body = updateAgentBodySchema.parse({
          ...(name !== undefined ? { name } : {}),
          ...(role !== undefined ? { role } : {}),
          ...(instructions !== undefined ? { instructions } : {}),
          ...(teamId !== undefined ? { teamId } : {}),
        });
        const updated = await deps.services.agents.update(agent.id, body);
        const team = deps.state.read().teams.find((candidate) => candidate.id === updated.teamId);
        const renamed = name !== undefined && agent.name !== updated.name ? ` (was ${agent.name})` : "";
        return ok(`Agent ${updated.name}${renamed} (id: ${updated.id}, unchanged) — ${updated.role} in team ${team?.name ?? updated.teamId}.`);
      },
    }),
    defineTool({
      name: "set_room_brain_sharing",
      description:
        "Decides which Brains a room's agents can read besides their own: the global Brain (reads_global) and/or other rooms (reads_rooms: the COMPLETE list; [] = none). It is one-way (room A reading B does not let B read A).",
      input: z.object({
        room: ref("Room"),
        reads_global: z.boolean().optional().describe("true = the room's agents read the global Brain"),
        reads_rooms: z.array(z.string().trim().min(1).max(64)).max(50).optional().describe("Room ids (or names) whose Brains this room reads (replaces the list)"),
      }),
      call: async ({ room: roomRef, reads_global, reads_rooms }) => {
        const state = deps.state.read();
        const room = findByRef(state.rooms, roomRef);
        if (!room) return error(`Room "${roomRef}" not found. See the ids with get_team.`);
        if (reads_global === undefined && reads_rooms === undefined) return error("Nothing to change: pass reads_global and/or reads_rooms.");
        let readsBrainsOf: string[] | undefined;
        if (reads_rooms) {
          readsBrainsOf = [];
          for (const peerRef of reads_rooms) {
            const peer = findByRef(state.rooms, peerRef);
            if (!peer) return error(`Room "${peerRef}" not found. See the ids with get_team.`);
            if (peer.id === room.id) return error("A room always reads its own Brain: do not list it.");
            readsBrainsOf.push(peer.id);
          }
        }
        const body = updateBrainSharingBodySchema.parse({ ...(reads_global !== undefined ? { readsGlobalBrain: reads_global } : {}), ...(readsBrainsOf ? { readsBrainsOf } : {}) });
        const updated = await deps.services.rooms.setBrainSharing(room.id, body);
        return ok(`Room ${updated.name} now reads: ${describeReads(deps.state.read().rooms, updated)}.`);
      },
    }),
    defineTool({
      name: "delete_room",
      description: [
        "Deletes a team room WITH everything in it: teams, agents, their tasks (active ones are cancelled), the room's Brain notes, its Para você items and calendar events. Cannot be undone.",
        "Only when the user explicitly asked. Call first without user_confirmed to get what would be deleted, tell the user, and call again with user_confirmed: true once they confirm.",
      ].join(" "),
      input: z.object({ room: ref("Room"), user_confirmed: deleteConfirm }),
      call: async ({ room: roomRef, user_confirmed }) => {
        const room = findByRef(deps.state.read().rooms, roomRef);
        if (!room) return error(`Room "${roomRef}" not found. See the ids with get_team.`);
        if (isMaestroRoom(room)) return error("The Maestro's room cannot be deleted.");
        const preview = await deps.services.rooms.deletionPreview(room.id);
        const what = [
          plural(preview.teams, "team", "teams"),
          plural(preview.agents, "agent", "agents"),
          `${plural(preview.tasks, "task", "tasks")} (${preview.activeTasks === 0 ? "none of them active" : `${preview.activeTasks} still active: those will be cancelled`})`,
          plural(preview.brainNotes, "Brain note", "Brain notes"),
          plural(preview.forYouItems, "Para você item", "Para você items"),
          plural(preview.calendarEvents, "calendar event", "calendar events"),
        ].join(", ");
        if (user_confirmed !== true) return error(`Nothing deleted. Deleting room ${room.name} (${room.id}) removes for good: ${what}. Tell the user and, if they confirm, call again with user_confirmed: true.`);
        await deps.services.rooms.remove(room.id);
        return ok(`Room ${room.name} deleted, with ${what}.`);
      },
    }),
    defineTool({
      name: "delete_team",
      description: [
        "Deletes a team and its agents (their active tasks are cancelled; the task history stays). Cannot be undone.",
        "Only when the user explicitly asked. Call first without user_confirmed to get what would be deleted, tell the user, and call again with user_confirmed: true once they confirm.",
      ].join(" "),
      input: z.object({ team: ref("Team"), user_confirmed: deleteConfirm }),
      call: async ({ team: teamRef, user_confirmed }) => {
        const state = deps.state.read();
        const team = findByRef(state.teams, teamRef);
        if (!team) return error(`Team "${teamRef}" not found. See the ids with get_team.`);
        if (maestroTeamIds(state).has(team.id)) return error("The Maestro's team (Gerência) cannot be deleted.");
        const agents = state.agents.filter((agent) => agent.teamId === team.id);
        const active = state.tasks.filter((task) => task.teamId === team.id && isActiveTaskStatus(task.status)).length;
        const names = agents.map((agent) => agent.name).join(", ");
        const what = `${plural(agents.length, "agent", "agents")}${names ? ` (${names})` : ""} and ${active === 0 ? "no active tasks" : `${plural(active, "active task", "active tasks")}, which will be cancelled`}`;
        if (user_confirmed !== true) return error(`Nothing deleted. Deleting team ${team.name} (${team.id}) also removes ${what}. Tell the user and, if they confirm, call again with user_confirmed: true.`);
        await deps.services.teams.remove(team.id);
        return ok(`Team ${team.name} deleted, with ${what.replace(", which will be cancelled", " (cancelled)")}.`);
      },
    }),
    defineTool({
      name: "delete_agent",
      description: [
        "Deletes an agent (their active tasks are cancelled and their pending Para você items go away; the task history stays). Cannot be undone.",
        "Only when the user explicitly asked. Call first without user_confirmed to get what would be deleted, tell the user, and call again with user_confirmed: true once they confirm.",
      ].join(" "),
      input: z.object({ agent: ref("Agent"), user_confirmed: deleteConfirm }),
      call: async ({ agent: agentRef, user_confirmed }) => {
        const state = deps.state.read();
        const agent = findAgent(state, agentRef);
        if (isResult(agent)) return agent;
        if (isMaestroAgent(state, agent)) return error("You (the Maestro) cannot be deleted.");
        const active = state.tasks.filter((task) => task.agentId === agent.id && isActiveTaskStatus(task.status)).length;
        const what = active === 0 ? "no active tasks to cancel" : `${plural(active, "active task", "active tasks")} (they will be cancelled)`;
        if (user_confirmed !== true) return error(`Nothing deleted. Deleting ${agent.name} (${agent.id}, ${agent.role}) removes the agent with ${what}. Tell the user and, if they confirm, call again with user_confirmed: true.`);
        await deps.services.agents.remove(agent.id);
        return ok(`Agent ${agent.name} deleted (${active === 0 ? "no active tasks were running" : `${plural(active, "active task", "active tasks")} cancelled`}).`);
      },
    }),
  ];
}

/** "global Brain, Estúdio (estudio)" ou "only its own Brain". */
function describeReads(rooms: readonly Room[], room: Room): string {
  const peers = room.readsBrainsOf.map((id) => {
    const peer = rooms.find((candidate) => candidate.id === id);
    return peer ? `${peer.name} (${peer.id})` : id;
  });
  const all = [...(room.readsGlobalBrain ? ["the global Brain"] : []), ...peers];
  return all.length > 0 ? `its own Brain + ${all.join(", ")}` : "only its own Brain";
}

function accessTools(deps: ManageToolsDeps): McpTool[] {
  return [
    defineTool({
      name: "set_agent_access",
      description: [
        "Turns internet (web search/page reading), the shared browser and/or the terminal on or off for ONE agent. Only when the user explicitly asked.",
        "An agent never gets more than the workspace policy allows: true only means 'follow the workspace'. The workspace policy itself is not changed here (the user changes it in Configurações › Acesso dos agentes). Applies when the agent is free (its terminal restarts).",
      ].join(" "),
      input: z.object({
        agent: ref("Agent"),
        internet: z.boolean().optional().describe("false = no web for this agent; true = follow the workspace"),
        browser: z.boolean().optional().describe("false = no shared browser; true = follow the workspace (needs internet)"),
        terminal: z.boolean().optional().describe("false = no terminal; true = follow the workspace (off by default there)"),
        user_confirmed: userConfirmed,
      }),
      call: async ({ agent: agentRef, internet, browser, terminal }) => {
        const agent = findAgent(deps.state.read(), agentRef);
        if (isResult(agent)) return agent;
        if (internet === undefined && browser === undefined && terminal === undefined) return error("Nothing to change: pass internet, browser and/or terminal.");
        const updated = await deps.services.agents.update(
          agent.id,
          updateAgentBodySchema.parse({ ...(internet !== undefined ? { internet } : {}), ...(browser !== undefined ? { browser } : {}), ...(terminal !== undefined ? { terminal } : {}) }),
        );
        const policy = deps.access();
        const effective = effectiveAccess(policy, updated);
        const asked = { internet, browser, terminal };
        const capped = (["internet", "browser", "terminal"] as const).filter((key) => asked[key] === true && !effective[key]);
        const note = capped.length > 0 ? ` Still off: ${capped.join(", ")} — the workspace policy does not allow it; only the user can change that in Configurações › Acesso dos agentes.` : "";
        const allowed = describeAccess(effectiveAccess(policy, {}));
        deps.helpAnswered?.(updated.id, `(Mensagem do Maestro, não do usuário) Respondi ao seu pedido de acesso: o seu acesso agora é ${describeAccess(effective)}.${capped.length > 0 ? ` Continua desligado: ${capped.join(", ")} (a política do workspace não permite; só o usuário muda).` : ""} A mudança vale a partir da próxima tarefa (o terminal reinicia quando você está livre). Não espere mais: termine esta tarefa com \`submit_result\`, dizendo o que conseguiu sem esse acesso e o que faltou.`);
        return ok(`${updated.name}'s effective access is now: ${describeAccess(effective)}. The workspace policy allows: ${allowed}; an agent can have at most that, and its own switch can only turn things off.${note}`);
      },
    }),
    defineTool({
      name: "set_agent_connectors",
      description:
        "Sets which of the workspace's connectors (external MCP servers, listed in get_team) ONE agent uses: the COMPLETE list (by id or name; [] = none). Only when the user explicitly asked. The agent sees the new tools from its next turn. Creating or configuring connectors is done by the user in the interface.",
      input: z.object({
        agent: ref("Agent"),
        connectors: z.array(z.string().trim().min(1).max(80)).max(50).describe("Connector ids (or names) the agent should use; replaces the current list"),
        user_confirmed: userConfirmed,
      }),
      call: async ({ agent: agentRef, connectors: refs }) => {
        const agent = findAgent(deps.state.read(), agentRef);
        if (isResult(agent)) return agent;
        const all = deps.connectors.list();
        const ids: string[] = [];
        for (const connectorRef of refs) {
          const connector = findByRef(all, connectorRef);
          if (!connector) return error(`Connector "${connectorRef}" not found. Workspace connectors: ${all.map((candidate) => `${candidate.name} (${candidate.id})`).join(", ") || "none (the user adds them in the interface)"}.`);
          ids.push(connector.id);
        }
        const now = await deps.connectors.setAgentConnectors(agent.id, ids);
        const disabled = now.filter((connector) => !connector.enabled).map((connector) => connector.name);
        const list = now.map((connector) => connector.name).join(", ") || "none";
        deps.helpAnswered?.(agent.id, `(Mensagem do Maestro, não do usuário) Respondi ao seu pedido: seus conectores agora são ${list}. As ferramentas novas valem a partir da próxima tarefa. Não espere mais: termine esta tarefa com \`submit_result\`, dizendo o que conseguiu e o que faltou.`);
        return ok(`${agent.name} now uses: ${list}.${disabled.length > 0 ? ` Disabled by the user (no tools until they turn it on): ${disabled.join(", ")}.` : ""}`);
      },
    }),
    defineTool({
      name: "set_agent_skills",
      description:
        "Sets which of the workspace's Library skills (ready-made instructions, listed in get_team) ONE agent receives: the COMPLETE list (by id or name; [] = none). Reversible and cheap (text only, no new tools), so no confirmation is needed. The agent sees the new skill index from its next session start (an idle agent restarts on its own; the conversation continues). Only skills the user released to this workspace can be handed out; releasing them is done in the Library page.",
      input: z.object({
        agent: ref("Agent"),
        skill_ids: z.array(z.string().trim().min(1).max(80)).max(50).describe("Skill ids (or names) the agent should have; replaces the current list"),
      }),
      call: async ({ agent: agentRef, skill_ids: refs }) => {
        const agent = findAgent(deps.state.read(), agentRef);
        if (isResult(agent)) return agent;
        const all = deps.skills.list();
        const ids: string[] = [];
        for (const skillRef of refs) {
          const skill = findByRef(all, skillRef);
          if (!skill) return error(`Skill "${skillRef}" not found in this workspace. Skills released to it: ${all.map((candidate) => `${candidate.name} (${candidate.id})`).join(", ") || "none (the user releases them in the Library page)"}.`);
          ids.push(skill.id);
        }
        const now = await deps.skills.setAgentSkills(agent.id, ids);
        const warnings = deps.skills.warnings(agent.id);
        const list = now.map((skill) => skill.name).join(", ") || "none";
        deps.helpAnswered?.(agent.id, `(Mensagem do Maestro, não do usuário) Respondi ao seu pedido: suas skills agora são ${list}. Elas valem a partir da próxima tarefa. Não espere mais: termine esta tarefa com \`submit_result\`, dizendo o que conseguiu e o que faltou.`);
        return ok(`${agent.name} now has the skills: ${list}.${warnings.length > 0 ? ` Warning: ${warnings.join(" ")}` : ""}`);
      },
    }),
  ];
}

function deleteApprovalTypeTool(deps: ManageToolsDeps): McpTool {
  return defineTool({
    name: "delete_approval_type",
    description:
      'Deletes an approval type of "Para você" (by id or name); its items move to the type "outro". Built-in types cannot be deleted. Only when the user explicitly asked.',
    input: z.object({ type: z.string().trim().min(1).max(60).describe("Approval type id (or name)"), user_confirmed: userConfirmed }),
    call: async ({ type: typeRef }) => {
      const types = deps.forYouTypes.list();
      const type = findByRef(types, typeRef);
      if (!type) return error(`Approval type "${typeRef}" not found. Types: ${types.map((candidate) => `${candidate.name} (${candidate.id})`).join(", ")}.`);
      await deps.forYouTypes.remove(type.id);
      return ok(`Approval type ${type.name} deleted; its items moved to "outro".`);
    },
  });
}
