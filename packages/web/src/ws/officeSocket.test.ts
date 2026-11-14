import type { ServerEvent } from "@cyno/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeOffice } from "../test-fixtures";

/** WebSocket falso: guarda a URL de cada conexão e deixa o teste abrir, mandar e derrubar. */
class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeSocket[] = [];
  readyState = FakeSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((message: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  open(): void {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }

  receive(message: object): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  drop(): void {
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.();
  }

  close(): void {
    this.drop();
  }
}

const listeners = { document: new Map<string, () => void>(), window: new Map<string, () => void>() };
const doc = {
  visibilityState: "visible" as DocumentVisibilityState,
  addEventListener: (type: string, fn: () => void) => listeners.document.set(type, fn),
  removeEventListener: (type: string) => listeners.document.delete(type),
};

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.instances = [];
  listeners.document.clear();
  listeners.window.clear();
  doc.visibilityState = "visible";
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("document", doc);
  vi.stubGlobal("window", {
    location: { protocol: "http:", host: "office.local" },
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (id: number) => clearTimeout(id),
    addEventListener: (type: string, fn: () => void) => listeners.window.set(type, fn),
    removeEventListener: (type: string) => listeners.window.delete(type),
  });
  vi.stubGlobal("fetch", async () => ({ ok: true, json: async () => ({ up: true }) }));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const { connectOfficeSocket } = await import("./officeSocket");

/** Deixa a consulta ao health (promessas) terminar. */
const settle = () => vi.advanceTimersByTimeAsync(0);
const last = () => FakeSocket.instances.at(-1)!;

async function connected(events: ServerEvent[], statuses: string[] = []) {
  const stop = connectOfficeSocket({ workspaceId: "principal", onEvent: (event) => events.push(event), onStatus: (status) => statuses.push(status) });
  await settle();
  last().open();
  return stop;
}

const snapshot = (epoch: string, seq: number) => ({ type: "office:snapshot", office: makeOffice(), epoch, seq });
const removed = (id: string, seq: number) => ({ type: "calendar:deleted", id, seq });

describe("connectOfficeSocket: cursor, replay e ressincronização", () => {
  it("conexão nova sem cursor; a reconexão pede só o que faltou (since + epoch)", async () => {
    const events: ServerEvent[] = [];
    const stop = await connected(events);
    expect(last().url).toBe("ws://office.local/ws?workspace=principal");
    last().receive(snapshot("e1", 5));
    last().receive(removed("a", 6));
    last().receive(removed("b", 7));
    // Evento sem seq (só visual) não mexe no cursor.
    last().receive({ type: "browser:activity", activity: { agentId: "ana", tabId: "t", label: "x", at: "2026-11-09T00:00:00.000Z" } });
    // O seq não chega às stores.
    expect(events[1]).toEqual({ type: "calendar:deleted", id: "a" });

    last().drop();
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeSocket.instances).toHaveLength(2);
    expect(last().url).toBe("ws://office.local/ws?workspace=principal&since=7&epoch=e1");
    stop();
  });

  it("aplica o replay em ordem e descarta o que já tinha chegado (sem duplicar)", async () => {
    const events: ServerEvent[] = [];
    const stop = await connected(events);
    last().receive(snapshot("e1", 5));
    last().receive(removed("a", 6));
    last().drop();
    await vi.advanceTimersByTimeAsync(1000);
    last().open();
    last().receive({ type: "sync:resumed", epoch: "e1", since: 6, until: 8, replayed: 2 });
    last().receive(removed("a", 6));
    last().receive(removed("b", 7));
    last().receive(removed("c", 8));
    expect(events.map((event) => (event.type === "calendar:deleted" ? event.id : event.type))).toEqual(["office:snapshot", "a", "sync:resumed", "b", "c"]);

    last().drop();
    await vi.advanceTimersByTimeAsync(1000);
    expect(last().url).toContain("since=8&epoch=e1");
    stop();
  });

  it("snapshot depois de reconectar (server reiniciou) troca o cursor: o próximo pedido usa o epoch novo", async () => {
    const events: ServerEvent[] = [];
    const stop = await connected(events);
    last().receive(snapshot("e1", 50));
    last().drop();
    await vi.advanceTimersByTimeAsync(1000);
    last().open();
    last().receive(snapshot("e2", 3));
    // Um seq menor que o antigo vale de novo (outro epoch).
    last().receive(removed("novo", 4));
    expect(events.at(-1)).toEqual({ type: "calendar:deleted", id: "novo" });
    last().drop();
    await vi.advanceTimersByTimeAsync(1000);
    expect(last().url).toContain("since=4&epoch=e2");
    stop();
  });

  it("aba que volta para a frente com o socket caído reconecta na hora, sem esperar o backoff", async () => {
    const statuses: string[] = [];
    const stop = await connected([], statuses);
    last().receive(snapshot("e1", 1));
    doc.visibilityState = "hidden";
    last().drop();
    // Escondida: segue o backoff (nada antes de 500 ms, o mínimo com jitter).
    listeners.document.get("visibilitychange")!();
    await settle();
    expect(FakeSocket.instances).toHaveLength(1);

    doc.visibilityState = "visible";
    listeners.document.get("visibilitychange")!();
    await settle();
    expect(FakeSocket.instances).toHaveLength(2);
    expect(last().url).toContain("since=1&epoch=e1");
    // O timer do backoff que já estava marcado não abre uma segunda conexão.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(FakeSocket.instances).toHaveLength(2);
    expect(statuses).toEqual(["connecting", "open", "reconnecting"]);

    // Já aberto: voltar para a aba (ou a rede voltar) não faz nada.
    last().open();
    listeners.window.get("online")!();
    listeners.document.get("visibilitychange")!();
    await settle();
    expect(FakeSocket.instances).toHaveLength(2);
    stop();
    expect(listeners.document.size + listeners.window.size).toBe(0);
  });
});
