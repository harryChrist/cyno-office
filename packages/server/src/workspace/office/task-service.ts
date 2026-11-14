import { randomUUID } from "node:crypto";
import {
  isMaestroTask,
  maestroTeamIds,
  type BrainContext,
  type createTaskBodySchema,
  type listTasksQuerySchema,
  type MaestroMessageResponse,
  type Task,
} from "@cyno/shared";
import type { z } from "zod";
import { routeTask } from "./routing";
import type { ServiceDeps } from "./deps";
import { requireTeam } from "./lookup";

type CreateInput = z.output<typeof createTaskBodySchema>;
type ListQuery = z.output<typeof listTasksQuerySchema>;

export class TaskService {
  constructor(private readonly deps: ServiceDeps) {}

  /** Tarefas em ordem de criação, filtradas por quarto e/ou agente. */
  list(query: ListQuery): Task[] {
    return this.deps.state
      .read()
      .tasks.filter(
        (task) =>
          (query.roomId === undefined || task.roomId === query.roomId) &&
          (query.agentId === undefined || task.agentId === query.agentId),
      );
  }

  /**
   * Sem time: o pedido vai para o Maestro (triagem e delegação). Com `teamId` (atalho): cria a
   * tarefa já com o agente escolhido por routeTask e a coloca na fila dele. Mandar para a
   * Gerência é o mesmo que mandar para o Maestro.
   */
  async create(input: CreateInput, extra: { routineId?: string; agentId?: string } = {}): Promise<Task> {
    if (input.teamId === undefined) return this.deps.maestro.submit(input.prompt);
    const state = this.deps.state.read();
    if (maestroTeamIds(state).has(input.teamId)) return this.deps.maestro.submit(input.prompt);
    const roomId = input.roomId ?? requireTeam(state.teams, input.teamId).roomId;
    // `extra.agentId` (o vigia de rotinas): o dono da rotina, sem passar pelo roteamento do time.
    const agentId = extra.agentId ?? routeTask(state, { roomId, teamId: input.teamId });
    const at = this.deps.now().toISOString();
    const task: Task = {
      id: randomUUID(),
      roomId,
      teamId: input.teamId,
      agentId,
      prompt: input.prompt,
      ...(extra.routineId ? { routineId: extra.routineId } : {}),
      status: "queued",
      createdAt: at,
      updatedAt: at,
    };
    state.tasks.push(task);
    await this.deps.state.commit({ tasks: state.tasks, events: [{ type: "task:upserted", task }] });
    this.deps.orchestrator.enqueue(agentId);
    return task;
  }

  /** Mensagem para o Maestro (conversa; no Maestro simulado, vira pedido). Veja MaestroCoordinator.message. */
  message(text: string): Promise<MaestroMessageResponse> {
    return this.deps.maestro.message(text);
  }

  /**
   * Atalho de aprovação. Tarefa do Maestro: quem decide é ele (veja MaestroCoordinator.approve);
   * as outras: aprova ou rejeita o item ligado no "Para você", que decide a tarefa.
   */
  approve(id: string, approved: boolean): Promise<Task> {
    const state = this.deps.state.read();
    const task = state.tasks.find((candidate) => candidate.id === id);
    if (task && isMaestroTask(state, task)) return this.deps.maestro.approve(id, approved);
    return this.deps.forYou.decideTask(id, approved);
  }

  /** Fecha um pedido do Maestro pelo usuário (veja MaestroCoordinator.closeRequest). */
  close(id: string, mode: "concluir" | "cancelar", note?: string): Promise<Task> {
    return this.deps.maestro.closeRequest(id, mode, note);
  }

  context(roomId: string): Promise<BrainContext> {
    return this.deps.brain.buildContext(roomId);
  }
}
