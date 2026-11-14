import { clipPhrase, clipTitle, MAX_SCENE_SUBS, MAX_SCENE_TASKS, type SceneAgent, type SceneFrame, type SceneSub, type SceneTask, type SceneTaskCode, type SceneTool } from "./timeline";
import { engineBlockLabel, type EngineBlock } from "./models";
import { findMaestroAgent } from "./maestro";
import { fraseDeAtividade } from "./work-phrase";
import { isActiveTaskStatus, type Agent, type OfficeState, type Task } from "./types";
import { type AgentLogEntry } from "./agent-log";
import { type AgentTerminalInfo } from "./terminal";
import { type Blocked, type Project } from "./projects";
import { type ForYouItem } from "./for-you";
import { type TaskProgressInfo } from "./events";

/** A ferramenta que acabou há menos que isto ainda vale como "em uso" (mesma regra do adaptador da cena). */
export const TOOL_RECENT_MS = 8_000;
const DAY_MS = 24 * 3_600_000;

export type RememberedTool = { entryId: string; at: number; name: string; phrase: { icon: string; text: string }; running: boolean; error: boolean };
export type RememberedSub = SceneSub & { taskId: string };

/** O que o gravador lembra do log do agente: a última ferramenta do agente e os subagentes rodando. */
export type LogMemory = {
  tools: Map<string, RememberedTool>;
  subs: Map<string, Map<string, RememberedSub>>;
};

export const emptyLogMemory = (): LogMemory => ({ tools: new Map(), subs: new Map() });

export type FrameInput = {
  office: OfficeState;
  terminals: Readonly<Record<string, AgentTerminalInfo>>;
  forYou: readonly ForYouItem[];
  projects: readonly Project[];
  progress: Readonly<Record<string, TaskProgressInfo>>;
  /** Por que o motor do agente está indisponível agora (cota, CLI ausente). */
  block: (agent: Agent) => EngineBlock | undefined;
  log: LogMemory;
  now: number;
};

const time = (iso: string | undefined, fallback: number): number => {
  const value = iso ? Date.parse(iso) : Number.NaN;
  return Number.isFinite(value) ? value : fallback;
};
const firstLine = (text: string): string => clipTitle((text.split("\n").find((line) => line.trim()) ?? "").trim());

const CODE: Record<Task["status"], SceneTaskCode> = { queued: "q", in_progress: "a", waiting_approval: "w", done: "d", failed: "f" };

function projectTitle(task: Task, projects: readonly Project[]): string | undefined {
  if (!task.work) return undefined;
  return projects.find((project) => project.id === task.work!.projectId)?.tasks.find((item) => item.ref === task.work!.ref)?.title;
}

/** O bloqueio mais antigo de uma tarefa de projeto do agente (o que o adaptador usa para decidir o estado). */
function blockOf(agentId: string, projects: readonly Project[]): Blocked | undefined {
  let found: Blocked | undefined;
  for (const project of projects) {
    for (const task of project.tasks) {
      if (task.ownerId !== agentId || !task.blocked) continue;
      if (task.status === "concluida" || task.status === "falhou" || task.status === "cancelada") continue;
      if (!found || time(task.blocked.since, Infinity) < time(found.since, Infinity)) found = task.blocked;
    }
  }
  return found;
}

/**
 * O quadro de agora: os dados do Cyno de que o adaptador da cena precisa, em forma compacta. Pura (o relógio entra
 * por `now`). A ordem dos agentes é a do escritório; as tarefas vêm das mais urgentes para as mais velhas.
 */
export function buildSceneFrame(input: FrameInput): SceneFrame {
  const { office, now } = input;
  const maestro = findMaestroAgent(office);
  const frame: SceneFrame = { rooms: new Map(), teams: new Map(), agents: new Map() };
  for (const room of office.rooms) frame.rooms.set(room.id, { id: room.id, name: room.name, kind: room.kind, gx: room.gridPosition.x, gy: room.gridPosition.y });
  for (const team of office.teams) frame.teams.set(team.id, { id: team.id, roomId: team.roomId, name: team.name, ...(team.leadAgentId ? { lead: team.leadAgentId } : {}) });

  const pending = new Map<string, ForYouItem>();
  for (const item of input.forYou) if (item.status === "pendente" && !pending.has(item.agentId)) pending.set(item.agentId, item);

  const byAgent = new Map<string, Task[]>();
  for (const task of office.tasks) {
    if (!task.agentId) continue;
    const list = byAgent.get(task.agentId) ?? [];
    list.push(task);
    byAgent.set(task.agentId, list);
  }

  for (const agent of office.agents) {
    const mine = byAgent.get(agent.id) ?? [];
    // Uma passada só pelas tarefas do agente (a lista pode ter milhares): a ativa, as ativas, as feitas há pouco e os pedidos.
    let active: Task | undefined;
    const activeOnes: Task[] = [];
    const recent: Task[] = [];
    const allRequests: Task[] = [];
    const openTasks = new Set<string>();
    for (const task of mine) {
      if (task.status === "in_progress" || task.status === "waiting_approval") active = task;
      if (isActiveTaskStatus(task.status)) openTasks.add(task.id);
      if (task.role === "request") {
        if (isActiveTaskStatus(task.status)) allRequests.push(task);
        continue;
      }
      if (isActiveTaskStatus(task.status)) activeOnes.push(task);
      else if (recent.length < MAX_SCENE_TASKS && (task.status === "done" || (task.status === "failed" && task.outcome !== "cancelled")) && now - time(task.updatedAt, 0) <= DAY_MS) recent.push(task);
    }
    activeOnes.sort((a, b) => (a.status === "queued" ? 1 : 0) - (b.status === "queued" ? 1 : 0));
    const isMaestro = agent.id === maestro?.id;

    const scene: SceneAgent = { id: agent.id, name: agent.name, role: agent.role, teamId: agent.teamId, avatar: agent.avatar, status: agent.status };
    if (agent.engine) scene.engine = agent.engine;
    if (agent.model) scene.model = agent.model;

    const terminal = input.terminals[agent.id];
    if (terminal) {
      scene.terminal = { status: terminal.status };
      if (terminal.chatting) scene.terminal.chatting = true;
      if (terminal.error) scene.terminal.error = clipPhrase(terminal.error);
      if (terminal.status === "error") scene.terminal.at = time(terminal.updatedAt, now);
    }
    const block = input.block(agent);
    if (block) scene.unavailable = clipPhrase(engineBlockLabel(block, now));
    const ask = pending.get(agent.id);
    if (ask) scene.asking = clipPhrase(ask.title ?? ask.where ?? ask.to ?? ask.type);
    const blocked = blockOf(agent.id, input.projects);
    if (blocked) scene.blocked = { type: blocked.type, note: clipPhrase(blocked.note), ...(blocked.by ? { by: blocked.by } : {}), since: blocked.since };

    // ---- as tarefas: as ativas (fila por último), depois as feitas ou falhadas nas últimas 24 h
    const wall = isMaestro ? [] : [...activeOnes, ...recent].slice(0, MAX_SCENE_TASKS);
    const requests = allRequests.slice(0, 4);
    const toScene = (task: Task): SceneTask => ({
      id: task.id,
      s: CODE[task.status],
      title: projectTitle(task, input.projects) ?? firstLine(task.prompt),
      at: time(task.updatedAt, now),
      ...(task.role === "request" ? { rq: true as const } : {}),
    });
    const tasks = [...wall, ...requests].map(toScene);
    // A tarefa ativa tem de estar na lista mesmo se passou do corte.
    if (active && !tasks.some((task) => task.id === active.id)) tasks.push(toScene(active));
    if (tasks.length) scene.tasks = tasks;
    const progress = active ? input.progress[active.id] : undefined;
    if (progress && progress.message.trim()) scene.progress = { message: clipPhrase(progress.message), pct: Math.round(progress.progress * 100) };

    // ---- o Maestro esperando os times que pegaram os pedidos dele
    if (isMaestro) {
      const teams = requests.flatMap((request) => office.tasks.filter((sub) => sub.projectId === request.id && isActiveTaskStatus(sub.status)).map((sub) => sub.teamId));
      const unique = [...new Set(teams)].filter((id) => frame.teams.has(id));
      if (unique.length) scene.delegating = unique;
    }

    // ---- ferramenta em uso e subagentes
    const tool = input.log.tools.get(agent.id);
    if (tool && (tool.running || now - tool.at <= TOOL_RECENT_MS)) {
      const entry: SceneTool = { id: tool.entryId, at: tool.at, icon: tool.phrase.icon, text: clipPhrase(tool.phrase.text), name: tool.name };
      if (tool.error) entry.error = true;
      scene.tool = entry;
    }
    const subs = [...(input.log.subs.get(agent.id)?.values() ?? [])].filter((sub) => openTasks.has(sub.taskId)).slice(0, MAX_SCENE_SUBS);
    if (subs.length) scene.subs = subs.map(({ taskId: _taskId, ...sub }) => sub);

    frame.agents.set(agent.id, scene);
  }
  return frame;
}

/** Atualiza a memória do log com uma entrada (`agent:log`). Devolve se algo que o quadro usa pode ter mudado. */
export function rememberLogEntry(memory: LogMemory, entry: AgentLogEntry, now: number): boolean {
  if (entry.kind === "tool" && !entry.thread) {
    const phrase = entry.phrase ?? fraseDeAtividade({ name: entry.name, input: entry.input });
    memory.tools.set(entry.agentId, { entryId: entry.toolUseId, at: time(entry.at, now), name: entry.name, phrase, running: entry.status === "running", error: entry.status === "error" });
    return true;
  }
  if (entry.kind === "subagent") {
    const byAgent = memory.subs.get(entry.agentId) ?? new Map<string, RememberedSub>();
    const key = `${entry.taskId}:${entry.subagentId}`;
    if (entry.phase === "started") {
      byAgent.set(key, { id: entry.subagentId, label: clipPhrase(entry.label), goal: clipPhrase(entry.goal), at: time(entry.at, now), taskId: entry.taskId, ...(entry.model ? { model: entry.model } : {}) });
      memory.subs.set(entry.agentId, byAgent);
    } else byAgent.delete(key);
    return true;
  }
  return false;
}

/** Esquece o que é do agente que saiu do escritório. */
export function forgetAgentLog(memory: LogMemory, agentId: string): void {
  memory.tools.delete(agentId);
  memory.subs.delete(agentId);
}
