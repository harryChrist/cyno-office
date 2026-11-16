import { parseSceneMessage, type Agent, type OfficeState, type Room, type SceneChar, type SceneFull, type SceneLiveMessage, type ServerEvent, type Task } from "@cyno/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sceneLiveEnabled, sceneLiveIdleMs, SceneLiveService } from "./service";

const T0 = Date.parse("2026-11-15T12:00:00.000Z");
const IDLE_MS = 5 * 60_000;

const room = (id: string, x: number): Room => ({ id, kind: "team", name: id.toUpperCase(), theme: "mint", gridPosition: { x, y: 0 }, readsGlobalBrain: false, readsBrainsOf: [] });
const agent = (id: string, teamId: string): Agent => ({ id, teamId, name: id, role: "Testador", instructions: "", avatar: { skin: "tone2", hair: "long", hairColor: "wood", shirt: "mint", pants: "denim" }, status: "idle" });
const task = (id: string, agentId: string, status: Task["status"]): Task => ({ id, roomId: "estudio", teamId: "time", agentId, prompt: `pedido ${id}`, status, createdAt: new Date(T0).toISOString(), updatedAt: new Date(T0).toISOString() });

/** Um escritório mutável: o `source` do serviço lê sempre o estado de agora. */
function setup(idleMs = IDLE_MS) {
  const office: OfficeState = { rooms: [room("estudio", 1)], teams: [{ id: "time", roomId: "estudio", name: "Time", focus: "" }], agents: [agent("ana", "time"), agent("bia", "time")], tasks: [] };
  const warn = vi.fn();
  const service = new SceneLiveService({
    workspaceId: "principal",
    workspaceName: () => "Principal",
    source: () => ({ office, terminals: {}, forYou: [], projects: [], progress: {}, block: () => undefined }),
    now: () => Date.now(),
    idleMs,
    log: { warn },
  });
  /** Uma tela: guarda as mensagens e mantém o estado que o protocolo promete (full substitui, delta aplica). */
  const screen = () => {
    const messages: SceneLiveMessage[] = [];
    const wires: string[] = [];
    const chars = new Map<string, SceneChar>();
    const unsubscribe = service.subscribe((wire) => {
      wires.push(wire);
      const message = parseSceneMessage(wire)!;
      messages.push(message);
      if (message.t === "scene:full") {
        chars.clear();
        for (const ch of message.chars) chars.set(ch.id, ch);
      } else if (message.t === "scene:delta") {
        for (const id of message.x ?? []) chars.delete(id);
        for (const change of message.c ?? []) chars.set(change.id, { ...chars.get(change.id), ...change } as SceneChar);
      }
    });
    return { messages, wires, chars, unsubscribe, fulls: () => messages.filter((m): m is SceneFull => m.t === "scene:full") };
  };
  const emit = (event: ServerEvent) => service.observe(event);
  return { office, service, screen, emit, warn };
}

const positions = (chars: Map<string, SceneChar>) => Object.fromEntries([...chars].map(([id, ch]) => [id, [ch.x, ch.y]]));

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("chave e folga (variáveis de ambiente)", () => {
  it("CYNO_SCENE_LIVE vem desligada; só 1/on/true ligam", () => {
    expect(sceneLiveEnabled({})).toBe(false);
    expect(sceneLiveEnabled({ CYNO_SCENE_LIVE: "0" })).toBe(false);
    for (const value of ["1", "on", "TRUE"]) expect(sceneLiveEnabled({ CYNO_SCENE_LIVE: value })).toBe(true);
  });

  it("SCENE_LIVE_IDLE_MS: padrão de 5 min; valor inválido volta ao padrão", () => {
    expect(sceneLiveIdleMs({})).toBe(IDLE_MS);
    expect(sceneLiveIdleMs({ SCENE_LIVE_IDLE_MS: "1000" })).toBe(1000);
    expect(sceneLiveIdleMs({ SCENE_LIVE_IDLE_MS: "abc" })).toBe(IDLE_MS);
    expect(sceneLiveIdleMs({ SCENE_LIVE_IDLE_MS: "-5" })).toBe(IDLE_MS);
  });
});

describe("serviço da cena ao vivo", () => {
  it("só liga no primeiro assinante: antes disso não há simulação nem temporizador", () => {
    const { service, screen } = setup();
    expect(service.active).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    const first = screen();
    expect(service.active).toBe(true);
    expect(service.subscribers).toBe(1);
    expect(first.messages.map((m) => m.t)).toEqual(["scene:hello", "scene:full"]);
    const full = first.fulls()[0]!;
    expect(full.layout.rooms.map((r) => r.id).sort()).toEqual(["estudio"]);
    expect(full.chars.map((c) => c.id).sort()).toEqual(["ana", "bia"]);
    expect(full.rooms[0]).toMatchObject({ id: "estudio", ph: "ready", l: 1 });
  });

  it("o scene:hello traz as taxas e a hora do servidor", () => {
    const { screen } = setup();
    const hello = screen().messages[0]!;
    expect(hello).toMatchObject({ v: 1, t: "scene:hello", at: T0, tickHz: 20, sendHz: 10, idleMs: IDLE_MS });
  });

  it("mesmo escritório, mesmo layout: o resultado não depende do relógio do navegador (determinístico)", () => {
    const a = setup();
    const b = setup();
    expect(a.screen().fulls()[0]!.layout).toEqual(b.screen().fulls()[0]!.layout);
  });

  it("dois assinantes recebem o mesmo scene:full e os mesmos deltas", () => {
    const { office, screen, emit } = setup();
    const one = screen();
    const two = screen();
    expect(two.wires[1]).toBe(one.wires[1]);
    // Um agente novo chega: entra pela porta do elevador e anda até a mesa.
    office.agents.push(agent("caio", "time"));
    office.tasks.push(task("t1", "caio", "in_progress"));
    emit({ type: "agent:upserted", agent: office.agents.at(-1)! });
    vi.advanceTimersByTime(3_000);
    expect(one.wires.length).toBeGreaterThan(2);
    expect(two.wires).toEqual(one.wires);
    expect(one.messages.some((m) => m.t === "scene:delta")).toBe(true);
  });

  it("quem entra depois recebe o scene:full com as posições do momento, não o estado inicial", () => {
    const { office, screen, emit } = setup();
    const early = screen();
    office.agents.push(agent("caio", "time"));
    office.tasks.push(task("t1", "caio", "in_progress"));
    emit({ type: "agent:upserted", agent: office.agents.at(-1)! });
    vi.advanceTimersByTime(1_500);
    const firstSeen = early.chars.get("caio");
    vi.advanceTimersByTime(4_000);
    const late = screen();
    const lateFull = late.fulls()[0]!;
    const caioLate = lateFull.chars.find((c) => c.id === "caio")!;
    expect(caioLate).toBeDefined();
    // O delta aplicado pela primeira tela e o full da segunda descrevem o mesmo instante.
    expect(positions(late.chars)).toEqual(positions(early.chars));
    // E o caio andou desde que apareceu (não é a posição de entrada).
    expect(firstSeen).toBeDefined();
    expect([caioLate.x, caioLate.y]).not.toEqual([firstSeen!.x, firstSeen!.y]);
    // Os outros ficaram nas mesas, como no começo.
    expect(late.chars.get("ana")!.s).toBe(1);
  });

  it("reassinar dentro da folga mantém a cena; passada a folga, desliga e a próxima assinatura recomeça do zero", () => {
    const { office, service, screen, emit } = setup();
    const first = screen();
    const initial = positions(first.chars);
    const sim = service.sim;
    office.agents.push(agent("caio", "time"));
    office.tasks.push(task("t1", "caio", "in_progress"));
    emit({ type: "agent:upserted", agent: office.agents.at(-1)! });
    vi.advanceTimersByTime(4_000);
    first.unsubscribe();
    expect(service.subscribers).toBe(0);
    expect(service.active).toBe(true);

    // Dentro da folga: a mesma simulação, o caio onde estava.
    vi.advanceTimersByTime(IDLE_MS - 1_000);
    expect(service.active).toBe(true);
    const back = screen();
    expect(service.sim).toBe(sim);
    expect(back.chars.has("caio")).toBe(true);
    back.unsubscribe();

    // Passada a folga: desligou (nenhum temporizador sobra) e descartou o Sim.
    vi.advanceTimersByTime(IDLE_MS + 1_000);
    expect(service.active).toBe(false);
    expect(service.sim).toBeNull();
    expect(vi.getTimerCount()).toBe(0);

    // A próxima assinatura recomeça: uma simulação nova com todos nas mesas, as posições iniciais do primeiro full.
    const again = screen();
    expect(service.sim).not.toBe(sim);
    expect(positions(again.chars).ana).toEqual(initial.ana);
    expect(positions(again.chars).bia).toEqual(initial.bia);
  });

  it("a folga recomeça a cada saída: quem sai e volta antes do fim não deixa a simulação cair", () => {
    const { service, screen } = setup();
    const first = screen();
    first.unsubscribe();
    vi.advanceTimersByTime(IDLE_MS - 10);
    screen();
    vi.advanceTimersByTime(IDLE_MS * 2);
    expect(service.active).toBe(true);
  });

  it("ocioso -> trabalhando chega ao Sim e aparece nos deltas", () => {
    const { office, service, screen, emit } = setup();
    const view = screen();
    expect(view.chars.get("bia")!.m).toBe("idle");
    office.agents[1]!.status = "working";
    office.tasks.push(task("t1", "bia", "in_progress"));
    emit({ type: "agent:upserted", agent: office.agents[1]! });
    // O retrato espera 150 ms para juntar rajadas; depois o Sim recebe e o delta sai no envio de 100 ms.
    vi.advanceTimersByTime(100);
    expect(service.sim!.chars.get("bia")!.mode).toBe("idle");
    vi.advanceTimersByTime(1_000);
    expect(service.sim!.chars.get("bia")!.mode).toBe("work");
    const deltas = view.messages.filter((m) => m.t === "scene:delta");
    const biaChange = deltas.flatMap((m) => (m.t === "scene:delta" ? (m.c ?? []) : [])).find((c) => c.id === "bia" && c.m === "work");
    expect(biaChange).toBeDefined();
    expect(view.chars.get("bia")!.m).toBe("work");
  });

  it("delta só sai quando algo mudou; escritório parado não gera tráfego", () => {
    const { screen } = setup();
    const view = screen();
    vi.advanceTimersByTime(2_000);
    const before = view.wires.length;
    vi.advanceTimersByTime(3_000);
    // Os ociosos podem se mexer, mas ninguém recebe mensagens vazias.
    for (const message of view.messages.slice(before)) {
      expect(message.t).toBe("scene:delta");
      if (message.t === "scene:delta") expect(Boolean(message.c || message.x || message.r || message.el || message.u)).toBe(true);
    }
  });

  it("uma sala nova muda o layout: todos recebem um scene:full novo", () => {
    const { office, screen, emit } = setup();
    const view = screen();
    office.rooms.push(room("outra", 2));
    office.teams.push({ id: "time2", roomId: "outra", name: "Time 2", focus: "" });
    office.agents.push(agent("duda", "time2"));
    emit({ type: "room:upserted", room: office.rooms.at(-1)! });
    vi.advanceTimersByTime(1_000);
    const fulls = view.fulls();
    expect(fulls.length).toBe(2);
    expect(fulls[1]!.layout.rooms.map((r) => r.id).sort()).toEqual(["estudio", "outra"]);
    expect(fulls[1]!.lv).toBeGreaterThan(fulls[0]!.lv);
    expect(fulls[1]!.rooms.find((r) => r.id === "outra")!.ph).toBe("building");
  });

  it("dispose derruba tudo (nenhum temporizador sobra)", () => {
    const { service, screen } = setup();
    screen();
    service.dispose();
    expect(service.active).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("assinante que quebra ao receber não derruba os outros nem o laço", () => {
    const { service, screen, warn } = setup();
    service.subscribe(() => {
      throw new Error("socket quebrado");
    });
    const view = screen();
    vi.advanceTimersByTime(1_000);
    expect(view.messages.length).toBeGreaterThanOrEqual(2);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
