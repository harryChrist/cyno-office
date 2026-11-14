// O cachorro do escritório: passeia com passo calmo, senta ao lado de um agente à toa, cochila na recepção, abana o
// rabo quando alguém chega pelo elevador e, às vezes, acompanha o agente que entrega uma tarefa. Só enfeite: nada
// aqui mexe em agente, tarefa ou estado.
import type { Quadro } from "./arteComum";
import { quadroCachorro, type PoseCachorro } from "./arteCachorro";
import { Bicho, sortearPeso, type Acao, type Contexto, type Plano, type Tile } from "./base";
import { tileDe } from "./porta";

const PESOS = { passear: 38, sentarComAgente: 22, cochilar: 14, sentar: 14, deitar: 12 } as const;
/** Chance de ir junto quando um agente começa uma entrega, e a espera até poder acompanhar outra. */
export const CHANCE_DE_ACOMPANHAR = 0.6;
export const ESPERA_DEPOIS_DE_ACOMPANHAR_MS = 25_000;
/** Chance de abanar o rabo quando alguém sai do elevador. */
export const CHANCE_DE_ABANAR = 0.75;

export class Cachorro extends Bicho {
  private seguindo: string | null = null;
  private seguirPronto = 0;
  private proximoAjuste = 0;
  private entregasVistas = new Set<string>();
  private chegadasVistas = new Set<string>();

  constructor(id: string, rng: () => number, ctx: Contexto, primeiraEspera = 9000 + Math.floor(rng() * 6000)) {
    super(id, rng, ctx, primeiraEspera, 36);
  }

  get profundidade(): number {
    return this.y;
  }

  get acompanhandoId(): string | null {
    return this.seguindo;
  }

  protected ritmoAtual(): "anda" | "trota" {
    return "anda";
  }

  protected escolher(): Plano {
    const f = sortearPeso(this.rng, PESOS);
    switch (f) {
      case "sentarComAgente": {
        const alvo = this.ctx.agentes.filter((a) => a.modo === "idle" && !a.andando);
        if (alvo.length) {
          const a = alvo[Math.floor(this.rng() * alvo.length)]!;
          const ao = this.tileAoLado(tileDe(a.x, a.y));
          if (ao) return { destino: ao, acao: "senta", ms: 9000 + this.rng() * 8000 };
        }
        return { destino: this.sortearDestino(), acao: "senta", ms: 6000 + this.rng() * 6000 };
      }
      case "cochilar": {
        const d = this.sortearDestino((tipo) => tipo === "recepcao");
        return { destino: d, acao: "cochila", ms: 20000 + this.rng() * 22000 };
      }
      case "sentar":
        return { destino: null, acao: "senta", ms: 6000 + this.rng() * 7000 };
      case "deitar":
        return { destino: null, acao: "deita", ms: 9000 + this.rng() * 9000 };
      default:
        return { destino: this.sortearDestino(), acao: "para", ms: 600 + this.rng() * 1400 };
    }
  }

  protected override preemptar(): Plano | null {
    // abana o rabo para quem chega pelo elevador (só se não está ocupado com outra coisa)
    if (this.seguindo) return null;
    const chegando = this.ctx.agentes.filter((a) => a.chegando);
    for (const a of chegando) {
      if (this.chegadasVistas.has(a.id)) continue;
      this.chegadasVistas.add(a.id);
      if (this.rng() < CHANCE_DE_ABANAR) return { destino: null, acao: "abana", ms: 3200 };
    }
    return null;
  }

  override atualizar(dt: number): void {
    if (dt > 0 && this.ligado && (this.estado.k === "fazendo" || this.estado.k === "indo")) this.cuidarDaEntrega();
    // esquece quem já saiu do elevador (a próxima chegada abana de novo)
    if (this.chegadasVistas.size) {
      const ainda = new Set(this.ctx.agentes.filter((a) => a.chegando).map((a) => a.id));
      for (const id of this.chegadasVistas) if (!ainda.has(id)) this.chegadasVistas.delete(id);
    }
    super.atualizar(dt);
  }

  /** Um agente entrega uma tarefa (caminha até quem a pediu): o cachorro vai junto, às vezes. */
  private cuidarDaEntrega(): void {
    const { t, agentes } = this.ctx;
    const entregando = agentes.filter((a) => a.modo === "deliver" && a.andando);
    if (!this.seguindo) {
      const ids = new Set(entregando.map((a) => a.id));
      for (const id of this.entregasVistas) if (!ids.has(id)) this.entregasVistas.delete(id);
      if (t < this.seguirPronto) return;
      for (const a of entregando) {
        if (this.entregasVistas.has(a.id)) continue;
        this.entregasVistas.add(a.id);
        if (this.rng() < CHANCE_DE_ACOMPANHAR) {
          this.seguindo = a.id;
          this.acompanhando = true;
          this.proximoAjuste = 0;
          break;
        }
      }
      if (!this.seguindo) return;
    }
    const alvo = agentes.find((a) => a.id === this.seguindo);
    if (!alvo || alvo.modo !== "deliver") {
      // a entrega terminou: senta onde está e descansa um pouco
      this.seguindo = null;
      this.acompanhando = false;
      this.seguirPronto = t + ESPERA_DEPOIS_DE_ACOMPANHAR_MS;
      this.comecar({ destino: null, acao: "senta", ms: 5000 });
      return;
    }
    if (t < this.proximoAjuste) return;
    this.proximoAjuste = t + 600;
    // um tile logo atrás do agente (ou ao lado), nunca em cima dele
    const at = tileDe(alvo.x, alvo.y);
    const eu = this.tile;
    let melhor: Tile | null = null;
    let melhorD = Infinity;
    for (const [dx = 0, dy = 0] of [[-1, 0], [1, 0], [0, 1], [0, -1], [-1, 1], [1, 1], [-1, -1], [1, -1], [-2, 0], [2, 0]]) {
      const c = { tx: at.tx + dx, ty: at.ty + dy };
      if (!this.ctx.porta.caminhavel(c.tx, c.ty) || this.ctx.porta.assento(c.tx, c.ty)) continue;
      if (this.ctx.outros(this).some((o) => Math.max(Math.abs(o.tx - c.tx), Math.abs(o.ty - c.ty)) < 2)) continue;
      const d = Math.abs(c.tx - eu.tx) + Math.abs(c.ty - eu.ty);
      if (d < melhorD) {
        melhorD = d;
        melhor = c;
      }
    }
    if (!melhor || melhorD === 0) return;
    this.comecar({ destino: melhor, acao: "para", ms: 500, ritmo: "trota" });
  }

  quadro(): Quadro | null {
    if (!this.visivel && this.alpha <= 0.02) return null;
    const e = this.estado;
    let pose: PoseCachorro = "abana";
    let i = 0;
    if (e.k === "indo") {
      const trota = e.plano.ritmo === "trota";
      pose = trota ? "trota" : "anda";
      i = this.passoDoCiclo(trota ? 100 : 150);
    } else if (e.k === "fazendo") {
      const rel = this.ctx.t - e.desde;
      const acao: Acao = e.acao;
      switch (acao) {
        case "senta":
          pose = "senta";
          i = Math.floor(rel / 280);
          break;
        case "deita":
          pose = "deita";
          i = Math.floor(rel / 3500) % 2 === 1 ? 1 : 0;
          break;
        case "cochila":
        case "dorme":
          pose = "cochila";
          i = Math.floor(rel / 1500);
          break;
        case "carinho":
          pose = "carinho";
          i = Math.floor(rel / 220);
          break;
        case "abana":
          pose = "abana";
          i = Math.floor(rel / 170);
          break;
        default:
          pose = "abana";
          i = 0;
      }
    }
    return quadroCachorro(pose, i, this.lado);
  }
}
