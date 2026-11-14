import { LibraryService, libraryDirOf } from "../library/library-service";
import {
  agentEngine,
  createAgentBodySchema,
  createRoomBodySchema,
  createTeamBodySchema,
  findMaestroAgent,
  updateAgentBodySchema,
  type Agent,
  type CreateAgentBody,
  type CreateRoomBody,
  type CreateTeamBody,
  type OfficeState,
  type Room,
  type Team,
  type UpdateAgentBody,
  type Workspace,
} from "@cyno/shared";
import Fastify from "fastify";
import { DEFAULT_MAESTRO_TIMINGS } from "../sim/coordinator";
import { McpTokens } from "../mcp/tokens";
import { DEFAULT_TERMINALS_CONFIG } from "../engines/terminals/manager";
import { WorkspaceManager } from "../platform/workspaces/manager";

/**
 * Workspace de teste dos agentes reais ("Laboratório"): Sala do Maestro com o Maestro em motor
 * claude, um quarto/time "Conteúdo" com o agente "Redator" (motor claude) e um quarto/time
 * "Pesquisa" com o "Pesquisador" (motor gemini, no Google Antigravity CLI), para o Maestro do
 * Claude Code delegar para um agente Gemini. Idempotente: só cria ou acerta o que falta, e nunca
 * mexe nos outros workspaces.
 */
export const LAB = {
  id: "laboratorio",
  name: "Laboratório",
  room: { name: "Conteúdo", theme: "lavender", readsGlobalBrain: true } satisfies CreateRoomBody,
  team: { name: "Conteúdo", focus: "escrever textos curtos" },
  agent: {
    name: "Redator",
    role: "Redator de textos curtos",
    instructions: "Escreve textos curtos (posts, slogans, legendas), claros e diretos, em português do Brasil.",
    avatar: { skin: "tone3", hair: "curly", hairColor: "ink", shirt: "lavender", pants: "navy", accessory: "glasses" },
    engine: "claude",
  },
  research: {
    room: { name: "Pesquisa", theme: "ocean", readsGlobalBrain: true } satisfies CreateRoomBody,
    team: { name: "Pesquisa", focus: "pesquisar fatos, comparar opções e resumir o que achou" },
    agent: {
      name: "Pesquisador",
      role: "Pesquisador",
      instructions:
        "Pesquisa e organiza fatos sobre o tema pedido (na web, quando o acesso do workspace permite, citando as fontes), compara opções e entrega um resumo curto em tópicos, em português do Brasil.",
      avatar: { skin: "tone5", hair: "bun", hairColor: "wood-dark", shirt: "ocean", pants: "charcoal", accessory: "headphones" },
      engine: "gemini",
      /** Modelo barato do Antigravity (o nível de raciocínio vem no nome). */
      model: "gemini-3.8-flash-medium",
    },
  },
} as const;

/** O que o setup precisa (pela API HTTP com o server no ar, ou direto nos serviços com ele parado). */
export type LabApi = {
  listWorkspaces(): Promise<Workspace[]>;
  createWorkspace(name: string): Promise<Workspace>;
  office(ws: string): Promise<OfficeState>;
  createRoom(ws: string, body: CreateRoomBody): Promise<Room>;
  createTeam(ws: string, body: CreateTeamBody): Promise<Team>;
  createAgent(ws: string, body: CreateAgentBody): Promise<Agent>;
  updateAgent(ws: string, id: string, body: UpdateAgentBody): Promise<Agent>;
};

/** Um quarto com um time e um agente (o Redator, o Pesquisador). */
export type LabWorker = { room: Room; team: Team; agent: Agent };

export type LabResult = { workspace: Workspace; maestro: Agent; room: Room; team: Team; agent: Agent; research: LabWorker; changes: string[] };

type WorkerSpec = {
  room: CreateRoomBody;
  team: { name: string; focus: string };
  agent: Omit<CreateAgentBody, "teamId" | "engine" | "model"> & { engine: "claude" | "gemini"; model?: string };
};

const ENGINE_NAMES = { claude: "Claude Code", gemini: "Antigravity" } as const;

/** Cria (ou acerta) quarto, time e agente; motor e modelo voltam ao do laboratório se mudaram. */
async function ensureWorker(api: LabApi, spec: WorkerSpec, changes: string[]): Promise<LabWorker> {
  let office = await api.office(LAB.id);
  let room = office.rooms.find((candidate) => candidate.kind === "team" && candidate.name === spec.room.name);
  if (!room) {
    room = await api.createRoom(LAB.id, spec.room);
    changes.push(`quarto ${spec.room.name} criado`);
  }
  office = await api.office(LAB.id);
  let team = office.teams.find((candidate) => candidate.roomId === room.id && candidate.name === spec.team.name);
  if (!team) {
    team = await api.createTeam(LAB.id, { roomId: room.id, ...spec.team });
    changes.push(`time ${spec.team.name} criado`);
  }
  const { engine, model, ...fields } = spec.agent;
  let agent = office.agents.find((candidate) => candidate.teamId === team.id && candidate.name === fields.name);
  if (!agent) {
    agent = await api.createAgent(LAB.id, { teamId: team.id, ...fields, avatar: { ...fields.avatar }, engine, ...(model ? { model } : {}) });
    changes.push(`agente ${fields.name} criado (motor ${engine}${model ? `, modelo ${model}` : ""})`);
  } else if (agentEngine(agent) !== engine || (model !== undefined && agent.model !== model)) {
    agent = await api.updateAgent(LAB.id, agent.id, { engine, ...(model ? { model } : {}) });
    changes.push(`${fields.name} agora roda no ${ENGINE_NAMES[engine]}${model ? ` (${model})` : ""}`);
  }
  return { room, team, agent };
}

export async function setupLab(api: LabApi): Promise<LabResult> {
  const changes: string[] = [];
  let workspace = (await api.listWorkspaces()).find((ws) => ws.id === LAB.id);
  if (!workspace) {
    workspace = await api.createWorkspace(LAB.name);
    if (workspace.id !== LAB.id) throw new Error(`O workspace foi criado com o id "${workspace.id}" (esperado "${LAB.id}")`);
    changes.push(`workspace ${LAB.name} criado`);
  }
  const office = await api.office(LAB.id);
  let maestro = findMaestroAgent(office);
  if (!maestro) throw new Error("O Laboratório ficou sem o Maestro");
  if (agentEngine(maestro) !== "claude") {
    maestro = await api.updateAgent(LAB.id, maestro.id, { engine: "claude" });
    changes.push("Maestro agora roda no Claude Code");
  }
  const writer = await ensureWorker(api, LAB, changes);
  const research = await ensureWorker(api, LAB.research, changes);
  return { workspace, maestro, ...writer, research, changes };
}

/** LabApi pela API HTTP do server no ar (o caminho seguro: um só processo grava os dados). */
export function httpLabApi(baseUrl: string): LabApi {
  const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (response.status === 401) {
      throw new Error(
        `${baseUrl} exige senha (401): é um app com senha, como o app real, e o Laboratório não destrava senha. Suba um app de teste isolado (sem senha) com "npm run lab:up" ou aponte LAB_API_URL para um server sem senha.`,
      );
    }
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
    return (await response.json()) as T;
  };
  return {
    listWorkspaces: () => call("GET", "/api/workspaces"),
    createWorkspace: (name) => call("POST", "/api/workspaces", { name }),
    office: (ws) => call("GET", `/api/w/${ws}/office`),
    createRoom: (ws, body) => call("POST", `/api/w/${ws}/rooms`, body),
    createTeam: (ws, body) => call("POST", `/api/w/${ws}/teams`, body),
    createAgent: (ws, body) => call("POST", `/api/w/${ws}/agents`, body),
    updateAgent: (ws, id, body) => call("PATCH", `/api/w/${ws}/agents/${id}`, body),
  };
}

/**
 * LabApi direto nos serviços (server PARADO): abre os workspaces sem retomar filas nem subir
 * terminais (nenhuma tarefa anda e nada do "principal" muda). Feche com `close`.
 */
export async function offlineLabApi(dataDir: string): Promise<LabApi & { close: () => Promise<void> }> {
  const log = Fastify({ logger: false }).log;
  const library = await LibraryService.open({ libraryDir: libraryDirOf(dataDir), publishPlatform: () => undefined, claudeList: { command: "/nao-existe/lab-setup-nao-sobe-cli" }, autoTest: false, log, now: () => new Date() });
  const manager = await WorkspaceManager.open(dataDir, {
    library,
    terminals: { ...DEFAULT_TERMINALS_CONFIG, claude: { command: "/nao-existe/lab-setup-nao-sobe-cli" }, gemini: { command: "/nao-existe/lab-setup-nao-sobe-cli" } },
    mcpTokens: new McpTokens(),
    doneLingerMs: 0,
    maestro: DEFAULT_MAESTRO_TIMINGS,
    now: () => new Date(),
    log,
  });
  const services = (ws: string) => manager.get(ws).services;
  return {
    listWorkspaces: async () => manager.list(),
    createWorkspace: (name) => manager.create(name),
    office: async (ws) => manager.get(ws).store.snapshot(),
    createRoom: (ws, body) => services(ws).rooms.create(createRoomBodySchema.parse(body)),
    createTeam: (ws, body) => services(ws).teams.create(createTeamBodySchema.parse(body)),
    createAgent: (ws, body) => services(ws).agents.create(createAgentBodySchema.parse(body)),
    updateAgent: (ws, id, body) => services(ws).agents.update(id, updateAgentBodySchema.parse(body)),
    close: async () => {
      await manager.close();
      await library.close();
    },
  };
}
