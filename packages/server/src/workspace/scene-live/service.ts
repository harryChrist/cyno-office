import { DEFAULT_WORLD_OPTIONS, PURE_ART, Sim, type Character, type RoomState } from "@cyno/cena/sim";
import {
  buildSceneFrame,
  emptyLogMemory,
  forgetAgentLog,
  rememberLogEntry,
  SCENE_LIVE_IDLE_MS,
  SCENE_LIVE_SEND_HZ,
  SCENE_LIVE_TICK_HZ,
  SCENE_LIVE_VERSION,
  type FrameInput,
  type SceneChar,
  type SceneCharDelta,
  type SceneDelta,
  type SceneDir,
  type SceneFull,
  type SceneHello,
  type SceneLayout,
  type SceneMode,
  type ScenePhase,
  type SceneRoomState,
  type ServerEvent,
} from "@cyno/shared";
import { entradaDoQuadro, memoriaInicial, montarRetrato, type MemoriaDaCena } from "@cyno/shared/cena";
import type { OfficeSnapshot } from "@cyno/cena/tipos";

/** Espera entre a última mudança do escritório e o novo retrato (rajadas de `agent:log` viram uma montagem só; o mesmo do cliente). */
export const SCENE_SNAPSHOT_DELAY_MS = 150;
/** Mesmo sem evento, o retrato é refeito de tempos em tempos (a ferramenta que vence, a cota que volta, a festa que acaba). */
export const SCENE_SNAPSHOT_POLL_MS = 1_000;
/** Idades acima disto não importam para a tela (a luz e as fases só animam nos primeiros segundos). */
const AGE_CAP_MS = 600_000;

const TICK_MS = Math.round(1000 / SCENE_LIVE_TICK_HZ);
const SEND_MS = Math.round(1000 / SCENE_LIVE_SEND_HZ);

/** `CYNO_SCENE_LIVE`: a cena ao vivo (padrão DESLIGADA). Só "1", "on" ou "true" ligam. */
export function sceneLiveEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.CYNO_SCENE_LIVE?.trim().toLowerCase();
  return value === "1" || value === "on" || value === "true";
}

/** `SCENE_LIVE_IDLE_MS`: quanto a simulação segue ligada sem nenhuma tela olhando (padrão 5 min). */
export function sceneLiveIdleMs(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number(env.SCENE_LIVE_IDLE_MS);
  return env.SCENE_LIVE_IDLE_MS !== undefined && env.SCENE_LIVE_IDLE_MS.trim() !== "" && Number.isFinite(value) && value >= 0 ? value : SCENE_LIVE_IDLE_MS;
}

export type SceneLiveDeps = {
  workspaceId: string;
  workspaceName: () => string;
  /** Os dados do Cyno de agora: os mesmos que o gravador da linha do tempo lê. */
  source: () => Omit<FrameInput, "log" | "now">;
  now: () => number;
  /** Quanto fica ligado depois da última tela sair. */
  idleMs: number;
  log: { warn: (object: unknown, message: string) => void };
};

/** Quem recebe as mensagens: o JSON já pronto (uma serialização só para todos). */
export type SceneListener = (wire: string) => void;

/** Um personagem com os tempos ABSOLUTOS (para comparar de um envio ao outro sem que as idades mudem sozinhas). */
type Abs = {
  x: number;
  y: number;
  d: SceneDir;
  p: string;
  h: string;
  s: 0 | 1;
  a: number;
  m: SceneMode;
  r: string;
  lv: 0 | 1;
  in: 0 | 1;
  /** Epoch até quando fica escondido (0 = visível). */
  hu: number;
  sy: number | null;
  as: string | null;
  hs: string | null;
  i: string | null;
  /** [ícone, texto, desde, até] (epoch). */
  b: [string, string, number, number] | null;
  /** [texto, desde, até]. */
  sa: [string, number, number] | null;
  /** [emoji, até]. */
  ce: [string, number] | null;
  ca: number;
  /** [desde, quantos, rótulo, estágio, entrou] (epoch). */
  sh: [number, number, string, string | null, number] | null;
};

type AbsRoom = { ph: ScenePhase; phaseAt: number; l: 0 | 1; lightAt: number };

const DIR: Record<string, SceneDir> = { down: "d", up: "u", left: "l", right: "r" };
const round = (value: number, places: number): number => {
  const k = 10 ** places;
  return Math.round(value * k) / k;
};
const same = (a: unknown, b: unknown): boolean => a === b || (typeof a === "object" && typeof b === "object" && JSON.stringify(a) === JSON.stringify(b));
const age = (now: number, at: number): number => Math.max(0, Math.min(AGE_CAP_MS, Math.round(now - at)));
const left = (now: number, until: number): number => Math.max(0, Math.min(AGE_CAP_MS, Math.round(until - now)));

/** O estado do `Character` que a tela desenha e que a simulação decide, em tempos absolutos. */
function absOf(ch: Character, now: number): Abs {
  const shell = ch.shellSince > 0 ? ([Math.round(ch.shellSince), ch.shellCount, ch.shellLabel, ch.shellStage, Math.round(ch.shellEnteredAt)] as Abs["sh"]) : null;
  return {
    x: round(ch.x, 1),
    y: round(ch.y, 1),
    d: DIR[ch.dir] ?? "d",
    p: ch.pose,
    h: ch.held,
    s: ch.seated ? 1 : 0,
    a: round(ch.alpha, 2),
    m: ch.mode,
    r: ch.roomId,
    lv: ch.leaving ? 1 : 0,
    in: ch.inside ? 1 : 0,
    hu: ch.hiddenUntil > now ? Math.round(ch.hiddenUntil) : 0,
    sy: ch.sortY === null ? null : round(ch.sortY, 1),
    as: ch.atSpot,
    hs: ch.homeSpot,
    i: ch.icon,
    b: ch.bubbleText && now < ch.bubbleUntil ? [ch.bubbleIcon, ch.bubbleText, Math.round(ch.bubbleAt), Math.round(ch.bubbleUntil)] : null,
    sa: ch.sayText && now < ch.sayUntil ? [ch.sayText, Math.round(ch.sayAt), Math.round(ch.sayUntil)] : null,
    ce: ch.chatEmoji && now < ch.chatUntil ? [ch.chatEmoji, Math.round(ch.chatUntil)] : null,
    ca: Math.round(ch.activityChangedAt),
    sh: shell,
  };
}

/** Um valor de `Abs` no formato do fio (idades e restantes em relação a `now`). */
function wire<K extends keyof Abs>(key: K, value: Abs[K], now: number): SceneChar[K extends keyof SceneChar ? K : never] {
  let out: unknown = value;
  switch (key) {
    case "hu":
      out = value ? left(now, value as number) : 0;
      break;
    case "b": {
      const v = value as Abs["b"];
      out = v ? [v[0], v[1], age(now, v[2]), left(now, v[3])] : null;
      break;
    }
    case "sa": {
      const v = value as Abs["sa"];
      out = v ? [v[0], age(now, v[1]), left(now, v[2])] : null;
      break;
    }
    case "ce": {
      const v = value as Abs["ce"];
      out = v ? [v[0], left(now, v[1])] : null;
      break;
    }
    case "ca":
      out = age(now, value as number);
      break;
    case "sh": {
      const v = value as Abs["sh"];
      out = v ? [age(now, v[0]), v[1], v[2], v[3], age(now, v[4])] : null;
      break;
    }
    default:
      break;
  }
  return out as SceneChar[K extends keyof SceneChar ? K : never];
}

const KEYS = ["x", "y", "d", "p", "h", "s", "a", "m", "r", "lv", "in", "hu", "sy", "as", "hs", "i", "b", "sa", "ce", "ca", "sh"] as const satisfies readonly (keyof Abs)[];

function fullChar(id: string, abs: Abs, now: number): SceneChar {
  const out: Record<string, unknown> = { id };
  for (const key of KEYS) out[key] = wire(key, abs[key], now);
  return out as SceneChar;
}

/** Eventos do hub que podem mudar o que a cena desenha (os mesmos do gravador da linha do tempo). */
const SCENE_EVENTS: ReadonlySet<ServerEvent["type"]> = new Set([
  "task:upserted",
  "task:progress",
  "agent:upserted",
  "agent:deleted",
  "agent:terminal",
  "room:upserted",
  "room:deleted",
  "team:upserted",
  "team:deleted",
  "foryou:upserted",
  "foryou:deleted",
  "project:upserted",
  "project:deleted",
]);

/** O que existe só enquanto alguém assiste. */
type Run = {
  sim: Sim;
  memory: MemoriaDaCena | null;
  signature: string;
  sentChars: Map<string, Abs>;
  sentRooms: Map<string, AbsRoom>;
  sentElevators: string;
  sentBusy: string;
  layoutSignature: string;
  lastTickAt: number;
  dirtyAt: number | null;
  lastSnapshotAt: number;
  tick: ReturnType<typeof setInterval>;
  send: ReturnType<typeof setInterval>;
};

/**
 * A cena ao vivo de UM workspace: roda o `Sim` do motor no servidor enquanto alguém assiste e entrega o estado às telas.
 *
 * - Liga na primeira assinatura e desliga `idleMs` depois da última sair (descarta o `Sim`: a próxima começa do zero).
 *   Reassinar dentro da folga mantém a cena.
 * - Nada vai para o disco: o `Sim` roda com carteiras só em memória e a memória do adaptador (ordem de chegada dos agentes
 *   e das salas) nasce vazia a cada ligação, o que dá uma ordem determinística (a do escritório: agentes pela ordem do
 *   array, salas pelo Maestro primeiro, depois pelo mapa).
 * - O retrato (o mesmo `montarRetrato` do navegador, alimentado pelo mesmo quadro do gravador da linha do tempo) é refeito
 *   150 ms depois de uma mudança do escritório e a cada 1 s, e só entra no `Sim` se mudou.
 * - O `Sim` anda a 20 Hz; a cada 100 ms sai o que mudou (`scene:delta`), ou um `scene:full` novo se o layout mudou.
 */
export class SceneLiveService {
  private readonly log = emptyLogMemory();
  private readonly listeners = new Set<SceneListener>();
  private run: Run | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private warned = false;

  constructor(private readonly deps: SceneLiveDeps) {}

  /** A simulação está ligada? */
  get active(): boolean {
    return this.run !== null;
  }

  get subscribers(): number {
    return this.listeners.size;
  }

  /** O que a simulação tem agora (só para testes e para a medição): os personagens em memória. */
  get sim(): Sim | null {
    return this.run?.sim ?? null;
  }

  /**
   * Uma tela abriu o Escritório. Liga a simulação se estava desligada e entrega `scene:hello` e `scene:full` na hora
   * (o estado do instante, não o inicial). Devolve a função que fecha a assinatura.
   */
  subscribe(listener: SceneListener): () => void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
    if (!this.run) this.start();
    // Fecha o que está pendente para os outros e usa o mesmo instante como base: o delta seguinte vale para quem entra agora.
    this.publish();
    this.listeners.add(listener);
    const now = this.deps.now();
    const hello: SceneHello = { v: SCENE_LIVE_VERSION, t: "scene:hello", at: now, tickHz: SCENE_LIVE_TICK_HZ, sendHz: SCENE_LIVE_SEND_HZ, idleMs: this.deps.idleMs };
    this.safeSend(listener, JSON.stringify(hello));
    this.safeSend(listener, JSON.stringify(this.buildFull(now)));
    let open = true;
    return () => {
      if (!open) return;
      open = false;
      this.listeners.delete(listener);
      if (this.listeners.size === 0 && this.run) {
        this.idleTimer = setTimeout(() => this.stop(), this.deps.idleMs);
        this.idleTimer.unref?.();
      }
    };
  }

  /** Um evento do hub do workspace: guarda o que só o log sabe (ferramenta e subagentes) e marca "mudou". */
  observe(event: ServerEvent): void {
    if (event.type === "agent:log") {
      if (rememberLogEntry(this.log, event.entry, this.deps.now())) this.touch();
      return;
    }
    if (event.type === "agent:deleted") forgetAgentLog(this.log, event.id);
    if (SCENE_EVENTS.has(event.type)) this.touch();
  }

  /** Desliga tudo já (o workspace fechou ou o servidor vai parar). */
  dispose(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    this.listeners.clear();
    this.stop();
  }

  // ---------------------------------------------------------------- ligar e desligar

  private start(): void {
    const sim = new Sim(PURE_ART, () => ({ ...DEFAULT_WORLD_OPTIONS }), null, {});
    const now = this.deps.now();
    const run: Run = {
      sim,
      memory: null,
      signature: "",
      sentChars: new Map(),
      sentRooms: new Map(),
      sentElevators: "",
      sentBusy: "",
      layoutSignature: "",
      lastTickAt: now,
      dirtyAt: null,
      lastSnapshotAt: -Infinity,
      tick: setInterval(() => this.tick(), TICK_MS),
      send: setInterval(() => this.publish(), SEND_MS),
    };
    run.tick.unref?.();
    run.send.unref?.();
    this.run = run;
    this.refreshSnapshot(now);
    this.baseline(run, now);
  }

  private stop(): void {
    const run = this.run;
    if (!run) return;
    clearInterval(run.tick);
    clearInterval(run.send);
    this.run = null;
  }

  private touch(): void {
    if (this.run && this.run.dirtyAt === null) this.run.dirtyAt = this.deps.now();
  }

  private safeSend(listener: SceneListener, wireText: string): void {
    try {
      listener(wireText);
    } catch (error) {
      if (!this.warned) {
        this.warned = true;
        this.deps.log.warn({ err: error }, "falha ao entregar a cena ao vivo a uma tela");
      }
    }
  }

  private broadcast(wireText: string): void {
    for (const listener of [...this.listeners]) this.safeSend(listener, wireText);
  }

  private fail(error: unknown): void {
    if (this.warned) return;
    this.warned = true;
    this.deps.log.warn({ err: error }, "erro na cena ao vivo");
  }

  // ---------------------------------------------------------------- o laço

  private tick(): void {
    const run = this.run;
    if (!run) return;
    const now = this.deps.now();
    try {
      const pending = run.dirtyAt !== null && now - run.dirtyAt >= SCENE_SNAPSHOT_DELAY_MS;
      if (pending || now - run.lastSnapshotAt >= SCENE_SNAPSHOT_POLL_MS) this.refreshSnapshot(now);
      const dt = Math.min(0.25, Math.max(0, (now - run.lastTickAt) / 1000));
      run.lastTickAt = now;
      run.sim.update(dt, now);
    } catch (error) {
      this.fail(error);
    }
  }

  /** Monta o retrato do escritório de agora e, se mudou, entrega ao `Sim`. */
  private refreshSnapshot(now: number): void {
    const run = this.run;
    if (!run) return;
    run.dirtyAt = null;
    run.lastSnapshotAt = now;
    const source = this.deps.source();
    const frame = buildSceneFrame({ ...source, log: this.log, now });
    const entrada = entradaDoQuadro(frame, now);
    // O quadro da linha do tempo não grava tema nem semente da sala; o escritório de verdade tem, e é ele que vale.
    const { snapshot, memoria } = montarRetrato(
      { ...entrada, office: { ...entrada.office, rooms: source.office.rooms }, workspaceId: this.deps.workspaceId, workspaceName: this.deps.workspaceName() },
      run.memory ?? memoriaInicial(now),
    );
    run.memory = memoria;
    const signature = signatureOf(snapshot);
    if (signature === run.signature) return;
    run.signature = signature;
    run.sim.applySnapshot(snapshot, now);
  }

  // ---------------------------------------------------------------- o que sai

  private layoutOf(sim: Sim): SceneLayout {
    const rooms = [...sim.rooms.values()].filter((room) => room.present);
    return {
      cols: sim.building.cols,
      rooms: rooms.map((room) => ({
        id: room.id,
        s: room.slot,
        sd: room.seed,
        ...(room.layout.maestro ? { k: "maestro" as const } : {}),
        ...(room.ghost ? { g: 1 as const } : {}),
        n: room.info.name,
      })),
    };
  }

  private roomsOf(sim: Sim): Map<string, AbsRoom> {
    const out = new Map<string, AbsRoom>();
    for (const room of sim.rooms.values()) if (room.present) out.set(room.id, absRoom(room));
    return out;
  }

  private elevatorsOf(sim: Sim): number[] {
    return sim.elevators.map((elevator) => elevator.state);
  }

  private busyOf(sim: Sim, now: number): string[] {
    const ids = new Set<string>(sim.stallBusy);
    for (const [id, until] of sim.machineUntil) if (until > now) ids.add(id);
    return [...ids].sort();
  }

  private charsOf(sim: Sim, now: number): Map<string, Abs> {
    const out = new Map<string, Abs>();
    for (const ch of sim.chars.values()) if (!ch.gone) out.set(ch.id, absOf(ch, now));
    return out;
  }

  /** Guarda o estado de agora como o que as telas já têm. */
  private baseline(run: Run, now: number): void {
    run.sentChars = this.charsOf(run.sim, now);
    run.sentRooms = this.roomsOf(run.sim);
    run.sentElevators = JSON.stringify(this.elevatorsOf(run.sim));
    run.sentBusy = JSON.stringify(this.busyOf(run.sim, now));
    run.layoutSignature = JSON.stringify(this.layoutOf(run.sim));
  }

  private buildFull(now: number): SceneFull {
    const run = this.run!;
    return {
      v: SCENE_LIVE_VERSION,
      t: "scene:full",
      at: now,
      lv: run.sim.layoutVersion,
      layout: this.layoutOf(run.sim),
      chars: [...run.sentChars].map(([id, abs]) => fullChar(id, abs, now)),
      rooms: [...run.sentRooms].map(([id, room]) => roomWire(id, room, now)),
      el: this.elevatorsOf(run.sim),
      u: this.busyOf(run.sim, now),
    };
  }

  /** A cada 100 ms: o que mudou desde o último envio vai às telas (um `scene:full` novo se o layout mudou). */
  private publish(): void {
    const run = this.run;
    if (!run) return;
    const now = this.deps.now();
    try {
      const layoutSignature = JSON.stringify(this.layoutOf(run.sim));
      const chars = this.charsOf(run.sim, now);
      const rooms = this.roomsOf(run.sim);
      const elevators = this.elevatorsOf(run.sim);
      const busy = this.busyOf(run.sim, now);
      if (layoutSignature !== run.layoutSignature) {
        run.sentChars = chars;
        run.sentRooms = rooms;
        run.sentElevators = JSON.stringify(elevators);
        run.sentBusy = JSON.stringify(busy);
        run.layoutSignature = layoutSignature;
        if (this.listeners.size > 0) this.broadcast(JSON.stringify(this.buildFull(now)));
        return;
      }
      const delta: SceneDelta = { v: SCENE_LIVE_VERSION, t: "scene:delta", at: now };
      const changed: SceneCharDelta[] = [];
      for (const [id, abs] of chars) {
        const before = run.sentChars.get(id);
        if (!before) {
          changed.push(fullChar(id, abs, now));
          continue;
        }
        let out: Record<string, unknown> | null = null;
        for (const key of KEYS) {
          if (same(before[key], abs[key])) continue;
          out ??= { id };
          out[key] = wire(key, abs[key], now);
        }
        if (out) changed.push(out as SceneCharDelta);
      }
      const gone = [...run.sentChars.keys()].filter((id) => !chars.has(id));
      const roomsChanged: SceneRoomState[] = [];
      for (const [id, room] of rooms) if (!same(run.sentRooms.get(id), room)) roomsChanged.push(roomWire(id, room, now));
      const elevatorsText = JSON.stringify(elevators);
      const busyText = JSON.stringify(busy);
      if (changed.length) delta.c = changed;
      if (gone.length) delta.x = gone;
      if (roomsChanged.length) delta.r = roomsChanged;
      if (elevatorsText !== run.sentElevators) delta.el = elevators;
      if (busyText !== run.sentBusy) delta.u = busy;
      run.sentChars = chars;
      run.sentRooms = rooms;
      run.sentElevators = elevatorsText;
      run.sentBusy = busyText;
      if (delta.c || delta.x || delta.r || delta.el || delta.u) this.broadcast(JSON.stringify(delta));
    } catch (error) {
      this.fail(error);
    }
  }
}

function absRoom(room: RoomState): AbsRoom {
  return { ph: room.phase as ScenePhase, phaseAt: Math.round(room.phaseAt), l: room.lightOn ? 1 : 0, lightAt: Math.round(room.lightAt) };
}

function roomWire(id: string, room: AbsRoom, now: number): SceneRoomState {
  return { id, ph: room.ph, pa: age(now, room.phaseAt), l: room.l, la: age(now, room.lightAt) };
}

/** Assinatura do retrato (como a do cliente): tudo menos o número e o relógio, que sempre andam. */
function signatureOf(snapshot: OfficeSnapshot): string {
  return JSON.stringify({ rooms: snapshot.rooms, agents: snapshot.agents, accounts: snapshot.accounts, meta: snapshot.meta });
}
