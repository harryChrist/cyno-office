// O gato do escritório: chega alguns segundos depois de abrir, passeia pelas salas e pelo corredor pela rota do motor,
// senta, deita no tapete (ou perto do sofá do lounge), dorme perto de um agente que trabalha há muito tempo, se
// espreguiça ao levantar e some por alguns minutos de vez em quando. Só enfeite: nada aqui mexe em agente, tarefa ou estado.
import type { Quadro } from "./arteComum";
import { quadroGato, type PoseGato } from "./arteGato";
import { Bicho, sortearPeso, type Acao, type Contexto, type Plano, type Tile } from "./base";
import { tileDe } from "./porta";

/** O agente trabalha há tanto tempo (ms) que o gato vai dormir perto dele. */
export const TRABALHO_LONGO_MS = 8 * 60_000;
/** O gato some por tanto tempo (ms), no mínimo e no máximo, e não antes de tanto tempo desde a última vez. */
export const SOME_POR_MS: readonly [number, number] = [90_000, 240_000];
export const INTERVALO_MIN_ENTRE_SUMIDAS_MS = 4 * 60_000;

const PESOS = { passear: 34, sentar: 20, deitar: 16, dormir: 14, espreguicar: 0, sumir: 6 } as const;

export class Gato extends Bicho {
  private ultimaSumida = 0;
  /** A ação anterior foi de descanso (então levanta se espreguiçando). */
  private descansou = false;

  constructor(id: string, rng: () => number, ctx: Contexto, primeiraEspera = 4000 + Math.floor(rng() * 4000)) {
    super(id, rng, ctx, primeiraEspera, 44);
    this.ultimaSumida = -INTERVALO_MIN_ENTRE_SUMIDAS_MS / 2;
  }

  get profundidade(): number {
    return this.y;
  }

  protected ritmoAtual(): "anda" | "trota" {
    return "anda";
  }

  /** O agente que trabalha há mais tempo (acima do limite), com um tile livre ao lado dele. */
  private agenteQueTrabalhaHaMuito(): Tile | null {
    let melhor: { t: Tile; desde: number } | null = null;
    for (const a of this.ctx.agentes) {
      if (a.modo !== "work" || a.andando) continue;
      if (this.ctx.agora - a.desde < TRABALHO_LONGO_MS) continue;
      const ao = this.tileAoLado(tileDe(a.x, a.y));
      if (!ao) continue;
      if (!melhor || a.desde < melhor.desde) melhor = { t: ao, desde: a.desde };
    }
    return melhor?.t ?? null;
  }

  /** Um tile de tapete (de preferência do lounge) em que dê para deitar. */
  private tileDeTapete(): Tile | null {
    const { porta } = this.ctx;
    const areas = porta.areas();
    const lounge = areas.filter((a) => a.tipo === "lounge");
    for (const grupo of [lounge, areas]) {
      const cand: Tile[] = [];
      for (const a of grupo) {
        for (const r of a.tapetes) {
          for (let ty = Math.floor(r.y / 16); ty < Math.ceil((r.y + r.h) / 16); ty++) {
            for (let tx = Math.floor(r.x / 16); tx < Math.ceil((r.x + r.w) / 16); tx++) {
              if (this.tileLivre({ tx, ty })) cand.push({ tx, ty });
            }
          }
        }
      }
      if (cand.length) {
        for (let i = 0; i < 6; i++) {
          const t = cand[Math.floor(this.rng() * cand.length)]!;
          if (this.ctx.porta.rota(this.tile.tx, this.tile.ty, t.tx, t.ty)) return t;
        }
      }
    }
    return null;
  }

  protected escolher(): Plano {
    const { t } = this.ctx;
    // levantou de um descanso: espreguiça primeiro
    if (this.descansou) {
      this.descansou = false;
      return { destino: null, acao: "espreguica", ms: 2200 };
    }
    const pesos: Record<keyof typeof PESOS, number> = { ...PESOS };
    if (t - this.ultimaSumida < INTERVALO_MIN_ENTRE_SUMIDAS_MS) pesos.sumir = 0;
    const perto = this.agenteQueTrabalhaHaMuito();
    if (!perto) pesos.dormir = pesos.dormir * 0.35;
    else pesos.dormir += 18;
    const f = sortearPeso(this.rng, pesos);
    switch (f) {
      case "sentar": {
        this.descansou = false;
        return { destino: null, acao: "senta", ms: 6000 + this.rng() * 8000 };
      }
      case "deitar": {
        const tp = this.tileDeTapete();
        this.descansou = true;
        return { destino: tp, acao: "deita", ms: 12000 + this.rng() * 14000 };
      }
      case "dormir": {
        const dest = perto ?? this.tileDeTapete();
        this.descansou = true;
        return { destino: dest, acao: "dorme", ms: 22000 + this.rng() * 22000 };
      }
      case "sumir":
        this.ultimaSumida = t;
        return { destino: this.ctx.porta.pontos("elevator")[0] ?? null, acao: "para", ms: 0, sairPor: SOME_POR_MS };
      default: {
        const d = this.sortearDestino();
        return { destino: d, acao: "para", ms: 800 + this.rng() * 1600 };
      }
    }
  }

  /** O desenho de agora. */
  quadro(): Quadro | null {
    if (!this.visivel && this.alpha <= 0.02) return null;
    const e = this.estado;
    let pose: PoseGato = "para";
    let i = 0;
    if (e.k === "indo") {
      pose = "anda";
      i = this.passoDoCiclo(130);
    } else if (e.k === "fazendo") {
      const acao: Acao = e.acao;
      const rel = this.ctx.t - e.desde;
      const mapa: Record<Acao, PoseGato> = { para: "para", senta: "senta", deita: "deita", dorme: "dorme", cochila: "dorme", espreguica: "espreguica", abana: "para", carinho: "carinho" };
      pose = mapa[acao];
      i = acao === "dorme" ? Math.floor(rel / 1400) : acao === "deita" ? (Math.floor(rel / 3200) % 4 === 3 ? 1 : 0) : acao === "carinho" ? Math.floor(rel / 380) : Math.floor(rel / 900);
    }
    return quadroGato(pose, i, this.lado);
  }

  /** Cria um "z" de vez em quando enquanto dorme. */
  protected override aoAtualizar(): void {
    const e = this.estado;
    if (e.k !== "fazendo" || e.acao !== "dorme") return;
    const rel = this.ctx.t - e.desde;
    const n = Math.floor(rel / 2600);
    if (n !== this.ultimoZ && rel > 800) {
      this.ultimoZ = n;
      this.ctx.efeitos.push({ tipo: "z", x: this.x + (this.lado === "right" ? 8 : -8), y: this.y - 10, t0: this.ctx.t, dur: 2200 });
    }
  }
  private ultimoZ = -1;
}
