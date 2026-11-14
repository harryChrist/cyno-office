// Arquivo nosso (não vem do Habblaud): o que se desenha em cima da cidade local do Cyno. Substitui o `social.ts` do
// original (curtir, cumprimentar, teletransporte...), que ficou de fora, e guarda só o que a cidade do Cyno usa:
// as duas placas da praça (a meta da semana do dono e o resumo da cidade), as bandeirinhas e os enfeites quando a
// meta bate, os fogos, a luz da praça à noite e os letreiros legíveis dos prédios (nome e selo do que espera o dono).
// Os módulos de desenho (`fireworks.ts`, `facade.ts`) são os copiados.
import { signRect } from './facade';
import {
  BOARDS,
  boardTextRects,
  BUNTING,
  drawBunting,
  drawBuntingLights,
  drawGoalBoard,
  drawHallBoard,
  drawSeasonal,
  Fireworks,
  ornamentFor,
  seasonalSpots,
  type GoalView,
} from './fireworks';
import type { BuildingVis, CityFx, CityFxProp, CityScreenMap, CityView } from './scene';

const UI_FONT = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif';

/** O que a praça mostra (montado pelo Cyno a partir dos workspaces). */
export interface PracaDados {
  /** Prédios com agente trabalhando agora. */
  acesos: number;
  /** Agentes trabalhando em todos os workspaces. */
  agentes: number;
  /** A meta da semana do dono; null = sem meta (a placa convida a definir). */
  meta: GoalView | null;
  /** Texto de apoio na placa da meta quando não há meta. */
  semMeta?: string;
}

export const PRACA_VAZIA: PracaDados = { acesos: 0, agentes: 0, meta: null };

/** Onde a etiqueta do prédio mora na tela (para o clique e os testes): px CSS do canvas. */
export interface EtiquetaDoPredio {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** O gancho de desenho da cidade do Cyno (`CityRenderer.fx`). */
export class Praca implements CityFx {
  dados: PracaDados = PRACA_VAZIA;
  /** Com `zoom` abaixo disto o letreiro do prédio (da fachada) é pequeno demais e esta etiqueta o substitui. */
  static readonly ZOOM_DO_LETREIRO = 1.05;
  /** Id do prédio do workspace aberto: ganha um anel na etiqueta. */
  atual: string | null = null;
  readonly etiquetas: EtiquetaDoPredio[] = [];
  /** Quem desenha a cidade (ligado pela vista): os prédios do último quadro e a noite (0..1). */
  fonte: { buildingsDrawn: readonly BuildingVis[]; night: number } | null = null;
  private readonly fogos = new Fireworks();
  private readonly pool: CityFxProp[] = [];
  private ultimo = 0;
  private fim = 0;

  /** Dispara os fogos da praça por 20 s (a meta bateu). */
  festejar(now: number): void {
    this.fogos.start(now);
    this.fim = now + 20_000;
  }

  /** Os fogos estão no ar? */
  get festejando(): boolean {
    return this.fogos.active;
  }

  frame(now: number, dt: number): void {
    this.ultimo = now;
    this.fogos.update(now, dt);
    this.fogos.confetti.update(dt);
  }

  private meta(now: number): GoalView | null {
    const m = this.dados.meta;
    if (m && this.fogos.showing(now)) return { ...m, pct: 1, pctText: '100%', progressText: 'Meta batida!', reached: Math.max(1, m.reached) };
    return m;
  }

  props(view: CityView, push: (p: CityFxProp) => void): void {
    const pool = this.pool;
    let used = 0;
    const take = (y: number, draw: (ctx: CanvasRenderingContext2D, now: number) => void) => {
      let p = pool[used];
      if (!p) pool[used] = p = { y, draw };
      p.y = y;
      p.draw = draw;
      used++;
      push(p);
    };
    const inView = (x: number, y: number, w: number, hh: number) => x < view.x1 && x + w > view.x0 && y < view.y1 && y + hh > view.y0;
    const bw = BOARDS.w;
    const bh = BOARDS.h + BOARDS.posts;
    if (inView(BOARDS.goal.x - bw / 2, BOARDS.goal.y - bh, bw, bh)) take(BOARDS.goal.y, (ctx, now) => drawGoalBoard(ctx, this.meta(now), now));
    if (inView(BOARDS.hall.x - bw / 2, BOARDS.hall.y - bh, bw, bh)) take(BOARDS.hall.y, (ctx) => drawHallBoard(ctx, this.dados.acesos > 0));
    if ((this.meta(this.ultimo)?.reached ?? 0) < 1) return;
    for (const [x0, y0, x1, y1] of BUNTING) {
      if (inView(x0, y0 - 4, x1 - x0, 30)) take(y0 + 40, (ctx, now) => drawBunting(ctx, x0, y0, x1, y1, now));
    }
    for (const s of seasonalSpots(ornamentFor(new Date()))) {
      if (inView(s.x - 20, s.y - 60, 40, 64)) take(s.y, (ctx) => drawSeasonal(ctx, s.kind, s.x, s.y));
    }
  }

  world(ctx: CanvasRenderingContext2D, now: number, view: CityView): void {
    const noite = this.fonte?.night ?? 0;
    const inView = (x: number, y: number, w: number, hh: number) => x < view.x1 && x + w > view.x0 && y < view.y1 && y + hh > view.y0;
    if (noite > 0.15) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (const [b, tint] of [
        [BOARDS.goal, 'rgba(255,150,110,'],
        [BOARDS.hall, 'rgba(130,180,255,'],
      ] as const) {
        const x = b.x - BOARDS.w / 2 + 3;
        const y = b.y - BOARDS.posts - BOARDS.h + 3;
        if (!inView(x, y, BOARDS.w, BOARDS.h)) continue;
        ctx.fillStyle = `${tint}${(0.16 * noite).toFixed(3)})`;
        ctx.fillRect(x, y, BOARDS.w - 6, BOARDS.h - 6);
        ctx.fillStyle = `${tint}${(0.07 * noite).toFixed(3)})`;
        ctx.fillRect(x - 6, y - 6, BOARDS.w + 6, BOARDS.h + 6);
      }
      if ((this.meta(now)?.reached ?? 0) >= 1) {
        for (const [x0, y0, x1, y1] of BUNTING) if (inView(x0, y0 - 4, x1 - x0, 34)) drawBuntingLights(ctx, x0, y0, x1, y1, now, noite);
      }
      ctx.restore();
    }
    this.fogos.confetti.draw(ctx, view.x0, view.y0, view.x1, view.y1, now);
    this.fogos.draw(ctx, now, view, noite);
  }

  /** Espaço de tela: os textos das placas da praça e as etiquetas dos prédios (nome e selo). */
  screen(ctx: CanvasRenderingContext2D, now: number, map: CityScreenMap): void {
    this.textosDaPraca(ctx, map, now);
    this.etiquetasDosPredios(ctx, map, this.fonte?.buildingsDrawn ?? []);
  }

  private texto(ctx: CanvasRenderingContext2D, t0: string, x: number, y: number, maxW: number, size: number, cor: string, peso = 700, alinhar: CanvasTextAlign = 'left'): void {
    ctx.font = `${peso} ${size.toFixed(1)}px ${UI_FONT}`;
    let t = t0;
    while (t.length > 1 && ctx.measureText(t).width > maxW) t = `${t.slice(0, -2).trimEnd()}…`;
    ctx.textAlign = alinhar;
    ctx.fillStyle = 'rgba(5,8,14,0.6)';
    ctx.fillText(t, x + 0.5, y + 1);
    ctx.fillStyle = cor;
    ctx.fillText(t, x, y);
  }

  private quebrar(ctx: CanvasRenderingContext2D, texto: string, maxW: number, size: number, peso = 600): string[] {
    ctx.font = `${peso} ${size.toFixed(1)}px ${UI_FONT}`;
    const out: string[] = [];
    let cur = '';
    for (const palavra of texto.split(' ')) {
      const next = cur ? `${cur} ${palavra}` : palavra;
      if (ctx.measureText(next).width <= maxW || !cur) cur = next;
      else {
        out.push(cur);
        cur = palavra;
      }
    }
    if (cur) out.push(cur);
    return out;
  }

  private textosDaPraca(ctx: CanvasRenderingContext2D, map: CityScreenMap, now: number): void {
    const rects = boardTextRects();
    const k = map.k;
    const g = this.meta(now);
    ctx.save();
    ctx.textBaseline = 'middle';
    const pequeno = Math.max(7, Math.min(11, 4.2 * k));
    const passo = pequeno * 1.18;
    const altura = ctx.canvas.height;
    const dentro = (x: number, y: number, w: number, h: number) => x + w > -50 && y + h > -50 && y < altura + 50;
    {
      const r = rects.goal;
      const x = map.sx(r.x);
      const y = map.sy(r.y);
      const w = r.w * k;
      if (dentro(x, y, w, 52 * k)) {
        this.texto(ctx, 'META DA SEMANA', x + w / 2, y + 4 * k, w - 4, Math.max(7, Math.min(11, 4.6 * k)), '#fff1e0', 800, 'center');
        const esq = x + 16 * k;
        const tw = w - 19 * k;
        if (g) {
          const grande = Math.max(10, Math.min(24, 9.5 * k));
          this.texto(ctx, g.pctText, esq, y + 17 * k, tw, grande, g.pct >= 1 ? '#ffd166' : '#ff9c74', 800);
          let yy = y + 17 * k + grande * 0.75 + passo * 0.5;
          for (const l of this.quebrar(ctx, g.label, tw, pequeno).slice(0, 2)) {
            this.texto(ctx, l, esq, yy, tw, pequeno, '#d6dcea', 600);
            yy += passo;
          }
          this.texto(ctx, g.progressText, esq, yy, tw, pequeno * 0.92, '#9aa4b8', 600);
        } else {
          let yy = y + 17 * k;
          for (const l of this.quebrar(ctx, this.dados.semMeta ?? 'Defina uma meta da semana.', tw, pequeno).slice(0, 4)) {
            this.texto(ctx, l, esq, yy, tw, pequeno, '#9aa4b8', 600);
            yy += passo;
          }
        }
      }
    }
    {
      const r = rects.hall;
      const x = map.sx(r.x);
      const y = map.sy(r.y);
      const w = r.w * k;
      if (dentro(x, y, w, 52 * k)) {
        this.texto(ctx, 'CYNO', x + w / 2, y + 4 * k, w - 4, Math.max(7, Math.min(11, 4.6 * k)), '#e3f1ff', 800, 'center');
        const esq = x + 23 * k;
        const tw = w - 26 * k;
        const { acesos, agentes } = this.dados;
        const acesas = acesos === 1 ? '1 prédio aceso agora' : `${acesos} prédios acesos agora`;
        const trabalhando = agentes === 0 ? 'Ninguém trabalhando' : agentes === 1 ? '1 agente trabalhando' : `${agentes} agentes trabalhando`;
        let yy = y + 15 * k;
        for (const l of this.quebrar(ctx, acesas, tw, pequeno, 700).slice(0, 2)) {
          this.texto(ctx, l, esq, yy, tw, pequeno, '#ffd27a', 700);
          yy += passo;
        }
        yy += passo * 0.3;
        for (const l of this.quebrar(ctx, trabalhando, tw, pequeno).slice(0, 2)) {
          this.texto(ctx, l, esq, yy, tw, pequeno, '#d6dcea', 600);
          yy += passo;
        }
      }
    }
    ctx.restore();
  }

  /**
   * A etiqueta do prédio: nome do workspace e, se algo espera o dono, o selo com o número. Aparece quando a fachada
   * está pequena (a placa pintada na fachada só se lê de perto); de perto, quem escreve é a fachada (com o selo, patch 10).
   */
  private etiquetasDosPredios(ctx: CanvasRenderingContext2D, map: CityScreenMap, predios: readonly BuildingVis[]): void {
    this.etiquetas.length = 0;
    const k = map.k;
    ctx.save();
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    for (const v of predios) {
      const r = signRect(v.m);
      const larguraDaPlaca = r.w * k;
      const aberto = v.b.state === 'online';
      const espera = v.b.likes;
      const noPredio = this.atual === v.b.id;
      const perto = map.zoom >= Praca.ZOOM_DO_LETREIRO;
      // de perto a placa da fachada cabe o nome (a etiqueta some, mas o retângulo continua valendo para o clique)
      const cx = map.sx(v.x + r.x + r.w / 2);
      const base = map.sy(v.y + r.y + r.h / 2);
      if (perto) {
        this.etiquetas.push({ id: v.b.id, x: cx - larguraDaPlaca / 2, y: base - 6, w: larguraDaPlaca, h: 12 });
        continue;
      }
      const tamanho = 11.5;
      const fonte = `700 ${tamanho}px ${UI_FONT}`;
      ctx.font = fonte;
      const selo = espera > 0 ? String(espera) : '';
      const seloW = selo ? Math.max(16, ctx.measureText(selo).width + 10) : 0;
      let nome = v.b.owner.name;
      const maxNome = Math.max(70, Math.min(190, 192 * k * 1.6));
      while (nome.length > 1 && ctx.measureText(nome).width > maxNome) nome = `${nome.slice(0, -2).trimEnd()}…`;
      const nomeW = ctx.measureText(nome).width;
      const w = nomeW + 16 + (seloW ? seloW + 4 : 0);
      const h = 20;
      const x = Math.round(cx - w / 2);
      const y = Math.round(base - h / 2);
      ctx.globalAlpha = aberto ? 1 : 0.8;
      ctx.fillStyle = noPredio ? 'rgba(22,52,86,0.94)' : 'rgba(14,17,26,0.86)';
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, 6);
      ctx.fill();
      ctx.lineWidth = noPredio ? 2 : 1;
      ctx.strokeStyle = noPredio ? 'rgba(124,200,255,0.95)' : 'rgba(255,255,255,0.18)';
      ctx.stroke();
      ctx.fillStyle = aberto ? '#fff8e6' : '#aab0be';
      ctx.fillText(nome, x + 8, y + h / 2 + 0.5);
      if (selo) {
        const sx = x + 8 + nomeW + 6;
        ctx.fillStyle = '#f5a524';
        ctx.beginPath();
        ctx.roundRect(sx, y + 3, seloW, h - 6, (h - 6) / 2);
        ctx.fill();
        ctx.fillStyle = '#1a1206';
        ctx.textAlign = 'center';
        ctx.font = `800 10.5px ${UI_FONT}`;
        ctx.fillText(selo, sx + seloW / 2, y + h / 2 + 0.5);
        ctx.textAlign = 'left';
      }
      ctx.globalAlpha = 1;
      this.etiquetas.push({ id: v.b.id, x, y, w, h });
    }
    ctx.restore();
  }
}
