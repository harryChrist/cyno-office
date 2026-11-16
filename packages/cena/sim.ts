// Porta de entrada do motor SEM DOM (arquivo nosso, não vem do Habblaud): o `Sim` (a simulação dos personagens, das
// salas e dos elevadores) e as funções puras de arte e de layout que ele usa, para o servidor rodar a cena ao vivo.
// Não puxa `createWorld`, o renderer, os canvas nem a arte desenhada (`art/index.ts` cria canvas): só o que roda em Node.
import type { ArtModule } from './client/src/art/api';
import { appearanceFromSeed } from './client/src/art/character/appearance';
import { roomTheme } from './client/src/art/theme';

export { Sim } from './client/src/world/sim/sim';
export type { SimMode, VisitLight, WorldEffect } from './client/src/world/sim/sim';
export { Character } from './client/src/world/sim/character';
export type { RoomState, RoomPhase } from './client/src/world/sim/room-state';
export { DEFAULT_WORLD_OPTIONS } from './client/src/world/api';
export type { WorldOptions } from './client/src/world/api';
export { appearanceFromSeed, roomTheme };
// O layout do prédio é função pura de (id, vaga, semente, tipo) e do tema da semente: a tela refaz o mesmo prédio do servidor.
export { assembleBuilding } from './client/src/world/layout/building';
export { columnsFor } from './client/src/world/layout/geometry';
export { isMaestroRoomInfo, layoutProjectRoom } from './client/src/world/layout/room';
export type { RoomInput } from './client/src/world/layout/room';
export type { Dir, HeldItem, IconName, Pose, RoomTheme } from './client/src/art/api';
export type { Mode } from './client/src/world/sim/behavior';
export type { ShellStage } from './client/src/world/sim/shell';

/**
 * A arte que o `Sim` pede (`appearanceFromSeed` e `roomTheme`: as duas puras, sem canvas). Os sprites e os móveis
 * desenhados ficam de fora de propósito (o `Sim` nunca os chama); por isso o tipo é afirmado.
 */
export const PURE_ART = { appearanceFromSeed, roomTheme } as unknown as ArtModule;
