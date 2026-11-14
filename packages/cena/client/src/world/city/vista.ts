// Arquivo nosso (não vem do Habblaud): a cidade local do Cyno num <canvas>. Monta o `CityRenderer`, o `CityState`, a
// câmera e a entrada (arrastar, roda, pinça, clique) do Habblaud, sem jogador, rede nem social. Quem alimenta a
// cidade é o Cyno (`aplicar` com os prédios que ele montou); a vista só desenha, enquadra e avisa do clique.
import * as artModule from '../../art';
import type { ArtModule } from '../../art/api';
import { TILE } from '../../art/api';
import type { WorldSceneSnapshot } from '../../../../shared/world/api';
import { BLOCK_TILES, blockOrigin, lotOrigin, LOT, PLAZA } from '../../../../shared/world/city';
import type { WorldBuildingPublic } from '../../../../shared/world/protocol';
import { DEFAULT_WORLD_OPTIONS, type WorldOptions } from '../api';
import { Camera } from '../camera';
import { CityInput } from './input';
import { Praca, PRACA_VAZIA, type EtiquetaDoPredio, type PracaDados } from './praca';
import { CityRenderer } from './scene';
import { CityState } from './state';

const art: ArtModule = artModule;

/** Zoom mínimo da cidade (a mesma conta do Habblaud: ~200 lotes numa tela larga). */
export const ZOOM_MINIMO = 0.28;
/** Zoom máximo da vista (de perto o bastante para ler a placa pintada na fachada). */
export const ZOOM_MAXIMO = 3;
/** Abaixo disto a fachada deixa de ser legível: o enquadramento inicial deixa a praça de fora. */
const ZOOM_LEGIVEL = 0.45;
const NIVEIS_BAIXOS = [0.375, 0.5, 0.75];

class CameraDaCidade extends Camera {
  override levels(): number[] {
    const set = new Set(super.levels());
    for (const z of NIVEIS_BAIXOS) if (z >= this.minZoom - 1e-6) set.add(z);
    set.add(this.minZoom);
    return [...set].filter((z) => z <= ZOOM_MAXIMO).sort((a, b) => a - b);
  }
}

/** Faixa da praça (em tiles, a partir do topo do quarteirão) que sempre entra no enquadramento: a fonte, o coreto e as placas. O gramado dos cantos pode ficar de fora. */
const PRACA_NUCLEO = { y0: 3, y1: 21 } as const;

/**
 * Retângulo do mundo (px) que contém os lotes usados e a praça: o que a vista enquadra. Com `nucleo`, a praça entra só
 * pela faixa do meio (o gramado de cima e de baixo fica fora) e a folga ao norte segue a altura real da fachada mais alta
 * (2 andares por tile, de 2 a 6 tiles): é o que deixa os prédios maiores numa faixa baixa e larga.
 */
export function limitesDaCidade(predios: readonly (Pick<WorldBuildingPublic, 'lot'> & Partial<Pick<WorldBuildingPublic, 'floors'>>)[], comPraca = true, nucleo = false): { x: number; y: number; w: number; h: number } {
  const p = blockOrigin(PLAZA);
  const sem = !comPraca && predios.length > 0;
  let x0 = sem ? Infinity : p.x;
  let y0 = sem ? Infinity : p.y + (nucleo ? PRACA_NUCLEO.y0 : 0);
  let x1 = sem ? -Infinity : p.x + BLOCK_TILES.w;
  let y1 = sem ? -Infinity : p.y + (nucleo ? PRACA_NUCLEO.y1 : BLOCK_TILES.h);
  let andares = 0;
  for (const b of predios) {
    const o = lotOrigin(b.lot);
    x0 = Math.min(x0, o.x);
    y0 = Math.min(y0, o.y);
    x1 = Math.max(x1, o.x + LOT.w);
    y1 = Math.max(y1, o.y + LOT.h);
    andares = Math.max(andares, b.floors ?? 12);
  }
  // a fachada sobe acima do lote (até 12 andares): folga ao norte
  const norte = nucleo && predios.length > 0 ? Math.max(2, Math.min(6, Math.ceil(andares / 2))) : 6;
  return { x: x0 * TILE, y: (y0 - norte) * TILE, w: (x1 - x0) * TILE, h: (y1 - y0 + norte) * TILE };
}

export interface ClicouNaCidade {
  /** Id do prédio clicado, ou null (clicou no chão). */
  id: string | null;
  /** Ponto do clique em px CSS do canvas. */
  x: number;
  y: number;
}

export interface VistaOpcoes {
  canvas: HTMLCanvasElement;
  /** Opções do desenho (dia e noite, tema); o padrão do motor. */
  opcoes?: () => Partial<WorldOptions>;
  /** Margem coberta pela interface (px CSS), como no escritório. */
  aoClicar?: (c: ClicouNaCidade) => void;
  /** Hora fixa (0 a 24) em vez da hora local: para capturas e testes. */
  hora?: number | null;
}

export interface Vista {
  /** Troca os prédios e os dados da praça. */
  aplicar(predios: readonly WorldBuildingPublic[], praca?: PracaDados): void;
  /** O prédio do workspace aberto (ganha o destaque). */
  destacar(id: string | null): void;
  /** Enquadra todos os lotes usados e a praça. */
  enquadrar(animar?: boolean): void;
  /** Põe a câmera no prédio e aproxima. */
  focarPredio(id: string, zoom?: number): void;
  zoomPor(fator: number): void;
  /** Para o laço de desenho (aba escondida, faixa fechada) e o retoma; ao retomar, nada é recalculado. */
  suspender(suspensa: boolean): void;
  readonly suspensa: boolean;
  /** Dispara os fogos da praça. */
  festejar(): void;
  /** Onde o prédio está na tela agora (px CSS do canvas), se estiver desenhado. */
  telaDoPredio(id: string): { x: number; y: number; w: number; h: number } | null;
  /** Qual prédio está sob o ponto (px CSS do canvas). */
  predioEm(x: number, y: number): string | null;
  etiquetas(): readonly EtiquetaDoPredio[];
  readonly camera: Camera;
  readonly renderer: CityRenderer;
  readonly estado: CityState;
  destruir(): void;
}

export function criarVista(o: VistaOpcoes): Vista {
  const camera = new CameraDaCidade();
  camera.minZoom = ZOOM_MINIMO;
  camera.bounds = { x: -1e7, y: -1e7, w: 2e7, h: 2e7 };
  const estado = new CityState();
  const renderer = new CityRenderer(o.canvas, art, camera, estado);
  const praca = new Praca();
  praca.fonte = renderer;
  renderer.fx = praca;
  if (o.hora !== undefined) renderer.hourOverride = o.hora;
  let predios: readonly WorldBuildingPublic[] = [];
  let destaque: string | null = null;
  let pairando: string | null = null;
  let suspensa = true;
  let raf = 0;
  let ultimo = 0;
  let enquadrou = false;

  const opcoes = (): WorldOptions => ({ ...DEFAULT_WORLD_OPTIONS, ...o.opcoes?.() });

  const dimensionar = () => {
    const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    const w = o.canvas.clientWidth || 800;
    const h = o.canvas.clientHeight || 300;
    const pw = Math.floor(w * dpr);
    const ph = Math.floor(h * dpr);
    if (o.canvas.width !== pw || o.canvas.height !== ph) {
      o.canvas.width = pw;
      o.canvas.height = ph;
    }
    camera.setView(w, h, dpr);
  };

  const predioEm = (sx: number, sy: number): string | null => {
    // a etiqueta (nome e selo) também clica no prédio
    for (const e of praca.etiquetas) if (sx >= e.x && sx <= e.x + e.w && sy >= e.y && sy <= e.y + e.h) return e.id;
    const w = camera.screenToWorld(sx, sy);
    let melhor: string | null = null;
    let fundo = -Infinity;
    for (const v of renderer.buildingsDrawn) {
      if (w.x < v.x || w.x > v.x + 192 || w.y < v.y || w.y > v.y + v.m.height) continue;
      if (v.depth > fundo) {
        fundo = v.depth;
        melhor = v.b.id;
      }
    }
    return melhor;
  };

  const entrada = new CityInput(o.canvas, camera, {
    active: () => false,
    hover: (sx, sy, dentro) => {
      pairando = dentro ? predioEm(sx, sy) : null;
      o.canvas.style.cursor = pairando ? 'pointer' : '';
    },
    click: (sx, sy) => o.aoClicar?.({ id: predioEm(sx, sy), x: sx, y: sy }),
    interact: () => camera.stop(),
    zoomStep: (passos, sx = camera.viewW / 2, sy = camera.viewH / 2) => camera.zoomAt(camera.stepZoom(passos), sx, sy, Date.now(), true),
    use: () => undefined,
    recenter: () => enquadrar(true),
    moved: () => undefined,
  });

  const enquadrar = (animar = false) => {
    dimensionar();
    // A praça entra no enquadramento; se isso deixar os prédios pequenos demais para ler (tela estreita ou cidade
    // grande), o enquadramento fica só nos lotes usados e a praça fica a um arrasto de distância.
    // Numa faixa baixa e larga o zoom que cabe a praça inteira deixa gramado dos dois lados: o enquadramento cresce até
    // encher a largura (ou até a faixa do meio da praça encher a altura), cortando só o gramado de cima e de baixo.
    let r = limitesDaCidade(predios);
    let z = camera.fitZoom(r, 14);
    if (z < ZOOM_LEGIVEL && predios.length > 0) {
      r = limitesDaCidade(predios, false);
      z = camera.fitZoom(r, 14);
    } else if (predios.length > 0) {
      const nucleo = limitesDaCidade(predios, true, true);
      const largura = camera.fitZoom({ x: r.x, y: r.y, w: r.w, h: 1 }, 14);
      z = Math.max(z, Math.min(camera.fitZoom(nucleo, 14), largura));
      r = nucleo;
    }
    z = Math.max(ZOOM_MINIMO, Math.min(1.6, z));
    const c = camera.centerFor(r.x + r.w / 2, r.y + r.h / 2, z);
    camera.stop();
    if (animar) camera.animateTo(c.x, c.y, z, Date.now(), 380);
    else {
      camera.zoom = z;
      camera.x = c.x;
      camera.y = c.y;
    }
    enquadrou = true;
  };

  const laco = (ts: number) => {
    raf = requestAnimationFrame(laco);
    const folga = ultimo ? ts - ultimo : 16.7;
    const dt = ultimo ? Math.min(0.1, Math.max(0, folga / 1000)) : 1 / 60;
    ultimo = ts;
    try {
      const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
      if (o.canvas.clientWidth !== camera.viewW || o.canvas.clientHeight !== camera.viewH || dpr !== camera.dpr) {
        dimensionar();
        if (!enquadrou) enquadrar(false);
      }
      const agora = performance.now();
      praca.frame(agora, dt);
      camera.update(Date.now(), null, dt);
      renderer.frame(agora, dt, opcoes(), null, { building: pairando ?? destaque, player: null, door: null, me: null });
    } catch (erro) {
      console.error('[cidade] erro no frame', erro);
    }
  };

  const vista: Vista = {
    aplicar(novos, dados = PRACA_VAZIA) {
      predios = novos;
      praca.dados = dados;
      const porChunk = new Map<string, WorldBuildingPublic[]>();
      for (const b of novos) {
        const chave = `${b.lot.district}:0,0`;
        porChunk.set(chave, [...(porChunk.get(chave) ?? []), b]);
      }
      const snapshot: WorldSceneSnapshot = {
        stream: 'cyno',
        connected: true,
        viewing: true,
        afk: false,
        chunks: [...porChunk].map(([chunk, buildings]) => ({ chunk, rev: 1, buildings })),
        players: [],
        minimap: null,
      };
      estado.applySnapshot(snapshot, performance.now());
      if (!enquadrou) enquadrar(false);
    },
    destacar(id) {
      destaque = id;
      praca.atual = id;
    },
    enquadrar,
    focarPredio(id, zoomPedido) {
      const v = renderer.buildingsDrawn.find((x) => x.b.id === id);
      const b = estado.buildings.get(id);
      const o2 = b ? lotOrigin(b.lot) : null;
      const altura = v ? v.m.height : 150;
      const cx = v ? v.x + 96 : o2 ? (o2.x + LOT.w / 2) * TILE : 0;
      const cy = v ? v.y + altura / 2 : o2 ? (o2.y + LOT.h / 2) * TILE : 0;
      // sem zoom pedido, o prédio inteiro cabe na vista (até 2x)
      const zoom = zoomPedido ?? Math.max(ZOOM_MINIMO, Math.min(2, camera.fitZoom({ x: cx - 96, y: cy - altura / 2, w: 192, h: altura + 24 }, 10)));
      const c = camera.centerFor(cx, cy, zoom);
      camera.animateTo(c.x, c.y, zoom, Date.now(), 380);
    },
    zoomPor(fator) {
      if (!Number.isFinite(fator) || fator <= 0 || fator === 1) return;
      camera.zoomAt(camera.stepZoom(fator > 1 ? 1 : -1), camera.viewW / 2, camera.viewH / 2, Date.now(), true);
    },
    suspender(s) {
      if (s === suspensa) return;
      suspensa = s;
      cancelAnimationFrame(raf);
      if (!s) {
        ultimo = 0;
        raf = requestAnimationFrame(laco);
      }
    },
    get suspensa() {
      return suspensa;
    },
    festejar: () => praca.festejar(performance.now()),
    telaDoPredio(id) {
      const v = renderer.buildingsDrawn.find((x) => x.b.id === id);
      if (!v) return null;
      const a = camera.worldToScreen(v.x, v.y);
      const b = camera.worldToScreen(v.x + 192, v.y + v.m.height);
      return { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y };
    },
    predioEm,
    etiquetas: () => praca.etiquetas,
    camera,
    renderer,
    estado,
    destruir() {
      cancelAnimationFrame(raf);
      suspensa = true;
      entrada.destroy();
    },
  };
  return vista;
}
