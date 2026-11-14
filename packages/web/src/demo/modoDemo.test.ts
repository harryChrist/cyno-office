import { DEMO_WORKSPACE_ID, DemoOffice, isSafeId, parseTimeline, slugify } from "@cyno/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BATIMENTO_DA_DEMO_MS, MENSAGEM_DE_ESCRITA, armazenamentoEmMemoria, instalarDemo } from "./instalar";
import { fichaDaDemo, instanteDeSaoPaulo, parametrosDaDemo, pedeDemo, responderDaDemo } from "./modoDemo";

const NOW = Date.parse("2026-11-12T17:30:00.000Z"); // 14:30 em São Paulo
const consulta = (texto = "") => new URLSearchParams(texto);

describe("endereço da demonstração", () => {
  it("só `?demo=1` liga; seed e now são opcionais (now na hora de São Paulo)", () => {
    expect(pedeDemo("?demo=1")).toBe(true);
    expect(pedeDemo("?demo=0")).toBe(false);
    expect(pedeDemo("")).toBe(false);
    expect(parametrosDaDemo("?demo=1", NOW)).toEqual({ seed: 7, now: NOW });
    expect(parametrosDaDemo("?demo=1&seed=3&now=2026-11-12T14:00", NOW)).toEqual({ seed: 3, now: Date.parse("2026-11-12T17:00:00.000Z") });
    expect(parametrosDaDemo("?demo=1&seed=abc", NOW).seed).toBe(7);
    expect(instanteDeSaoPaulo("2026-11-12")).toBe(Date.parse("2026-11-12T15:00:00.000Z"));
    expect(instanteDeSaoPaulo("2026-11-12T10:15:30")).toBe(Date.parse("2026-11-12T13:15:30.000Z"));
    expect(instanteDeSaoPaulo("2026-11-12T10:15:00Z")).toBe(Date.parse("2026-11-12T10:15:00.000Z"));
    expect(instanteDeSaoPaulo("lixo")).toBeNull();
  });
});

describe("rotas de leitura da demonstração", () => {
  const sim = new DemoOffice({ seed: 7, now: NOW });
  const base = `/api/w/${DEMO_WORKSPACE_ID}`;

  it("a diária e a lista de dias vêm do simulador", () => {
    const dia = responderDaDemo(sim, `${base}/day-stats`, consulta())!;
    expect(dia.status).toBe(200);
    expect((dia.body as { day: string }).day).toBe(sim.day);
    expect(responderDaDemo(sim, `${base}/day-stats/days`, consulta())!.body).toMatchObject({ days: [sim.day] });
  });

  it("o dia gravado sai por partes, em NDJSON, e só existe o dia de mentira", () => {
    const dias = responderDaDemo(sim, `${base}/timeline/days`, consulta())!.body as { recording: boolean; days: { day: string; from: number; to: number }[] };
    expect(dias.recording).toBe(true);
    const [dia] = dias.days;
    expect(dia!.day).toBe(sim.day);
    const parte = responderDaDemo(sim, `${base}/timeline/${sim.day}`, consulta(`from=${dia!.from - 1}&to=${dia!.from + 3 * 3_600_000}`))!;
    const registros = parseTimeline(parte.texto!);
    expect(registros[0]!.t).toBe("k");
    expect(registros.length).toBeGreaterThan(10);
    expect(responderDaDemo(sim, `${base}/timeline/2026-01-01`, consulta())!.status).toBe(404);
    expect(responderDaDemo(sim, `${base}/timeline/${sim.day}`, consulta("from=0&to=999999999999999"))!.status).toBe(400);
  });

  it("a ficha do workspace e as esperas batem com os itens pendentes; rota que não existe devolve null", () => {
    const ficha = fichaDaDemo(sim);
    expect(ficha.waitingForYou).toBe(sim.forYou.filter((i) => i.status === "pendente").length);
    expect(ficha.team.agents.length).toBe(sim.agents.length - 1);
    expect((responderDaDemo(sim, "/api/cyno/waiting", consulta())!.body as { items: unknown[] }).items).toHaveLength(ficha.waitingForYou);
    expect(responderDaDemo(sim, "/api/nao-existe", consulta())).toBeNull();
  });
});

describe("instalarDemo: nada chama o servidor e nada é gravado", () => {
  afterEach(() => vi.restoreAllMocks());

  function janelaFalsa() {
    const real = vi.fn(async () => new Response("estático"));
    const janela = { fetch: real, location: { href: "http://app.local/?demo=1", origin: "http://app.local" } } as unknown as Window;
    return { janela, real };
  }

  it("leitura da API sai do simulador, escrita é recusada e só os arquivos estáticos passam para o fetch de verdade", async () => {
    const { janela, real } = janelaFalsa();
    const sim = instalarDemo("?demo=1&now=2026-11-12T14:30", janela);
    const lista = await janela.fetch(`/api/w/${DEMO_WORKSPACE_ID}/day-stats/days`);
    expect(lista.status).toBe(200);
    expect(((await lista.json()) as { days: string[] }).days).toEqual([sim.day]);
    const escrita = await janela.fetch(`/api/w/${DEMO_WORKSPACE_ID}/tasks`, { method: "POST", body: "{}" });
    expect(escrita.status).toBe(403);
    expect(((await escrita.json()) as { error: string }).error).toBe(MENSAGEM_DE_ESCRITA);
    expect((await janela.fetch("/api/nao-existe")).status).toBe(404);
    expect(real).not.toHaveBeenCalled();
    await janela.fetch("/cena/assets/manifest.json");
    expect(real).toHaveBeenCalledTimes(1);
    expect(janela.__demo?.sim).toBe(sim);
  });

  it("o id da demonstração não é um id que a criação de workspace aceite (slug só com a-z, 0-9 e hífen)", () => {
    expect(DEMO_WORKSPACE_ID).not.toBe("demo");
    expect(slugify(DEMO_WORKSPACE_ID)).not.toBe(DEMO_WORKSPACE_ID);
    expect(isSafeId(DEMO_WORKSPACE_ID)).toBe(false);
  });

  it("com o modo ligado, nenhuma chave do localStorage é criada ou alterada", () => {
    const real = new Map<string, string>([["cyno.cena.memoria.demo", "antigo"]]);
    const escritas: string[] = [];
    const armazenamentoReal = { getItem: (k: string) => real.get(k) ?? null, setItem: (k: string, v: string) => { escritas.push(k); real.set(k, v); }, removeItem: (k: string) => { escritas.push(k); real.delete(k); } } as unknown as Storage;
    const { janela } = janelaFalsa();
    Object.defineProperty(janela, "localStorage", { value: armazenamentoReal, configurable: true, writable: true });
    instalarDemo("?demo=1&now=2026-11-12T14:30", janela);
    janela.localStorage.setItem("cyno.cena.memoria.demo", "novo");
    janela.localStorage.setItem("cyno.cena.lotes", "x");
    janela.localStorage.removeItem("qualquer");
    expect(janela.localStorage.getItem("cyno.cena.memoria.demo")).toBe("novo");
    expect(escritas).toEqual([]);
    expect([...real.entries()]).toEqual([["cyno.cena.memoria.demo", "antigo"]]);
    const memoria = armazenamentoEmMemoria();
    memoria.setItem("a", "1");
    expect([memoria.length, memoria.key(0), memoria.getItem("b")]).toEqual([1, "a", null]);
  });

  it("o socket do escritório recebe a lista de workspaces, o retrato e depois os eventos de 2 em 2 segundos", async () => {
    vi.useFakeTimers();
    try {
      const { janela } = janelaFalsa();
      instalarDemo("?demo=1&now=2026-11-12T14:30", janela);
      const Socket = (janela as unknown as { WebSocket: new (url: string) => { onmessage: ((e: { data: string }) => void) | null; close(): void } }).WebSocket;
      const tipos: string[] = [];
      const socket = new Socket(`/ws?workspace=${DEMO_WORKSPACE_ID}`);
      socket.onmessage = (mensagem) => void tipos.push((JSON.parse(mensagem.data) as { type: string }).type);
      await vi.advanceTimersByTimeAsync(1);
      expect(tipos).toEqual(["workspaces:list", "office:snapshot"]);
      await vi.advanceTimersByTimeAsync(BATIMENTO_DA_DEMO_MS * 30);
      expect(tipos.length).toBeGreaterThan(2);
      socket.close();
      const antes = tipos.length;
      await vi.advanceTimersByTimeAsync(BATIMENTO_DA_DEMO_MS * 5);
      expect(tipos.length).toBe(antes);
    } finally {
      vi.useRealTimers();
    }
  });
});
