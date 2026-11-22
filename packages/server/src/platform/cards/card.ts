import {
  blockedLeaves,
  DAY_MS,
  expandAvulsas,
  isDeadlineAtRisk,
  isProjectTaskFinished,
  leavesOf,
  findMaestroAgent,
  nextSlots,
  pendingForYou,
  releaseHold,
  type AgentTerminalInfo,
  type Card,
  type CardAgent,
  type CardMetrics,
  type CardProject,
  type CardSummary,
  type Connector,
  type ForYouItem,
  type OfficeState,
  type Project,
  type Routine,
  type SubscriptionUsage,
  type WorkspaceAccess,
} from "@cyno/shared";
import { computeMetrics, type MetricsSnapshot } from "../../workspace/metrics/compute";

/** Quantas entregas e projetos em andamento a ficha mostra (o resto fica nas contagens). */
export const CARD_LIMITS = { deliveries: 5, activeProjects: 6, routines: 8, sites: 8 } as const;

/** Tudo o que a ficha lê do workspace, já tirado dos serviços (assim `buildCard` é pura e testável em tabela). */
export type CardInput = {
  workspace: string;
  name: string;
  summary: CardSummary;
  office: Pick<OfficeState, "rooms" | "teams" | "agents">;
  terminals: Record<string, Pick<AgentTerminalInfo, "status">>;
  access: Pick<WorkspaceAccess, "allowedDomains">;
  connectors: Pick<Connector, "id" | "name" | "enabled" | "agentIds">[];
  routines: Routine[];
  projects: Project[];
  forYou: ForYouItem[];
  /** Motores indisponíveis (cota esgotada ou CLI ausente): o motor entra em `engines` com `available: false`. */
  engineBlocked: (engine: string) => boolean;
  usage: SubscriptionUsage[];
  /** Turnos dos agentes do workspace na janela de 5 h. */
  turns5h: number;
  /** O que o `computeMetrics` lê (sem ele a ficha sai sem `metrics`). O `usage` aqui só precisa dos últimos 7 dias. */
  metrics?: MetricsSnapshot;
  now: Date;
};

/**
 * Os números da Gestão para a ficha: o MESMO `computeMetrics` da aba Gestão (e da rota `/metrics`) com a janela padrão (7 dias para
 * contagens e gasto, 28 para a mediana), em modo leve (sem retrospectiva e sem previsão). Por isso os números batem com os da Gestão.
 */
export function cardMetrics(snapshot: MetricsSnapshot, now: number): CardMetrics {
  const report = computeMetrics(snapshot, { now, light: true });
  const atRisk = expandAvulsas([...snapshot.projects]).filter((project) => {
    if (!isDeadlineAtRisk(project, now)) return false;
    const open = leavesOf(project).filter((leaf) => !isProjectTaskFinished(leaf) && !leaf.archived);
    return open.length === 0 || open.some((leaf) => !releaseHold(leaf));
  }).length;
  return {
    throughput7d: report.throughput.n,
    throughputPrev7d: report.throughput.prevN,
    medianCycleMs: report.cycleTime.value,
    oldestWaitMs: report.approvalWait.pending.oldestMs,
    waiting: report.approvalWait.pending.count,
    blocked: report.blockedNow.count,
    atRisk,
    weekCostUsd: report.spend.usd,
  };
}

/** Arredondado para o centavo de dólar: a ficha só muda quando o gasto muda de verdade. */
const cents = (usd: number): number => Math.round(usd * 100) / 100;
export const CARD_METRICS_WINDOW_MS = 8 * DAY_MS;

const terminalOf = (status: string | undefined): CardAgent["terminal"] => {
  switch (status) {
    case "starting":
      return "starting";
    case "idle":
      return "ready";
    case "busy":
      return "busy";
    case "error":
      return "error";
    default:
      return "stopped";
  }
};

/** Etapa atual de um projeto: o que a primeira tarefa em curso faz agora (ou a próxima liberada a rodar). */
function stageOf(project: Project): string | undefined {
  const task = project.tasks.find((candidate) => candidate.status === "em_andamento" || candidate.status === "esperando_voce") ?? project.tasks.find((candidate) => (candidate.status === "a_fazer" || candidate.status === "backlog") && !releaseHold(candidate));
  if (!task) return undefined;
  const step = task.steps[task.current];
  return step?.what ? `${task.title}: ${step.what}` : task.title;
}

function projectOf(project: Project): CardProject {
  const total = project.tasks.length;
  const done = project.tasks.filter((task) => task.status === "concluida").length;
  const stage = stageOf(project);
  return { id: project.id, title: project.title, ...(stage ? { stage } : {}), ...(total > 0 ? { done, total } : {}), ...(project.dueAt ? { dueAt: project.dueAt } : {}), status: project.status };
}

/**
 * A ficha de um workspace, montada só com código (sem IA): equipe com motor/modelo, sites declarados,
 * conectores, rotinas ativas e próximos horários, projetos em andamento, últimas entregas, o que
 * espera o dono e o uso. A frase "o que este workspace faz" vem de fora (`summary`).
 */
export function buildCard(input: CardInput): Card {
  const { office, now } = input;
  const maestro = findMaestroAgent(office);
  const team: CardAgent[] = office.agents
    .filter((agent) => agent.id !== maestro?.id)
    .map((agent) => ({
      id: agent.id,
      name: agent.name,
      engine: agent.engine ?? "mock",
      ...(agent.model ? { model: agent.model } : {}),
      ...(agent.role ? { focus: agent.role } : {}),
      terminal: terminalOf(input.terminals[agent.id]?.status),
    }));
  const maestroStatus = input.terminals[maestro?.id ?? ""]?.status;
  const maestroInfo: Card["team"]["maestro"] = {
    engine: maestro?.engine ?? "mock",
    ...(maestro?.model ? { model: maestro.model } : {}),
    status: maestroStatus === "busy" ? "ocupado" : maestroStatus === "idle" || maestroStatus === "starting" ? "ocioso" : "parado",
  };

  const engines = [...new Set([maestroInfo.engine, ...team.map((agent) => agent.engine)])]
    .filter((engine) => engine !== "mock")
    .sort()
    .map((engine) => ({ engine, available: !input.engineBlocked(engine) }));

  // Sites: só os declarados (rotinas ativas e a lista de domínios liberados). O login não é conferido: a v1 avisa.
  const siteSet = new Set<string>();
  for (const routine of input.routines) if (routine.status === "ativa" && routine.site) siteSet.add(routine.site.toLowerCase());
  for (const domain of input.access.allowedDomains) siteSet.add(domain.toLowerCase());
  const sites = [...siteSet].sort().slice(0, CARD_LIMITS.sites).map((domain) => ({ domain, login: "nao-verificado" as const }));

  const nameOf = (id: string) => office.agents.find((agent) => agent.id === id)?.name ?? id;
  const connectors = input.connectors.filter((connector) => connector.enabled).map((connector) => ({ id: connector.id, usedBy: connector.agentIds.map(nameOf) }));

  const routines = input.routines
    .filter((routine) => routine.status === "ativa")
    .slice(0, CARD_LIMITS.routines)
    .map((routine) => {
      const next = nextSlots(routine, now, 1)[0]?.at;
      return { id: routine.id, title: routine.title, type: routine.type, ...(next ? { next } : {}), ...(routine.type === "meta" && routine.target ? { target: routine.target, unit: routine.unit, period: routine.period } : {}) };
    });

  const counts: Record<string, number> = {};
  for (const project of input.projects) counts[project.status] = (counts[project.status] ?? 0) + 1;
  const blockedIds = input.projects.filter((project) => project.status === "ativo" || project.status === "pausado" || project.status === "proposto").flatMap((project) => blockedLeaves(project).map((leaf) => `${project.id}/${leaf.ref}`));
  const blockedCount = blockedIds.length;
  const active = input.projects.filter((project) => project.status === "ativo").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const deliveries = input.projects
    .filter((project) => project.status === "concluido")
    .map((project) => ({ title: project.title, at: project.finishedAt ?? project.updatedAt }))
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, CARD_LIMITS.deliveries);

  const provider = maestroInfo.engine;
  const window = input.usage.find((usage) => usage.provider === provider)?.windows.find((candidate) => candidate.id === "five_hour");

  return {
    workspace: input.workspace,
    name: input.name,
    summary: input.summary,
    team: { rooms: office.rooms.filter((room) => room.kind !== "maestro").map((room) => ({ id: room.id, name: room.name })), agents: team, maestro: maestroInfo },
    engines,
    sites,
    connectors,
    routines,
    projects: { active: active.slice(0, CARD_LIMITS.activeProjects).map(projectOf), counts },
    deliveries,
    // As subtarefas travadas (dependência cancelada ou que falhou) também esperam o dono.
    waitingForYou: pendingForYou(input.forYou).length + blockedCount,
    waitingIds: [...pendingForYou(input.forYou).map((item) => item.id), ...blockedIds],
    usage: { ...(window ? { windowPercent: Math.round(window.utilization * 100), windowEngine: provider } : {}), turns5h: input.turns5h },
    ...(input.metrics ? { metrics: ((m) => ({ ...m, weekCostUsd: cents(m.weekCostUsd) }))(cardMetrics(input.metrics, now.getTime())) } : {}),
    updatedAt: now.toISOString(),
  };
}
