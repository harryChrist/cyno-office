import {
  effectiveAccess,
  workspaceAccess,
  type EffectiveAccess,
  type WorkspaceAccess,
  AVATAR_OPTIONS,
  avatarSchema,
  createAgentBodySchema,
  createRoomBodySchema,
  createTeamBodySchema,
  AGENT_EFFORTS,
  describeModelChoice,
  ENGINE_LABELS,
  findMaestroAgent,
  IMPLEMENTED_CLI_ENGINES,
  isCliEngine,
  isMaestroRoom,
  ROOM_PURPOSE_SPECS,
  ROOM_SIZE_SPECS,
  ROOM_THEME_IDS,
  THEME_LABELS,
  type Agent,
  type AgentEffort,
  type Avatar,
  type EngineInfo,
  type ModelChoice,
  modelUsesEffort,
  type OfficeState,
  type Room,
  type RoomPurpose,
  type RoomSize,
  type RoomThemeId,
  type Team,
} from "@cyno/shared";
import { z } from "zod";
import type { Services } from "../workspace/office";
import { defineTool, type McpTool, type McpToolResult } from "./protocol";

/**
 * Ferramentas de estrutura do Maestro: criar salas, times e agentes e escolher o líder do time
 * quando o usuário pede ("Maestro, monta um time de vídeo com 3 pessoas"). Tudo passa pelos
 * serviços do escritório (os mesmos das rotas), então os eventos saem normais e o escritório
 * atualiza ao vivo. Editar e remover ficam em manage-tools.ts. O contrato MCP é em
 * inglês (os valores de tipo/tamanho de sala viram os ids gravados aqui).
 */

export type StructureToolsDeps = {
  state: { read(): OfficeState };
  services: {
    rooms: Pick<Services["rooms"], "create" | "update">;
    teams: Pick<Services["teams"], "create" | "update">;
    agents: Pick<Services["agents"], "create" | "update">;
  };
  /** Modo simulado ligado (AGENT_RUNNER=mock, só testes): só então o motor "mock" existe para o Maestro. */
  simulated?: boolean;
  /** Motores detectados neste server (GET /api/engines). */
  engines?: () => Promise<EngineInfo[]>;
  /** Padrão `agentes` do workspace (preenche o agente novo). */
  agentDefaults?: () => ModelChoice | undefined;
  /** Acesso dos agentes do workspace (ausente = os padrões). */
  access?: () => WorkspaceAccess | undefined;
};

/** Motores que o Maestro pode pedir: os que têm adaptador de CLI (o simulado só no modo simulado, veja `structureEngines`). */
const STRUCTURE_ENGINES = ["mock", ...IMPLEMENTED_CLI_ENGINES] as const;
type StructureEngine = (typeof STRUCTURE_ENGINES)[number];
const structureEngines = (simulated: boolean | undefined) => (simulated ? STRUCTURE_ENGINES : IMPLEMENTED_CLI_ENGINES);

/** Tipo de sala no MCP (inglês) -> o id gravado, com a descrição em inglês para o modelo. */
export const ROOM_PURPOSE_INPUTS = {
  general: { id: "geral", description: "Standard office: desks, whiteboard, coffee, bookshelf and sofa." },
  dev: { id: "dev", description: "More monitors per desk, task board and a server rack." },
  research: { id: "pesquisa", description: "More bookshelves and a reading table with armchairs." },
  design: { id: "design", description: "Creative table, camera/tripod, lighting and a reference wall." },
  content: { id: "conteudo", description: "Writing desks, story board and a small recording corner." },
  meeting: { id: "reuniao", description: "Big meeting table with chairs and a TV on the wall; few individual desks." },
} as const satisfies Record<string, { id: RoomPurpose; description: string }>;
type RoomPurposeInput = keyof typeof ROOM_PURPOSE_INPUTS;
const PURPOSE_INPUT_IDS = Object.keys(ROOM_PURPOSE_INPUTS) as [RoomPurposeInput, ...RoomPurposeInput[]];

/** Tamanho de sala no MCP (inglês) -> o id gravado. */
export const ROOM_SIZE_INPUTS = { auto: "auto", s: "p", m: "m", l: "g", xl: "gg" } as const satisfies Record<string, RoomSize>;
type RoomSizeInput = keyof typeof ROOM_SIZE_INPUTS;
const SIZE_INPUT_IDS = Object.keys(ROOM_SIZE_INPUTS) as [RoomSizeInput, ...RoomSizeInput[]];

/** Tipo de sala gravado -> o valor do MCP ("pesquisa" -> "research"), para o get_team falar a mesma língua do create_room. */
export function roomPurposeInput(purpose: RoomPurpose): string {
  return PURPOSE_INPUT_IDS.find((input) => ROOM_PURPOSE_INPUTS[input].id === purpose) ?? purpose;
}

/** Tamanho gravado -> o valor do MCP ("g" -> "l"). */
export function roomSizeInput(size: RoomSize): string {
  return SIZE_INPUT_IDS.find((input) => ROOM_SIZE_INPUTS[input] === size) ?? size;
}

/** Campo de um tamanho lido com cuidado (o contrato de room-spec ainda pode mudar). */
type LooseSizeSpec = { label: string; hint?: string; tiles?: { w: number; h: number } | null; maxDesks?: number | null };
const sizeSpec = (size: RoomSize): LooseSizeSpec => ROOM_SIZE_SPECS[size] as LooseSizeSpec;

/** "13×12 tiles initial floor, fits ~8 desks" — só informação (em inglês, para o modelo): a sala cresce sozinha se precisar. */
export function describeRoomSize(size: RoomSize): string {
  const spec = sizeSpec(size);
  if (!spec.tiles) return "grows with the teams and agents";
  const desks = typeof spec.maxDesks === "number" ? `, fits ~${spec.maxDesks} desks` : "";
  return `${spec.tiles.w}×${spec.tiles.h} tiles initial floor${desks}`;
}

/** Texto do `list_room_options`: tamanhos (piso inicial) e tipos de sala com a descrição. */
export function sizesAndPurposesText(): string {
  return [
    "## Sizes (`size`)",
    "The size is only the initial floor: the room grows by itself if it needs more space; there is no limit of teams or desks.",
    ...SIZE_INPUT_IDS.map((size) => `- ${size}: ${describeRoomSize(ROOM_SIZE_INPUTS[size])}${size === "auto" ? " — default" : ""}`),
    "",
    "## Purposes (`purpose`, decides the furniture)",
    ...PURPOSE_INPUT_IDS.map((purpose) => `- ${purpose}: ${ROOM_PURPOSE_INPUTS[purpose].description}${purpose === "general" ? " (default)" : ""}`),
  ].join("\n");
}

/** Próximo tema que nenhum quarto de time usa (se todos já são usados, o menos usado). */
export function nextRoomTheme(rooms: readonly Room[]): RoomThemeId {
  const counts = new Map<RoomThemeId, number>(ROOM_THEME_IDS.map((theme) => [theme, 0]));
  for (const room of rooms) {
    if (isMaestroRoom(room)) continue;
    const theme = room.theme as RoomThemeId;
    if (counts.has(theme)) counts.set(theme, counts.get(theme)! + 1);
  }
  let best: RoomThemeId = ROOM_THEME_IDS[0];
  for (const theme of ROOM_THEME_IDS) if (counts.get(theme)! < counts.get(best)!) best = theme;
  return best;
}

/** Hash FNV-1a de 32 bits (determinístico: o mesmo nome dá sempre o mesmo avatar). */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Avatar "sorteado" a partir do nome: sempre válido (AVATAR_OPTIONS) e igual para o mesmo nome. */
export function avatarFromName(name: string): Avatar {
  const key = name.trim().toLowerCase();
  const pick = <T>(options: readonly T[], salt: string): T => options[hash(`${salt}:${key}`) % options.length]!;
  // Metade dos agentes ganha um acessório.
  const withAccessory = hash(`acc?:${key}`) % 2 === 0;
  return {
    skin: pick(AVATAR_OPTIONS.skin, "skin"),
    hair: pick(AVATAR_OPTIONS.hair, "hair"),
    hairColor: pick(AVATAR_OPTIONS.hairColor, "hairColor"),
    shirt: pick(AVATAR_OPTIONS.shirt, "shirt"),
    pants: pick(AVATAR_OPTIONS.pants, "pants"),
    ...(withAccessory ? { accessory: pick(AVATAR_OPTIONS.accessory, "accessory") } : {}),
  };
}

/** Compara nomes sem acento nem maiúsculas. */
const plain = (text: string) =>
  text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .toLowerCase();

/** Acha pelo id ou, se não houver, pelo nome (sem acento/maiúsculas). */
export function findByRef<T extends { id: string; name: string }>(items: readonly T[], ref: string): T | undefined {
  return items.find((item) => item.id === ref) ?? items.find((item) => plain(item.name) === plain(ref));
}
const error = (text: string): McpToolResult => ({ text, isError: true });
const ok = (text: string): McpToolResult => ({ text });

const roomTeams = (state: OfficeState, roomId: string) => state.teams.filter((team) => team.roomId === roomId);
const teamAgents = (state: OfficeState, teamId: string) => state.agents.filter((agent) => agent.teamId === teamId);

/** Motor real pedido (ou vindo do padrão): precisa da confirmação do usuário e da CLI instalada. */
async function checkRealEngine(
  deps: StructureToolsDeps,
  engine: Exclude<StructureEngine, "mock">,
  confirmed: boolean | undefined,
  fromDefault: boolean,
  what: string,
): Promise<string | undefined> {
  const label = ENGINE_LABELS[engine];
  const simulated = deps.simulated === true;
  if (confirmed !== true) {
    return fromDefault
      ? `${what}: this workspace's default for new agents is ${label}, which runs on the user's SUBSCRIPTION (it spends their usage). If the user asked for it explicitly (or confirms), call again with user_confirmed: true${simulated ? '; to create a simulated one, pass engine: "mock"' : "; otherwise tell the user"}.`
      : `${what}: a ${label} agent runs on the user's subscription (it spends their usage). Only use a real engine if the user explicitly asked for a ${label} agent; in that case call again with user_confirmed: true.${simulated ? ' Otherwise pass engine: "mock" (simulated).' : " Otherwise tell the user."}`;
  }
  if (!deps.engines) return `${what}: this server does not report which engines are installed.${simulated ? ' Pass engine: "mock" or tell the user.' : " Tell the user."}`;
  const info = (await deps.engines()).find((candidate) => candidate.engine === engine);
  if (!info?.available) return `${what}: the ${label} engine is not available on this server${info?.reason ? ` (${info.reason})` : ""}. ${simulated ? 'Use engine: "mock" or tell the user.' : "Tell the user."}`;
  return undefined;
}

const isStructureEngine = (engine: string): engine is StructureEngine => (STRUCTURE_ENGINES as readonly string[]).includes(engine);

const NO_ENGINE = "Agent not created: this workspace has no default engine for new agents. Ask the user to pick one in Settings (default models), or pass `engine` (claude or gemini) when the user asked for one.";

/**
 * Motor/modelo/esforço de um agente novo: o que o Maestro passou, completado pelo padrão `agentes`
 * do workspace (o modelo/esforço do padrão só valem se o motor for o mesmo do padrão).
 */
function newAgentChoice(deps: StructureToolsDeps, input: { engine?: StructureEngine; model?: string; effort?: AgentEffort }): { choice: ModelChoice; fromDefault: boolean } | undefined {
  const fallback = deps.agentDefaults?.() ?? { engine: "mock" };
  const engine: StructureEngine = input.engine ?? (isStructureEngine(fallback.engine) ? fallback.engine : "mock");
  const fromDefault = input.engine === undefined;
  if (engine === "mock") return deps.simulated ? { choice: { engine: "mock" }, fromDefault } : undefined;
  const sameAsDefault = engine === fallback.engine;
  const model = input.model ?? (sameAsDefault ? fallback.model : undefined);
  const effort = input.effort ?? (sameAsDefault ? fallback.effort : undefined);
  return { choice: { engine, ...(model ? { model } : {}), ...(effort ? { effort } : {}) }, fromDefault };
}

/** "internet, browser" (o que está ligado) ou "none" — para o modelo. */
export function describeAccess(access: EffectiveAccess): string {
  const on = (["internet", "browser", "terminal"] as const).filter((key) => access[key]);
  return on.length > 0 ? on.join(", ") : "none";
}

export function structureTools(deps: StructureToolsDeps): McpTool[] {
  return [
    defineTool({
      name: "list_room_options",
      description: "Lists the room sizes (initial floor; the room grows by itself) and the room purposes (function, which decides the furniture). Use it before create_room.",
      input: z.object({}),
      call: () => ok(sizesAndPurposesText()),
    }),
    defineTool({
      name: "create_room",
      description:
        'Creates a team room in the office. Returns the room id (use it in create_team). Default theme: one not used yet; default size: "auto" (grows with the teams and agents); default purpose: "general". See list_room_options.',
      input: z.object({
        name: z.string().trim().min(1).max(40).describe("Room name, shown to the user (e.g. Estúdio de Vídeo)"),
        purpose: z.enum(PURPOSE_INPUT_IDS).optional().describe(`Room function: ${PURPOSE_INPUT_IDS.join(", ")} (default general)`),
        size: z.enum(SIZE_INPUT_IDS).optional().describe(`Initial floor: ${SIZE_INPUT_IDS.join(", ")} (default auto; the room grows if needed)`),
        theme: z.enum(ROOM_THEME_IDS).optional().describe(`Colors: ${ROOM_THEME_IDS.join(", ")} (default: one not used yet)`),
      }),
      call: async ({ name, purpose: purposeInput, size: sizeInput, theme: themeInput }) => {
        const state = deps.state.read();
        const theme = themeInput ?? nextRoomTheme(state.rooms);
        const size: RoomSize = ROOM_SIZE_INPUTS[sizeInput ?? "auto"];
        const purpose: RoomPurpose = ROOM_PURPOSE_INPUTS[purposeInput ?? "general"].id;
        const body = createRoomBodySchema.parse({ name, theme, size, purpose });
        let room = await deps.services.rooms.create(body);
        // Serviço de antes do size/purpose no create: grava os dois com um update.
        if (room.size !== size || room.purpose !== purpose) room = await deps.services.rooms.update(room.id, { size, purpose });
        return ok(
          `Room "${room.name}" created (id: ${room.id}) — purpose ${purposeInput ?? "general"} (${ROOM_PURPOSE_SPECS[purpose].label}), size ${sizeInput ?? "auto"} (${describeRoomSize(size)}), theme ${THEME_LABELS[theme]}. Now create the teams with create_team(room: "${room.id}", …).`,
        );
      },
    }),
    defineTool({
      name: "create_team",
      description: "Creates a team in a room (by room id or name). Returns the team id (use it in create_agent and set_team_lead).",
      input: z.object({
        room: z.string().trim().min(1).max(64).describe("Room id (or name)"),
        name: z.string().trim().min(1).max(40).describe("Team name, shown to the user (e.g. Vídeo)"),
        focus: z.string().trim().min(1).max(120).describe("What the team works on (one short sentence in Brazilian Portuguese; it is what triage reads)"),
      }),
      call: async ({ room: roomRef, name, focus }) => {
        const state = deps.state.read();
        const room = findByRef(state.rooms, roomRef);
        if (!room) return error(`Room "${roomRef}" not found. See the ids with get_team or create one with create_room.`);
        if (isMaestroRoom(room)) return error("The Maestro's room does not take teams. Create a room with create_room.");
        const team = await deps.services.teams.create(createTeamBodySchema.parse({ roomId: room.id, name, focus }));
        const count = roomTeams(deps.state.read(), room.id).length;
        return ok(`Team "${team.name}" created (id: ${team.id}) in room ${room.name} (now with ${count} ${count === 1 ? "team" : "teams"}). Create the agents with create_agent(team: "${team.id}", …) and then pick the lead with set_team_lead.`);
      },
    }),
    defineTool({
      name: "create_agent",
      description: [
        "Creates an agent in a team (by team id or name). Default avatar: drawn from the name.",
        "Without `engine`, the agent is created with the workspace's default for agents (engine, model and effort; see get_team).",
        "Access (`internet`, `browser`, `terminal`) follows the workspace's agent access policy when omitted; an agent can only be restricted below it (pass false only if the user asked).",
        'Real agents ("claude" = Claude Code, "gemini" = Antigravity) run on the user\'s SUBSCRIPTION: only create one (including through the default) with `user_confirmed: true` when the user EXPLICITLY asked for it or confirmed.',
        deps.simulated
          ? 'Without confirmation, pass engine: "mock" (simulated, spends nothing). Never pick a model or effort on your own: use the default or what the user asked for.'
          : "Without the user's explicit request or confirmation, do not create real agents: tell the user. Never pick a model or effort on your own: use the default or what the user asked for.",
      ].join(" "),
      input: z.object({
        team: z.string().trim().min(1).max(64).describe("Team id (or name)"),
        name: z.string().trim().min(1).max(24).describe("Agent name (e.g. Bia)"),
        role: z.string().trim().min(1).max(60).describe("Role in the team, in Brazilian Portuguese (e.g. Editora de vídeo)"),
        instructions: z.string().trim().max(2000).describe("How the agent works (style, responsibilities)"),
        engine: z.enum(structureEngines(deps.simulated)).optional().describe(`Omitted = the workspace default. ${deps.simulated ? '"mock" (simulated), ' : ""}"claude" (Claude Code), "gemini" (Antigravity), "freebuff", "openclaw" or "hermes" (see the notes in get_team) — real only with user_confirmed`),
        model: z.string().trim().min(1).max(80).optional().describe("CLI model (only with a real engine and only if the user asked; e.g. sonnet). Omitted = the default"),
        effort: z.enum(AGENT_EFFORTS).optional().describe("Effort (low…max; only if the user asked). Omitted = the default"),
        internet: z.boolean().optional().describe("false = no web search/page reading for this agent. Omitted = follows the workspace policy"),
        browser: z.boolean().optional().describe("false = no shared browser for this agent. Omitted = follows the workspace policy"),
        terminal: z.boolean().optional().describe("false = no terminal for this agent. Omitted = follows the workspace policy (which is off by default)"),
        avatar: avatarSchema.optional().describe("Appearance (optional; default drawn from the name)"),
        user_confirmed: z.boolean().optional().describe("true ONLY when the user explicitly asked for or confirmed a real agent (Claude/Antigravity spend their subscription)"),
      }),
      call: async ({ team: teamRef, name, role, instructions, engine, model, effort, internet, browser, terminal, avatar, user_confirmed }) => {
        const state = deps.state.read();
        const team = findByRef(state.teams, teamRef);
        if (!team) return error(`Team "${teamRef}" not found. See the ids with get_team or create one with create_team.`);
        const picked = newAgentChoice(deps, { engine: engine as StructureEngine | undefined, model, effort });
        if (!picked) return error(NO_ENGINE);
        const { choice, fromDefault } = picked;
        const real = choice.engine !== "mock";
        if (choice.engine !== "mock") {
          const problem = await checkRealEngine(deps, choice.engine as Exclude<StructureEngine, "mock">, user_confirmed, fromDefault, "Agent not created");
          if (problem) return error(problem);
        }
        const body = createAgentBodySchema.parse({
          teamId: team.id,
          name,
          role,
          instructions,
          avatar: avatar ?? avatarFromName(name),
          ...(real ? { engine: choice.engine } : {}),
          ...(real && choice.model ? { model: choice.model } : {}),
          ...(real && choice.effort ? { effort: choice.effort } : {}),
          ...(internet !== undefined ? { internet } : {}),
          ...(browser !== undefined ? { browser } : {}),
          ...(terminal !== undefined ? { terminal } : {}),
        });
        const agent = await deps.services.agents.create(body);
        const ignored = !real && (model || effort) ? " (model/effort ignored: a simulated agent does not use them)" : "";
        const web = real ? `; access: ${describeAccess(effectiveAccess(workspaceAccess(deps.access?.()), agent))}` : "";
        return ok(`Agent ${agent.name} created (id: ${agent.id}) — ${agent.role} in team ${team.name}; ${describeModelChoice({ engine: agent.engine ?? "mock", model: agent.model, effort: agent.effort })}${web}${ignored}.`);
      },
    }),
    defineTool({
      name: "set_agent_model",
      description: [
        "Changes the engine, model and/or effort of ONE agent or of ALL agents of a team.",
        'Use it ONLY when the user explicitly asked for it in this request (e.g. "coloca o time de Vídeo no Opus"). Never change models on your own (not to save usage, not because the task looks hard or simple).',
        "Applies from each agent's next task. A real engine (Claude/Antigravity) spends the user's subscription.",
      ].join(" "),
      input: z.object({
        agent: z.string().trim().min(1).max(64).optional().describe("Id (or name) of one agent"),
        team: z.string().trim().min(1).max(64).optional().describe("Id (or name) of a team: changes all of its agents"),
        engine: z.enum(structureEngines(deps.simulated)).optional().describe(`${deps.simulated ? '"mock", ' : ""}"claude", "gemini", "freebuff", "openclaw" or "hermes" (omitted = keep)`),
        model: z.string().trim().min(1).max(80).optional().describe("CLI model (e.g. opus, sonnet, haiku, gemini-3.8-flash-medium; omitted = keep, or the default when changing engine)"),
        effort: z.enum(AGENT_EFFORTS).optional().describe("low, medium, high, xhigh or max (omitted = keep)"),
        user_confirmed: z.literal(true).describe("Always true: only call it when the user explicitly asked for this change"),
      }),
      call: async ({ agent: agentRef, team: teamRef, engine, model, effort, user_confirmed }) => {
        if ((agentRef ? 1 : 0) + (teamRef ? 1 : 0) !== 1) return error("Say who changes: `agent` OR `team` (one of them).");
        if (!engine && !model && !effort) return error("Nothing to change: pass `engine`, `model` and/or `effort`.");
        const state = deps.state.read();
        let targets: Agent[];
        if (agentRef) {
          const agent = findByRef(state.agents, agentRef);
          if (!agent) return error(`Agent "${agentRef}" not found. See the ids with get_team.`);
          targets = [agent];
        } else {
          const team = findByRef(state.teams, teamRef!);
          if (!team) return error(`Team "${teamRef}" not found. See the ids with get_team.`);
          targets = teamAgents(state, team.id);
          if (targets.length === 0) return error(`Team ${team.name} has no agents.`);
        }
        const maestroId = findMaestroAgent(state)?.id;
        if (engine && targets.some((agent) => agent.id === maestroId && (agent.engine ?? "mock") !== engine)) {
          return error("The Maestro's own engine does not change here (the user changes it in the interface). Model and effort can change.");
        }
        if (engine && engine !== "mock") {
          const problem = await checkRealEngine(deps, engine as Exclude<StructureEngine, "mock">, user_confirmed, false, "Model not changed");
          if (problem) return error(problem);
        }
        const defaults = deps.agentDefaults?.();
        const lines: string[] = [];
        for (const agent of targets) {
          const before: ModelChoice = { engine: agent.engine ?? "mock", ...(agent.model ? { model: agent.model } : {}), ...(agent.effort ? { effort: agent.effort } : {}) };
          const nextEngine = engine ?? before.engine;
          const changedEngine = nextEngine !== before.engine;
          // Trocando de motor sem dizer o modelo: o do padrão do workspace se for o mesmo motor; senão, o padrão da CLI.
          const fallbackModel = changedEngine ? (defaults?.engine === nextEngine ? defaults.model : undefined) : before.model;
          const fallbackEffort = changedEngine ? (defaults?.engine === nextEngine ? defaults.effort : undefined) : before.effort;
          const cli = isCliEngine(nextEngine);
          const nextModel = cli ? (model ?? fallbackModel) : undefined;
          // O esforço só vale onde o motor e o modelo o aceitam (nos Gemini o nível vai no nome do modelo).
          const nextEffort = cli && modelUsesEffort(nextEngine, nextModel) ? (effort ?? fallbackEffort) : undefined;
          const updated = await deps.services.agents.update(agent.id, { engine: nextEngine, model: nextModel ?? null, effort: nextEffort ?? null });
          lines.push(`- ${updated.name}: ${describeModelChoice(before)} → ${describeModelChoice({ engine: updated.engine ?? "mock", model: updated.model, effort: updated.effort })}`);
        }
        return ok(`Models changed (they apply from each agent's next task):\n${lines.join("\n")}`);
      },
    }),
    defineTool({
      name: "set_team_lead",
      description: "Picks a team's lead (an agent of that team): they get the highlighted seat of the island.",
      input: z.object({
        team: z.string().trim().min(1).max(64).describe("Team id (or name)"),
        agent: z.string().trim().min(1).max(64).describe("Agent id (or name); must belong to the team"),
      }),
      call: async ({ team: teamRef, agent: agentRef }) => {
        const state = deps.state.read();
        const team: Team | undefined = findByRef(state.teams, teamRef);
        if (!team) return error(`Team "${teamRef}" not found. See the ids with get_team.`);
        const room = state.rooms.find((candidate) => candidate.id === team.roomId);
        if (room && isMaestroRoom(room)) return error("The Maestro's room team does not change lead.");
        const members = teamAgents(state, team.id);
        const agent: Agent | undefined = findByRef(members, agentRef);
        if (!agent) {
          const names = members.map((member) => `${member.name} (${member.id})`).join(", ");
          return error(`Agent "${agentRef}" is not in team ${team.name}. ${names ? `Team agents: ${names}.` : "The team has no agents yet (create them with create_agent)."}`);
        }
        await deps.services.teams.update(team.id, { leadAgentId: agent.id });
        return ok(`${agent.name} is now the lead of team ${team.name}.`);
      },
    }),
  ];
}
