import { SCENE_LIVE_VERSION, type SceneDelta, type SceneFull } from "@cyno/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONFERENCIA_MS, ESPERA_MAXIMA_MS, ligarAoVivo, esperaDeReconexao, TEMPO_PARADA_MS, type SimRemoto, type SocketLike } from "./ligarAoVivo";

class SocketFalso implements SocketLike {
  onopen: SocketLike["onopen"] = null;
  onmessage: SocketLike["onmessage"] = null;
  onclose: SocketLike["onclose"] = null;
  onerror: SocketLike["onerror"] = null;
  fechado = false;
  constructor(readonly url: string) {}
  close(): void {
    this.fechado = true;
  }
  receber(msg: unknown): void {
    this.onmessage?.({ data: typeof msg === "string" ? msg : JSON.stringify(msg) });
  }
  cair(): void {
    this.onclose?.({});
  }
}

const full = (): SceneFull => ({ v: SCENE_LIVE_VERSION, t: "scene:full", at: 1, lv: 1, layout: { cols: 2, rooms: [] }, chars: [], rooms: [], el: [], u: [] });
const delta = (): SceneDelta => ({ v: SCENE_LIVE_VERSION, t: "scene:delta", at: 2, x: ["a"] });

function novoSim() {
  const sim = {
    remote: { on: false },
    fulls: 0,
    deltas: 0,
    frozen: false,
    applyRemoteFull: vi.fn(() => {
      sim.remote.on = true;
      sim.fulls++;
    }),
    applyRemoteDelta: vi.fn(() => {
      sim.deltas++;
    }),
    freezeRemote: vi.fn((valor: boolean) => {
      sim.frozen = valor;
    }),
    stopRemote: vi.fn(() => {
      sim.remote.on = false;
    }),
  };
  return sim satisfies SimRemoto & Record<string, unknown>;
}

function montar(opcoes: { disponivel?: boolean } = {}) {
  let sim = novoSim();
  let replay = false;
  const sockets: SocketFalso[] = [];
  const estados: string[] = [];
  const ligacao = ligarAoVivo({
    workspaceId: "principal",
    mundo: () => ({ sim, replay }),
    disponivel: async () => opcoes.disponivel ?? true,
    criarSocket: (url) => {
      const s = new SocketFalso(url);
      sockets.push(s);
      return s;
    },
    url: (id) => `ws://x/ws/scene?workspace=${id}`,
    aoMudar: (e) => estados.push(e),
  });
  const ligar = async () => {
    ligacao.definirEscritorioVisivel(true);
    await vi.advanceTimersByTimeAsync(0);
  };
  const s = (i: number): SocketFalso => sockets[i] as SocketFalso;
  return { ligacao, sockets, s, estados, ligar, sim: () => sim, trocarSim: () => (sim = novoSim()), replay: (v: boolean) => (replay = v) };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("espera de reconexão", () => {
  it("cresce de 0,5 s e para em 15 s", () => {
    expect([0, 1, 2, 3].map(esperaDeReconexao)).toEqual([500, 1000, 2000, 4000]);
    expect(esperaDeReconexao(20)).toBe(ESPERA_MAXIMA_MS);
  });
});

describe("ligação da cena ao vivo", () => {
  it("só conecta com o Escritório visível E a aba visível; fecha ao esconder", async () => {
    const m = montar();
    expect(m.sockets).toHaveLength(0);
    await m.ligar();
    expect(m.sockets).toHaveLength(1);
    expect(m.s(0).url).toBe("ws://x/ws/scene?workspace=principal");
    m.ligacao.definirAbaVisivel(false);
    expect(m.s(0).fechado).toBe(true);
    m.ligacao.definirAbaVisivel(true);
    expect(m.sockets).toHaveLength(2);
    m.ligacao.definirEscritorioVisivel(false);
    expect(m.s(1).fechado).toBe(true);
  });

  it("servidor sem a chave: nunca abre o socket e a cena segue local", async () => {
    const m = montar({ disponivel: false });
    await m.ligar();
    m.ligacao.definirAbaVisivel(false);
    m.ligacao.definirAbaVisivel(true);
    expect(m.sockets).toHaveLength(0);
    expect(m.sim().applyRemoteFull).not.toHaveBeenCalled();
    expect(m.ligacao.estado()).toBe("desligada");
  });

  it("o scene:full liga o modo remoto e o delta é aplicado; mensagem estranha é ignorada", async () => {
    const m = montar();
    await m.ligar();
    const s = m.s(0);
    s.receber({ v: 1, t: "scene:hello", at: 1, tickHz: 20, sendHz: 10, idleMs: 1 });
    s.receber("lixo");
    s.receber(delta());
    expect(m.sim().applyRemoteDelta).not.toHaveBeenCalled();
    s.receber(full());
    expect(m.ligacao.estado()).toBe("remoto");
    s.receber(delta());
    expect(m.sim().fulls).toBe(1);
    expect(m.sim().deltas).toBe(1);
  });

  it("queda: congela, tenta de novo com espera crescente e retoma com o novo full", async () => {
    const m = montar();
    await m.ligar();
    m.s(0).receber(full());
    m.s(0).cair();
    expect(m.ligacao.estado()).toBe("reconectando");
    expect(m.sim().frozen).toBe(true);
    await vi.advanceTimersByTimeAsync(499);
    expect(m.sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2);
    expect(m.sockets).toHaveLength(2);
    m.s(1).cair();
    await vi.advanceTimersByTimeAsync(1000);
    expect(m.sockets).toHaveLength(3);
    m.s(2).receber(full());
    expect(m.ligacao.estado()).toBe("remoto");
    expect(m.sim().frozen).toBe(false);
    expect(m.sim().stopRemote).not.toHaveBeenCalled();
    // a desistência foi cancelada
    await vi.advanceTimersByTimeAsync(TEMPO_PARADA_MS * 2);
    expect(m.sim().stopRemote).not.toHaveBeenCalled();
  });

  it("passando de 10 s sem voltar, a cena volta para a simulação local; quando o servidor volta, retoma", async () => {
    const m = montar();
    await m.ligar();
    m.s(0).receber(full());
    m.s(0).cair();
    for (let i = 0; i < 30; i++) {
      await vi.advanceTimersByTimeAsync(ESPERA_MAXIMA_MS);
      const ultimo = m.s(m.sockets.length - 1);
      if (!ultimo.fechado) ultimo.cair();
      if (m.ligacao.estado() === "local") break;
    }
    expect(m.ligacao.estado()).toBe("local");
    expect(m.sim().stopRemote).toHaveBeenCalledTimes(1);
    // continua tentando de vez em quando
    const antes = m.sockets.length;
    await vi.advanceTimersByTimeAsync(ESPERA_MAXIMA_MS + 1);
    expect(m.sockets.length).toBeGreaterThan(antes);
    m.s(m.sockets.length - 1).receber(full());
    expect(m.ligacao.estado()).toBe("remoto");
  });

  it("falha na primeira conexão: fica local e tenta de novo", async () => {
    const m = montar();
    await m.ligar();
    m.s(0).cair();
    expect(m.ligacao.estado()).toBe("local");
    expect(m.sim().stopRemote).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(600);
    expect(m.sockets).toHaveLength(2);
  });

  it("replay: sai do modo remoto e fecha; ao sair, conecta e pede o estado de novo", async () => {
    const m = montar();
    await m.ligar();
    m.s(0).receber(full());
    m.ligacao.definirReplay(true);
    expect(m.s(0).fechado).toBe(true);
    expect(m.sim().stopRemote).toHaveBeenCalledTimes(1);
    expect(m.ligacao.estado()).toBe("local");
    m.ligacao.definirReplay(false);
    expect(m.sockets).toHaveLength(2);
    m.s(1).receber(full());
    expect(m.ligacao.estado()).toBe("remoto");
  });

  it("o mundo recriado (replay que terminou) é local: pede um scene:full novo", async () => {
    const m = montar();
    await m.ligar();
    m.s(0).receber(full());
    m.trocarSim();
    await vi.advanceTimersByTimeAsync(CONFERENCIA_MS + 1);
    expect(m.s(0).fechado).toBe(true);
    expect(m.sockets).toHaveLength(2);
    m.s(1).receber(full());
    expect(m.sim().fulls).toBe(1);
  });

  it("replay detectado pelo mundo (sem a loja): sai e volta sozinho", async () => {
    const m = montar();
    await m.ligar();
    m.s(0).receber(full());
    m.replay(true);
    const sim = m.sim();
    await vi.advanceTimersByTimeAsync(CONFERENCIA_MS + 1);
    expect(sim.stopRemote).toHaveBeenCalledTimes(1);
    expect(m.s(0).fechado).toBe(true);
    m.replay(false);
    await vi.advanceTimersByTimeAsync(CONFERENCIA_MS + 1);
    expect(m.sockets).toHaveLength(2);
  });

  it("desligar fecha tudo e para as tentativas", async () => {
    const m = montar();
    await m.ligar();
    m.s(0).receber(full());
    m.s(0).cair();
    m.ligacao.desligar();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(m.sockets).toHaveLength(1);
  });
});
