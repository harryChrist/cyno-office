// Liga os bichos ao mundo da cena: registra os extras (poleiro, calopsita, gato, cachorro e os efeitos), anda com eles
// a cada quadro, dá o clique (carinho, cinco cliques da calopsita) e respeita as preferências (desligado = some na
// hora). Os bichos são só enfeite: nada aqui escreve em loja, tarefa ou estado de agente.
import type { ExtraEntity, ExtrasApi, WorldProbe } from "@cyno/cena";
import { birdBesideMaestro, subscribeBirdHome } from "./birdHome";
import { eggPref, subscribeEggPrefs, type EggPrefId } from "./prefs";
import { hashTexto, mulberry32 } from "./arteComum";
import type { Quadro } from "./arteComum";
import { quadroCoracao, quadroNota, quadroPoleiro, quadroZ } from "./arteEfeitos";
import { Bicho, type Contexto, type Efeito, type Tile } from "./base";
import { Cachorro } from "./cachorro";
import { Calopsita } from "./calopsita";
import { paraCanvas } from "./desenho";
import { Gato } from "./gato";
import { portaDoMotor, type PortaCena } from "./porta";

/** O que a ligação usa do mundo (o `probe` e o gancho de extras do motor). */
export interface MundoDosBichos {
  probe(): WorldProbe;
  extras: ExtrasApi;
}

export interface OpcoesDosBichos {
  /** Semente do sorteio (o id do workspace): o mesmo workspace dá os mesmos passeios. */
  semente: string;
  /** Troca a porta da cena (testes). */
  porta?: PortaCena;
  /** Preferência de cada bicho (testes); padrão: as do navegador. */
  pref?: (id: EggPrefId) => boolean;
  /** A calopsita mora ao lado do Maestro? (testes); padrão: a preferência do navegador. */
  noMaestro?: () => boolean;
  /** Relógio de parede (testes). */
  relogio?: () => number;
}

export interface BichosLigados {
  gato: Gato;
  cachorro: Cachorro;
  calopsita: Calopsita;
  contexto: Contexto;
  entidades: ExtraEntity[];
  /** Um quadro (o mesmo que o motor chama): útil nos testes. */
  quadro(f: { dt: number; now: number; playback: boolean }): void;
  /** Um clique no extra de id `id` (o que o motor chamaria). */
  clicar(id: string, agora?: number): boolean;
  desligar(): void;
}

/** Sombra de contato (elipse de pixels) embaixo do bicho. */
function sombra(ctx: CanvasRenderingContext2D, x: number, y: number, rx: number): void {
  ctx.fillStyle = "rgba(28,32,52,0.24)";
  const ry = Math.max(1, Math.round(rx / 3));
  for (let dy = -ry; dy <= ry; dy++) {
    const w = Math.round(rx * Math.sqrt(1 - (dy * dy) / (ry * ry + 0.5)));
    ctx.fillRect(Math.round(x) - w, Math.round(y) + dy, w * 2, 1);
  }
}

function desenharQuadro(ctx: CanvasRenderingContext2D, q: Quadro, x: number, y: number, alpha = 1): void {
  const d = paraCanvas(q);
  const salvo = ctx.globalAlpha;
  ctx.globalAlpha = salvo * alpha;
  ctx.drawImage(d.canvas, Math.round(x) - d.ax, Math.round(y) - d.ay);
  ctx.globalAlpha = salvo;
}

export function ligarBichos(mundo: MundoDosBichos, o: OpcoesDosBichos): BichosLigados {
  const porta = o.porta ?? portaDoMotor(() => mundo.probe());
  const pref = o.pref ?? eggPref;
  const noMaestro = o.noMaestro ?? birdBesideMaestro;
  const efeitos: Efeito[] = [];
  const base = hashTexto(o.semente);
  let emTimelapse = false;
  let ativo = true;

  // eslint-disable-next-line prefer-const
  let gato: Gato;
  // eslint-disable-next-line prefer-const
  let cachorro: Cachorro;
  const ctx: Contexto = {
    porta,
    t: 0,
    agora: o.relogio?.() ?? Date.now(),
    efeitos,
    agentes: [],
    outros(de: Bicho): Tile[] {
      const outro = de === gato ? cachorro : gato;
      return outro.visivel || outro.alpha > 0 ? outro.tileOcupado() : [];
    },
  };
  gato = new Gato("gato", mulberry32(base ^ 0x6a70), ctx);
  cachorro = new Cachorro("cachorro", mulberry32(base ^ 0xc4c4), ctx);
  const calopsita = new Calopsita(mulberry32(base ^ 0x1c1c), ctx);

  // ---- as entidades do motor
  const entidade = (id: string, bicho: Bicho): ExtraEntity => ({
    id,
    get y() {
      return bicho.profundidade;
    },
    get visible() {
      return !emTimelapse && bicho.visivel;
    },
    draw(c) {
      const q = bicho.quadro();
      if (!q) return;
      sombra(c, bicho.x, bicho.y + 1, 6);
      desenharQuadro(c, q, bicho.x, bicho.y + 1, bicho.alpha);
    },
    hit: () => bicho.area(),
  });
  const entGato = entidade("bicho:gato", gato);
  const entCachorro = entidade("bicho:cachorro", cachorro);
  const entPoleiro: ExtraEntity = {
    id: "bicho:poleiro",
    get y() {
      return calopsita.poleiro?.profundidade ?? 0;
    },
    get visible() {
      return !emTimelapse && calopsita.visivel;
    },
    draw(c) {
      const p = calopsita.poleiro;
      if (p) desenharQuadro(c, quadroPoleiro(), p.x, p.y);
    },
  };
  const entCalopsita: ExtraEntity = {
    id: "bicho:calopsita",
    get y() {
      return calopsita.profundidade;
    },
    get visible() {
      return !emTimelapse && calopsita.visivel;
    },
    draw(c) {
      const q = calopsita.quadro();
      const p = calopsita.poleiro;
      if (q && p) desenharQuadro(c, q, p.x, p.y + 1);
    },
    hit: () => calopsita.area(),
  };
  // corações, notas e "z": por cima de tudo (a profundidade enorme)
  const entEfeitos: ExtraEntity = {
    id: "bicho:efeitos",
    y: 1e9,
    get visible() {
      return !emTimelapse && efeitos.length > 0;
    },
    draw(c) {
      for (const e of efeitos) {
        const idade = ctx.t - e.t0;
        if (idade < 0 || idade > e.dur) continue;
        const k = idade / e.dur;
        const alpha = k > 0.65 ? 1 - (k - 0.65) / 0.35 : 1;
        if (e.tipo === "coracao") desenharQuadro(c, quadroCoracao(), e.x, e.y - k * 9, alpha);
        else if (e.tipo === "nota") desenharQuadro(c, quadroNota(Math.floor(idade / 320)), e.x, e.y - Math.min(4, k * 8), alpha);
        else desenharQuadro(c, quadroZ(Math.floor(idade / 700)), e.x, e.y - k * 8, alpha);
      }
    },
  };
  const entidades = [entPoleiro, entCalopsita, entGato, entCachorro, entEfeitos];
  const remover = entidades.map((e) => mundo.extras.add(e));

  // ---- preferências e poleiro
  let versaoDoPoleiro = -2;
  let poleiroNoMaestro = noMaestro();
  const aplicarPrefs = (): void => {
    for (const [bicho, id] of [[gato, "gato"], [cachorro, "cachorro"]] as const) {
      const liga = pref(id);
      if (liga && !bicho.ligado) bicho.reiniciar();
      bicho.ligado = liga;
      if (!liga) bicho.alpha = 0;
    }
    calopsita.ligada = pref("calopsita");
    const m = noMaestro();
    const v = porta.versaoDoLayout();
    if (m !== poleiroNoMaestro || v !== versaoDoPoleiro || (!calopsita.poleiro && calopsita.ligada)) {
      poleiroNoMaestro = m;
      versaoDoPoleiro = v;
      calopsita.poleiro = porta.poleiro(m);
    }
  };
  aplicarPrefs();

  const quadro = (f: { dt: number; now: number; playback: boolean }): void => {
    if (!ativo) return;
    emTimelapse = f.playback;
    aplicarPrefs();
    if (f.playback) return;
    ctx.t += Math.max(0, f.dt) * 1000;
    ctx.agora = o.relogio?.() ?? f.now;
    ctx.agentes = porta.agentes();
    for (let i = efeitos.length - 1; i >= 0; i--) if (ctx.t - efeitos[i]!.t0 > efeitos[i]!.dur) efeitos.splice(i, 1);
    gato.atualizar(f.dt);
    cachorro.atualizar(f.dt);
    calopsita.atualizar(f.dt);
  };
  const desligarFrame = mundo.extras.onFrame(quadro);

  const clicar = (id: string, agora = o.relogio?.() ?? Date.now()): boolean => {
    if (id === "bicho:calopsita") return calopsita.clicar(agora);
    if (id === "bicho:gato") return gato.acariciar();
    if (id === "bicho:cachorro") return cachorro.acariciar();
    return false;
  };
  const desligarClique = mundo.extras.onClick((e) => clicar(e.id));
  // uma troca de preferência vale no próximo quadro; este aviso só acorda a leitura
  const desligarPrefs = subscribeEggPrefs(aplicarPrefs);
  const desligarCasa = subscribeBirdHome(aplicarPrefs);

  return {
    gato,
    cachorro,
    calopsita,
    contexto: ctx,
    entidades,
    quadro,
    clicar,
    desligar() {
      if (!ativo) return;
      ativo = false;
      desligarFrame();
      desligarClique();
      desligarPrefs();
      desligarCasa();
      for (const r of remover) r();
    },
  };
}
