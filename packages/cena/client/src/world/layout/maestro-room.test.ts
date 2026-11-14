// Teste do Cyno (patch 13): a planta da Sala do Maestro.
import { describe, expect, it } from 'vitest';
import { FURNITURE, TILE, type FurnitureKind, type RoomTheme } from '../../art/api';
import { PathFinder } from '../path/astar';
import { assembleBuilding } from './building';
import { columnsFor, slotRect } from './geometry';
import { MAESTRO_ROOM_ID } from './maestro-room';
import { isMaestroRoomInfo, layoutProjectRoom } from './room';
import type { AreaLayout, SpotDef } from './types';

const theme: RoomTheme = {
  carpet: '#4f6d8f',
  carpet2: '#486685',
  wall: { base: '#e6e2da', trim: '#9a8f80', pattern: 'plain' },
  accent: '#3f7fd8',
  deskVariant: 'wood',
  chairVariant: 'black',
};

const maestro = (slot: number, seed = 1234): AreaLayout => layoutProjectRoom({ id: MAESTRO_ROOM_ID, slot, seed, kind: 'maestro' }, theme);
const kinds = (a: AreaLayout) => a.furniture.map((f) => f.kind);

describe('Sala do Maestro: a planta', () => {
  const room = maestro(0);
  const team = layoutProjectRoom({ id: '/proj/0', slot: 0, seed: 1234 }, theme);

  it('tem o mesmo tamanho (e as mesmas paredes e porta) das salas dos times, e se declara do Maestro', () => {
    expect(room.rect).toEqual(team.rect);
    expect(room.rect).toEqual(slotRect(0));
    expect(room.door).toEqual(team.door);
    expect(room.maestro).toBe(true);
    expect(team.maestro).toBeUndefined();
    expect(room.walls.map((w) => w.kind)).toEqual(team.walls.map((w) => w.kind));
  });

  it('não tem mesas de time: uma mesa de chefe, o Maestro sozinho na mesa', () => {
    expect(kinds(room)).not.toContain('desk');
    expect(kinds(room)).not.toContain('desk_back');
    expect(kinds(room).filter((k) => k === 'boss_desk')).toHaveLength(1);
    const desks = room.spots.filter((s) => s.kind === 'desk');
    expect(desks).toHaveLength(1);
    expect(desks[0]!.rank).toBe(0);
  });

  it('tem as coisas dele em volta: estante, lousa, janela, poltronas com mesinha, plantas, cafeteira, geladeira, luminárias', () => {
    const k = kinds(room);
    for (const esperado of ['bookshelf', 'coffee_table', 'armchair', 'plant_tall', 'plant_small', 'coffee_machine', 'fridge', 'floor_lamp'] as FurnitureKind[]) expect(k, esperado).toContain(esperado);
    const parede = room.wallItems.map((w) => w.kind);
    for (const esperado of ['whiteboard', 'sign', 'window', 'clock', 'poster', 'light_switch'] as FurnitureKind[]) expect(parede, esperado).toContain(esperado);
    expect(room.spots.filter((s) => s.kind === 'switch')).toHaveLength(1);
    expect(k.filter((x) => x === 'plant_tall').length).toBeGreaterThanOrEqual(2);
  });

  it('o assento do Maestro fica atrás da mesa (ao norte), centrado nela e virado para a câmera', () => {
    const mesa = room.furniture.find((f) => f.kind === 'boss_desk')!;
    const assento = room.spots.find((s) => s.kind === 'desk')!;
    expect(assento.deskId).toBe(mesa.id);
    expect(assento.side).toBe('N');
    expect(assento.dir).toBe('down');
    expect(assento.seated).toBe(true);
    expect(assento.ty).toBeLessThan(mesa.ty);
    // o centro do tronco bate com o centro da mesa (4 tiles) e a cadeira é desenhada nele
    expect(assento.x).toBe((mesa.tx + FURNITURE.boss_desk.footprint.w / 2) * TILE);
    const cadeira = room.furniture.find((f) => f.id === assento.furnitureId)!;
    expect(cadeira.kind).toBe('office_chair_front');
    expect(cadeira.tx * TILE + TILE / 2 + (cadeira.dx ?? 0)).toBe(assento.x);
    // a mesa é desenhada depois dele (cobre as pernas): a profundidade do assento fica antes da base da mesa
    expect(assento.sortY!).toBeLessThan((mesa.ty + 1) * TILE);
    // a mesa fica no meio da sala (a porta tem o mesmo centro)
    expect(mesa.tx * TILE + (FURNITURE.boss_desk.footprint.w * TILE) / 2).toBe((room.rect.x + 8) * TILE);
  });

  it('duas cadeiras de visita na frente da mesa, viradas para ela', () => {
    const mesa = room.furniture.find((f) => f.kind === 'boss_desk')!;
    const visita = room.spots.filter((s) => s.kind === 'stool');
    expect(visita).toHaveLength(2);
    for (const s of visita) {
      expect(s.dir).toBe('up');
      expect(s.ty).toBeGreaterThan(mesa.ty);
      expect(room.furniture.find((f) => f.id === s.furnitureId)!.kind).toBe('armchair');
      expect(s.tx).toBeGreaterThanOrEqual(mesa.tx);
      expect(s.tx).toBeLessThan(mesa.tx + FURNITURE.boss_desk.footprint.w);
    }
    // lugares extras para quem vier (poltronas e pontos em pé)
    expect(room.spots.filter((s) => s.kind === 'nook').length).toBeGreaterThanOrEqual(2);
    expect(room.spots.filter((s) => s.kind === 'stand').length).toBeGreaterThanOrEqual(3);
  });

  it('a ponta direita do tampo fica livre para o poleiro: nada na coluna da ponta além da própria mesa', () => {
    const mesa = room.furniture.find((f) => f.kind === 'boss_desk')!;
    const ponta = mesa.tx + FURNITURE.boss_desk.footprint.w - 1;
    for (const f of room.furniture) {
      if (f.id === mesa.id) continue;
      const w = FURNITURE[f.kind].footprint.w;
      const ocupa = f.tx <= ponta && f.tx + w > ponta && f.ty === mesa.ty;
      expect(ocupa, f.id).toBe(false);
    }
  });
});

describe('Sala do Maestro: todas as sementes e os dois lados', () => {
  const sementes = Array.from({ length: 40 }, (_, i) => (i * 7919 + 13) >>> 0);

  it('nada sobreposto, tudo dentro do piso, tudo alcançável da porta, spots fora de móveis', () => {
    for (const slot of [0, 1]) {
      for (const seed of sementes) {
        const room = maestro(slot, seed);
        const b = assembleBuilding(columnsFor([slot]), [room]);
        const usado = new Map<string, string>();
        for (const f of room.furniture) {
          const def = FURNITURE[f.kind];
          for (let y = f.ty; y < f.ty + def.footprint.h; y++)
            for (let x = f.tx; x < f.tx + def.footprint.w; x++) {
              expect(x >= room.rect.x + 1 && x < room.rect.x + 15 && y >= room.rect.y + 2 && y < room.rect.y + 11, `${f.id} fora do piso`).toBe(true);
              if (!def.blocks) continue;
              expect(usado.get(`${x},${y}`), `${f.id} sobre ${usado.get(`${x},${y}`)}`).toBeUndefined();
              usado.set(`${x},${y}`, f.id);
            }
        }
        const porta = room.door!;
        const alcance = b.grid.reachableFrom(porta.x, porta.y);
        const alcancavel = (x: number, y: number) => alcance[y * b.grid.w + x] === 1;
        for (const s of room.spots) {
          expect(alcancavel(s.tx, s.ty), `${s.id} inalcançável (semente ${seed}, slot ${slot})`).toBe(true);
          expect(b.grid.walkable(s.tx, s.ty), `${s.id} sobre móvel`).toBe(true);
        }
        const r = room.rect;
        for (let y = r.y + 2; y < r.y + 11; y++) for (let x = r.x + 1; x < r.x + 15; x++) if (b.grid.walkable(x, y)) expect(alcancavel(x, y), `tile ${x},${y} isolado`).toBe(true);
      }
    }
  });

  it('caminho livre da porta até o Maestro e até cada cadeira de visita', () => {
    for (const slot of [0, 1]) {
      const room = maestro(slot);
      const b = assembleBuilding(columnsFor([slot]), [room]);
      const porta = room.door!;
      const de = slot === 0 ? { x: porta.x, y: porta.y } : { x: porta.x, y: porta.y + porta.h - 1 };
      const finder = new PathFinder(b.grid);
      const buf: number[] = [];
      for (const s of room.spots.filter((p) => p.kind === 'desk' || p.kind === 'stool')) {
        // o motor anda até o tile do assento (ele é caminhável, mas evitado pelo A*)
        expect(b.grid.walkable(s.tx, s.ty)).toBe(true);
        const achou = finder.find(de.x, de.y, s.tx, s.ty, buf);
        expect(achou, `${s.id} sem caminho`).toBe(true);
      }
    }
  });

  it('quadros e janela não ficam atrás de móvel alto', () => {
    const ALTOS = new Set<FurnitureKind>(['plant_tall', 'bookshelf', 'binder_shelf', 'fridge', 'floor_lamp']);
    const DECOR = new Set<FurnitureKind>(['painting', 'poster', 'window', 'tv', 'whiteboard', 'sign', 'clock', 'mirror']);
    for (const slot of [0, 1]) {
      const room = maestro(slot);
      for (const w of room.wallItems) {
        if (w.on !== 'face' || !DECOR.has(w.kind)) continue;
        const meio = (FURNITURE[w.kind].footprint.w * TILE) / 2 - 2;
        for (const f of room.furniture) {
          if (!ALTOS.has(f.kind) || f.ty !== w.baseY / TILE) continue;
          const x0 = f.tx * TILE + (f.dx ?? 0);
          const x1 = x0 + FURNITURE[f.kind].footprint.w * TILE;
          expect(x0 < w.cx + meio && x1 > w.cx - meio, `${w.id} atrás de ${f.id}`).toBe(false);
        }
      }
    }
  });

  it('ids únicos de móveis e de spots', () => {
    const room = maestro(0);
    expect(new Set(room.furniture.map((f) => f.id)).size).toBe(room.furniture.length);
    const ids = room.spots.map((s: SpotDef) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('quem é a sala do Maestro', () => {
  it('pelo campo `kind` ou, nas molduras antigas, pelo id', () => {
    expect(isMaestroRoomInfo({ id: 'qualquer', kind: 'maestro' })).toBe(true);
    expect(isMaestroRoomInfo({ id: MAESTRO_ROOM_ID })).toBe(true);
    expect(isMaestroRoomInfo({ id: '/proj/a' })).toBe(false);
  });

  it('sem o tipo, a planta é a dos times (a sala comum não mudou)', () => {
    const comum = layoutProjectRoom({ id: '/proj/0', slot: 0, seed: 5 }, theme);
    expect(comum.furniture.some((f) => f.kind === 'desk')).toBe(true);
    expect(comum.furniture.some((f) => f.kind === 'boss_desk')).toBe(false);
  });
});
