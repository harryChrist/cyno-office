// Teste do Cyno (patch 14): o modo remoto do `Sim` (a cena ao vivo desenha o que o servidor manda).
import { describe, expect, it } from 'vitest';
import type { AgentInfo, OfficeSnapshot, RoomInfo } from '../../../../shared/types';
import type { Appearance, ArtModule, RoomTheme } from '../../art/api';
import { DEFAULT_WORLD_OPTIONS } from '../api';
import { TILE } from '../constants';
import { REMOTE_DELAY_MS, REMOTE_TELEPORT_PX, interpolate, isTeleport, mergeRemote, type RemoteChar, type RemoteFull, type RemoteState } from './remote';
import { Sim } from './sim';

const theme: RoomTheme = { carpet: '#4f6d8f', carpet2: '#486685', wall: { base: '#e6e2da', trim: '#9a8f80', pattern: 'plain' }, accent: '#3f7fd8', deskVariant: 'wood', chairVariant: 'black' };
const appearance = { skin: '#f0c8a0', hair: '#3a2a20', hairStyle: 'short', eyes: '#222', top: '#3f7fd8', topAccent: '#fff', topStyle: 'tshirt', bottom: '#333', shoes: '#111', accessory: 'none', accessoryColor: '#000', lanyard: null, look: 'm' } as unknown as Appearance;
const art = { appearanceFromSeed: () => appearance, roomTheme: () => theme } as unknown as ArtModule;
const T0 = 1_700_000_000_000;

const newSim = () => new Sim(art, () => ({ ...DEFAULT_WORLD_OPTIONS }), null);

function ch(id: string, patch: Partial<RemoteChar> = {}): RemoteChar {
  return { id, x: 100, y: 100, d: 'd', p: 'stand', h: 'none', s: 0, a: 1, m: 'idle', r: 'sala-a', lv: 0, in: 0, hu: 0, sy: null, as: null, hs: null, i: null, b: null, sa: null, ce: null, ca: 5000, sh: null, ...patch };
}

function full(chars: RemoteChar[], patch: Partial<RemoteFull> = {}): RemoteFull {
  return {
    at: T0,
    lv: 1,
    layout: { cols: 2, rooms: [{ id: 'sala-a', s: 0, sd: 11, n: 'Sala A' }] },
    chars,
    rooms: [{ id: 'sala-a', ph: 'ready', pa: 20_000, l: 1, la: 20_000 }],
    el: [0, 0],
    u: [],
    ...patch,
  };
}

function info(id: string, patch: Partial<AgentInfo> = {}): AgentInfo {
  return {
    id,
    kind: 'main',
    roomId: 'sala-a',
    name: `Nome ${id}`,
    look: 'f',
    role: 'Agente principal',
    sessionId: 's',
    account: '.claude',
    status: 'working',
    recent: [],
    tasks: [],
    startedAt: T0,
    lastEventAt: T0,
    statusSince: T0,
    stats: { toolCalls: 0, tokensIn: 0, tokensOut: 0, subagents: 0 },
    seed: 4242,
    ...patch,
  };
}

function snapshot(agents: AgentInfo[], rooms: RoomInfo[] = [{ id: 'sala-a', name: 'Sala A', path: 'sala-a', slot: 0, seed: 11, createdAt: T0 }]): OfficeSnapshot {
  return { rev: 1, serverTime: T0, rooms, agents, accounts: [], meta: { demo: true, sources: [], startedAt: T0, version: 't' } } as unknown as OfficeSnapshot;
}

describe('conversão de tempos (idade e restante viram instante local)', () => {
  it('b, sa, ce, ca, sh e hu usam o relógio local da chegada', () => {
    const s = mergeRemote(undefined, ch('a', { b: ['code', 'editando', 300, 2000], sa: ['oi', 100, 1500], ce: ['🎉', 900], ca: 4000, hu: 700, sh: [8000, 2, 'npm test', 'popcorn', 6000] }), T0);
    expect(s.b).toEqual(['code', 'editando', T0 - 300, T0 + 2000]);
    expect(s.sa).toEqual(['oi', T0 - 100, T0 + 1500]);
    expect(s.ce).toEqual(['🎉', T0 + 900]);
    expect(s.activityAt).toBe(T0 - 4000);
    expect(s.hiddenUntil).toBe(T0 + 700);
    expect(s.sh).toEqual([T0 - 8000, 2, 'npm test', 'popcorn', T0 - 6000]);
  });

  it('delta: só as chaves enviadas mudam e null apaga o campo opcional', () => {
    const a = mergeRemote(undefined, ch('a', { i: 'check', b: ['x', 'y', 0, 1000], as: 'mesa1', sy: 90 }), T0);
    const b = mergeRemote(a, { id: 'a', x: 130, i: null, b: null, as: null, sy: null }, T0 + 100);
    expect(b.x).toBe(130);
    expect(b.y).toBe(100);
    expect(b.i).toBeNull();
    expect(b.b).toBeNull();
    expect(b.as).toBeNull();
    expect(b.sy).toBeNull();
    expect(b.p).toBe('stand');
  });
});

describe('interpolação e teleporte', () => {
  const s = (x: number, y: number, extra: Partial<RemoteState> = {}): RemoteState => ({ ...mergeRemote(undefined, ch('a', { x, y }), T0), ...extra });

  it('anda entre dois estados e para no segundo', () => {
    const a = { t: 1000, c: s(0, 0) };
    const b = { t: 1100, c: s(10, 20), jump: false };
    expect(interpolate(a, b, 1050)).toEqual({ x: 5, y: 10 });
    expect(interpolate(a, b, 900)).toEqual({ x: 0, y: 0 });
    expect(interpolate(a, b, 1500)).toEqual({ x: 10, y: 20 });
  });

  it('com salto (teleporte) fica no primeiro até a hora do segundo', () => {
    expect(interpolate({ t: 1000, c: s(0, 0) }, { t: 1100, c: s(200, 0), jump: true }, 1050)).toEqual({ x: 0, y: 0 });
  });

  it('teleporte: salto maior que 3 tiles, troca de dentro/fora e de escondido', () => {
    expect(isTeleport(s(0, 0), s(REMOTE_TELEPORT_PX - 1, 0))).toBe(false);
    expect(isTeleport(s(0, 0), s(REMOTE_TELEPORT_PX + 1, 0))).toBe(true);
    expect(isTeleport(s(0, 0), s(1, 0, { inside: true }))).toBe(true);
    expect(isTeleport(s(0, 0), s(1, 0, { hiddenUntil: T0 + 500 }))).toBe(true);
  });
});

describe('Sim em modo remoto', () => {
  it('applyRemoteFull monta o prédio, as salas, os personagens e as portas', () => {
    const sim = newSim();
    sim.applyRemoteFull(full([ch('a', { x: 120, y: 80, p: 'type', s: 1, m: 'work' }), ch('b', { x: 200, y: 90 })], { el: [4, 0], u: ['mesa-x'] }), T0);
    expect(sim.remote.on).toBe(true);
    expect(sim.initialized).toBe(true);
    expect(sim.rooms.get('sala-a')?.present).toBe(true);
    expect(sim.rooms.get('sala-a')?.lightOn).toBe(true);
    expect(sim.building.cols).toBe(2);
    expect([...sim.chars.keys()].sort()).toEqual(['a', 'b']);
    const a = sim.chars.get('a')!;
    expect([a.x, a.y, a.pose, a.seated, a.mode]).toEqual([120, 80, 'type', true, 'work']);
    expect(sim.stallBusy.has('mesa-x')).toBe(true);
    sim.update(0.5, T0 + 500);
    expect(sim.elevators[0].door).toBeGreaterThan(3);
    expect(sim.elevators[1].door).toBe(0);
  });

  it('o mesmo layout do servidor: um Sim local com as mesmas vagas e sementes tem os mesmos lugares', () => {
    const local = newSim();
    local.applySnapshot(snapshot([info('a')]), T0);
    const sim = newSim();
    sim.applyRemoteFull(full([], { layout: { cols: local.building.cols, rooms: [{ id: 'sala-a', s: 0, sd: 11, n: 'Sala A' }] } }), T0);
    const ids = (s: Sim) => [...s.building.spots].map((p) => p.id).sort();
    expect(ids(sim)).toEqual(ids(local));
  });

  it('delta: campos, novo personagem inteiro, remoção, sala e luz', () => {
    const sim = newSim();
    sim.applyRemoteFull(full([ch('a'), ch('b', { i: 'check' })]), T0);
    sim.applyRemoteDelta({ at: T0 + 100, c: [{ id: 'a', p: 'walk', d: 'r' }, { id: 'b', i: null }, ch('c', { x: 300, y: 40 })], x: [], r: [{ id: 'sala-a', ph: 'ready', pa: 20_100, l: 0, la: 0 }] }, T0 + 100);
    sim.update(0.1, T0 + 100 + REMOTE_DELAY_MS + 50);
    expect(sim.chars.get('a')!.pose).toBe('walk');
    expect(sim.chars.get('a')!.dir).toBe('right');
    expect(sim.chars.get('b')!.icon).toBeNull();
    expect(sim.chars.get('c')!.x).toBe(300);
    expect(sim.rooms.get('sala-a')!.lightOn).toBe(false);
    sim.applyRemoteDelta({ at: T0 + 200, x: ['a'] }, T0 + 200);
    expect(sim.chars.has('a')).toBe(false);
  });

  it('posição interpolada com o atraso de desenho, sem passar do último estado', () => {
    const sim = newSim();
    sim.applyRemoteFull(full([ch('a', { x: 100, y: 100 })]), T0);
    sim.applyRemoteDelta({ at: T0 + 1000, c: [{ id: 'a', x: 110, y: 100, p: 'walk' }] }, T0 + 1000);
    sim.applyRemoteDelta({ at: T0 + 1100, c: [{ id: 'a', x: 120, y: 100 }] }, T0 + 1100);
    // no instante da chegada do segundo, a tela mostra o passado: metade do primeiro trecho ainda não chegou
    sim.update(0.016, T0 + 1000 + REMOTE_DELAY_MS + 50);
    const x = sim.chars.get('a')!.x;
    expect(x).toBeGreaterThan(110);
    expect(x).toBeLessThan(120);
    sim.update(0.016, T0 + 5000);
    expect(sim.chars.get('a')!.x).toBe(120);
  });

  it('teleporte não interpola', () => {
    const sim = newSim();
    sim.applyRemoteFull(full([ch('a', { x: 100, y: 100 })]), T0);
    sim.applyRemoteDelta({ at: T0 + 1000, c: [{ id: 'a', x: 100 + 10 * TILE, y: 100, in: 1 }] }, T0 + 1000);
    sim.update(0.016, T0 + 1000 + REMOTE_DELAY_MS - 20);
    expect(sim.chars.get('a')!.x).toBe(100);
    sim.update(0.016, T0 + 1000 + REMOTE_DELAY_MS + 1);
    expect(sim.chars.get('a')!.x).toBe(100 + 10 * TILE);
    expect(sim.chars.get('a')!.inside).toBe(true);
  });

  it('um novo scene:full troca o layout e tira quem saiu', () => {
    const sim = newSim();
    sim.applyRemoteFull(full([ch('a'), ch('b')]), T0);
    const before = sim.layoutVersion;
    const same = sim.building;
    sim.applyRemoteFull(full([ch('a')]), T0 + 500);
    expect(sim.building).toBe(same);
    expect(sim.layoutVersion).toBe(before);
    expect(sim.chars.has('b')).toBe(false);
    sim.applyRemoteFull(full([ch('a')], { layout: { cols: 4, rooms: [{ id: 'sala-a', s: 0, sd: 11, n: 'A' }, { id: 'sala-b', s: 2, sd: 22, n: 'B' }] }, rooms: [{ id: 'sala-a', ph: 'ready', pa: 1, l: 1, la: 1 }, { id: 'sala-b', ph: 'building', pa: 100, l: 0, la: 0 }] }), T0 + 900);
    expect(sim.layoutVersion).toBeGreaterThan(before);
    expect(sim.building.cols).toBe(4);
    expect(sim.rooms.get('sala-b')?.phase).toBe('building');
  });

  it('a mesa de casa fica reservada para o dono', () => {
    const sim = newSim();
    sim.applyRemoteFull(full([]), T0);
    const desk = sim.rooms.get('sala-a')!.layout.spots.find((s) => s.kind === 'desk')!;
    sim.applyRemoteFull(full([ch('a', { hs: desk.id, as: desk.id })]), T0 + 100);
    sim.update(0.016, T0 + 1000);
    expect(sim.spots.ownerOf(desk.id)).toBe('a');
  });

  it('applySnapshot em modo remoto só mexe no info (e na aparência), sem criar nem mover ninguém', () => {
    const sim = newSim();
    sim.applyRemoteFull(full([ch('a', { x: 150, y: 70 })]), T0);
    sim.applySnapshot(snapshot([info('a', { name: 'Marina' }), info('fantasma')]), T0 + 10);
    expect(sim.chars.get('a')!.info.name).toBe('Marina');
    expect(sim.chars.get('a')!.x).toBe(150);
    expect(sim.chars.has('fantasma')).toBe(false);
    // quem o servidor cria depois já nasce com o info guardado
    sim.applyRemoteDelta({ at: T0 + 100, c: [ch('fantasma', { x: 10, y: 10 })] }, T0 + 100);
    expect(sim.chars.get('fantasma')!.info.name).toBe('Nome fantasma');
  });

  it('personagem sem retrato nasce com um info provisório e o ganha quando o retrato chega', () => {
    const sim = newSim();
    sim.applyRemoteFull(full([ch('a')]), T0);
    expect(sim.chars.get('a')!.info.name).toBe('a');
    sim.applySnapshot(snapshot([info('a', { seed: 99 })]), T0 + 10);
    expect(sim.chars.get('a')!.info.seed).toBe(99);
  });

  it('parado (conexão caiu): quem andava fica em pé; fastForward não mexe em ninguém', () => {
    const sim = newSim();
    sim.applyRemoteFull(full([ch('a', { p: 'walk', x: 50, y: 50 })]), T0);
    sim.freezeRemote(true);
    sim.update(0.1, T0 + 500);
    expect(sim.chars.get('a')!.pose).toBe('stand');
    sim.fastForward(T0 + 10_000);
    expect(sim.chars.get('a')!.x).toBe(50);
    sim.freezeRemote(false);
    sim.update(0.1, T0 + 600);
    expect(sim.chars.get('a')!.pose).toBe('walk');
  });

  it('sair do modo remoto devolve a simulação local, com carga inicial normal', () => {
    const sim = newSim();
    sim.applySnapshot(snapshot([info('a')]), T0);
    sim.applyRemoteFull(full([ch('a', { x: 5, y: 5 }), ch('so-remoto')]), T0 + 100);
    expect(sim.chars.has('so-remoto')).toBe(true);
    sim.stopRemote(T0 + 200);
    expect(sim.remote.on).toBe(false);
    expect(sim.chars.has('so-remoto')).toBe(false);
    const a = sim.chars.get('a')!;
    const home = sim.spots.get(a.homeSpot);
    expect(home).toBeTruthy();
    expect([a.x, a.y]).toEqual([home!.x, home!.y]);
    sim.update(0.05, T0 + 250);
    expect(sim.chars.get('a')).toBeTruthy();
  });
});
