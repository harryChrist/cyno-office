// O quadro gravado -> a entrada do adaptador `montarRetrato` (a reprodução passa pelo mesmo adaptador do ao vivo).
// O quadro tem só o que o adaptador usa; aqui ele vira os objetos do Cyno que o adaptador espera, com o que não
// foi gravado vazio (texto da tarefa além do título, log, tokens).
import type { Agent, AgentLogThread, AgentTerminalInfo, ForYouItem, OfficeState, Project, Room, SceneAgent, SceneFrame, SceneTask, Task, Team } from "@cyno/shared";
import { tipoDaFerramenta, type EntradaDoRetrato, type FerramentaEmUso } from "../adaptador/retrato";

const iso = (ms: number): string => new Date(ms).toISOString();
const STATUS: Record<SceneTask["s"], Task["status"]> = { q: "queued", a: "in_progress", w: "waiting_approval", d: "done", f: "failed" };

/** Entrada do adaptador para o quadro `frame` no instante `agora` (sem a identidade do workspace). */
export function entradaDoQuadro(frame: SceneFrame, agora: number): Omit<EntradaDoRetrato, "workspaceId" | "workspaceName"> {
  const rooms: Room[] = [...frame.rooms.values()]
    .map((room) => ({ id: room.id, kind: room.kind, name: room.name, theme: "", gridPosition: { x: room.gx, y: room.gy }, readsGlobalBrain: false, readsBrainsOf: [] }) satisfies Room)
    .sort((a, b) => a.gridPosition.y - b.gridPosition.y || a.gridPosition.x - b.gridPosition.x);
  const teams: Team[] = [...frame.teams.values()].map((team) => ({ id: team.id, roomId: team.roomId, name: team.name, focus: "", ...(team.lead ? { leadAgentId: team.lead } : {}) }));
  const roomOf = (teamId: string): string => frame.teams.get(teamId)?.roomId ?? "?";

  const agents: Agent[] = [];
  const tasks: Task[] = [];
  const terminals: Record<string, AgentTerminalInfo> = {};
  const indisponiveis: Record<string, { label: string }> = {};
  const progress: Record<string, { agentId: string; progress: number; message: string }> = {};
  const ferramentas: Record<string, FerramentaEmUso> = {};
  const subagentes: Record<string, AgentLogThread[]> = {};
  const forYou: ForYouItem[] = [];
  const projects: Project[] = [];

  for (const scene of frame.agents.values() as Iterable<SceneAgent>) {
    agents.push({ id: scene.id, teamId: scene.teamId, name: scene.name, role: scene.role, instructions: "", avatar: scene.avatar, status: scene.status, ...(scene.engine ? { engine: scene.engine } : {}), ...(scene.model ? { model: scene.model } : {}) });
    let activeId: string | undefined;
    for (const task of scene.tasks ?? []) {
      tasks.push({
        id: task.id,
        roomId: roomOf(scene.teamId),
        teamId: scene.teamId,
        agentId: scene.id,
        ...(task.rq ? { role: "request" as const } : {}),
        prompt: task.title,
        status: STATUS[task.s],
        createdAt: iso(task.at),
        updatedAt: iso(task.at),
      });
      if (task.s === "a" || task.s === "w") activeId = task.id;
    }
    if (scene.delegating?.length) {
      const request = (scene.tasks ?? []).find((task) => task.rq);
      if (request) for (const teamId of scene.delegating) tasks.push({ id: `dlg:${request.id}:${teamId}`, roomId: roomOf(teamId), teamId, projectId: request.id, prompt: "", status: "in_progress", createdAt: iso(agora), updatedAt: iso(agora) });
    }
    if (activeId && scene.progress) progress[activeId] = { agentId: scene.id, progress: scene.progress.pct / 100, message: scene.progress.message };
    if (scene.terminal) terminals[scene.id] = { agentId: scene.id, engine: scene.engine ?? "mock", status: scene.terminal.status, ...(scene.terminal.chatting ? { chatting: true } : {}), ...(scene.terminal.error ? { error: scene.terminal.error } : {}), updatedAt: iso(scene.terminal.at ?? agora) };
    if (scene.unavailable) indisponiveis[scene.id] = { label: scene.unavailable };
    if (scene.asking) forYou.push({ id: `ask:${scene.id}`, agentId: scene.id, roomId: roomOf(scene.teamId), type: "pergunta", status: "pendente", title: scene.asking, meta: {}, text: "", originalText: "", editedByUser: false } as ForYouItem);
    if (scene.blocked) {
      projects.push({ id: `blk:${scene.id}`, title: "", tasks: [{ ref: "1", title: "", ownerId: scene.id, status: "em_andamento", blocked: { type: scene.blocked.type, note: scene.blocked.note, ...(scene.blocked.by ? { by: scene.blocked.by } : {}), since: scene.blocked.since } }] } as unknown as Project);
    }
    if (scene.tool) ferramentas[scene.id] = { id: scene.tool.id, quando: scene.tool.at, icon: scene.tool.icon, text: scene.tool.text, kind: tipoDaFerramenta(scene.tool.name), tool: scene.tool.name, ...(scene.tool.error ? { error: true } : {}) };
    if (scene.subs?.length) subagentes[scene.id] = scene.subs.map((sub) => ({ id: sub.id, label: sub.label, goal: sub.goal, status: "running" as const, startedAt: iso(sub.at), ...(sub.model ? { model: sub.model } : {}) }));
  }

  const office: OfficeState = { rooms, teams, agents, tasks };
  return { office, progress, forYou, projects, terminals, logs: {}, indisponiveis, ferramentas, subagentes, agora };
}
