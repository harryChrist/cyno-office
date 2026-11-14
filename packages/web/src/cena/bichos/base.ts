// O que o gato e o cachorro têm em comum: andar pela rota da cena, fazer uma coisa por um tempo, sair do tile
// quando um agente vem, não parar colado no outro bicho. Puro (sem DOM) e determinístico: o relógio entra por
// `atualizar(dt, agora)` (dt = 0 com a cena pausada) e o sorteio por uma semente.
import { TILE } from "@cyno/cena/arte";
import type { Lado, Quadro } from "./arteComum";
import { pesDoTile, tileDe, type AgenteDaCena, type PortaCena } from "./porta";

export type Tile = { tx: number; ty: number };

export type Efeito = { tipo: "coracao" | "nota" | "z"; x: number; y: number; t0: number; dur: number };

/** O que todos os bichos compartilham: a cena, a lista de efeitos, o relógio e a posição dos outros bichos. */
export interface Contexto {
  porta: PortaCena;
  /** Relógio dos bichos (ms de animação: só avança quando a cena anda). */
  t: number;
  /** Relógio de parede (epoch ms) do quadro: para "há quanto tempo o agente trabalha". */
  agora: number;
  efeitos: Efeito[];
  /** Os tiles que os outros bichos ocupam ou para onde vão (o gato e o cachorro não ficam colados). */
  outros(de: Bicho): Tile[];
  /** Os agentes de agora (lidos uma vez por quadro). */
  agentes: AgenteDaCena[];
}

export type Acao = "para" | "senta" | "deita" | "dorme" | "cochila" | "espreguica" | "abana" | "carinho";

export interface Plano {
  destino: Tile | null;
  acao: Acao;
  /** Quanto tempo faz a ação ao chegar (ms). */
  ms: number;
  ritmo?: "anda" | "trota";
  /** Ao chegar ao destino, em vez de fazer a ação, some por um tempo sorteado entre [min, max] ms (vai embora pelo elevador). */
  sairPor?: readonly [number, number];
}

export type Estado =
  | { k: "espera"; ate: number }
  | { k: "indo"; plano: Plano; rota: Tile[] }
  | { k: "fazendo"; acao: Acao; desde: number; ate: number; depois?: Acao }
  | { k: "fora"; ate: number };

/** Distância (em tiles, máximo dos eixos) mínima entre o gato e o cachorro. */
export const DISTANCIA_ENTRE_BICHOS = 2;

export const chave = (tx: number, ty: number): number => ty * 4096 + tx;

export abstract class Bicho {
  x = 0;
  y = 0;
  lado: Lado = "right";
  /** 0 a 1: aparece e some aos poucos. */
  alpha = 0;
  estado: Estado;
  /** O bicho está ligado nas preferências (desligado = não desenha e não anda). */
  ligado = true;
  /** Desde quando está parado fazendo a ação (ms do relógio dos bichos), para escolher o quadro. */
  protected inicio = 0;
  private versao = -1;
  /** Acompanhando um agente (a entrega): não foge dele e o destino pode ser colado nele. */
  protected acompanhando = false;
  /** Para onde olha quando está parado, em tiles (sentar ao lado de alguém). */
  protected olhaPara: Tile | null = null;
  /** Último movimento (px): decide a direção do desenho. */
  private ultimoDx = 1;

  constructor(
    readonly id: string,
    protected readonly rng: () => number,
    protected readonly ctx: Contexto,
    primeiraEspera: number,
    /** Velocidade de caminhada em px/s. */
    protected readonly velocidade: number,
  ) {
    this.estado = { k: "espera", ate: primeiraEspera };
  }

  get tile(): Tile {
    return tileDe(this.x, this.y);
  }

  /** O tile em que está, ou o que vai ocupar (o destino): usado para manter o outro bicho longe. */
  tileOcupado(): Tile[] {
    const out = [this.tile];
    if (this.estado.k === "indo" && this.estado.plano.destino) out.push(this.estado.plano.destino);
    return out;
  }

  get visivel(): boolean {
    return this.ligado && this.estado.k !== "espera" && this.estado.k !== "fora" && this.alpha > 0.02;
  }

  /** Ao reaparecer depois de desligado: recomeça do zero. */
  reiniciar(): void {
    this.estado = { k: "espera", ate: this.ctx.t + 1500 };
    this.alpha = 0;
  }

  // ----------------------------------------------------------------- o que cada bicho decide

  /** O que fazer a seguir (sorteio ponderado pelo caráter do bicho). */
  protected abstract escolher(): Plano;
  /** Uma cena de preempção (cachorro que acompanha a entrega, que abana ao ver o elevador); null = segue o plano. */
  protected preemptar(): Plano | null {
    return null;
  }
  /** O bicho está andando de verdade (passo)? Para a calopsita não se aplica. */
  protected abstract ritmoAtual(): "anda" | "trota";

  // ----------------------------------------------------------------- utilidades de tiles e agentes

  protected tileLivre(t: Tile, opts: { semAgentes?: boolean } = {}): boolean {
    const { porta } = this.ctx;
    if (!porta.caminhavel(t.tx, t.ty) || porta.assento(t.tx, t.ty)) return false;
    if (!opts.semAgentes && this.agenteEm(t)) return false;
    for (const o of this.ctx.outros(this)) if (Math.max(Math.abs(o.tx - t.tx), Math.abs(o.ty - t.ty)) < DISTANCIA_ENTRE_BICHOS) return false;
    return true;
  }

  /** Um agente está neste tile, vai parar nele ou vem andando para perto dele? */
  protected agenteEm(t: Tile): boolean {
    for (const a of this.ctx.agentes) {
      const at = tileDe(a.x, a.y);
      if (at.tx === t.tx && at.ty === t.ty) return true;
      if (a.destino && a.destino.tx === t.tx && a.destino.ty === t.ty) return true;
      if (a.andando && Math.max(Math.abs(at.tx - t.tx), Math.abs(at.ty - t.ty)) <= 1) return true;
      if (Math.hypot(a.x - (t.tx * TILE + TILE / 2), a.y - (t.ty * TILE + 11)) < 9) return true;
    }
    return false;
  }

  /** Sorteia um tile de uma área (ou de qualquer área) que dê para parar e a que o bicho consiga ir. */
  protected sortearDestino(onde?: (tipo: string) => boolean): Tile | null {
    const { porta } = this.ctx;
    const areas = porta.areas().filter((a) => !onde || onde(a.tipo));
    if (!areas.length) return null;
    const total = areas.reduce((s, a) => s + a.rect.w * a.rect.h, 0);
    for (let tentativa = 0; tentativa < 14; tentativa++) {
      let r = this.rng() * total;
      let area = areas[0]!;
      for (const a of areas) {
        r -= a.rect.w * a.rect.h;
        if (r <= 0) {
          area = a;
          break;
        }
      }
      const t = { tx: area.rect.x + Math.floor(this.rng() * area.rect.w), ty: area.rect.y + Math.floor(this.rng() * area.rect.h) };
      if (!this.tileLivre(t)) continue;
      if (porta.rota(this.tile.tx, this.tile.ty, t.tx, t.ty)) return t;
    }
    return null;
  }

  /** O tile livre mais perto (≥ 2 tiles de qualquer agente) para sair da frente de alguém. */
  protected tileParaFugir(): Tile | null {
    const { porta } = this.ctx;
    const cur = this.tile;
    let melhor: Tile | null = null;
    let melhorD = Infinity;
    for (let dy = -6; dy <= 6; dy++) {
      for (let dx = -6; dx <= 6; dx++) {
        const t = { tx: cur.tx + dx, ty: cur.ty + dy };
        if (!this.tileLivre(t)) continue;
        if (this.ctx.agentes.some((a) => Math.max(Math.abs(tileDe(a.x, a.y).tx - t.tx), Math.abs(tileDe(a.x, a.y).ty - t.ty)) < 2)) continue;
        const d = Math.abs(dx) + Math.abs(dy) + this.rng() * 0.5;
        if (d >= melhorD) continue;
        if (!porta.rota(cur.tx, cur.ty, t.tx, t.ty)) continue;
        melhor = t;
        melhorD = d;
      }
    }
    return melhor;
  }

  /** Tile livre ao lado de um ponto (não assento, não ocupado). */
  protected tileAoLado(de: Tile): Tile | null {
    const opcoes: Tile[] = [];
    for (const [dx = 0, dy = 0] of [[-1, 0], [1, 0], [0, 1], [0, -1], [-1, 1], [1, 1], [-1, -1], [1, -1]]) {
      const t = { tx: de.tx + dx, ty: de.ty + dy };
      if (this.tileLivre(t)) opcoes.push(t);
    }
    if (!opcoes.length) return null;
    return opcoes[Math.floor(this.rng() * opcoes.length)] ?? null;
  }

  // ----------------------------------------------------------------- movimento

  /** Põe o bicho num tile (surgir do elevador, voltar). */
  protected colocar(t: Tile): void {
    const p = pesDoTile(t.tx, t.ty);
    this.x = p.x;
    this.y = p.y;
  }

  protected irPara(plano: Plano): void {
    const rota = plano.destino ? this.ctx.porta.rota(this.tile.tx, this.tile.ty, plano.destino.tx, plano.destino.ty) : [];
    if (!rota) {
      this.comecar({ destino: null, acao: "senta", ms: 3000 });
      return;
    }
    if (!rota.length) {
      this.comecar({ ...plano, destino: null });
      return;
    }
    this.estado = { k: "indo", plano, rota };
  }

  protected comecar(plano: Plano): void {
    if (plano.destino) return this.irPara(plano);
    this.inicio = this.ctx.t;
    this.estado = { k: "fazendo", acao: plano.acao, desde: this.ctx.t, ate: this.ctx.t + plano.ms };
  }

  /** Ritmo de caminhada do plano em andamento (para escolher o desenho e a velocidade). */
  get andando(): boolean {
    return this.estado.k === "indo";
  }

  protected velocidadeAgora(): number {
    const e = this.estado;
    return e.k === "indo" && e.plano.ritmo === "trota" ? this.velocidade * 1.7 : this.velocidade;
  }

  /** Avança um quadro. `dt` em segundos (0 = pausado). */
  atualizar(dt: number): void {
    if (!this.ligado) return;
    const { porta, t } = this.ctx;
    // fade
    const alvo = this.estado.k === "espera" || this.estado.k === "fora" ? 0 : 1;
    this.alpha += Math.sign(alvo - this.alpha) * Math.min(Math.abs(alvo - this.alpha), dt * 1.6);
    if (dt <= 0) return;
    // o prédio mudou: o tile em que estou ainda é chão?
    const v = porta.versaoDoLayout();
    if (v !== this.versao) {
      this.versao = v;
      if (this.estado.k !== "espera" && this.estado.k !== "fora") {
        const cur = this.tile;
        if (!porta.caminhavel(cur.tx, cur.ty)) {
          const n = porta.maisPerto(cur.tx, cur.ty, 8);
          if (n) {
            this.colocar(n);
            if (this.estado.k === "indo") this.estado = { k: "fazendo", acao: "senta", desde: t, ate: t + 800 };
          } else this.estado = { k: "fora", ate: t + 5000 };
        }
      }
    }
    const e = this.estado;
    switch (e.k) {
      case "espera":
        if (t >= e.ate) this.entrar();
        break;
      case "fora":
        if (t >= e.ate) this.entrar();
        break;
      case "indo":
        this.caminhar(dt);
        break;
      case "fazendo": {
        const pre = e.acao !== "carinho" ? this.preemptar() : null;
        if (pre) {
          this.comecar(pre);
          break;
        }
        if (e.acao !== "carinho" && !this.acompanhando && this.agentePertoDe(this.tile)) {
          const f = this.tileParaFugir();
          if (f) {
            this.comecar({ destino: f, acao: "para", ms: 1200, ritmo: "trota" });
            break;
          }
        }
        if (t >= e.ate) this.proximo(e);
        break;
      }
    }
    this.aoAtualizar();
  }

  /** Gancho de fim de quadro (efeitos que o bicho solta: o "z" do sono). */
  protected aoAtualizar(): void {}

  /** Só foge de quem pisa no tile dele (ou está para pisar), não de quem está sentado ao lado. */
  private agentePertoDe(tile: Tile): boolean {
    return this.agenteEm(tile);
  }

  private entrar(): void {
    const el = this.ctx.porta.pontos("elevator");
    // sai pelo elevador, a menos que o outro bicho esteja ali perto: espera um pouco
    const livre = el.find((p) => this.tileLivre(p, { semAgentes: true })) ?? (el.length ? null : this.ctx.porta.maisPerto(8, 8, 12));
    if (!livre) {
      this.estado = { k: "espera", ate: this.ctx.t + 1500 };
      return;
    }
    this.colocar(livre);
    this.alpha = 0;
    this.comecar({ destino: null, acao: "para", ms: 700 });
  }

  /** Termina uma ação: decide a próxima. */
  protected proximo(e: Extract<Estado, { k: "fazendo" }>): void {
    void e;
    this.comecar(this.escolher());
  }

  private caminhar(dt: number): void {
    const e = this.estado;
    if (e.k !== "indo") return;
    let resto = this.velocidadeAgora() * dt;
    while (resto > 0 && e.rota.length) {
      const prox = e.rota[0]!;
      // um agente parado no caminho: o bicho passa por ele (não ocupa lugar), mas não escolhe parar no tile dele
      const p = pesDoTile(prox.tx, prox.ty);
      const dx = p.x - this.x;
      const dy = p.y - this.y;
      const d = Math.hypot(dx, dy);
      if (Math.abs(dx) > 0.01) this.ultimoDx = dx;
      if (d <= resto) {
        this.x = p.x;
        this.y = p.y;
        resto -= d;
        e.rota.shift();
      } else {
        this.x += (dx / d) * resto;
        this.y += (dy / d) * resto;
        resto = 0;
      }
    }
    if (this.ultimoDx !== 0) this.lado = this.ultimoDx > 0 ? "right" : "left";
    if (!e.rota.length) {
      const dest = e.plano.destino;
      if (e.plano.sairPor) {
        const [min, max] = e.plano.sairPor;
        this.estado = { k: "fora", ate: this.ctx.t + min + this.rng() * (max - min) };
        return;
      }
      if (dest && !this.acompanhando && (this.agenteEm(dest) || !this.tileLivre(dest, { semAgentes: true }))) {
        // o lugar foi tomado no caminho: escolhe outro
        this.comecar(this.escolher());
        return;
      }
      this.comecar({ ...e.plano, destino: null });
    }
  }

  /** O quadro da animação de caminhada (índice) pelo relógio. */
  protected passoDoCiclo(msPorQuadro: number): number {
    return Math.floor(this.ctx.t / msPorQuadro);
  }

  /** Ao ser acariciado: para o que fazia, fica feliz e solta um coração; depois escolhe de novo. */
  acariciar(): boolean {
    if (!this.visivel) return false;
    const t = this.ctx.t;
    this.ctx.efeitos.push({ tipo: "coracao", x: this.x, y: this.y - 17, t0: t, dur: 1500 });
    this.inicio = t;
    this.estado = { k: "fazendo", acao: "carinho", desde: t, ate: t + 2600 };
    return true;
  }

  /** O retângulo clicável (px de mundo). */
  area(): { x: number; y: number; w: number; h: number } | null {
    return this.visivel ? { x: this.x - 10, y: this.y - 17, w: 20, h: 19 } : null;
  }

  abstract get profundidade(): number;
  /** O desenho de agora (null se não há nada para desenhar). */
  abstract quadro(): Quadro | null;
}

/** Sorteio ponderado: `pesos` por nome; devolve o escolhido (determinístico pelo `rng`). */
export function sortearPeso<T extends string>(rng: () => number, pesos: Readonly<Record<T, number>>): T {
  const ent = Object.entries(pesos) as [T, number][];
  const total = ent.reduce((s, [, p]) => s + p, 0);
  let r = rng() * total;
  for (const [k, p] of ent) {
    r -= p;
    if (r <= 0) return k;
  }
  return ent[ent.length - 1]![0];
}
