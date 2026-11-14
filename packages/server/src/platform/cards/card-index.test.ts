import { cardSummarySchema, type ForYouItem, type ServerEvent } from "@cyno/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CardIndex, type CardSource } from "./card-index";

const agent = { id: "maestro", teamId: "g", name: "Maestro", role: "maestro", instructions: "", avatar: {}, status: "idle", engine: "claude" };
const office = { rooms: [{ id: "m", kind: "maestro", name: "M", theme: "x", gridPosition: { x: 0, y: 0 }, readsGlobalBrain: true, readsBrainsOf: [] }], teams: [{ id: "g", roomId: "m", name: "G", focus: "" }], agents: [agent] } as never;

/** Um workspace falso: o estado é mexido pelo teste, o barramento é disparado à mão. */
function fakeSource(id: string, name = id) {
  const state = { forYou: [] as ForYouItem[], summary: "" };
  const listeners = new Set<(event: ServerEvent) => void>();
  const summaryListeners = new Set<() => void>();
  const reads = { count: 0 };
  const source: CardSource = {
    id,
    name,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onSummaryChange: (listener) => {
      summaryListeners.add(listener);
      return () => summaryListeners.delete(listener);
    },
    read: () => {
      reads.count += 1;
      return { summary: cardSummarySchema.parse({ summary: state.summary }), office, terminals: {}, access: { allowedDomains: [] }, connectors: [], routines: [], projects: [], forYou: state.forYou, engineBlocked: () => false, usage: [], turns5h: 0 };
    },
  };
  const emit = (type: ServerEvent["type"]) => listeners.forEach((listener) => listener({ type } as ServerEvent));
  return { source, state, emit, reads, listenerCount: () => listeners.size, summaryListeners };
}
const item = (id: string, createdAt: string): ForYouItem => ({ id, agentId: "maestro", roomId: "m", type: "post", status: "pendente", meta: {}, text: "", originalText: "", editedByUser: false, createdAt, title: `Item ${id}` }) as ForYouItem;

describe("CardIndex", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup(...sources: ReturnType<typeof fakeSource>[]) {
    let listChanged: (() => void) | undefined;
    const list = sources;
    const index = new CardIndex({
      sources: () => list.map((entry) => entry.source),
      subscribeList: (listener) => {
        listChanged = listener;
        return () => undefined;
      },
      now: () => new Date("2026-11-11T12:00:00Z"),
      debounceMs: 2000,
    });
    index.start();
    const changes: string[][] = [];
    index.subscribe((workspaces) => changes.push(workspaces));
    return { index, changes, list, listChanged: () => listChanged?.() };
  }

  it("calcula as fichas na primeira leitura e publica só quando a ficha mudou de verdade", () => {
    const a = fakeSource("a");
    const { index, changes } = setup(a);
    expect(index.cards().map((card) => card.workspace)).toEqual(["a"]);
    expect(changes).toEqual([["a"]]);
    changes.length = 0;
    // Evento que não muda nada: recalcula, mas não avisa.
    a.emit("task:upserted");
    vi.advanceTimersByTime(2000);
    expect(a.reads.count).toBe(2);
    expect(changes).toEqual([]);
  });

  it("debounce: uma rajada de eventos vira um recálculo só, 2 s depois", () => {
    const a = fakeSource("a");
    const { index, changes } = setup(a);
    index.cards();
    changes.length = 0;
    a.state.forYou = [item("A-1", "2026-11-10T10:00:00Z")];
    for (const type of ["foryou:upserted", "task:upserted", "project:upserted", "office:snapshot"] as const) a.emit(type);
    vi.advanceTimersByTime(1999);
    expect(a.reads.count).toBe(1);
    vi.advanceTimersByTime(1);
    expect(a.reads.count).toBe(2);
    expect(changes).toEqual([["a"]]);
    expect(index.cards()[0]?.waitingForYou).toBe(1);
  });

  it("recalcula só o workspace do evento", () => {
    const a = fakeSource("a");
    const b = fakeSource("b");
    const { index } = setup(a, b);
    index.cards();
    a.emit("task:upserted");
    vi.advanceTimersByTime(2000);
    expect(a.reads.count).toBe(2);
    expect(b.reads.count).toBe(1);
  });

  it("ignora os eventos que chegam aos montes (log dos agentes, atividade)", () => {
    const a = fakeSource("a");
    const { index } = setup(a);
    index.cards();
    for (let i = 0; i < 50; i += 1) {
      a.emit("agent:log");
      a.emit("activity:appended");
    }
    vi.advanceTimersByTime(5000);
    expect(a.reads.count).toBe(1);
  });

  it("a frase nova recalcula a ficha; trocar um item por outro (mesma contagem) também avisa", () => {
    const a = fakeSource("a");
    const { index, changes } = setup(a);
    a.state.forYou = [item("A-1", "2026-11-10T10:00:00Z")];
    index.cards();
    changes.length = 0;
    a.state.summary = "Faz posts";
    a.summaryListeners.forEach((listener) => listener());
    vi.advanceTimersByTime(2000);
    expect(changes).toEqual([["a"]]);
    expect(index.cards()[0]?.summary.summary).toBe("Faz posts");
    changes.length = 0;
    a.state.forYou = [item("A-2", "2026-11-10T11:00:00Z")];
    a.emit("foryou:upserted");
    vi.advanceTimersByTime(2000);
    expect(changes).toEqual([["a"]]);
  });

  it("workspace novo entra, o removido sai (e para de escutar)", () => {
    const a = fakeSource("a");
    const b = fakeSource("b");
    const { index, list, listChanged, changes } = setup(a);
    index.cards();
    list.push(b);
    listChanged();
    expect(index.cards().map((card) => card.workspace)).toEqual(["a", "b"]);
    changes.length = 0;
    list.splice(0, 1);
    expect(index.cards().map((card) => card.workspace)).toEqual(["b"]);
    expect(changes).toContainEqual(["a"]);
    expect(a.listenerCount()).toBe(0);
  });

  it("renomear recalcula o nome", () => {
    const a = fakeSource("a", "Antigo");
    const { index } = setup(a);
    expect(index.cards()[0]?.name).toBe("Antigo");
    a.source.name = "Novo";
    expect(index.cards()[0]?.name).toBe("Novo");
  });

  it("o Esperando você de todos: do mais antigo ao mais novo, com o destino de cada item", () => {
    const a = fakeSource("a", "Alfa");
    const b = fakeSource("b", "Beta");
    const { index } = setup(a, b);
    const pending: Record<string, ForYouItem[]> = { a: [item("A-2", "2026-11-10T12:00:00Z")], b: [item("A-1", "2026-11-09T12:00:00Z")] };
    const items = index.waiting((id) => (pending[id] ?? []).map((entry) => ({ item: entry, agent: "Eco" })));
    expect(items.map((entry) => [entry.workspace, entry.id, entry.workspaceName, entry.agent, entry.href])).toEqual([
      ["b", "A-1", "Beta", "Eco", "#/b/para-voce"],
      ["a", "A-2", "Alfa", "Eco", "#/a/para-voce"],
    ]);
  });

  it("digest e delta: o digest abre, o delta só traz o que mudou e avança o cursor", () => {
    const a = fakeSource("a", "Alfa");
    const { index } = setup(a);
    expect(index.unseen).toBe(true);
    expect(index.digest()).toContain("## a · Alfa");
    expect(index.unseen).toBe(false);
    expect(index.delta()).toEqual([]);
    a.state.forYou = [item("A-1", "2026-11-10T10:00:00Z")];
    a.emit("foryou:upserted");
    expect(index.delta()).toEqual(["a: +1 waiting for you (now 1)"]);
    expect(index.delta()).toEqual([]);
  });

  it("o cursor do delta é avisado a cada mudança e volta de onde estava depois de um reinício (a queda vira novidade)", () => {
    const a = fakeSource("a", "Alfa");
    const first = setup(a);
    const saved: unknown[] = [];
    const persistent = new CardIndex({ sources: () => [a.source], subscribeList: () => () => undefined, now: () => new Date("2026-11-11T12:00:00Z"), debounceMs: 2000, onSeen: (seen) => saved.push(structuredClone(seen)) });
    persistent.start();
    persistent.digest();
    expect(saved).toHaveLength(1);
    first.index.close();
    persistent.close();
    // "Reinício": o servidor volta com o cursor gravado, mas o que mudou durante a queda ainda não foi visto.
    a.state.forYou = [item("A-1", "2026-11-10T10:00:00Z")];
    const rebooted = new CardIndex({ sources: () => [a.source], subscribeList: () => () => undefined, now: () => new Date("2026-11-11T12:00:00Z"), debounceMs: 2000 });
    rebooted.start();
    rebooted.restoreSeen(saved.at(-1) as Parameters<CardIndex["restoreSeen"]>[0]);
    expect(rebooted.unseen).toBe(false);
    expect(rebooted.delta()).toEqual(["a: +1 waiting for you (now 1)"]);
    rebooted.close();
  });

  it("close solta as assinaturas e o timer", () => {
    const a = fakeSource("a");
    const { index } = setup(a);
    index.cards();
    a.emit("task:upserted");
    index.close();
    expect(a.listenerCount()).toBe(0);
    vi.advanceTimersByTime(5000);
    expect(a.reads.count).toBe(1);
  });
});
