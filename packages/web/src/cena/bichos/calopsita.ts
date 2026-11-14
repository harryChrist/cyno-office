// A calopsita: mora no poleirinho (na Sala do Maestro, ao lado da mesa dele; sem a sala, na recepção). Fica quieta,
// pisca, vira a cabeça, bate as asas e levanta a crista de vez em quando. Cinco cliques seguidos (até 0,9 s entre um
// e outro) fazem a crista subir e ela assobiar; quando uma tarefa é concluída no workspace, às vezes assobia sozinha
// (raro e discreto). Só enfeite: nada aqui mexe em agente, tarefa ou estado.
import type { Quadro } from "./arteComum";
import { quadroCalopsita, type PoseCalopsita } from "./arteCalopsita";
import type { Contexto } from "./base";
import type { PoleiroNaCena } from "./porta";

/** Cliques seguidos para ela assobiar, e o tempo máximo (ms) entre dois cliques. */
export const CLIQUES_PARA_ASSOBIAR = 5;
export const INTERVALO_ENTRE_CLIQUES_MS = 900;
/** Quanto dura o assobio (ms), a chance de assobiar ao ver uma tarefa concluída e a pausa mínima entre assobios sozinhos. */
export const DURACAO_DO_ASSOBIO_MS = 3200;
export const CHANCE_DE_ASSOBIAR_NA_TAREFA = 0.35;
export const PAUSA_ENTRE_ASSOBIOS_SOZINHA_MS = 60_000;

type Cena = { pose: PoseCalopsita; desde: number; ate: number };

export class Calopsita {
  ligada = true;
  poleiro: PoleiroNaCena | null = null;
  private cena: Cena = { pose: "parada", desde: 0, ate: Infinity };
  private proximoPisca: number;
  private proximoOlhar: number;
  private proximasAsas: number;
  private proximaCrista: number;
  private cliques = 0;
  private ultimoClique = -Infinity;
  private ultimoAssobio = -Infinity;
  private concluidasVistas: Set<string> | null = null;
  private notaEmitida = -1;
  alpha = 1;

  constructor(
    private readonly rng: () => number,
    private readonly ctx: Contexto,
  ) {
    this.proximoPisca = 1800 + rng() * 3000;
    this.proximoOlhar = 6000 + rng() * 6000;
    this.proximasAsas = 16000 + rng() * 20000;
    this.proximaCrista = 22000 + rng() * 20000;
  }

  get visivel(): boolean {
    return this.ligada && this.poleiro !== null;
  }

  get pose(): PoseCalopsita {
    return this.cena.pose;
  }

  get assobiando(): boolean {
    return this.cena.pose === "assobio";
  }

  get profundidade(): number {
    return (this.poleiro?.profundidade ?? 0) + 0.02;
  }

  private mudar(pose: PoseCalopsita, ms: number): void {
    this.cena = { pose, desde: this.ctx.t, ate: this.ctx.t + ms };
  }

  /** Crista em pé, bico abrindo e fechando e o balãozinho com a nota. */
  assobiar(ms = DURACAO_DO_ASSOBIO_MS): void {
    if (!this.visivel) return;
    this.ultimoAssobio = this.ctx.t;
    this.mudar("assobio", ms);
    this.notaEmitida = -1;
    this.emitirNota();
  }

  private emitirNota(): void {
    const p = this.poleiro;
    if (!p) return;
    this.notaEmitida = Math.floor((this.ctx.t - this.cena.desde) / 1000);
    this.ctx.efeitos.push({ tipo: "nota", x: p.x + (p.lado === "left" ? -2 : 2), y: p.y - 15, t0: this.ctx.t, dur: 1700 });
  }

  /**
   * Um clique na calopsita (`agora` em ms de relógio de parede). Devolve true: o clique é dela. O quinto seguido,
   * com até 0,9 s entre cada um, faz ela assobiar; os outros só a fazem olhar para quem clicou.
   */
  clicar(agora: number): boolean {
    if (!this.visivel) return false;
    this.cliques = agora - this.ultimoClique <= INTERVALO_ENTRE_CLIQUES_MS ? this.cliques + 1 : 1;
    this.ultimoClique = agora;
    if (this.cliques >= CLIQUES_PARA_ASSOBIAR) {
      this.cliques = 0;
      this.assobiar();
    } else if (this.cena.pose !== "assobio") this.mudar("frente", 1600);
    return true;
  }

  /**
   * Confere as tarefas concluídas dos agentes: a primeira leitura só anota o que já estava feito; depois, cada
   * tarefa nova concluída pode fazer ela assobiar (raro, com pausa).
   */
  observarTarefas(): void {
    const agora = new Set<string>();
    for (const a of this.ctx.agentes) for (const id of a.concluidas) agora.add(`${a.id}:${id}`);
    if (!this.concluidasVistas) {
      this.concluidasVistas = agora;
      return;
    }
    let nova = false;
    for (const id of agora) {
      if (!this.concluidasVistas.has(id)) nova = true;
    }
    this.concluidasVistas = agora;
    if (!nova || !this.visivel) return;
    if (this.ctx.t - this.ultimoAssobio < PAUSA_ENTRE_ASSOBIOS_SOZINHA_MS) return;
    if (this.rng() < CHANCE_DE_ASSOBIAR_NA_TAREFA) this.assobiar(2600);
  }

  /** Avança um quadro (o relógio já foi atualizado em `ctx.t`). */
  atualizar(dt: number): void {
    if (dt <= 0 || !this.visivel) return;
    const t = this.ctx.t;
    this.observarTarefas();
    const c = this.cena;
    if (c.pose === "assobio") {
      // a nota sobe de novo a cada segundo e meio
      if (Math.floor((t - c.desde) / 1500) > this.notaEmitida && t < c.ate - 600) {
        this.notaEmitida = Math.floor((t - c.desde) / 1500);
        const p = this.poleiro!;
        this.ctx.efeitos.push({ tipo: "nota", x: p.x + (p.lado === "left" ? -2 : 2), y: p.y - 15, t0: t, dur: 1500 });
      }
    }
    if (t < c.ate) return;
    this.cena = { pose: "parada", desde: t, ate: Infinity };
    if (t >= this.proximoPisca) {
      this.proximoPisca = t + 2200 + this.rng() * 4200;
      this.mudar("pisca", 160);
    } else if (t >= this.proximoOlhar) {
      this.proximoOlhar = t + 7000 + this.rng() * 9000;
      this.mudar("frente", 1800);
    } else if (t >= this.proximasAsas) {
      this.proximasAsas = t + 18000 + this.rng() * 24000;
      this.mudar("asas", 960);
    } else if (t >= this.proximaCrista) {
      this.proximaCrista = t + 24000 + this.rng() * 24000;
      this.mudar("crista", 2600);
    }
  }

  quadro(): Quadro | null {
    const p = this.poleiro;
    if (!this.visivel || !p) return null;
    const rel = this.ctx.t - this.cena.desde;
    let pose = this.cena.pose;
    let i = 0;
    if (pose === "asas") i = Math.floor(rel / 240);
    // o bico abre e fecha enquanto assobia
    if (pose === "assobio") pose = Math.floor(rel / 260) % 2 === 0 ? "assobio" : "crista";
    return quadroCalopsita(pose, i, p.lado);
  }

  area(): { x: number; y: number; w: number; h: number } | null {
    const p = this.poleiro;
    if (!this.visivel || !p) return null;
    return { x: p.x - 7, y: p.y - 15, w: 14, h: 19 };
  }
}
