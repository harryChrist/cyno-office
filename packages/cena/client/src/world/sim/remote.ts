// CYNO-PATCH 14 (arquivo nosso, não vem do Habblaud): o modo REMOTO do `Sim`, para a cena ao vivo.
//
// Quem simula é o servidor (protocolo em `packages/shared/src/scene-live.ts`); aqui o `Sim` só desenha o que recebe:
// não planeja, não anda sozinho e não roda as rodas sociais. Recebe o estado inteiro (`applyFull`) e as mudanças
// (`applyDelta`), monta o MESMO prédio do servidor (layout por sala + `assembleBuilding`) e, a cada quadro (`update`),
// só interpola a posição, avança os relógios de animação (passo da caminhada, portas) e o que é puramente visual.
//
// Tempo: toda idade/restante da mensagem vira um instante absoluto do relógio LOCAL no instante em que a mensagem chega.
// Os deltas chegam a 10 Hz: cada personagem guarda uma fila de estados e a tela mostra o passado (`REMOTE_DELAY_MS`),
// interpolando x,y entre dois estados; salto grande, troca de `in`/`hu` e entrada não interpolam.
import type { AgentInfo, OfficeSnapshot, RoomInfo } from '../../../../shared/types';
import type { ArtModule, Dir, HeldItem, IconName, Pose, RoomTheme } from '../../art/api';
import { TILE } from '../constants';
import { assembleBuilding } from '../layout/building';
import { layoutProjectRoom } from '../layout/room';
import type { Mode } from './behavior';
import { Character } from './character';
import { RoomState, type RoomPhase } from './room-state';
import type { Sim } from './sim';

/** Atraso de desenho (ms): a tela mostra o que o servidor mandou há tanto tempo, para ter sempre dois estados para interpolar. */
export const REMOTE_DELAY_MS = 130;
/** Salto de posição (px) a partir do qual não se interpola (3 tiles): é teleporte, não caminhada. */
export const REMOTE_TELEPORT_PX = 3 * TILE;
/** Velocidade das portas dos elevadores (estados por segundo, a mesma do `Elevator`). */
const DOOR_SPEED = 9;
/** Quantos estados no máximo ficam na fila de um personagem. */
const MAX_FRAMES = 24;
/** Enquanto o ícone está ligado, ele não vence por tempo na tela (o servidor manda `null` quando acaba). */
const FOREVER = 1e15;

// ---------------------------------------------------------------- o protocolo (formato estrutural, sem importar @cyno/shared)

export type RemoteChar = {
  id: string;
  x: number;
  y: number;
  d: string;
  p: string;
  h: string;
  s: number;
  a: number;
  m: string;
  r: string;
  lv: number;
  in: number;
  hu: number;
  sy: number | null;
  as: string | null;
  hs: string | null;
  i: string | null;
  b: [string, string, number, number] | null;
  sa: [string, number, number] | null;
  ce: [string, number] | null;
  ca: number;
  sh: [number, number, string, string | null, number] | null;
};
export type RemoteCharDelta = { id: string } & Partial<Omit<RemoteChar, 'id'>>;
export type RemoteRoomState = { id: string; ph: string; pa: number; l: number; la: number };
export type RemoteLayout = { cols: number; rooms: { id: string; s: number; sd: number; k?: 'maestro'; g?: 1; n: string }[] };
export type RemoteFull = { at: number; lv: number; layout: RemoteLayout; chars: RemoteChar[]; rooms: RemoteRoomState[]; el: number[]; u: string[] };
export type RemoteDelta = { at: number; c?: RemoteCharDelta[]; x?: string[]; r?: RemoteRoomState[]; el?: number[]; u?: string[] };

// ---------------------------------------------------------------- um personagem recebido, com os tempos no relógio local

/** O estado de um personagem no formato do fio, mas com todo tempo já em instante absoluto do relógio local. */
export interface RemoteState {
  x: number;
  y: number;
  d: string;
  p: string;
  h: string;
  s: boolean;
  a: number;
  m: string;
  r: string;
  lv: boolean;
  inside: boolean;
  /** Fica escondido até este instante (0 = visível). */
  hiddenUntil: number;
  sy: number | null;
  as: string | null;
  hs: string | null;
  i: string | null;
  /** [ícone, texto, desde, até]. */
  b: [string, string, number, number] | null;
  /** [texto, desde, até]. */
  sa: [string, number, number] | null;
  /** [emoji, até]. */
  ce: [string, number] | null;
  activityAt: number;
  /** [desde, quantos, rótulo, estágio, entrou]. */
  sh: [number, number, string, string | null, number] | null;
}

const BLANK: RemoteState = {
  x: 0,
  y: 0,
  d: 'd',
  p: 'stand',
  h: 'none',
  s: false,
  a: 1,
  m: 'idle',
  r: '',
  lv: false,
  inside: false,
  hiddenUntil: 0,
  sy: null,
  as: null,
  hs: null,
  i: null,
  b: null,
  sa: null,
  ce: null,
  activityAt: 0,
  sh: null,
};

/** Aplica um (pedaço de) personagem do fio sobre o estado anterior; `recv` é o relógio local da chegada. */
export function mergeRemote(prev: RemoteState | undefined, d: RemoteCharDelta, recv: number): RemoteState {
  const out: RemoteState = { ...(prev ?? { ...BLANK, activityAt: recv }) };
  if (d.x !== undefined) out.x = d.x;
  if (d.y !== undefined) out.y = d.y;
  if (d.d !== undefined) out.d = d.d;
  if (d.p !== undefined) out.p = d.p;
  if (d.h !== undefined) out.h = d.h;
  if (d.s !== undefined) out.s = !!d.s;
  if (d.a !== undefined) out.a = d.a;
  if (d.m !== undefined) out.m = d.m;
  if (d.r !== undefined) out.r = d.r;
  if (d.lv !== undefined) out.lv = !!d.lv;
  if (d.in !== undefined) out.inside = !!d.in;
  if (d.hu !== undefined) out.hiddenUntil = d.hu > 0 ? recv + d.hu : 0;
  if (d.sy !== undefined) out.sy = d.sy;
  if (d.as !== undefined) out.as = d.as;
  if (d.hs !== undefined) out.hs = d.hs;
  if (d.i !== undefined) out.i = d.i;
  if (d.b !== undefined) out.b = d.b ? [d.b[0], d.b[1], recv - d.b[2], recv + d.b[3]] : null;
  if (d.sa !== undefined) out.sa = d.sa ? [d.sa[0], recv - d.sa[1], recv + d.sa[2]] : null;
  if (d.ce !== undefined) out.ce = d.ce ? [d.ce[0], recv + d.ce[1]] : null;
  if (d.ca !== undefined) out.activityAt = recv - d.ca;
  if (d.sh !== undefined) out.sh = d.sh ? [recv - d.sh[0], d.sh[1], d.sh[2], d.sh[3], recv - d.sh[4]] : null;
  return out;
}

/** O salto entre dois estados é um teleporte (não se interpola)? */
export function isTeleport(a: RemoteState, b: RemoteState): boolean {
  return Math.hypot(b.x - a.x, b.y - a.y) > REMOTE_TELEPORT_PX || a.inside !== b.inside || a.hiddenUntil > 0 !== b.hiddenUntil > 0;
}

/** Posição a mostrar no instante `rt` entre os estados `a` (em `ta`) e `b` (em `tb`). */
export function interpolate(a: { t: number; c: RemoteState }, b: { t: number; c: RemoteState; jump: boolean } | undefined, rt: number): { x: number; y: number } {
  if (!b || b.jump) return { x: a.c.x, y: a.c.y };
  const span = b.t - a.t;
  const f = span > 0 ? Math.max(0, Math.min(1, (rt - a.t) / span)) : 1;
  return { x: a.c.x + (b.c.x - a.c.x) * f, y: a.c.y + (b.c.y - a.c.y) * f };
}

interface Frame {
  /** Instante local em que este estado passa a valer na tela. */
  t: number;
  c: RemoteState;
  /** Chegou por teleporte (ou é o primeiro): a posição salta, sem interpolar. */
  jump: boolean;
}

const DIRS: Record<string, Dir> = { d: 'down', u: 'up', l: 'left', r: 'right' };

const FALLBACK_THEME: RoomTheme = {
  carpet: '#5b7fa6',
  carpet2: '#4f7093',
  wall: { base: '#e7e3db', trim: '#9b9184', pattern: 'plain' },
  accent: '#3f7fd8',
  deskVariant: 'wood',
  chairVariant: 'black',
};

/** FNV-1a: semente do personagem que o servidor criou antes de a tela ter o retrato dele. */
function seedOf(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const lookSig = (a: AgentInfo): string => `${a.seed}|${a.look}|${JSON.stringify(a.parts ?? null)}`;

/**
 * O estado remoto de um `Sim`. `on` liga o modo: com ele, `Sim.update` chama `update` daqui e `Sim.applySnapshot` chama `snapshot`.
 */
export class RemoteScene {
  on = false;
  /** Parado (a conexão caiu): ninguém anda, mesmo que a fila ainda tenha estados. */
  frozen = false;
  private readonly tracks = new Map<string, Frame[]>();
  private infos = new Map<string, AgentInfo>();
  private roomInfos = new Map<string, RoomInfo>();
  private layoutKey = '';
  private elevatorTargets: number[] = [];
  private nextRoomInfoAt = 0;

  constructor(
    private readonly sim: Sim,
    private readonly art: ArtModule,
  ) {}

  // ---------------------------------------------------------------- ligar e desligar

  /** Entra no modo remoto: esquece o mundo local (o retrato da tela já recebido segue valendo para o `info`). */
  enter(now: number, snapshot: OfficeSnapshot | null): void {
    this.on = true;
    this.frozen = false;
    this.tracks.clear();
    this.layoutKey = '';
    this.elevatorTargets = [];
    this.infos = new Map((snapshot?.agents ?? []).map((a) => [a.id, a]));
    this.roomInfos = new Map((snapshot?.rooms ?? []).map((r) => [r.id, r]));
    this.sim.clearWorld(now);
  }

  /** Sai do modo remoto (o `Sim` volta ao mundo local; quem chama aplica o retrato como carga inicial). */
  leave(): void {
    this.on = false;
    this.frozen = false;
    this.tracks.clear();
    this.infos.clear();
    this.roomInfos.clear();
    this.layoutKey = '';
    this.elevatorTargets = [];
  }

  // ---------------------------------------------------------------- o retrato da tela (info e aparência)

  /** O retrato do Cyno que a tela monta: só atualiza o `info` (e a aparência) de quem já existe e guarda o resto para quem o servidor criar. */
  snapshot(input: OfficeSnapshot, now: number): void {
    const sim = this.sim;
    this.infos = new Map(input.agents.map((a) => [a.id, a]));
    this.roomInfos = new Map(input.rooms.map((r) => [r.id, r]));
    sim.accounts = new Map(input.accounts.map((a) => [a.id, { short: a.short, color: a.color, name: a.name, ...(a.provider === 'codex' ? { provider: a.provider } : {}) }]));
    for (const ch of [...sim.chars.values()]) {
      const info = this.infos.get(ch.id);
      if (info) this.adopt(ch, info);
    }
    for (const room of sim.rooms.values()) {
      const info = this.roomInfos.get(room.id);
      if (!info) continue;
      if (room.info.name !== info.name || room.info.seed !== info.seed) room.version++;
      room.info = info;
    }
    sim.roomFx.sync(input.rooms, input.serverTime, now);
    this.refreshRoomInfo(true);
  }

  /** Entrega o `info` ao personagem; a aparência (e a faixa lateral, que vem da semente) muda junto, se a semente mudou. */
  private adopt(ch: Character, info: AgentInfo): void {
    const sameLook = lookSig(info) === lookSig(ch.info);
    if (info.seed !== ch.info.seed) {
      // a faixa e o ritmo da caminhada nascem da semente (somente leitura no personagem): recria
      const next = this.newChar(info);
      if (next) {
        next.x = ch.x;
        next.y = ch.y;
        this.copyVisual(ch, next);
        this.sim.chars.set(ch.id, next);
      }
      return;
    }
    ch.info = info;
    if (!sameLook) {
      try {
        ch.appearance = this.art.appearanceFromSeed(info.seed, { look: info.look, sub: info.kind === 'sub', parts: info.parts });
      } catch {
        // arte com problema: fica a aparência que estava
      }
    }
  }

  private copyVisual(from: Character, to: Character): void {
    to.tx = from.tx;
    to.ty = from.ty;
    to.dir = from.dir;
    to.pose = from.pose;
    to.held = from.held;
    to.seated = from.seated;
    to.alpha = from.alpha;
    to.sortY = from.sortY;
    to.mode = from.mode;
    to.roomId = from.roomId;
    to.leaving = from.leaving;
    to.inside = from.inside;
    to.hiddenUntil = from.hiddenUntil;
    to.atSpot = from.atSpot;
    to.homeSpot = from.homeSpot;
    to.animT = from.animT;
    to.icon = from.icon;
    to.iconAt = from.iconAt;
    to.iconUntil = from.iconUntil;
    to.bubbleText = from.bubbleText;
    to.bubbleIcon = from.bubbleIcon;
    to.bubbleAt = from.bubbleAt;
    to.bubbleUntil = from.bubbleUntil;
    to.sayText = from.sayText;
    to.sayAt = from.sayAt;
    to.sayUntil = from.sayUntil;
    to.chatEmoji = from.chatEmoji;
    to.chatUntil = from.chatUntil;
    to.activityChangedAt = from.activityChangedAt;
    to.shellSince = from.shellSince;
    to.shellCount = from.shellCount;
    to.shellLabel = from.shellLabel;
    to.shellStage = from.shellStage;
    to.shellEnteredAt = from.shellEnteredAt;
    to.shellTextKey = -1;
  }

  private placeholderInfo(id: string, c: RemoteState, now: number): AgentInfo {
    return {
      id,
      kind: id.includes('::') ? 'sub' : 'main',
      roomId: c.r,
      name: id,
      look: 'm',
      role: '',
      sessionId: '',
      account: '',
      status: 'idle',
      recent: [],
      tasks: [],
      startedAt: now,
      lastEventAt: now,
      statusSince: now,
      stats: { toolCalls: 0, tokensIn: 0, tokensOut: 0, subagents: 0 },
      seed: seedOf(id),
    };
  }

  private newChar(info: AgentInfo): Character | null {
    let appearance;
    try {
      appearance = this.art.appearanceFromSeed(info.seed, { look: info.look, sub: info.kind === 'sub', parts: info.parts });
    } catch {
      return null;
    }
    return new Character(info, appearance);
  }

  // ---------------------------------------------------------------- scene:full

  /** O estado inteiro: substitui tudo (o prédio só é remontado se o layout mudou). */
  applyFull(full: RemoteFull, now: number): void {
    const sim = this.sim;
    sim.now = now;
    this.nextRoomInfoAt = 0;
    // ---- o prédio
    const key = JSON.stringify([full.layout.cols, full.layout.rooms.map((r) => [r.id, r.s, r.sd, r.k ?? 0, r.g ?? 0])]);
    if (key !== this.layoutKey) {
      this.layoutKey = key;
      const listed = new Set<string>();
      for (const r of full.layout.rooms) {
        listed.add(r.id);
        const have = sim.rooms.get(r.id);
        if (have && have.slot === r.s && have.seed === r.sd && !!have.layout.maestro === (r.k === 'maestro') && have.ghost === !!r.g) continue;
        sim.rooms.set(r.id, this.makeRoom(r, now));
      }
      for (const id of [...sim.rooms.keys()]) if (!listed.has(id)) sim.rooms.delete(id);
      const layouts = full.layout.rooms.map((r) => sim.rooms.get(r.id)!.layout);
      const building = assembleBuilding(full.layout.cols, layouts, sim.layoutVersion + 1);
      sim.building = building;
      sim.layoutVersion++;
      sim.finder.setGrid(building.grid);
      sim.spots.setSpots(building.spots);
    }
    this.applyRoomStates(full.rooms, now);
    this.applyElevators(full.el);
    this.applyBusy(full.u, now);
    // ---- os personagens
    const keep = new Set(full.chars.map((c) => c.id));
    for (const id of [...sim.chars.keys()]) {
      if (keep.has(id)) continue;
      sim.spots.releaseAll(id);
      sim.chars.delete(id);
      this.tracks.delete(id);
    }
    for (const id of [...this.tracks.keys()]) if (!keep.has(id)) this.tracks.delete(id);
    for (const c of full.chars) {
      const state = mergeRemote(undefined, c, now);
      this.ensureChar(c.id, state, now);
      // vale já: o estado inteiro é a verdade de agora (os deltas seguintes interpolam a partir dele)
      this.tracks.set(c.id, [{ t: now - REMOTE_DELAY_MS - 1, c: state, jump: true }]);
    }
    sim.initialized = true;
    this.frozen = false;
    this.refreshRoomInfo(true);
    this.update(0, now);
  }

  private makeRoom(r: RemoteLayout['rooms'][number], now: number): RoomState {
    let theme = FALLBACK_THEME;
    try {
      theme = this.art.roomTheme(r.sd) ?? FALLBACK_THEME;
    } catch {
      theme = FALLBACK_THEME;
    }
    const layout = layoutProjectRoom({ id: r.id, slot: r.s, seed: r.sd, ...(r.k === 'maestro' ? { kind: 'maestro' as const } : {}) }, theme);
    const info: RoomInfo = this.roomInfos.get(r.id) ?? { id: r.id, name: r.n, path: r.id, slot: r.s, seed: r.sd, createdAt: now, ...(r.k === 'maestro' ? { kind: 'maestro' as const } : {}) };
    const rs = new RoomState(info, theme, layout, 'ready', now, false, r.s);
    if (r.g) {
      rs.ghost = true;
      rs.listed = false;
    }
    return rs;
  }

  // ---------------------------------------------------------------- scene:delta

  applyDelta(delta: RemoteDelta, now: number): void {
    const sim = this.sim;
    sim.now = now;
    if (delta.x) {
      for (const id of delta.x) {
        sim.spots.releaseAll(id);
        sim.chars.delete(id);
        this.tracks.delete(id);
      }
    }
    if (delta.c) {
      for (const d of delta.c) {
        const frames = this.tracks.get(d.id);
        const last = frames?.[frames.length - 1];
        // personagem desconhecido e sem posição: um delta solto (a tela perdeu o começo); espera o próximo `scene:full`
        if (!last && d.x === undefined) continue;
        const state = mergeRemote(last?.c, d, now);
        if (!last) {
          this.ensureChar(d.id, state, now);
          this.tracks.set(d.id, [{ t: now - REMOTE_DELAY_MS - 1, c: state, jump: true }]);
          continue;
        }
        frames!.push({ t: now, c: state, jump: isTeleport(last.c, state) });
        if (frames!.length > MAX_FRAMES) frames!.shift();
      }
    }
    if (delta.r) this.applyRoomStates(delta.r, now);
    if (delta.el) this.applyElevators(delta.el);
    if (delta.u) this.applyBusy(delta.u, now);
  }

  private applyRoomStates(states: RemoteRoomState[], now: number): void {
    for (const s of states) {
      const room = this.sim.rooms.get(s.id);
      if (!room) continue;
      const phase = (s.ph === 'building' || s.ph === 'dismantling' ? s.ph : 'ready') as RoomPhase;
      room.phase = phase;
      room.phaseAt = now - s.pa;
      room.lightOn = !!s.l;
      room.lightAt = now - s.la;
    }
  }

  private applyElevators(el: number[]): void {
    this.elevatorTargets = el.slice();
  }

  private applyBusy(ids: string[], now: number): void {
    const sim = this.sim;
    sim.stallBusy.clear();
    sim.machineUntil.clear();
    // o servidor manda os ids em uso sem dizer o tipo: o desenho consulta pelo id do móvel, então cada um só vale no seu
    for (const id of ids) {
      sim.stallBusy.add(id);
      sim.machineUntil.set(id, now + FOREVER);
    }
  }

  private ensureChar(id: string, state: RemoteState, now: number): Character | null {
    const have = this.sim.chars.get(id);
    if (have) return have;
    const info = this.infos.get(id) ?? this.placeholderInfo(id, state, now);
    const ch = this.newChar(info);
    if (!ch) return null;
    this.sim.chars.set(id, ch);
    this.paint(ch, state, state.x, state.y, 0, now);
    return ch;
  }

  // ---------------------------------------------------------------- por quadro

  /** Interpola as posições, escreve o estado nos personagens e anda as portas. Não decide nada. */
  update(dt: number, now: number): void {
    const sim = this.sim;
    sim.now = now;
    const rt = now - REMOTE_DELAY_MS;
    for (const [id, frames] of this.tracks) {
      while (frames.length >= 2 && frames[1].t <= rt) frames.shift();
      const base = frames[0];
      const ch = sim.chars.get(id) ?? this.ensureChar(id, base.c, now);
      if (!ch) continue;
      const p = this.frozen ? { x: base.c.x, y: base.c.y } : interpolate(base, frames[1], rt);
      this.paint(ch, base.c, p.x, p.y, dt, now);
    }
    // portas
    sim.elevators.forEach((e, i) => {
      const target = this.elevatorTargets[i];
      if (target === undefined) return;
      const step = DOOR_SPEED * dt;
      e.door = e.door < target ? Math.min(target, e.door + step) : Math.max(target, e.door - step);
    });
    for (const [id, fx] of sim.roomFx.active) if (now >= fx.end) sim.roomFx.active.delete(id);
    if (now >= this.nextRoomInfoAt) {
      this.nextRoomInfoAt = now + 1000;
      this.refreshRoomInfo(false);
    }
  }

  /** Escreve um estado remoto no personagem (posição já interpolada). */
  private paint(ch: Character, c: RemoteState, x: number, y: number, dt: number, now: number): void {
    const sim = this.sim;
    // parado (a conexão caiu): quem andava fica em pé no lugar, sem pernas mexendo
    const pose = (this.frozen && (c.p === 'walk' || c.p === 'run') ? 'stand' : c.p) as Pose;
    if (ch.pose !== pose) {
      ch.pose = pose;
      ch.animT = 0;
    } else ch.animT += dt * 1000;
    ch.held = c.h as HeldItem;
    ch.x = x;
    ch.y = y;
    ch.tx = Math.floor(x / TILE);
    ch.ty = Math.floor(y / TILE);
    ch.dir = DIRS[c.d] ?? 'down';
    ch.seated = c.s;
    ch.alpha = c.a;
    ch.mode = c.m as Mode;
    ch.roomId = c.r;
    ch.leaving = c.lv;
    ch.inside = c.inside;
    ch.hiddenUntil = c.hiddenUntil;
    ch.sortY = c.sy;
    ch.atSpot = c.as;
    if (ch.homeSpot !== c.hs) {
      sim.spots.release(ch.homeSpot, ch.id);
      ch.homeSpot = c.hs;
    }
    // a mesa é de quem a tem como lugar de casa (o monitor da mesa lê o dono)
    if (c.hs && sim.spots.ownerOf(c.hs) !== ch.id) sim.spots.reserve(c.hs, ch.id);
    ch.gone = false;
    ch.arriving = false;
    ch.missingSince = null;
    if (ch.icon !== (c.i as IconName | null)) {
      ch.icon = c.i as IconName | null;
      ch.iconAt = now;
      ch.iconUntil = c.i ? FOREVER : 0;
    }
    if (c.b) {
      ch.bubbleIcon = c.b[0];
      ch.bubbleText = c.b[1];
      ch.bubbleAt = c.b[2];
      ch.bubbleUntil = c.b[3];
    } else {
      ch.bubbleText = null;
      ch.bubbleUntil = 0;
    }
    if (c.sa) {
      ch.sayText = c.sa[0];
      ch.sayAt = c.sa[1];
      ch.sayUntil = c.sa[2];
    } else {
      ch.sayText = '';
      ch.sayUntil = 0;
    }
    if (c.ce) {
      ch.chatEmoji = c.ce[0];
      ch.chatUntil = c.ce[1];
    } else {
      ch.chatEmoji = '';
      ch.chatUntil = 0;
    }
    ch.activityChangedAt = c.activityAt;
    if (c.sh) {
      ch.shellSince = c.sh[0];
      ch.shellCount = c.sh[1];
      if (ch.shellLabel !== c.sh[2]) {
        ch.shellLabel = c.sh[2];
        ch.shellTextKey = -1;
      }
      ch.shellStage = c.sh[3] as Character['shellStage'];
      ch.shellEnteredAt = c.sh[4];
    } else {
      ch.shellSince = 0;
      ch.shellCount = 0;
      ch.shellStage = null;
      ch.shellEnteredAt = 0;
    }
    ch.updateLane(dt);
  }

  /** Contas presentes e itens do quadro de cada sala (a placa e o kanban), como o `Sim` local faz. */
  private refreshRoomInfo(force: boolean): void {
    if (force) this.nextRoomInfoAt = this.sim.now + 1000;
    this.sim.refreshRoomInfo();
  }
}
