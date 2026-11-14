import {
  isActiveTaskStatus,
  isMaestroRoom,
  RESERVED_ROOM_IDS,
  uniqueSlug,
  type createRoomBodySchema,
  type ForYouItem,
  type OfficeState,
  type ServerEvent,
  type updateBrainSharingBodySchema,
  type updateFurnitureBodySchema,
  type updateRoomBodySchema,
  type Room,
  type RoomDeletionPreview,
} from "@cyno/shared";
import type { z } from "zod";
import { dropForYouItems } from "../for-you/service";
import { officeStructure } from "../../store/state-manager";
import { CANCEL_REASONS, failActiveTasks } from "./cancel";
import { applyReadsBrainsOf } from "./brain-sharing";
import type { ServiceDeps } from "./deps";
import { assertCellFree, findFreeCell } from "./grid";
import { definedFields, requireRoom } from "./lookup";
import { MAESTRO_RULES, maestroConflict } from "./maestro";

type CreateInput = z.output<typeof createRoomBodySchema>;
type UpdateInput = z.output<typeof updateRoomBodySchema>;
type BrainSharingInput = z.output<typeof updateBrainSharingBodySchema>;
type FurnitureInput = z.output<typeof updateFurnitureBodySchema>;

const upserted = (room: Room): ServerEvent => ({ type: "room:upserted", room });

export class RoomService {
  constructor(private readonly deps: ServiceDeps) {}

  /**
   * Novo quarto: id = slug do nome, sem repetir quartos atuais nem pastas de Cérebro
   * antigas no disco (um quarto novo nunca herda as notas de um quarto removido).
   */
  async create(input: CreateInput): Promise<Room> {
    const brainIds = await this.deps.brain.brainIds();
    const state = this.deps.state.read();
    const gridPosition = input.gridPosition ?? findFreeCell(state.rooms);
    assertCellFree(state.rooms, gridPosition);
    const taken = [...state.rooms.map((ws) => ws.id), ...brainIds];
    const room: Room = {
      id: uniqueSlug(input.name, taken, RESERVED_ROOM_IDS),
      kind: "team",
      name: input.name,
      theme: input.theme,
      gridPosition,
      readsGlobalBrain: input.readsGlobalBrain ?? false,
      readsBrainsOf: [],
      // Sem os campos = "auto"/"geral" (quartos antigos); o que vier no pedido fica gravado.
      ...(input.size ? { size: input.size } : {}),
      ...(input.purpose ? { purpose: input.purpose } : {}),
      ...(input.layoutSeed !== undefined ? { layoutSeed: input.layoutSeed } : {}),
    };
    state.rooms.push(room);
    await this.deps.state.commit({ office: officeStructure(state), events: [upserted(room)] });
    await this.deps.brain.ensureBrain(room.id);
    return room;
  }

  async update(id: string, input: UpdateInput): Promise<Room> {
    const state = this.deps.state.read();
    const room = requireRoom(state.rooms, id);
    if (input.gridPosition) assertCellFree(state.rooms, input.gridPosition, id);
    // Semente nova = outra arrumação: os ajustes manuais dos móveis (feitos sobre a antiga) saem.
    if (input.layoutSeed !== undefined && input.layoutSeed !== room.layoutSeed) delete room.furnitureEdits;
    // Tamanho e tipo são só o piso inicial e os móveis: nunca recusam nada (a sala cresce sozinha).
    Object.assign(room, definedFields(input));
    await this.deps.state.commit({ office: officeStructure(state), events: [upserted(room)] });
    return room;
  }

  /**
   * Ajustes manuais dos móveis (editor "Editar móveis"): troca a lista inteira. A validação de cada
   * ajuste contra o layout é do web (o gerador mora lá); os que não couberem são pulados ao desenhar.
   * Lista vazia = volta ao layout gerado.
   */
  async setFurnitureEdits(id: string, input: FurnitureInput): Promise<Room> {
    const state = this.deps.state.read();
    const room = requireRoom(state.rooms, id);
    if (input.edits.length > 0) room.furnitureEdits = input.edits;
    else delete room.furnitureEdits;
    await this.deps.state.commit({ office: officeStructure(state), events: [upserted(room)] });
    return room;
  }

  /**
   * Compartilhamento do Cérebro: lê o Cérebro global? e/ou a lista completa de quartos cujos
   * Cérebros ele lê (não simétrica). As portas não são configuráveis: são automáticas.
   */
  async setBrainSharing(id: string, input: BrainSharingInput): Promise<Room> {
    const state = this.deps.state.read();
    const room = requireRoom(state.rooms, id);
    if (input.readsBrainsOf) applyReadsBrainsOf(state.rooms, id, input.readsBrainsOf);
    if (input.readsGlobalBrain !== undefined) room.readsGlobalBrain = input.readsGlobalBrain;
    await this.deps.state.commit({ office: officeStructure(state), events: [upserted(room)] });
    return room;
  }

  /** O que o DELETE do quarto apagaria (a confirmação do web mostra a lista). */
  async deletionPreview(id: string): Promise<RoomDeletionPreview> {
    const state = this.deps.state.read();
    const scope = roomScope(state, id);
    const forYouItems = this.deps.state.readForYou().filter(scope.ownsForYou).length;
    const [brainNotes, logs] = await Promise.all([this.deps.cleanup.countBrainNotes(id), this.deps.cleanup.countTaskLogs(scope.taskIds)]);
    return {
      teams: scope.teamIds.size,
      agents: scope.agentIds.length,
      tasks: scope.taskIds.length,
      activeTasks: state.tasks.filter((task) => task.roomId === id && isActiveTaskStatus(task.status)).length,
      brainNotes,
      forYouItems,
      calendarEvents: this.deps.calendar.countByRoom(id),
      logs,
    };
  }

  /**
   * Cascata: cancela as tarefas ativas e remove tarefas, agentes e times do quarto; tira o
   * quarto da lista de Cérebros lidos pelos outros; apaga os itens do "Para você" e os eventos do calendário do
   * quarto e, no disco, o Cérebro do quarto, os logs das tarefas e as pastas dos agentes (os
   * terminais param antes). Nada fica guardado.
   */
  async remove(id: string): Promise<void> {
    const state = this.deps.state.read();
    const { teamIds, agentIds, taskIds, ownsForYou } = roomScope(state, id);
    this.deps.orchestrator.detachAgents(agentIds, CANCEL_REASONS.room);
    const inRoom = (task: { roomId: string }) => task.roomId === id;
    const at = this.deps.now().toISOString();
    // As tarefas ativas viram failed (os clientes veem o cancelamento) e depois saem junto com o quarto.
    const cancelled = failActiveTasks(state.tasks, inRoom, CANCEL_REASONS.room, at);

    const peers = state.rooms.filter((ws) => ws.readsBrainsOf.includes(id));
    for (const peer of peers) peer.readsBrainsOf = peer.readsBrainsOf.filter((peerId) => peerId !== id);
    const next: OfficeState = {
      rooms: state.rooms.filter((ws) => ws.id !== id),
      teams: state.teams.filter((team) => !teamIds.has(team.id)),
      agents: state.agents.filter((agent) => !teamIds.has(agent.teamId)),
      tasks: state.tasks.filter((task) => !inRoom(task)),
    };
    const removedTasks = next.tasks.length !== state.tasks.length;
    const forYou = dropForYouItems(this.deps.state.readForYou(), ownsForYou);
    const events: ServerEvent[] = [
      ...cancelled,
      ...forYou.events,
      ...agentIds.map((agentId): ServerEvent => ({ type: "agent:deleted", id: agentId })),
      ...[...teamIds].map((teamId): ServerEvent => ({ type: "team:deleted", id: teamId })),
      ...peers.map(upserted),
      { type: "room:deleted", id },
    ];
    // Não existe "task:deleted": um snapshot final tira dos clientes as tarefas removidas.
    if (removedTasks) events.push({ type: "office:snapshot", office: next });
    await this.deps.state.commit({
      office: officeStructure(next),
      tasks: removedTasks ? next.tasks : undefined,
      forYou: forYou.forYou,
      events,
    });
    await this.deps.calendar.removeByRoom(id);
    await this.deps.cleanup.removeLeftovers({ taskIds, agentIds, brainId: id });
  }
}

/** Tudo que pertence ao quarto (a Sala do Maestro é recusada: 409). */
function roomScope(state: OfficeState, id: string) {
  if (isMaestroRoom(requireRoom(state.rooms, id))) throw maestroConflict(MAESTRO_RULES.deleteRoom);
  const teamIds = new Set(state.teams.filter((team) => team.roomId === id).map((team) => team.id));
  const agentIds = state.agents.filter((agent) => teamIds.has(agent.teamId)).map((agent) => agent.id);
  const taskIds = state.tasks.filter((task) => task.roomId === id).map((task) => task.id);
  const tasks = new Set(taskIds);
  const agents = new Set(agentIds);
  const ownsForYou = (item: ForYouItem) =>
    item.roomId === id || agents.has(item.agentId) || (item.taskId !== undefined && tasks.has(item.taskId));
  return { teamIds, agentIds, taskIds, ownsForYou };
}
