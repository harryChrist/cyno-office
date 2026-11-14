import { describe, expect, it } from "vitest";
import type { ExtraEntity, ExtrasApi } from "@cyno/cena";
import { ligarBichos, type BichosLigados } from "./ligar";
import { DISTANCIA_ENTRE_BICHOS } from "./base";
import { CLIQUES_PARA_ASSOBIAR, INTERVALO_ENTRE_CLIQUES_MS } from "./calopsita";
import { pesDoTile, tileDe, type AgenteDaCena, type AreaDaCena, type PortaCena } from "./porta";
import type { EggPrefId } from "./prefs";

// ------------------------------------------------------------------ uma cena falsa: 40 x 14 tiles, tudo chão

class CenaFalsa implements PortaCena {
  versao = 1;
  agentesAgora: AgenteDaCena[] = [];
  paredes = new Set<string>();
  constructor(
    readonly w = 40,
    readonly h = 14,
  ) {
    // uma parede de verdade entre a recepção e o resto, com uma porta em y = 6..7
    for (let y = 0; y < h; y++) if (y !== 6 && y !== 7) this.paredes.add(`16,${y}`);
  }
  versaoDoLayout = () => this.versao;
  largura = () => this.w;
  altura = () => this.h;
  caminhavel = (tx: number, ty: number) => tx >= 0 && ty >= 0 && tx < this.w && ty < this.h && !this.paredes.has(`${tx},${ty}`);
  assento = (tx: number, ty: number) => tx === 20 && ty === 5;
  rota(sx: number, sy: number, gx: number, gy: number) {
    if (!this.caminhavel(gx, gy)) return null;
    const prev = new Map<string, string | null>([[`${sx},${sy}`, null]]);
    const fila: [number, number][] = [[sx, sy]];
    while (fila.length) {
      const [x, y] = fila.shift()!;
      if (x === gx && y === gy) break;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = x + dx;
        const ny = y + dy;
        if (!this.caminhavel(nx, ny) || prev.has(`${nx},${ny}`)) continue;
        prev.set(`${nx},${ny}`, `${x},${y}`);
        fila.push([nx, ny]);
      }
    }
    if (!prev.has(`${gx},${gy}`)) return null;
    const out: { tx: number; ty: number }[] = [];
    for (let k: string | null = `${gx},${gy}`; k && k !== `${sx},${sy}`; k = prev.get(k) ?? null) {
      const [x, y] = k.split(",").map(Number) as [number, number];
      out.unshift({ tx: x, ty: y });
    }
    return out;
  }
  agentes = () => this.agentesAgora;
  areas(): AreaDaCena[] {
    return [
      { id: "core:recepcao", tipo: "recepcao", rect: { x: 0, y: 0, w: 16, h: 12 }, tapetes: [] },
      { id: "core:lounge", tipo: "lounge", rect: { x: 17, y: 0, w: 12, h: 12 }, tapetes: [{ x: 18 * 16, y: 3 * 16, w: 5 * 16, h: 3 * 16 }] },
      { id: "corredor", tipo: "corredor", rect: { x: 0, y: 12, w: 40, h: 2 }, tapetes: [] },
    ];
  }
  pontos = (tipo: string) => (tipo === "elevator" ? [{ tx: 2, ty: 10 }] : []);
  maisPerto = (tx: number, ty: number) => (this.caminhavel(tx, ty) ? { tx, ty } : { tx: 2, ty: 10 });
  poleiro = (noMaestro: boolean) => (noMaestro ? { x: 100, y: 90, profundidade: 91, lado: "left" as const, onde: "maestro" as const } : { x: 60, y: 90, profundidade: 91, lado: "left" as const, onde: "recepcao" as const });
}

const agente = (id: string, tx: number, ty: number, over: Partial<AgenteDaCena> = {}): AgenteDaCena => {
  const p = pesDoTile(tx, ty);
  return Object.freeze({ id, x: p.x, y: p.y, modo: "idle", andando: false, sentado: false, destino: null, desde: 0, chegando: false, concluidas: [], salaId: "sala", ...over });
};

/** Um mundo falso com o gancho de extras (o mínimo que `ligarBichos` usa). */
function mundoFalso(cena: PortaCena) {
  const lista: ExtraEntity[] = [];
  const frames = new Set<(f: { dt: number; now: number; playback: boolean }) => void>();
  const extras: ExtrasApi = {
    add: (e) => (lista.push(e), () => void lista.splice(lista.indexOf(e), 1)),
    onFrame: (cb) => (frames.add(cb), () => void frames.delete(cb)),
    onClick: () => () => undefined,
    at: () => null,
    list: () => lista,
  };
  return { mundo: { probe: () => ({}) as never, extras }, lista, frames, cena };
}

const TODOS: Record<EggPrefId, boolean> = { gato: true, cachorro: true, calopsita: true };

function montar(cena: CenaFalsa, semente = "demo", pref: Partial<Record<EggPrefId, boolean>> = {}) {
  const { mundo, lista } = mundoFalso(cena);
  const prefs = { ...TODOS, ...pref };
  const b = ligarBichos(mundo, { semente, porta: cena, pref: (id) => prefs[id], noMaestro: () => true, relogio: () => 1_000_000 });
  return { b, lista, prefs };
}

/** Roda `s` segundos de cena em quadros de 100 ms; chama `aCada` depois de cada quadro. */
function rodar(b: BichosLigados, s: number, aCada?: (tSeg: number) => void, dt = 0.1): void {
  const n = Math.round(s / dt);
  for (let i = 0; i < n; i++) {
    b.quadro({ dt, now: 1_000_000 + i * dt * 1000, playback: false });
    aCada?.((i + 1) * dt);
  }
}

describe("a calopsita: cinco cliques seguidos", () => {
  it("o quinto clique com até 0,9 s entre eles faz ela assobiar (crista e nota)", () => {
    const { b } = montar(new CenaFalsa());
    rodar(b, 0.2);
    expect(b.calopsita.visivel).toBe(true);
    let t = 5000;
    for (let i = 0; i < CLIQUES_PARA_ASSOBIAR - 1; i++) {
      expect(b.calopsita.clicar(t)).toBe(true);
      expect(b.calopsita.assobiando).toBe(false);
      t += INTERVALO_ENTRE_CLIQUES_MS - 50;
    }
    b.calopsita.clicar(t);
    expect(b.calopsita.assobiando).toBe(true);
    expect(b.contexto.efeitos.some((e) => e.tipo === "nota")).toBe(true);
    // passa o assobio: volta a ficar quieta
    rodar(b, 4);
    expect(b.calopsita.assobiando).toBe(false);
  });

  it("com um intervalo maior que 0,9 s no meio, a contagem recomeça e ela não assobia", () => {
    const { b } = montar(new CenaFalsa());
    rodar(b, 0.2);
    let t = 5000;
    for (let i = 0; i < 3; i++) {
      b.calopsita.clicar(t);
      t += 400;
    }
    t += INTERVALO_ENTRE_CLIQUES_MS + 100; // pausa longa
    for (let i = 0; i < 4; i++) {
      b.calopsita.clicar(t);
      t += 400;
    }
    expect(b.calopsita.assobiando).toBe(false);
    b.calopsita.clicar(t); // 5 depois da pausa
    expect(b.calopsita.assobiando).toBe(true);
  });

  it("cliques muito espaçados nunca somam", () => {
    const { b } = montar(new CenaFalsa());
    rodar(b, 0.2);
    for (let i = 0; i < 12; i++) b.calopsita.clicar(5000 + i * 1200);
    expect(b.calopsita.assobiando).toBe(false);
  });

  it("assobia sozinha (raro) quando uma tarefa é concluída no workspace; na primeira leitura só anota o que já estava feito", () => {
    const cena = new CenaFalsa();
    cena.agentesAgora = [agente("a", 5, 5, { concluidas: ["t0"] })];
    const { b } = montar(cena);
    rodar(b, 2);
    expect(b.calopsita.assobiando).toBe(false);
    let assobiou = 0;
    // várias tarefas concluídas ao longo de muito tempo: assobia em algumas (a chance é baixa e há pausa), nunca em todas
    for (let k = 1; k <= 30; k++) {
      cena.agentesAgora = [agente("a", 5, 5, { concluidas: ["t0", ...Array.from({ length: k }, (_, i) => `n${i}`)] })];
      let viu = false;
      rodar(b, 70, () => {
        if (b.calopsita.assobiando) viu = true;
      });
      if (viu) assobiou++;
    }
    expect(assobiou).toBeGreaterThan(0);
    expect(assobiou).toBeLessThan(30);
  });

  it("desligada, some na hora e o clique não é dela", () => {
    const { b, prefs, lista } = montar(new CenaFalsa());
    rodar(b, 0.2);
    const ent = lista.find((e) => e.id === "bicho:calopsita")!;
    const poleiro = lista.find((e) => e.id === "bicho:poleiro")!;
    expect(ent.visible && poleiro.visible).toBe(true);
    prefs.calopsita = false;
    rodar(b, 0.1);
    expect(ent.visible).toBe(false);
    expect(poleiro.visible).toBe(false);
    expect(b.clicar("bicho:calopsita", 9000)).toBe(false);
  });

  it("mora ao lado do Maestro; sem a sala (ou com a escolha desligada) fica na recepção", () => {
    const cena = new CenaFalsa();
    const { mundo } = mundoFalso(cena);
    let maestro = true;
    const b = ligarBichos(mundo, { semente: "x", porta: cena, pref: () => true, noMaestro: () => maestro });
    expect(b.calopsita.poleiro?.onde).toBe("maestro");
    maestro = false;
    b.quadro({ dt: 0.1, now: 0, playback: false });
    expect(b.calopsita.poleiro?.onde).toBe("recepcao");
  });
});

describe("o gato", () => {
  it("chega alguns segundos depois de abrir (não está lá no começo)", () => {
    const { b } = montar(new CenaFalsa());
    rodar(b, 1);
    expect(b.gato.visivel).toBe(false);
    rodar(b, 12);
    expect(b.gato.visivel).toBe(true);
  });

  it("é determinístico: a mesma semente e o mesmo relógio dão a mesma sequência de estados e posições", () => {
    const trilha = (semente: string) => {
      const { b } = montar(new CenaFalsa(), semente);
      const out: string[] = [];
      rodar(b, 240, (t) => {
        if (Math.round(t * 10) % 10 === 0) out.push(`${b.gato.estado.k}:${"acao" in b.gato.estado ? b.gato.estado.acao : ""}:${b.gato.tile.tx},${b.gato.tile.ty}`);
      });
      return out;
    };
    expect(trilha("demo")).toEqual(trilha("demo"));
    expect(trilha("demo")).not.toEqual(trilha("outro"));
  });

  it("passeia, senta, deita e dorme: aparecem várias ações diferentes ao longo de 15 minutos", () => {
    const { b } = montar(new CenaFalsa(), "demo", { cachorro: false });
    const acoes = new Set<string>();
    let andou = false;
    rodar(b, 900, () => {
      const e = b.gato.estado;
      if (e.k === "fazendo") acoes.add(e.acao);
      if (e.k === "indo") andou = true;
    });
    expect(andou).toBe(true);
    for (const a of ["senta", "deita", "dorme"]) expect(acoes.has(a)).toBe(true);
  });

  it("dorme perto de um agente que trabalha há muito tempo", () => {
    const cena = new CenaFalsa();
    cena.agentesAgora = [agente("trab", 24, 9, { modo: "work", desde: 1_000_000 - 30 * 60_000, sentado: true })];
    const { b } = montar(cena, "demo", { cachorro: false });
    let pertoDormindo = 0;
    rodar(b, 1200, () => {
      const e = b.gato.estado;
      if (e.k === "fazendo" && e.acao === "dorme") {
        const t = b.gato.tile;
        if (Math.max(Math.abs(t.tx - 24), Math.abs(t.ty - 9)) <= 1) pertoDormindo++;
      }
    });
    expect(pertoDormindo).toBeGreaterThan(0);
  });

  it("some por alguns minutos de vez em quando e depois volta", () => {
    const { b } = montar(new CenaFalsa(), "demo", { cachorro: false });
    let foraDesde = -1;
    const duracoes: number[] = [];
    rodar(b, 3600, (t) => {
      const fora = b.gato.estado.k === "fora";
      if (fora && foraDesde < 0) foraDesde = t;
      if (!fora && foraDesde >= 0) {
        duracoes.push(t - foraDesde);
        foraDesde = -1;
      }
    });
    expect(duracoes.length).toBeGreaterThan(0);
    for (const d of duracoes) expect(d).toBeGreaterThanOrEqual(85);
  });

  it("sai do tile quando um agente vem e nunca fica no tile de um agente parado", () => {
    const cena = new CenaFalsa();
    const { b } = montar(cena, "demo", { cachorro: false });
    rodar(b, 13);
    // espera o gato parar em algum lugar
    let parou = false;
    rodar(b, 120, () => {
      if (b.gato.estado.k === "fazendo") parou = true;
    });
    expect(parou).toBe(true);
    // para de agir sozinho: fixa o gato parado e põe um agente em cima
    const alvo = b.gato.tile;
    b.gato.estado = { k: "fazendo", acao: "senta", desde: b.contexto.t, ate: b.contexto.t + 600_000 };
    cena.agentesAgora = [agente("chega", alvo.tx, alvo.ty)];
    rodar(b, 0.2);
    const depois = b.gato.tile;
    rodar(b, 4);
    const fim = b.gato.tile;
    expect(fim.tx !== alvo.tx || fim.ty !== alvo.ty).toBe(true);
    expect(Math.max(Math.abs(fim.tx - alvo.tx), Math.abs(fim.ty - alvo.ty))).toBeGreaterThanOrEqual(1);
    void depois;
  });

  it("não escolhe parar num tile de agente, assento ou parede, nem num tile para onde um agente vai", () => {
    const cena = new CenaFalsa();
    cena.agentesAgora = [agente("a", 5, 5), agente("b", 22, 4, { andando: true, destino: { tx: 25, ty: 4 } })];
    const { b } = montar(cena, "demo", { cachorro: false });
    rodar(b, 1500, () => {
      const e = b.gato.estado;
      if (e.k !== "fazendo") return;
      const t = b.gato.tile;
      expect(cena.caminhavel(t.tx, t.ty)).toBe(true);
      expect(cena.assento(t.tx, t.ty)).toBe(false);
      expect(t.tx === 5 && t.ty === 5).toBe(false);
      expect(t.tx === 25 && t.ty === 4).toBe(false);
    });
  });

  it("clique é carinho: fica feliz e solta um coração", () => {
    const { b, lista } = montar(new CenaFalsa(), "demo", { cachorro: false });
    expect(b.clicar("bicho:gato")).toBe(false); // ainda não chegou
    rodar(b, 14);
    const ent = lista.find((e) => e.id === "bicho:gato")!;
    const r = ent.hit!()!;
    expect(r.w).toBeGreaterThan(10);
    expect(b.clicar("bicho:gato")).toBe(true);
    expect(b.gato.estado).toMatchObject({ k: "fazendo", acao: "carinho" });
    expect(b.contexto.efeitos.some((e) => e.tipo === "coracao")).toBe(true);
  });
});

describe("o cachorro", () => {
  it("passeia com passo calmo (mais devagar que o gato... e que os agentes) e senta ao lado de um agente à toa", () => {
    const cena = new CenaFalsa();
    cena.agentesAgora = [agente("toa", 24, 8, { modo: "idle" })];
    const { b } = montar(cena, "demo", { gato: false });
    let ladoDoAgente = 0;
    let andou = false;
    rodar(b, 1200, () => {
      const e = b.cachorro.estado;
      if (e.k === "indo") andou = true;
      if (e.k === "fazendo" && e.acao === "senta") {
        const t = b.cachorro.tile;
        if (Math.max(Math.abs(t.tx - 24), Math.abs(t.ty - 8)) === 1) ladoDoAgente++;
      }
    });
    expect(andou).toBe(true);
    expect(ladoDoAgente).toBeGreaterThan(0);
  });

  it("cochila na recepção", () => {
    const { b } = montar(new CenaFalsa(), "demo", { gato: false });
    let cochilou = false;
    rodar(b, 1800, () => {
      const e = b.cachorro.estado;
      if (e.k === "fazendo" && e.acao === "cochila") {
        cochilou = true;
        expect(b.cachorro.tile.tx).toBeLessThan(16);
      }
    });
    expect(cochilou).toBe(true);
  });

  it("às vezes acompanha o agente que entrega uma tarefa (anda junto)", () => {
    const cena = new CenaFalsa();
    const { b } = montar(cena, "demo", { gato: false });
    rodar(b, 20);
    let acompanhou = 0;
    for (let n = 0; n < 8; n++) {
      // o agente caminha 14 tiles em 8 s
      const inicio = b.contexto.t;
      let segue = false;
      let pertoNoFim = false;
      rodar(b, 9, (tSeg) => {
        const tx = 20 + Math.min(14, (tSeg / 8) * 14);
        const p = pesDoTile(Math.round(tx), 9);
        cena.agentesAgora = [Object.freeze({ ...agente(`sub${n}`, Math.round(tx), 9, { modo: "deliver", andando: tSeg < 8 }), x: p.x, y: p.y })];
        if (b.cachorro.acompanhandoId === `sub${n}`) segue = true;
        if (tSeg > 7.5 && segue) {
          const a = tileDe(cena.agentesAgora[0]!.x, cena.agentesAgora[0]!.y);
          const t = b.cachorro.tile;
          if (Math.max(Math.abs(a.tx - t.tx), Math.abs(a.ty - t.ty)) <= 4) pertoNoFim = true;
        }
      });
      void inicio;
      if (segue && pertoNoFim) acompanhou++;
      cena.agentesAgora = [];
      rodar(b, 40);
    }
    expect(acompanhou).toBeGreaterThan(0);
    expect(acompanhou).toBeLessThan(8);
  });

  it("abana o rabo quando alguém chega pelo elevador", () => {
    const cena = new CenaFalsa();
    const { b } = montar(cena, "demo", { gato: false });
    rodar(b, 20);
    let abanou = false;
    for (let n = 0; n < 6 && !abanou; n++) {
      cena.agentesAgora = [agente(`novo${n}`, 2, 10, { chegando: true })];
      rodar(b, 1, () => {
        const e = b.cachorro.estado;
        if (e.k === "fazendo" && e.acao === "abana") abanou = true;
      });
      cena.agentesAgora = [];
      rodar(b, 8);
    }
    expect(abanou).toBe(true);
  });

  it("sai do tile quando um agente vem", () => {
    const cena = new CenaFalsa();
    const { b } = montar(cena, "demo", { gato: false });
    rodar(b, 40);
    b.cachorro.estado = { k: "fazendo", acao: "senta", desde: b.contexto.t, ate: b.contexto.t + 600_000 };
    const alvo = b.cachorro.tile;
    cena.agentesAgora = [agente("vem", alvo.tx, alvo.ty, { andando: true, destino: { tx: alvo.tx, ty: alvo.ty } })];
    rodar(b, 5);
    const fim = b.cachorro.tile;
    expect(fim.tx !== alvo.tx || fim.ty !== alvo.ty).toBe(true);
  });

  it("desligado some na hora; ligado de novo recomeça", () => {
    const { b, prefs, lista } = montar(new CenaFalsa(), "demo", { gato: false });
    rodar(b, 40);
    const ent = lista.find((e) => e.id === "bicho:cachorro")!;
    expect(ent.visible).toBe(true);
    prefs.cachorro = false;
    rodar(b, 0.1);
    expect(ent.visible).toBe(false);
    expect(b.clicar("bicho:cachorro")).toBe(false);
    prefs.cachorro = true;
    rodar(b, 40);
    expect(ent.visible).toBe(true);
  });
});

describe("as regras dos bichos", () => {
  it("gato e cachorro nunca ficam parados a menos de 2 tiles um do outro", () => {
    for (const semente of ["demo", "a", "b", "c"]) {
      const { b } = montar(new CenaFalsa(), semente);
      let sustos = 0;
      let juntos = 0;
      rodar(b, 2400, () => {
        if (!b.gato.visivel || !b.cachorro.visivel) return;
        if (b.gato.estado.k !== "fazendo" || b.cachorro.estado.k !== "fazendo") return;
        juntos++;
        const g = b.gato.tile;
        const c = b.cachorro.tile;
        if (Math.max(Math.abs(g.tx - c.tx), Math.abs(g.ty - c.ty)) < DISTANCIA_ENTRE_BICHOS) sustos++;
      });
      expect(juntos).toBeGreaterThan(100);
      expect(sustos).toBe(0);
    }
  });

  it("os bichos só enfeitam: não escrevem nos agentes (os objetos da cena chegam congelados) nem mudam a cena", () => {
    const cena = new CenaFalsa();
    cena.agentesAgora = [agente("a", 5, 5, { modo: "work", desde: 0 }), agente("b", 30, 4, { modo: "deliver", andando: true })];
    const antes = JSON.stringify(cena.agentesAgora);
    const paredes = [...cena.paredes].join("|");
    const { b } = montar(cena);
    expect(() => rodar(b, 600)).not.toThrow();
    expect(JSON.stringify(cena.agentesAgora)).toBe(antes);
    expect([...cena.paredes].join("|")).toBe(paredes);
  });

  it("com a cena pausada (dt = 0) nada anda; no timelapse somem e não andam", () => {
    const { b, lista } = montar(new CenaFalsa());
    rodar(b, 14);
    const antes = JSON.stringify([b.gato.x, b.gato.y, b.cachorro.x, b.cachorro.y, b.contexto.t]);
    for (let i = 0; i < 30; i++) b.quadro({ dt: 0, now: 2_000_000, playback: false });
    expect(JSON.stringify([b.gato.x, b.gato.y, b.cachorro.x, b.cachorro.y, b.contexto.t])).toBe(antes);
    b.quadro({ dt: 0.1, now: 2_000_000, playback: true });
    expect(lista.filter((e) => e.id !== "bicho:efeitos").every((e) => !e.visible)).toBe(true);
    expect(JSON.stringify([b.gato.x, b.gato.y, b.contexto.t])).toBe(JSON.stringify([JSON.parse(antes)[0], JSON.parse(antes)[1], JSON.parse(antes)[4]]));
    b.quadro({ dt: 0.1, now: 2_000_000, playback: false });
    expect(lista.some((e) => e.id === "bicho:calopsita" && e.visible)).toBe(true);
  });

  it("as entidades entram na ordem de profundidade pelos pés (y) e o poleiro fica atrás da calopsita", () => {
    const { b, lista } = montar(new CenaFalsa());
    rodar(b, 14);
    const y = (id: string) => lista.find((e) => e.id === id)!.y;
    expect(y("bicho:gato")).toBeCloseTo(b.gato.y);
    expect(y("bicho:cachorro")).toBeCloseTo(b.cachorro.y);
    expect(y("bicho:poleiro")).toBeLessThan(y("bicho:calopsita"));
    expect(y("bicho:efeitos")).toBeGreaterThan(1e6);
  });

  it("o prédio mudou e o tile virou parede: o bicho vai para o chão mais perto", () => {
    const cena = new CenaFalsa();
    const { b } = montar(cena, "demo", { cachorro: false });
    rodar(b, 14);
    b.gato.estado = { k: "fazendo", acao: "senta", desde: b.contexto.t, ate: b.contexto.t + 600_000 };
    const t = b.gato.tile;
    cena.paredes.add(`${t.tx},${t.ty}`);
    cena.versao++;
    rodar(b, 0.2);
    const novo = b.gato.tile;
    expect(cena.caminhavel(novo.tx, novo.ty)).toBe(true);
  });
});
