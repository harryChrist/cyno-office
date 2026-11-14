import {
  ENGINE_FALLBACK_MODELS,
  ENGINE_LABELS,
  isCliEngine,
  workspaceProposalPlanSchema,
  workspaceProposalSchema,
  type AgentEngine,
  type EngineInfo,
  type WorkspaceProposal,
  type WorkspaceProposalPlan,
} from "@cyno/shared";
import { workspaceNameSchema } from "@cyno/shared";
import { ROOM_PURPOSE_INPUTS, ROOM_SIZE_INPUTS } from "../../mcp/structure-tools";
import { maestroRoutineTools } from "../../mcp/routine-tools";
import type { WriteQueue } from "../../store/write-queue";
import { HttpError } from "../http/errors";
import { JsonRecords } from "./records";

/** O que o Cyno manda em `propose_workspace` (em inglês; os tipos de sala e tamanhos viram os ids gravados). */
export type ProposalInput = {
  name: string;
  summary?: string;
  maestro?: { engine: string; model?: string; effort?: string };
  rooms: {
    name: string;
    purpose?: string;
    size?: string;
    teams: { name: string; focus: string; agents: { name: string; role?: string; engine?: string; model?: string; effort?: string; focus: string; connectors?: string[]; access?: { internet?: boolean; browser?: boolean; terminal?: boolean } }[] }[];
  }[];
  sites?: { domain: string; why?: string }[];
  connectors?: { id: string; why?: string }[];
  routines?: Record<string, unknown>[];
  notes?: string;
};

/** A partir de 12 agentes, o servidor avisa (cada agente real é uma CLI com memória própria). */
export const AGENT_COUNT_WARNING = 12;

export type ValidationContext = {
  engines: readonly EngineInfo[];
  simulated: boolean;
  /** Nomes dos workspaces que já existem (o nome do novo não pode repetir). */
  workspaceNames: readonly string[];
  /** Conectores cadastrados em algum workspace (id e nome): os que o pacote pode reaproveitar. */
  knownConnectors: readonly { id: string; name: string }[];
};

const lower = (text: string) => text.normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase();

/** A rotina de uma proposta tem os mesmos campos do `routine_propose`; o schema dele vem de uma instância sem estado (só lê o `input`). */
function routineSchema() {
  const tools = maestroRoutineTools({ state: { read: () => ({ rooms: [], teams: [], agents: [], tasks: [] }) }, routines: {} as never, now: () => new Date() });
  return tools.find((tool) => tool.name === "routine_propose")!.input;
}

/**
 * Valida o pacote ANTES de mostrar o cartão (por código, o modelo não decide): motor instalado, modelo que
 * existe no motor, nomes únicos, tipos de sala e tamanhos válidos, conectores conhecidos, rotinas com o
 * formato do `routine_propose`. Devolve o plano normalizado (padrões preenchidos: o que o dono vê é o que será
 * criado) e os avisos, ou lança `Error` com TODOS os problemas (em inglês, para o Cyno corrigir de uma vez).
 */
export function validateProposal(input: ProposalInput, context: ValidationContext): { plan: WorkspaceProposalPlan; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const name = workspaceNameSchema.safeParse(input.name);
  if (!name.success) errors.push(`name: ${name.error.issues[0]?.message ?? "invalid"}`);
  else if (context.workspaceNames.some((existing) => lower(existing) === lower(input.name))) errors.push(`A workspace named "${input.name}" already exists. Pick another name.`);

  const engineInfo = (engine: string) => context.engines.find((info) => info.engine === engine);
  /** Motor + modelo + esforço com os padrões do dono (Claude Sonnet; Antigravity Gemini 3.8 Flash). */
  const choice = (where: string, engine: string | undefined, model: string | undefined, effort: string | undefined): { engine: string; model?: string; effort?: string } => {
    const wanted = engine ?? "claude";
    const real = isCliEngine(wanted as AgentEngine);
    if (!real && !(wanted === "mock" && context.simulated)) {
      errors.push(`${where}: engine "${wanted}" is not supported (use ${context.engines.filter((info) => info.available && isCliEngine(info.engine)).map((info) => info.engine).join(" or ") || "an installed engine"}).`);
      return { engine: wanted };
    }
    if (wanted === "mock") return { engine: "mock" };
    const info = engineInfo(wanted);
    if (!info?.available) errors.push(`${where}: the ${ENGINE_LABELS[wanted as AgentEngine]} engine is not installed on this server${info?.reason ? ` (${info.reason})` : ""}. See get_catalog.`);
    // Só o Claude Code e o Antigravity têm modelo inicial; os outros (Freebuff, OpenClaw, Hermes) seguem o padrão do motor quando nada foi pedido.
    const fallback = wanted === "claude" || wanted === "gemini" ? ENGINE_FALLBACK_MODELS[wanted] : undefined;
    const chosenModel = model ?? fallback?.model;
    if (info && !info.freeModel && chosenModel !== undefined && !info.models.some((candidate) => candidate.id === chosenModel)) {
      errors.push(`${where}: model "${chosenModel}" does not exist for ${wanted}. Options: ${info.models.map((candidate) => candidate.id).join(", ")}.`);
    }
    const chosenEffort = effort ?? (model === undefined ? fallback?.effort : undefined);
    return { engine: wanted, ...(chosenModel !== undefined ? { model: chosenModel } : {}), ...(chosenEffort ? { effort: chosenEffort } : {}) };
  };

  const maestro = input.maestro ? choice("maestro", input.maestro.engine, input.maestro.model, input.maestro.effort) : undefined;

  const roomNames = new Set<string>();
  const teamNames = new Set<string>();
  const agentNames = new Set<string>();
  const connectorIds = new Set((input.connectors ?? []).map((connector) => lower(connector.id)));
  let agentCount = 0;
  const rooms = input.rooms.map((room, ri) => {
    if (roomNames.has(lower(room.name))) errors.push(`rooms[${ri}]: duplicate room name "${room.name}".`);
    roomNames.add(lower(room.name));
    const purposeKey = (room.purpose ?? "general") as keyof typeof ROOM_PURPOSE_INPUTS;
    const sizeKey = (room.size ?? "auto") as keyof typeof ROOM_SIZE_INPUTS;
    if (!(purposeKey in ROOM_PURPOSE_INPUTS)) errors.push(`rooms[${ri}].purpose "${room.purpose}" is not valid. Use: ${Object.keys(ROOM_PURPOSE_INPUTS).join(", ")} (see get_catalog).`);
    if (!(sizeKey in ROOM_SIZE_INPUTS)) errors.push(`rooms[${ri}].size "${room.size}" is not valid. Use: ${Object.keys(ROOM_SIZE_INPUTS).join(", ")}.`);
    const teams = room.teams.map((team, ti) => {
      if (teamNames.has(lower(team.name))) errors.push(`rooms[${ri}].teams[${ti}]: duplicate team name "${team.name}" (team names are unique in the workspace).`);
      teamNames.add(lower(team.name));
      if (team.agents.length === 0) warnings.push(`The team "${team.name}" has no agents.`);
      const agents = team.agents.map((agent, ai) => {
        const where = `rooms[${ri}].teams[${ti}].agents[${ai}] (${agent.name})`;
        agentCount += 1;
        if (agentNames.has(lower(agent.name))) errors.push(`${where}: duplicate agent name "${agent.name}" (agent names are unique in the workspace).`);
        agentNames.add(lower(agent.name));
        if (agent.name.length > 24) errors.push(`${where}: agent names have at most 24 characters.`);
        const picked = choice(where, agent.engine, agent.model, agent.effort);
        for (const ref of agent.connectors ?? []) if (!connectorIds.has(lower(ref))) errors.push(`${where}: connector "${ref}" is not in the proposal's connectors list. Add it there (with why) first.`);
        return {
          name: agent.name,
          role: (agent.role ?? "").slice(0, 60) || agent.focus.slice(0, 60),
          engine: picked.engine,
          ...(picked.model ? { model: picked.model } : {}),
          ...(picked.effort ? { effort: picked.effort } : {}),
          focus: agent.focus,
          connectors: agent.connectors ?? [],
          skills: [],
          ...(agent.access ? { access: agent.access } : {}),
        };
      });
      return { name: team.name, focus: team.focus, agents };
    });
    return {
      name: room.name,
      purpose: ROOM_PURPOSE_INPUTS[purposeKey as keyof typeof ROOM_PURPOSE_INPUTS]?.id ?? "geral",
      size: ROOM_SIZE_INPUTS[sizeKey as keyof typeof ROOM_SIZE_INPUTS] ?? "auto",
      teams,
    };
  });
  if (rooms.length === 0) errors.push("rooms: the workspace needs at least one room with a team and agents (a workspace with only a Maestro does not need a proposal: use create_workspace).");
  if (agentCount >= AGENT_COUNT_WARNING) warnings.push(`${agentCount} agents is a lot: each real agent is a CLI process that costs memory and subscription usage.`);

  const connectors = (input.connectors ?? []).map((connector) => {
    const known = context.knownConnectors.find((candidate) => lower(candidate.id) === lower(connector.id) || lower(candidate.name) === lower(connector.id));
    if (!known) warnings.push(`The connector "${connector.id}" is not registered anywhere yet: it will NOT be created with the workspace. After creating, register it with add_connector (the owner approves) and give it to the agents (set_agent_connectors, also with approval).`);
    return { id: known?.id ?? connector.id, why: connector.why ?? "" };
  });

  const schema = routineSchema();
  const routines = (input.routines ?? []).map((routine, index) => {
    const parsed = schema.safeParse(routine);
    if (!parsed.success) errors.push(`routines[${index}]: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "routine"}: ${issue.message}`).join("; ")}`);
    else {
      const data = parsed.data as { type: string; owner: string; kind?: string; site?: string; goal?: unknown; schedules?: unknown[]; tracking?: { statuses?: unknown[] } };
      if (!agentNames.has(lower(String(data.owner))) && !teamNames.has(lower(String(data.owner)))) errors.push(`routines[${index}].owner "${String(data.owner)}" must be the name of an agent or team of this proposal.`);
      // As mesmas exigências que a ferramenta de rotinas faz ao criar (senão a criação quebraria depois do OK).
      if (data.type === "goal" && (!data.goal || !data.kind || !data.site)) errors.push(`routines[${index}]: type "goal" needs goal:{target, period?}, kind (post, comment, invite, like, other) and site (e.g. "instagram.com").`);
      if (data.type === "tracking" && (!data.schedules?.length || !data.tracking?.statuses?.length)) errors.push(`routines[${index}]: type "tracking" needs at least one schedule and tracking.statuses.`);
    }
    return routine;
  });

  if (errors.length > 0) throw new Error(`The proposal was NOT shown to the owner. Fix these and call propose_workspace again:\n- ${errors.join("\n- ")}`);
  const plan = workspaceProposalPlanSchema.parse({
    name: input.name,
    summary: (input.summary ?? "").slice(0, 280),
    ...(maestro ? { maestro } : {}),
    rooms,
    sites: (input.sites ?? []).map((site) => ({ domain: site.domain, why: site.why ?? "" })),
    connectors,
    routines,
    ...(input.notes ? { notes: input.notes } : {}),
  });
  return { plan, warnings };
}

/**
 * As propostas de workspace (`data/platform/cyno/proposals.json`): a lista, as transições de estado e o
 * progresso da criação. NÃO cria nada: `executeProposal` faz isso, chamado pela rota do dono.
 */
export class ProposalBook {
  private constructor(
    private readonly records: JsonRecords<WorkspaceProposal>,
    private readonly now: () => Date,
  ) {}

  static async open(file: string, queue: WriteQueue, now: () => Date, onError?: (error: unknown) => void): Promise<ProposalBook> {
    const records = await JsonRecords.open<WorkspaceProposal>(
      file,
      queue,
      (raw) => {
        const parsed = workspaceProposalSchema.safeParse(raw);
        return parsed.success ? parsed.data : undefined;
      },
      onError,
    );
    // "Criando" que ficou no meio (o servidor caiu): a criação não é retomada, então vira "falhou".
    for (const proposal of records.all()) {
      if (proposal.status === "criando" || proposal.status === "aprovada") {
        proposal.status = "falhou";
        proposal.error = "O servidor reiniciou durante a criação: confira se o workspace existe e peça uma nova proposta se faltar.";
      }
    }
    return new ProposalBook(records, now);
  }

  list(limit = 20): WorkspaceProposal[] {
    return structuredClone(this.records.all().slice(-limit));
  }

  get(id: string): WorkspaceProposal | undefined {
    const found = this.records.all().find((proposal) => proposal.id === id);
    return found ? structuredClone(found) : undefined;
  }

  /** Grava uma proposta nova; `replaces` aposenta a anterior (ainda "proposta") como recusada, já que esta a substitui. */
  create(plan: WorkspaceProposalPlan, warnings: string[], replaces?: string): WorkspaceProposal {
    const all = this.records.all();
    const previous = replaces ? all.find((proposal) => proposal.id === replaces) : undefined;
    if (replaces && !previous) throw new HttpError(404, `Proposal ${replaces} does not exist.`);
    if (previous && previous.status !== "proposta" && previous.status !== "falhou") throw new HttpError(409, `Proposal ${replaces} is already ${previous.status}: it cannot be replaced. Make a new proposal without replaces.`);
    const at = this.now().toISOString();
    const next = all.reduce((max, item) => Math.max(max, Number(item.id.slice(2)) || 0), 0) + 1;
    const proposal = workspaceProposalSchema.parse({
      id: `P-${String(next).padStart(4, "0")}`,
      version: previous ? previous.version + 1 : 1,
      ...(replaces ? { replaces } : {}),
      status: "proposta",
      plan,
      warnings,
      createdAt: at,
      updatedAt: at,
    });
    if (previous) {
      previous.status = "recusada";
      previous.updatedAt = at;
    }
    this.records.add(proposal);
    return structuredClone(proposal);
  }

  /** Muda o estado (e opcionalmente o progresso/erro/workspace); devolve a cópia. */
  update(id: string, change: Partial<Pick<WorkspaceProposal, "status" | "progress" | "error" | "workspaceId">>): WorkspaceProposal {
    const found = this.records.all().find((proposal) => proposal.id === id);
    if (!found) throw new HttpError(404, "Proposta não encontrada");
    Object.assign(found, change, { updatedAt: this.now().toISOString() });
    if (change.error === undefined && "error" in change) delete found.error;
    this.records.save();
    return structuredClone(found);
  }
}
