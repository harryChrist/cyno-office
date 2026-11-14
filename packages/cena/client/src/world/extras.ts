// ARQUIVO NOSSO (não vem do Habblaud): o gancho de "extras" do motor. Um extra é uma entidade que não é agente
// (o bicho do escritório, um enfeite vivo): entra na ordenação por profundidade do quadro, tem posição em px de
// mundo, um desenho por quadro e uma área de clique. Ver PATCHES.md (patches 11 e 12) e docs/arquitetura.md.
import type { Camera } from './camera';
import type { Renderer } from './render/renderer';
import type { Sim } from './sim/sim';

/** Retângulo em px de mundo. */
export interface ExtraRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Uma entidade extra da cena. */
export interface ExtraEntity {
  id: string;
  /** Profundidade (px de mundo): quem tem `y` menor é desenhado antes (fica atrás). Os pés do bicho, em geral. */
  y: number;
  /** false = não desenha e não recebe clique. */
  visible: boolean;
  /** Desenha em coordenadas de mundo (o contexto já está na transformação da câmera). */
  draw(ctx: CanvasRenderingContext2D, now: number): void;
  /** Área de clique (px de mundo), ou null/ausente: não clicável. */
  hit?(): ExtraRect | null;
}

/** O que a cena entrega a quem a consulta e estende (`world.probe()`). Os objetos são os vivos: não guarde por muito tempo. */
export interface WorldProbe {
  /** A simulação atual (muda quando o timelapse recomeça o mundo: leia de novo a cada quadro). */
  readonly sim: Sim;
  readonly renderer: Renderer;
  readonly camera: Camera;
  /** O timelapse está ligado? (a cena mostra o dia reproduzido, não o ao vivo) */
  readonly playback: boolean;
  /** A cena está fora da tela (outra página aberta)? Os quadros não rodam; serve para quem consulta de fora. */
  readonly suspended: boolean;
}

export interface FrameInfo {
  /** Segundos de animação neste quadro (0 com o timelapse pausado; já com o fator do timelapse). */
  dt: number;
  /** Relógio do mundo (epoch ms; no timelapse, o instante reproduzido). */
  now: number;
  playback: boolean;
}

/** O gancho de extras exposto por `createWorld`. */
export interface ExtrasApi {
  /** Registra uma entidade extra. Devolve quem remove. */
  add(e: ExtraEntity): () => void;
  /** Chamado a cada quadro, depois da simulação e antes do desenho (os extras andam aqui). Devolve quem desliga. */
  onFrame(cb: (f: FrameInfo) => void): () => void;
  /**
   * Clique num extra (só quando não há agente sob o cursor: o agente tem a vez). Devolve true se tratou o clique
   * (a cena não seleciona a sala). `at` em px de mundo.
   */
  onClick(cb: (e: ExtraEntity, at: { x: number; y: number }) => boolean): () => void;
  /** O extra visível sob o ponto (px de mundo; o mais à frente), ou null. */
  at(wx: number, wy: number): ExtraEntity | null;
  /** Os extras de agora (para o desenho e os testes). */
  list(): readonly ExtraEntity[];
}

/** Um ponto cabe na área? */
export function inExtraRect(r: ExtraRect, x: number, y: number): boolean {
  return x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
}

/** O extra visível sob o ponto, o de maior `y` (o mais à frente). */
export function extraAt(list: readonly ExtraEntity[], wx: number, wy: number): ExtraEntity | null {
  let best: ExtraEntity | null = null;
  for (const e of list) {
    if (!e.visible) continue;
    const r = e.hit?.();
    if (!r || !inExtraRect(r, wx, wy)) continue;
    if (!best || e.y >= best.y) best = e;
  }
  return best;
}

/** O registro por trás do gancho: a cena usa `entities`, `frame` e `dispatchClick`; o resto é o `ExtrasApi` público. */
export interface ExtrasHost extends ExtrasApi {
  readonly entities: ExtraEntity[];
  frame(f: FrameInfo): void;
  /** Despacha o clique num extra aos ouvintes; true se algum tratou. */
  dispatchClick(e: ExtraEntity, at: { x: number; y: number }): boolean;
}

/** Cria o registro de extras (a lista é compartilhada com o renderer, que a recria junto com o timelapse). */
export function createExtras(): ExtrasHost {
  const entities: ExtraEntity[] = [];
  const frames = new Set<(f: FrameInfo) => void>();
  const clicks = new Set<(e: ExtraEntity, at: { x: number; y: number }) => boolean>();
  return {
    entities,
    add(e) {
      entities.push(e);
      return () => {
        const i = entities.indexOf(e);
        if (i >= 0) entities.splice(i, 1);
      };
    },
    onFrame(cb) {
      frames.add(cb);
      return () => void frames.delete(cb);
    },
    onClick(cb) {
      clicks.add(cb);
      return () => void clicks.delete(cb);
    },
    at: (wx, wy) => extraAt(entities, wx, wy),
    list: () => entities,
    frame(f) {
      for (const cb of [...frames]) cb(f);
    },
    dispatchClick(e, at) {
      let handled = false;
      for (const cb of [...clicks]) if (cb(e, at)) handled = true;
      return handled;
    },
  };
}
