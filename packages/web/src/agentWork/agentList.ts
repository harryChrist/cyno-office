import {
  agentEngine,
  isActiveTaskStatus,
  isCliEngine,
  isMaestroAgent,
  terminalStateView,
  type Agent,
  type AgentLogEntry,
  type AgentTerminalInfo,
  type OfficeState,
  type TerminalStateView,
} from "@cyno/shared";
import { liveSummary } from "../store/agentLog";
import type { TaskProgressMap } from "../store/taskProgress";
import { agentStatusLabel, truncate, type StatusTone } from "../ui/format";
import { engineLabel, lastActivity } from "./agentLogTimeline";

/** Uma linha da lista de agentes. */
export type AgentListRow = {
  agent: Agent;
  isMaestro: boolean;
  tone: StatusTone;
  statusLabel: string;
  /** O que ele está fazendo agora (ou o estado, se está livre). */
  activity: string;
  /** Subagentes rodando agora ("+2"). */
  activeSubagents: number;
  engine?: string;
  /** Indisponível agora ("sem cota · volta às 14:30"): as tarefas dele esperam. */
  unavailable?: string;
  /** Estado do terminal da CLI (só agentes reais): criado, ligado, desligado, com erro… */
  terminal?: TerminalStateView;
};

/** Um time dentro da sala (subdivisão leve da lista), com o líder, se houver. */
export type AgentListTeam = { key: string; teamName: string; leadName?: string; rows: AgentListRow[] };

/** Uma sala/projeto (o cabeçalho da lista) com os times dela. */
export type AgentListRoom = { key: string; roomName: string; teams: AgentListTeam[] };

export type AgentList = { maestro?: AgentListRow; rooms: AgentListRoom[]; total: number; working: number };

/** Todas as linhas da lista (fora o Maestro), na ordem. */
export function listRows(list: AgentList): AgentListRow[] {
  return list.rooms.flatMap((room) => room.teams.flatMap((team) => team.rows));
}

const TONES: Record<Agent["status"], StatusTone> = { idle: "neutral", working: "busy", waiting_approval: "attention", done: "success" };

/** Uma linha: estado, atividade (progresso ao vivo > último passo do log > a tarefa atual) e subagentes. */
export function agentListRow(office: OfficeState, agent: Agent, entries: readonly AgentLogEntry[], progress: TaskProgressMap, serverSubagents = 0): AgentListRow {
  const active = office.tasks.filter((task) => task.agentId === agent.id && isActiveTaskStatus(task.status));
  const current = active.find((task) => task.status !== "queued") ?? active[0];
  const live = current ? progress[current.id] : undefined;
  const summary = liveSummary(entries);
  const busy = agent.status === "working" || agent.status === "waiting_approval";
  const logLine = busy && summary.activeTaskId ? lastActivity(entries) : undefined;
  const activity = live?.message ?? logLine ?? (current ? `“${truncate(current.prompt, 70)}”` : agent.status === "idle" ? "Livre" : agentStatusLabel(agent, office.tasks));
  return {
    agent,
    isMaestro: isMaestroAgent(office, agent),
    tone: TONES[agent.status],
    statusLabel: agentStatusLabel(agent, office.tasks),
    activity,
    // O log carregado diz ao vivo; sem log ainda, vale o resumo do server.
    activeSubagents: busy ? (entries.length > 0 ? summary.activeSubagents : serverSubagents) : 0,
    engine: engineLabel(agent, entries),
  };
}

/**
 * Lista de agentes do workspace para a pílula de status: o Maestro à parte (vai primeiro) e os
 * outros agrupados por sala/projeto e, dentro dela, por time (na ordem do escritório).
 */
export function agentList(
  office: OfficeState,
  logs: Readonly<Record<string, readonly AgentLogEntry[]>>,
  progress: TaskProgressMap,
  summaries: Readonly<Record<string, { activeSubagents: number }>> = {},
  unavailable: Readonly<Record<string, { label: string; block?: { reason: string } }>> = {},
  terminals: Readonly<Record<string, AgentTerminalInfo>> = {},
): AgentList {
  const row = (agent: Agent): AgentListRow => {
    const base = agentListRow(office, agent, logs[agent.id] ?? [], progress, summaries[agent.id]?.activeSubagents ?? 0);
    const blocked = unavailable[agent.id];
    const engine = agentEngine(agent);
    const terminal = isCliEngine(engine) ? terminalStateView(engine, terminals[agent.id], blocked ? { label: blocked.label, ...(blocked.block ? { reason: blocked.block.reason } : {}) } : null) : undefined;
    return { ...base, ...(blocked ? { unavailable: blocked.label } : {}), ...(terminal ? { terminal } : {}) };
  };
  let maestro: AgentListRow | undefined;
  const rooms: AgentListRoom[] = [];
  const roomOrder = new Map(office.rooms.map((room, index) => [room.id, index]));
  const teams = [...office.teams].sort((a, b) => (roomOrder.get(a.roomId) ?? Infinity) - (roomOrder.get(b.roomId) ?? Infinity));
  for (const team of teams) {
    const members = office.agents.filter((agent) => agent.teamId === team.id);
    const rows: AgentListRow[] = [];
    for (const agent of members) {
      const current = row(agent);
      if (current.isMaestro) maestro = current;
      else rows.push(current);
    }
    if (rows.length === 0) continue;
    const lead = team.leadAgentId ? office.agents.find((agent) => agent.id === team.leadAgentId) : undefined;
    const entry: AgentListTeam = { key: team.id, teamName: team.name, ...(lead ? { leadName: lead.name } : {}), rows };
    const existing = rooms.find((room) => room.key === team.roomId);
    if (existing) existing.teams.push(entry);
    else rooms.push({ key: team.roomId, roomName: office.rooms.find((candidate) => candidate.id === team.roomId)?.name ?? team.roomId, teams: [entry] });
  }
  // Agentes de um time que sumiu (não deveria acontecer): ficam num grupo à parte.
  const known = new Set(office.teams.map((team) => team.id));
  const orphans = office.agents.filter((agent) => !known.has(agent.teamId)).map(row);
  if (orphans.length > 0) rooms.push({ key: "__sem-quarto", roomName: "Sem sala", teams: [{ key: "__sem-time", teamName: "Sem time", rows: orphans }] });
  return {
    maestro,
    rooms,
    total: office.agents.length,
    working: office.agents.filter((agent) => agent.status === "working").length,
  };
}
