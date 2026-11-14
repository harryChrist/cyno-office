// A Sala do Maestro (arquivo do Cyno, não existe no Habblaud; patch 13): do mesmo tamanho das salas dos times
// (16x12 tiles com paredes próprias), mas com um arranjo só dele no lugar da ilha de mesas.
//
//   - a mesa de chefe (4x1, `boss_desk`) centrada na sala, sobre o tapete, com o Maestro sentado ATRÁS dela, de
//     frente para a câmera (o mesmo assento "N" das mesas `desk_back`); a ponta direita do tampo fica livre
//     para o poleiro da calopsita;
//   - duas cadeiras de visita viradas para a mesa (lugares extras: subagentes e visitas sentam ali);
//   - em volta: estante, quadro de planejamento, janela, duas poltronas com mesinha, plantas, luminárias,
//     geladeira e cafeteira. Nenhuma mesa de time.
//
// Para a sala não ficar nua sem ninguém (ou com agentes a mais, caso raro: o time do Maestro tem mais gente),
// os lugares extras são as cadeiras de visita (banquetas), as duas poltronas (nook) e três pontos em pé.
import { type Dir, type FurnitureKind, type RoomTheme, type WallStyle } from '../../art/api';
import { shade } from '../../art/core/color';
import { DOOR_W, DOOR_X, TILE } from '../constants';
import { AreaBuilder, type SpotOpts } from './builder';
import { slotRect, slotSide } from './geometry';
import type { AreaLayout, SpotDef, SpotKind } from './types';

export interface MaestroRoomInput {
  id: string;
  slot: number;
  seed: number;
}

/** Id da sala do Maestro no Cyno (as molduras gravadas antes do campo `kind` só trazem o id). */
export const MAESTRO_ROOM_ID = 'sala-do-maestro';

export function layoutMaestroRoom(room: MaestroRoomInput, theme: RoomTheme): AreaLayout {
  const rect = slotRect(room.slot);
  const side = slotSide(room.slot);
  const b = new AreaBuilder(room.id, 'room', rect);
  const area = b.area;
  area.side = side;
  area.maestro = true;
  const wall: WallStyle = theme.wall;
  const north = side === 'north';
  const door = { lx: DOOR_X, w: DOOR_W };

  const furn = (kind: FurnitureKind, lx: number, ly: number, variant?: string, o: { dx?: number; dy?: number; order?: number } = {}) => b.furn(kind, lx, ly, variant, o);
  const spot = (kind: SpotKind, lx: number, ly: number, dir: Dir, o: SpotOpts = {}): SpotDef => b.spot(kind, lx, ly, dir, o);
  const seat = (kind: SpotKind, fk: FurnitureKind, lx: number, ly: number, dir: Dir, variant?: string, o: SpotOpts & { order?: number } = {}): SpotDef => b.seat(kind, fk, lx, ly, dir, variant, o);

  // ---- piso: madeira (a sala é do chefe; o porcelanato é dos times) com o tom da sala por cima
  b.floor('wood', 0, 0, 16, 12, room.seed);
  area.floorTint = theme.carpet;
  // tapete grande sob a mesa e as cadeiras de visita (centrado na sala: colunas 5 a 11)
  b.rug(5, 3.5, 6, 6, theme.carpet, room.seed);
  // tapetinho das poltronas e da mesinha (sem encostar no grande)
  b.rug(0.75, 7.5, 4.2, 3, shade(theme.carpet2, 0.3), room.seed + 2);
  // tapetinho na entrada
  b.rug(DOOR_X - 0.25, north ? 9.5 : 2, DOOR_W + 0.5, 1.25, shade(theme.carpet2, -0.1), room.seed + 1);

  // ---- paredes
  if (north) {
    b.face(0.5, 15, wall);
    b.south(0.5, 15, 11, wall, [door]);
  } else {
    b.face(0.5, 15, wall, [door]);
    b.south(0.5, 15, 11, { ...wall, exterior: true });
    b.wall('door_frame', DOOR_X + DOOR_W / 2, undefined, { order: 0.05 });
  }
  b.cap(0, 0, 0.5, 12, wall);
  b.cap(15.5, 0, 0.5, 12, wall);

  // ---- caminhabilidade
  b.walk(1, 2, 14, 9);
  area.door = north ? { x: rect.x + DOOR_X, y: rect.y + 11, w: DOOR_W, h: 1 } : { x: rect.x + DOOR_X, y: rect.y, w: DOOR_W, h: 2 };
  b.walk(area.door.x - rect.x, area.door.y - rect.y, area.door.w, area.door.h);

  // ---- itens de parede: o quadro de planejamento (a lousa), a placa, relógio, pôster e a janela
  const shelfX = north ? 1 : 4;
  if (north) {
    area.signId = b.wall('sign', 8, undefined, { order: 0.95 });
    b.wall('whiteboard', 4.5, undefined, { order: 0.6 });
    b.wall('clock', 10, undefined, { order: 0.7 });
    b.wall('poster', 11.1, 'ship_it', { order: 0.5 });
    b.wall('window', 12.75, undefined, { order: 0.4 });
    b.wall('light_switch', DOOR_X - 0.5, 'on', { ly: 12, on: 'south', order: 0.8 });
    spot('switch', DOOR_X - 1, 10, 'down', { dy: -1 });
    spot('window', 12, 2, 'up', { dx: 12, dy: 1 });
  } else {
    area.signId = b.wall('sign', 10.5, undefined, { order: 0.95 });
    b.wall('whiteboard', 2.5, undefined, { order: 0.6 });
    b.wall('light_switch', DOOR_X - 0.5, 'on', { order: 0.8 });
    b.wall('clock', 12.3, undefined, { order: 0.7 });
    b.wall('poster', 13.35, 'ship_it', { order: 0.5 });
    spot('switch', DOOR_X - 1, 2, 'up', { dy: -3 });
    furn('plant_small', 1, 2, 'flower', { order: 0.22 });
  }
  spot('whiteboard', north ? 4 : 2, 2, 'up', { dx: 8, dy: 2 });

  // ---- a mesa de chefe: o balcão grande (colunas 6–9, centrado), o Maestro atrás dele, de frente para a câmera
  const desk = furn('boss_desk', 6, 5, undefined, { order: 0.4 });
  seat('desk', 'office_chair_front', 7, 4, 'down', theme.chairVariant === 'red' ? 'black' : theme.chairVariant, { dx: TILE / 2, deskId: desk, rank: 0, side: 'N', order: 0.55 });
  // ao lado da mesa: planta alta à esquerda e luminária à direita (a ponta do tampo é do poleiro)
  furn('plant_tall', 4, 5, 'ficus', { order: 0.5 });
  furn('floor_lamp', 11, 5, undefined, { order: 0.5 });

  // ---- cadeiras de visita, viradas para a mesa
  seat('stool', 'armchair', 6, 7, 'up', 'up', { order: 0.65 });
  seat('stool', 'armchair', 9, 7, 'up', 'up', { order: 0.66 });

  // ---- estante, plantas e o canto do café (coluna da direita, junto à parede)
  furn('bookshelf', shelfX, 2, undefined, { order: 0.25 });
  spot('shelf', shelfX, 3, 'up', { dx: 8, dy: -2 });
  furn('plant_tall', 14, 2, 'monstera', { order: 0.2 });
  furn('fridge', 14, 4, undefined, { order: 0.3 });
  furn('coffee_machine', 14, 5, undefined, { order: 0.32 });
  furn('binder_shelf', 14, 7, undefined, { order: 0.34 });
  furn('plant_tall', 14, 10, 'palm', { order: 0.34 });
  furn('trash_bin', 13, 10, undefined, { order: 0.36 });

  // ---- cantinho de poltronas com mesinha (canto de baixo, à esquerda)
  furn('coffee_table', 2, 8, undefined, { order: 0.45 });
  seat('nook', 'armchair', 1, 8, 'right', 'right', { order: 0.65 });
  seat('nook', 'armchair', 4, 8, 'left', 'left', { order: 0.66 });
  furn('plant_small', 2, 10, 'succulent', { order: 0.4 });
  furn('floor_lamp', 5, 8, undefined, { order: 0.67 });

  // ---- pontos em pé (subagentes sem lugar sentado; também servem de conversa)
  spot('stand', 11, 6, 'left');
  spot('stand', 4, 6, 'right');
  spot('stand', 12, 9, 'up', { dy: -2 });

  // ---- sombreamento quando a luz está apagada
  const p = { x: rect.x * TILE, y: rect.y * TILE, w: rect.w * TILE, h: rect.h * TILE };
  area.shade = north ? { x: p.x, y: p.y, w: p.w, h: p.h - TILE } : { x: p.x, y: p.y, w: p.w, h: p.h };
  return b.build();
}
