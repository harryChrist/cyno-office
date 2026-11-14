import { emptyFrame, keyframeOf, type SceneAgent, type TimelineRecord } from "@cyno/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { abrir, alternarTocar, aoSuspenderCena, arrastar, escolherVelocidade, fechar, irParaDia, registrarCena, reiniciarReplay, replayAtivo, useReplayStore, type CenaDoReplay } from "./replayStore";

const T0 = Date.parse("2026-11-11T11:00:00.000Z");
const MIN = 60_000;
const avatar = { skin: "tone3", hair: "bun", hairColor: "ink", shirt: "mint", pants: "denim" };
const agent = (id: string, extra: Partial<SceneAgent> = {}): SceneAgent => ({ id, name: id, role: "Dev", teamId: "t", avatar, status: "idle", ...extra });

function registros(): TimelineRecord[] {
  const f = emptyFrame();
  f.rooms.set("m", { id: "m", name: "Maestro", kind: "maestro", gx: 0, gy: 0 });
  f.teams.set("t", { id: "t", roomId: "m", name: "Time" });
  f.agents.set("ana", agent("ana"));
  return [keyframeOf(f, T0, 300_000, true), { t: "d", at: T0 + 10 * MIN, agents: [["ana", { status: "working" }]] }, { t: "end", at: T0 + 20 * MIN, reason: "stop" }];
}

function fakeCena() {
  const chamadas: string[] = [];
  const retratos: unknown[] = [];
  const cena: CenaDoReplay = {
    workspaceId: "w",
    workspaceName: "W",
    mundo: { setPlayback: (p) => void chamadas.push(p ? "setPlayback" : "setPlayback(null)") },
    publicar: (r) => void retratos.push(r),
    voltarAoVivo: () => void chamadas.push("voltarAoVivo"),
    pausarVivo: (v) => void chamadas.push(v ? "pausar" : "retomar"),
  };
  return { cena, chamadas, retratos };
}

function fingirServidor(dias: unknown[], recording = true) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.endsWith("/timeline/days")) return new Response(JSON.stringify({ recording, days: dias }), { status: 200 });
      const lista = registros();
      return new Response(lista.map((r) => JSON.stringify(r)).join("\n"), { status: 200 });
    }),
  );
}

const info = { day: "2026-11-11", bytes: 1000, from: T0, to: T0 + 20 * MIN };

const classes = new Set<string>();
beforeEach(() => {
  classes.clear();
  vi.stubGlobal("document", { documentElement: { classList: { add: (c: string) => classes.add(c), remove: (c: string) => classes.delete(c), contains: (c: string) => classes.has(c) } } });
  reiniciarReplay();
});
afterEach(() => {
  reiniciarReplay();
  vi.unstubAllGlobals();
});

describe("controle do replay", () => {
  it("sem gravação: o estado vazio diz que ela começa hoje", async () => {
    fingirServidor([]);
    const { cena } = fakeCena();
    registrarCena(cena);
    await abrir();
    const s = useReplayStore.getState();
    expect(s.situacao).toBe("vazio");
    expect(s.mensagem).toContain("começa hoje");
    fechar();
    expect(replayAtivo()).toBe(false);
  });

  it("abre no dia gravado, pausa a cena ao vivo, publica o retrato e volta ao agora", async () => {
    fingirServidor([info]);
    const { cena, chamadas, retratos } = fakeCena();
    registrarCena(cena);
    await abrir();
    await vi.waitFor(() => expect(useReplayStore.getState().situacao).toBe("pronto"));
    expect(chamadas).toEqual(["pausar", "setPlayback"]);
    expect(retratos).toHaveLength(1);
    expect(useReplayStore.getState().player).toMatchObject({ de: T0, ate: T0 + 20 * MIN, t: T0, tocando: false });
    expect(replayAtivo()).toBe(true);
    fechar();
    expect(chamadas.slice(2)).toEqual(["setPlayback(null)", "voltarAoVivo", "retomar"]);
    expect(replayAtivo()).toBe(false);
    expect(classes.has("is-replay")).toBe(false);
  });

  it("abre num instante pedido (o 'Ver esse momento') e arrastar a régua leva a cena para lá", async () => {
    fingirServidor([info]);
    const { cena, retratos } = fakeCena();
    registrarCena(cena);
    await abrir({ dia: "2026-11-11", instante: T0 + 12 * MIN });
    await vi.waitFor(() => expect(useReplayStore.getState().situacao).toBe("pronto"));
    expect(useReplayStore.getState().player?.t).toBe(T0 + 12 * MIN);
    const retrato = retratos.at(-1) as { agents: { id: string; status: string }[] };
    expect(retrato.agents.find((a) => a.id === "ana")?.status).toBe("working");
    arrastar(T0 + 5 * MIN, true);
    expect((retratos.at(-1) as { agents: { status: string }[] }).agents[0]!.status).toBe("idle");
    arrastar(T0 + 999 * MIN, true);
    expect(useReplayStore.getState().player?.t).toBe(T0 + 20 * MIN);
  });

  it("tocar, velocidade e pausar; o instante anda enquanto toca", async () => {
    vi.useFakeTimers({ toFake: ["performance", "setTimeout", "clearTimeout"] });
    vi.stubGlobal("requestAnimationFrame", (cb: () => void) => setTimeout(cb, 16) as unknown as number);
    vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
    try {
      fingirServidor([info]);
      const { cena } = fakeCena();
      registrarCena(cena);
      await abrir();
      await vi.waitFor(() => expect(useReplayStore.getState().situacao).toBe("pronto"), { timeout: 2000 });
      escolherVelocidade(900);
      expect(useReplayStore.getState().player?.velocidade).toBe(900);
      alternarTocar();
      expect(useReplayStore.getState().player?.tocando).toBe(true);
      await vi.advanceTimersByTimeAsync(200);
      expect(useReplayStore.getState().player!.t).toBeGreaterThan(T0);
      alternarTocar();
      const parado = useReplayStore.getState().player!.t;
      await vi.advanceTimersByTimeAsync(500);
      expect(useReplayStore.getState().player!.t).toBe(parado);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cena suspensa pela interface fecha o replay, para o laço e tira a classe is-replay", async () => {
    const { cena } = fakeCena();
    registrarCena(cena);
    vi.stubGlobal("requestAnimationFrame", (cb: () => void) => setTimeout(cb, 16) as unknown as number);
    vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
    await abrir({ tocar: true });
    expect(classes.has("is-replay")).toBe(true);
    aoSuspenderCena(false);
    expect(replayAtivo()).toBe(true);
    aoSuspenderCena(true);
    expect(replayAtivo()).toBe(false);
    expect(classes.has("is-replay")).toBe(false);
    expect(useReplayStore.getState().player).toBeNull();
  });

  it("a cena fechada (troca de workspace) encerra o replay; dia que falha mostra o erro", async () => {
    fingirServidor([info]);
    const { cena } = fakeCena();
    registrarCena(cena);
    await abrir();
    await vi.waitFor(() => expect(useReplayStore.getState().situacao).toBe("pronto"));
    registrarCena(null);
    expect(replayAtivo()).toBe(false);

    vi.stubGlobal("fetch", vi.fn(async (url: string) => (url.endsWith("/days") ? new Response(JSON.stringify({ recording: true, days: [info] })) : new Response("x", { status: 500 }))));
    const outra = fakeCena();
    registrarCena(outra.cena);
    await abrir();
    await vi.waitFor(() => expect(useReplayStore.getState().situacao).toBe("erro"));
    irParaDia("2026-11-11");
  });
});
