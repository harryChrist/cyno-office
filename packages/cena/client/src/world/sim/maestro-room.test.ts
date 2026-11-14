// Teste do Cyno (patch 13): a Sala do Maestro na simulação (quem senta onde).
import { describe, expect, it } from 'vitest';
import type { AppearanceParts } from '../../../../shared/appearance';
import type { AgentInfo, OfficeSnapshot, RoomInfo, ShellJob } from '../../../../shared/types';
import type { Appearance, ArtModule, RoomTheme } from '../../art/api';
import { DEFAULT_WORLD_OPTIONS } from '../api';
import type { Character } from './character';
import { SHELL_DONE_TOOL, Sim } from './sim';

const theme: RoomTheme = {
  carpet: '#4f6d8f',
  carpet2: '#486685',
  wall: { base: '#e6e2da', trim: '#9a8f80', pattern: 'plain' },
  accent: '#3f7fd8',
  deskVariant: 'wood',
  chairVariant: 'black',
};

const appearance: Appearance = {
  skin: '#f0c8a0',
  hair: '#3a2a20',
  hairStyle: 'short',
  eyes: '#222',
  top: '#3f7fd8',
  topAccent: '#fff',
  topStyle: 'tshirt',
  bottom: '#333',
  shoes: '#111',
  accessory: 'none',
  accessoryColor: '#000',
  lanyard: null,
  look: 'm',
};

const art = {
  appearanceFromSeed: () => appearance,
  roomTheme: () => theme,
} as unknown as ArtModule;

const T0 = 1_700_000_000_000;

function room(id: string, slot: number): RoomInfo {
  return { id, name: id.replace('/', ''), path: id, slot, seed: slot * 99 + 7, createdAt: T0 };
}

function agent(id: string, roomId: string, status: AgentInfo['status'], extra: Partial<AgentInfo> = {}): AgentInfo {
  return {
    id,
    kind: 'main',
    roomId,
    name: id,
    look: 'f',
    role: 'Agente principal',
    sessionId: `s-${id}`,
    account: '.claude',
    status,
    recent: [],
    tasks: [],
    startedAt: T0,
    lastEventAt: T0,
    statusSince: T0,
    stats: { toolCalls: 0, tokensIn: 0, tokensOut: 0, subagents: 0 },
    seed: id.length * 1234567,
    ...extra,
  };
}

function snap(rooms: RoomInfo[], agents: AgentInfo[], rev = 1): OfficeSnapshot {
  return {
    rev,
    serverTime: T0,
    rooms,
    agents,
    accounts: [{ id: '.claude', short: 'C', name: 'Conta C', color: '#f08a3c', configDir: '~/.claude', sessions: 1, usageStatus: 'ok' }],
    meta: { demo: true, sources: [], startedAt: T0, version: 't' },
  };
}

/** Avança a simulação em passos de 1/30 s. */
function run(sim: Sim, clock: { now: number }, seconds: number, until?: () => boolean): void {
  const steps = Math.round(seconds * 30);
  for (let i = 0; i < steps; i++) {
    clock.now += 1000 / 30;
    sim.update(1 / 30, clock.now);
    if (until?.()) return;
  }
}

function newSim(): Sim {
  return new Sim(art, () => ({ ...DEFAULT_WORLD_OPTIONS, liveliness: 'calm' }));
}

describe('Sala do Maestro na simulação', () => {
  const sala = (id = 'sala-do-maestro', slot = 0): RoomInfo => ({ ...room(id, slot), kind: 'maestro' });

  it('o Maestro senta atrás da mesa de chefe, de frente, digitando; a sala usa a planta própria', () => {
    const sim = newSim();
    const clock = { now: T0 };
    sim.applySnapshot(snap([sala()], [agent('maestro', 'sala-do-maestro', 'working', { role: 'Maestro' })]), clock.now);
    run(sim, clock, 0.5);
    const rs = sim.rooms.get('sala-do-maestro')!;
    expect(rs.layout.maestro).toBe(true);
    const m = sim.chars.get('maestro')!;
    const lugar = rs.layout.spots.find((s) => s.id === m.atSpot)!;
    expect(lugar.kind).toBe('desk');
    const mesa = rs.layout.furniture.find((f) => f.id === lugar.deskId)!;
    expect(mesa.kind).toBe('boss_desk');
    expect(m.seated).toBe(true);
    expect(m.dir).toBe('down');
    expect(m.pose).toBe('type');
    expect(m.ty).toBeLessThan(mesa.ty);
  });

  it('só pelo id (molduras antigas, sem o campo `kind`) a sala também é a do Maestro', () => {
    const sim = newSim();
    sim.applySnapshot(snap([room('sala-do-maestro', 0)], [agent('maestro', 'sala-do-maestro', 'idle', { role: 'Maestro' })]), T0);
    expect(sim.rooms.get('sala-do-maestro')!.layout.maestro).toBe(true);
    expect(sim.rooms.get('sala-do-maestro')!.layout.furniture.some((f) => f.kind === 'boss_desk')).toBe(true);
  });

  it('a sala de um time continua com as mesas de time', () => {
    const sim = newSim();
    sim.applySnapshot(snap([sala(), room('/a', 1)], [agent('maestro', 'sala-do-maestro', 'idle', { role: 'Maestro' }), agent('ana', '/a', 'working')]), T0);
    expect(sim.rooms.get('/a')!.layout.maestro).toBeUndefined();
    expect(sim.rooms.get('/a')!.layout.furniture.filter((f) => f.kind === 'desk')).toHaveLength(3);
  });

  it('mais gente na sala dele: a cadeira do chefe é só do Maestro, os outros ficam nas cadeiras de visita, poltronas e em pé, sem ninguém no mesmo lugar', () => {
    const sim = newSim();
    const clock = { now: T0 };
    // quem trabalha senta primeiro: o Maestro está ocioso e os outros, trabalhando (não podem tomar a mesa dele)
    const gente: AgentInfo[] = [agent('m', 'sala-do-maestro', 'idle', { role: 'Maestro' })];
    for (let i = 0; i < 9; i++) gente.push(agent(`colega-${i}-${'z'.repeat(i)}`, 'sala-do-maestro', 'working'));
    sim.applySnapshot(snap([sala()], gente), clock.now);
    run(sim, clock, 20);
    const rs = sim.rooms.get('sala-do-maestro')!;
    const chefe = rs.layout.spots.find((s) => s.kind === 'desk')!;
    const m = sim.chars.get('m')!;
    expect(m.homeSpot).toBe(chefe.id);
    for (const c of sim.chars.values()) if (c.id !== 'm') expect(c.homeSpot, c.id).not.toBe(chefe.id);
    const usados = [...sim.chars.values()].filter((c) => c.homeSpot).map((c) => c.homeSpot);
    expect(new Set(usados).size).toBe(usados.length);
    const visita = rs.layout.spots.filter((s) => s.kind === 'stool').map((s) => s.id);
    expect(visita.every((id) => usados.includes(id))).toBe(true);
    // quem trabalha fica dentro da sala (o Maestro ocioso pode ter saído a passeio)
    const r = rs.layout.rect;
    for (const c of [...sim.chars.values()].filter((x) => x.mode === 'work')) expect(c.tx >= r.x && c.tx < r.x + r.w && c.ty >= r.y && c.ty < r.y + r.h, `${c.id} em ${c.tx},${c.ty}`).toBe(true);
  });

  it('a sala muda de vaga mantendo a planta do Maestro (e a fantasma também)', () => {
    const sim = newSim();
    const clock = { now: T0 };
    sim.applySnapshot(snap([sala('sala-do-maestro', 5)], [agent('m', 'sala-do-maestro', 'working', { role: 'Maestro' })]), clock.now);
    run(sim, clock, 1);
    const rs = sim.rooms.get('sala-do-maestro')!;
    expect(rs.layout.maestro).toBe(true);
    sim.moveRoom(rs, 2, clock.now);
    expect(rs.layout.maestro).toBe(true);
    const fantasma = [...sim.rooms.values()].find((r) => r.ghost)!;
    expect(fantasma.layout.maestro).toBe(true);
  });
});
