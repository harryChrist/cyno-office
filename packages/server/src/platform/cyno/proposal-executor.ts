import {
  createAgentBodySchema,
  createRoomBodySchema,
  createTeamBodySchema,
  findMaestroAgent,
  GLOBAL_BRAIN_ID,
  type AgentEngine,
  type AgentEffort,
  type RoomPurpose,
  type RoomSize,
  type RoomThemeId,
  type WorkspaceProposal,
} from "@cyno/shared";
import { avatarFromName, nextRoomTheme } from "../../mcp/structure-tools";
import { errorMessage } from "../../util/text";
import type { WorkspaceManager } from "../workspaces/manager";
import type { WorkspaceRuntime } from "../../workspace/runtime";

type Step = { step: string; done: boolean; error?: string };

export type ExecuteHost = {
  workspaces: Pick<WorkspaceManager, "create" | "remove" | "list" | "find" | "update">;
  /** Chamado a cada passo (o cartão mostra o progresso ao vivo). */
  progress: (steps: Step[]) => void;
};

export type ExecuteResult = { workspaceId: string; workspaceName: string; summary: string; pendingConnectors: string[]; logins: string[] };

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
const lower = (text: string) => text.normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase();

/**
 * Cria o pacote inteiro de uma proposta aprovada, por código, num passo a passo (workspace, salas, times,
 * agentes, conectores, rotinas, nota de logins). Qualquer falha DESFAZ tudo (o workspace criado sai da
 * plataforma, indo para a lixeira como uma exclusão) e o erro volta com o passo que quebrou. Nada aqui
 * passa pelo modelo: usa só o plano gravado na proposta.
 */
export async function executeProposal(proposal: WorkspaceProposal, host: ExecuteHost): Promise<ExecuteResult> {
  const plan = proposal.plan;
  const roomCount = plan.rooms.length;
  const teamCount = plan.rooms.reduce((total, room) => total + room.teams.length, 0);
  const agentCount = plan.rooms.reduce((total, room) => total + room.teams.reduce((sum, team) => sum + team.agents.length, 0), 0);
  const steps: Step[] = [
    { step: "Criar o workspace e o Maestro", done: false },
    { step: `Montar ${plural(roomCount, "sala", "salas")} e ${plural(teamCount, "time", "times")}`, done: false },
    { step: `Contratar ${plural(agentCount, "agente", "agentes")}`, done: false },
    ...(plan.connectors.length > 0 ? [{ step: "Conectores", done: false }] : []),
    ...(plan.routines.length > 0 ? [{ step: `Propor ${plural(plan.routines.length, "rotina", "rotinas")}`, done: false }] : []),
    { step: "Registrar a frase da ficha e os logins pendentes", done: false },
  ];
  let current = 0;
  const publish = () => host.progress(structuredClone(steps));
  const advance = () => {
    steps[current]!.done = true;
    current += 1;
    publish();
  };
  publish();

  let created: { id: string; name: string } | undefined;
  try {
    // 1. Workspace (com o Maestro no motor/modelo pedido).
    const workspace = await host.workspaces.create(plan.name, plan.maestro ? { choice: { engine: plan.maestro.engine as AgentEngine, ...(plan.maestro.model ? { model: plan.maestro.model } : {}), ...(plan.maestro.effort ? { effort: plan.maestro.effort as AgentEffort } : {}) } } : undefined);
    created = { id: workspace.id, name: workspace.name };
    const runtime = host.workspaces.find(workspace.id);
    if (!runtime) throw new Error("O workspace foi criado mas não abriu.");
    advance();

    // 2. Salas e times.
    const teamIds = new Map<string, string>();
    for (const room of plan.rooms) {
      const theme: RoomThemeId = nextRoomTheme(runtime.store.snapshot().rooms);
      const made = await runtime.services.rooms.create(createRoomBodySchema.parse({ name: room.name, theme, size: (room.size ?? "auto") as RoomSize, purpose: (room.purpose ?? "geral") as RoomPurpose }));
      const roomNow = made.size === room.size && made.purpose === room.purpose ? made : await runtime.services.rooms.update(made.id, { size: (room.size ?? "auto") as RoomSize, purpose: (room.purpose ?? "geral") as RoomPurpose });
      for (const team of room.teams) {
        const madeTeam = await runtime.services.teams.create(createTeamBodySchema.parse({ roomId: roomNow.id, name: team.name, focus: team.focus.slice(0, 120) || team.name }));
        teamIds.set(lower(team.name), madeTeam.id);
      }
    }
    advance();

    // 3. Agentes (o primeiro de cada time lidera).
    const agentIdsByName = new Map<string, string>();
    for (const room of plan.rooms) {
      for (const team of room.teams) {
        let lead: string | undefined;
        for (const agent of team.agents) {
          const real = agent.engine !== "mock";
          const made = await runtime.services.agents.create(
            createAgentBodySchema.parse({
              teamId: teamIds.get(lower(team.name)),
              name: agent.name,
              role: agent.role || agent.focus.slice(0, 60) || agent.name,
              instructions: agent.focus,
              avatar: avatarFromName(agent.name),
              ...(real ? { engine: agent.engine, ...(agent.model ? { model: agent.model } : {}), ...(agent.effort ? { effort: agent.effort } : {}) } : {}),
              ...(agent.access?.internet !== undefined ? { internet: agent.access.internet } : {}),
              ...(agent.access?.browser !== undefined ? { browser: agent.access.browser } : {}),
              ...(agent.access?.terminal !== undefined ? { terminal: agent.access.terminal } : {}),
            }),
          );
          agentIdsByName.set(lower(agent.name), made.id);
          lead ??= made.id;
        }
        if (lead) await runtime.services.teams.update(teamIds.get(lower(team.name))!, { leadAgentId: lead });
      }
    }
    advance();

    // 4. Conectores: os que já estão liberados a outro workspace são liberados também a este (mesmas credenciais); os que não existem ficam para depois.
    const pendingConnectors: string[] = [];
    if (plan.connectors.length > 0) {
      const connectorIds = new Map<string, string>();
      for (const connector of plan.connectors) {
        const source = findConnectorSource(host, connector.id, workspace.id);
        if (!source) {
          pendingConnectors.push(connector.id);
          continue;
        }
        // O conector já está na Biblioteca: basta liberá-lo ao workspace novo (as credenciais são as mesmas).
        const copy = await runtime.connectors.adopt(source.id, "cyno");
        connectorIds.set(lower(connector.id), copy.id);
      }
      for (const room of plan.rooms) {
        for (const team of room.teams) {
          for (const agent of team.agents) {
            const ids = agent.connectors.flatMap((ref) => connectorIds.get(lower(ref)) ?? []);
            if (ids.length > 0) await runtime.connectors.setAgentConnectors(agentIdsByName.get(lower(agent.name))!, ids);
          }
        }
      }
      advance();
    }

    // 5. Rotinas, como propostas no Para você (nada roda até o dono aprovar lá).
    if (plan.routines.length > 0) {
      const maestro = findMaestroAgent(runtime.store.snapshot());
      if (!maestro) throw new Error("O Maestro do workspace novo não foi encontrado.");
      for (const routine of plan.routines) {
        const tool = runtime.officeTools(maestro.id).find((candidate) => candidate.name === "routine_propose");
        if (!tool) throw new Error("A ferramenta de rotinas não está disponível neste workspace.");
        const result = await tool.call(routine);
        if (result.isError) throw new Error(`Rotina "${String(routine.title ?? "?")}": ${result.text}`);
      }
      advance();
    }

    // 6. A frase da ficha e a nota com os logins que dependem do dono.
    if (plan.summary) await runtime.cardSummary.write(plan.summary, "cyno");
    const logins = plan.sites.map((site) => site.domain);
    if (logins.length > 0) await writeLoginsNote(runtime, plan.sites);
    advance();

    const parts = [plural(roomCount, "sala", "salas"), plural(teamCount, "time", "times"), plural(agentCount, "agente", "agentes"), ...(plan.routines.length > 0 ? [`${plural(plan.routines.length, "rotina proposta", "rotinas propostas")} (aguardam o seu OK no Para você)`] : [])];
    return { workspaceId: workspace.id, workspaceName: workspace.name, summary: `Workspace "${workspace.name}" criado: ${parts.join(", ")}.`, pendingConnectors, logins };
  } catch (error) {
    steps[Math.min(current, steps.length - 1)]!.error = errorMessage(error).slice(0, 280);
    publish();
    let undone = "";
    if (created) {
      try {
        await host.workspaces.remove(created.id);
        undone = " O que já tinha sido criado foi desfeito (o workspace saiu da plataforma).";
      } catch (rollback) {
        undone = ` Atenção: não consegui desfazer o workspace "${created.name}" (${errorMessage(rollback)}); apague-o à mão.`;
      }
    }
    throw new ProposalFailed(`Falhou em "${steps[Math.min(current, steps.length - 1)]!.step}": ${errorMessage(error)}.${undone}`, steps);
  }
}

/** A criação falhou e foi desfeita; `steps` mostra onde. */
export class ProposalFailed extends Error {
  constructor(
    message: string,
    readonly steps: Step[],
  ) {
    super(message);
  }
}

function findConnectorSource(host: ExecuteHost, ref: string, except: string) {
  for (const workspace of host.workspaces.list()) {
    if (workspace.id === except) continue;
    const runtime = host.workspaces.find(workspace.id);
    const found = runtime?.connectors.list().find((connector) => lower(connector.id) === lower(ref) || lower(connector.name) === lower(ref));
    if (found) return found;
  }
  return undefined;
}

async function writeLoginsNote(runtime: WorkspaceRuntime, sites: { domain: string; why: string }[]): Promise<void> {
  const lines = ["# Logins pendentes", "", "Estes sites precisam de login feito pelo dono (o login é sempre manual, no navegador do workspace):", "", ...sites.map((site) => `- ${site.domain}${site.why ? `: ${site.why}` : ""}`), ""];
  await runtime.brain.writeRootNote(GLOBAL_BRAIN_ID, "logins-pendentes.md", lines.join("\n"), { replace: false });
}
