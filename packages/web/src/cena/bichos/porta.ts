// A porta entre os bichos e a cena: tudo o que eles precisam saber do escritório (onde estão as áreas, que tiles são
// livres, onde estão os agentes, a rota entre dois pontos), em tipos simples. Assim o comportamento dos bichos é puro
// e testável com uma cena falsa; `portaDoMotor` liga isto ao `probe()` do motor.
import { FURNITURE, TILE } from "@cyno/cena/arte";
import type { WorldProbe } from "@cyno/cena";

export const FOOT_DX = TILE / 2;
export const FOOT_DY = 11;

export type TipoDeArea = "recepcao" | "banheiro" | "copa" | "lounge" | "sala" | "corredor";

export interface Retangulo {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface AreaDaCena {
  id: string;
  tipo: TipoDeArea;
  /** Em tiles. */
  rect: Retangulo;
  /** Tapetes (px de mundo): o gato gosta deles. */
  tapetes: Retangulo[];
}

export interface AgenteDaCena {
  id: string;
  /** Pés, px de mundo. */
  x: number;
  y: number;
  /** Modo da simulação: work, wait, idle, shell, deliver, leave. */
  modo: string;
  andando: boolean;
  sentado: boolean;
  /** Para onde vai (último passo de caminhada da fila), em tiles. */
  destino: { tx: number; ty: number } | null;
  /** Desde quando está no status atual (epoch ms). */
  desde: number;
  /** Saindo do elevador agora. */
  chegando: boolean;
  /** Ids das tarefas concluídas (para o assobio discreto da calopsita). */
  concluidas: readonly string[];
  /** Sala onde trabalha. */
  salaId: string;
}

export interface PoleiroNaCena {
  /** Onde a calopsita pisa (px de mundo, pés). */
  x: number;
  y: number;
  /** Profundidade em que o poleiro e a calopsita são desenhados (px de mundo). */
  profundidade: number;
  /** Para onde ela olha. */
  lado: "left" | "right";
  /** Em que sala está: "maestro" ou "recepcao". */
  onde: "maestro" | "recepcao";
}

export interface PortaCena {
  /** Muda quando o prédio muda (sala nova, sala desmontada): os bichos conferem o próprio tile. */
  versaoDoLayout(): number;
  largura(): number;
  altura(): number;
  /** O tile é chão (qualquer coisa que não é parede ou móvel)? */
  caminhavel(tx: number, ty: number): boolean;
  /** O tile é um assento (cadeira, poltrona, sofá)? Os bichos não escolhem parar ali. */
  assento(tx: number, ty: number): boolean;
  /** Rota de tiles do ponto de partida (sem ele) ao destino (com ele), ou null se não há. */
  rota(sx: number, sy: number, gx: number, gy: number): { tx: number; ty: number }[] | null;
  agentes(): AgenteDaCena[];
  areas(): AreaDaCena[];
  /** Tiles de aproximação dos pontos de um tipo ("elevator", "sofa"...). */
  pontos(tipo: string): { tx: number; ty: number }[];
  /** O tile caminhável mais perto. */
  maisPerto(tx: number, ty: number, raio?: number): { tx: number; ty: number } | null;
  /** Onde fica o poleiro da calopsita (na Sala do Maestro, se `noMaestro` e ela existe; senão na recepção). */
  poleiro(noMaestro: boolean): PoleiroNaCena | null;
}

/** Tile de um ponto em px (pés). */
export const tileDe = (x: number, y: number): { tx: number; ty: number } => ({ tx: Math.floor(x / TILE), ty: Math.floor(y / TILE) });
/** Pés no ponto padrão de um tile. */
export const pesDoTile = (tx: number, ty: number): { x: number; y: number } => ({ x: tx * TILE + FOOT_DX, y: ty * TILE + FOOT_DY });

const TIPO_DA_AREA: Record<string, TipoDeArea> = { reception: "recepcao", restroom: "banheiro", cafe: "copa", lounge: "lounge", room: "sala", corridor: "corredor" };

/** O topo do tampo de uma mesa: onde a calopsita pisa (px acima da base do móvel). */
const TAMPO_ACIMA_DA_BASE = 14;

/** Liga a porta ao mundo da cena (`world.probe()`): sempre lê a simulação de agora (o timelapse a recria). */
export function portaDoMotor(probe: () => WorldProbe): PortaCena {
  const sim = () => probe().sim;
  const grade = () => sim().building.grid;
  const buf: number[] = [];
  return {
    versaoDoLayout: () => sim().layoutVersion,
    largura: () => grade().w,
    altura: () => grade().h,
    caminhavel: (tx, ty) => grade().walkable(tx, ty),
    assento: (tx, ty) => grade().get(tx, ty) === 2,
    rota(sx, sy, gx, gy) {
      if (!sim().finder.find(sx, sy, gx, gy, buf)) return null;
      const out: { tx: number; ty: number }[] = [];
      for (let i = 0; i < buf.length; i += 2) out.push({ tx: buf[i]!, ty: buf[i + 1]! });
      return out;
    },
    agentes() {
      const out: AgenteDaCena[] = [];
      for (const ch of sim().chars.values()) {
        if (ch.gone || ch.inside || ch.alpha <= 0.05) continue;
        let destino: { tx: number; ty: number } | null = null;
        for (const s of ch.step ? [ch.step, ...ch.queue] : ch.queue) if (s.t === "go") destino = { tx: s.tx, ty: s.ty };
        out.push({
          id: ch.id,
          x: ch.x,
          y: ch.y,
          modo: ch.mode,
          andando: ch.pose === "walk" || ch.pose === "run",
          sentado: ch.seated,
          destino,
          desde: ch.info.statusSince,
          chegando: ch.step?.t === "elevOut",
          concluidas: ch.info.tasks.filter((t) => t.status === "completed").map((t) => t.id),
          salaId: ch.roomId,
        });
      }
      return out;
    },
    areas() {
      const b = sim().building;
      const todas = [...b.core, b.corridor, ...b.rooms];
      return todas.map((a) => ({
        id: a.id,
        tipo: TIPO_DA_AREA[a.kind] ?? "sala",
        rect: { ...a.rect },
        tapetes: a.rugs.map((r) => ({ x: r.x, y: r.y, w: r.w, h: r.h })),
      }));
    },
    pontos: (tipo) =>
      sim()
        .building.spots.filter((s) => s.kind === tipo)
        .map((s) => ({ tx: s.tx, ty: s.ty })),
    maisPerto: (tx, ty, raio = 6) => {
      const n = grade().nearestWalkable(tx, ty, raio);
      return n ? { tx: n.x, ty: n.y } : null;
    },
    poleiro(noMaestro) {
      const b = sim().building;
      const sala = noMaestro ? b.rooms.find((r) => r.id === "sala-do-maestro") : undefined;
      const area = sala ?? b.core.find((a) => a.kind === "reception");
      if (!area) return null;
      // na Sala do Maestro o poleiro fica na ponta direita da mesa de chefe; na recepção, na do balcão
      const mesas = area.furniture.filter((f) => (sala ? f.kind === "boss_desk" || f.kind === "desk" : f.kind === "reception_desk"));
      if (!mesas.length) return null;
      // a ponta direita da mesa (a mais à direita da ilha, ou do balcão), em cima do tampo
      let fim = mesas[0]!;
      for (const f of mesas) if (f.tx + FURNITURE[f.kind].footprint.w > fim.tx + FURNITURE[fim.kind].footprint.w) fim = f;
      const w = FURNITURE[fim.kind].footprint.w;
      const baseY = (fim.ty + FURNITURE[fim.kind].footprint.h) * TILE;
      return {
        x: (fim.tx + w) * TILE - 11,
        y: baseY - TAMPO_ACIMA_DA_BASE,
        profundidade: baseY + 1,
        lado: "left",
        onde: sala ? "maestro" : "recepcao",
      };
    },
  };
}
