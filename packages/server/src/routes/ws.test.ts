import type { AddressInfo } from "node:net";
import { parseServerMessage, workspaceSocketPath, WS_HEARTBEAT_WIRE, type ServerEvent, type ServerMessage } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import { useTestApp, type TestApp } from "../dev/test-app";

const setupApp = useTestApp();

type Client = {
  socket: WebSocket;
  events: ServerEvent[];
  /** Cada mensagem com o seq (quando veio). */
  messages: ServerMessage[];
  waitFor: (predicate: (event: ServerEvent) => boolean, timeoutMs?: number) => Promise<ServerEvent>;
  closed: Promise<void>;
};

/** Sobe o app de verdade (porta 0) e devolve a URL base. */
async function listen(testApp: TestApp): Promise<string> {
  await testApp.app.listen({ port: 0, host: "127.0.0.1" });
  const { port } = testApp.app.server.address() as AddressInfo;
  return `127.0.0.1:${port}`;
}

function connect(host: string, path = "/ws"): Promise<Client> {
  const socket = new WebSocket(`ws://${host}${path}`);
  const events: ServerEvent[] = [];
  const messages: ServerMessage[] = [];
  const wakers = new Set<() => void>();
  socket.on("message", (data) => {
    const message = parseServerMessage(String(data));
    if (message) {
      events.push(message.event);
      messages.push(message);
    }
    for (const wake of wakers) wake();
  });
  const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
  const waitFor: Client["waitFor"] = (predicate, timeoutMs = 3000) =>
    new Promise((resolve, reject) => {
      const check = () => {
        const found = events.find(predicate);
        if (!found) return;
        wakers.delete(check);
        clearTimeout(timer);
        resolve(found);
      };
      const timer = setTimeout(() => {
        wakers.delete(check);
        reject(new Error("evento não chegou pelo WebSocket"));
      }, timeoutMs);
      wakers.add(check);
      check();
    });
  return new Promise((resolve, reject) => {
    socket.once("open", () => resolve({ socket, events, messages, waitFor, closed }));
    socket.once("error", reject);
  });
}

async function waitUntil(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error("condição não ficou verdadeira a tempo");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("WebSocket /ws (server real na porta 0)", () => {
  it("manda o snapshot ao conectar e transmite os eventos de uma tarefa para todos os clientes", async () => {
    const testApp = await setupApp();
    const host = await listen(testApp);
    const [first, second] = [await connect(host), await connect(host)];

    const snapshot = await first.waitFor((event) => event.type === "office:snapshot");
    expect(snapshot.type === "office:snapshot" && snapshot.office.rooms.map((ws) => ws.id)).toEqual(["projetox", "projetoy", "sala-do-maestro"]);
    expect(testApp.hub.listenerCount).toBe(7); // EventLog do teste + Maestro + agentes de CLI + cadeia de atenção + vigia do orçamento + 2 clientes

    const response = await fetch(`http://${host}/api/w/principal/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ roomId: "projetox", teamId: "projetox-frontend", prompt: "Via WS" }),
    });
    expect(response.status).toBe(201);
    const { id } = (await response.json()) as { id: string };

    for (const client of [first, second]) {
      await client.waitFor((event) => event.type === "task:upserted" && event.task.id === id && event.task.status === "done");
      expect(client.events.some((event) => event.type === "task:progress" && event.taskId === id)).toBe(true);
      expect(client.events.some((event) => event.type === "agent:upserted" && event.agent.status === "working")).toBe(true);
    }

    first.socket.close();
    await first.closed;
    await waitUntil(() => testApp.hub.listenerCount === 6);
    second.socket.close();
    await second.closed;
    await waitUntil(() => testApp.hub.listenerCount === 5);
  });

  it("o snapshot de quem conecta depois traz o último progresso e a pergunta de aprovação", async () => {
    const testApp = await setupApp();
    const host = await listen(testApp);
    const response = await fetch(`http://${host}/api/w/principal/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ roomId: "projetox", teamId: "projetox-backend", prompt: "Migrar o banco [aprovar]" }),
    });
    const { id, agentId } = (await response.json()) as { id: string; agentId: string };
    await testApp.log.waitForTask(id, "waiting_approval");

    // "Recarregar a página": um cliente novo só recebe o snapshot.
    const late = await connect(host);
    const snapshot = await late.waitFor((event) => event.type === "office:snapshot");
    if (snapshot.type !== "office:snapshot") throw new Error("esperava o snapshot");
    const entry = snapshot.progress?.[id];
    expect(entry).toMatchObject({ agentId });
    expect(entry!.progress).toBeGreaterThan(0);
    expect(entry!.message).toContain("quer sua aprovação");
    expect(Object.keys(snapshot.progress!)).toEqual([id]);

    // Depois de decidir, a tarefa termina e sai do progresso do próximo snapshot.
    await fetch(`http://${host}/api/w/principal/tasks/${id}/approval`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approved: false }),
    });
    await testApp.log.waitForTask(id, "failed");
    const after = await connect(host);
    const second = await after.waitFor((event) => event.type === "office:snapshot");
    expect(second.type === "office:snapshot" && second.progress).toEqual({});
    late.socket.close();
    after.socket.close();
    await Promise.all([late.closed, after.closed]);
  });

  it("heartbeat: o server manda ping periodicamente", async () => {
    const testApp = await setupApp({ wsHeartbeatMs: 20 });
    const client = await connect(await listen(testApp));
    const pinged = new Promise<void>((resolve) => client.socket.once("ping", () => resolve()));
    await pinged;
    client.socket.close();
    await client.closed;
  });

  it("heartbeat: junto com o ping vai o aviso de vida em texto, que a página consegue ver", async () => {
    const testApp = await setupApp({ wsHeartbeatMs: 20 });
    const client = await connect(await listen(testApp));
    const beat = await new Promise<string>((resolve) => {
      client.socket.on("message", (data) => {
        if (String(data) === WS_HEARTBEAT_WIRE) resolve(String(data));
      });
    });
    expect(beat).toBe('{"type":"heartbeat"}');
    // Não é um evento: não entra na lista de eventos do cliente.
    expect(client.events.some((event) => (event as { type: string }).type === "heartbeat")).toBe(false);
    client.socket.close();
    await client.closed;
  });

  it("derruba quem não responde ao ping e libera o listener", async () => {
    const testApp = await setupApp({ wsHeartbeatMs: 20 });
    const client = await connect(await listen(testApp));
    // Simula um cliente travado: sem pong automático.
    (client.socket as unknown as { pong: () => void }).pong = () => undefined;
    await client.closed;
    await waitUntil(() => testApp.hub.listenerCount === 5); // EventLog do teste + Maestro + agentes de CLI + cadeia de atenção + vigia do orçamento
  });

  it("fechar o app encerra os clientes conectados", async () => {
    const testApp = await setupApp();
    const client = await connect(await listen(testApp));
    await testApp.app.close();
    await client.closed;
    await waitUntil(() => testApp.hub.listenerCount === 1); // o Maestro e os agentes de CLI também saem
  });
});

describe("WebSocket /ws: seq, replay e snapshot na reconexão", () => {
  const post = (host: string, path: string, body: unknown) =>
    fetch(`http://${host}/api/w/principal${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  it("o snapshot é o retrato completo: epoch e seq do hub, 'Para você', conectores e navegador", async () => {
    const testApp = await setupApp();
    const host = await listen(testApp);
    const client = await connect(host, workspaceSocketPath("principal"));
    const snapshot = await client.waitFor((event) => event.type === "office:snapshot");
    if (snapshot.type !== "office:snapshot") throw new Error("esperava o snapshot");
    expect(snapshot.epoch).toBe(testApp.hub.epoch);
    expect(snapshot.seq).toBe(testApp.hub.seq);
    expect(Array.isArray(snapshot.forYou)).toBe(true);
    expect(snapshot.forYouTypes!.length).toBeGreaterThan(0);
    expect(snapshot.connectors).toEqual([]);
    expect(snapshot.browser).toMatchObject({ tabs: [] });
    client.socket.close();
    await client.closed;
  });

  it("reconexão com since/epoch: reenvia só o que faltou, em ordem e sem snapshot; depois segue ao vivo", async () => {
    const testApp = await setupApp();
    const host = await listen(testApp);
    const first = await connect(host, workspaceSocketPath("principal"));
    const snapshot = await first.waitFor((event) => event.type === "office:snapshot");
    if (snapshot.type !== "office:snapshot") throw new Error("esperava o snapshot");
    const cursor = { epoch: snapshot.epoch!, seq: snapshot.seq! };
    first.socket.close();
    await first.closed;

    // Com o cliente fora: uma tarefa inteira e um item no calendário.
    const created = await post(host, "/tasks", { roomId: "projetox", teamId: "projetox-frontend", prompt: "Enquanto estava fora" });
    const { id } = (await created.json()) as { id: string };
    await testApp.log.waitForTask(id, "done");
    expect((await post(host, "/calendar", { title: "Reunião perdida", date: "2026-11-10", time: "13:00" })).status).toBe(201);
    const missedUntil = testApp.hub.seq;
    expect(missedUntil).toBeGreaterThan(cursor.seq);

    const back = await connect(host, workspaceSocketPath("principal", cursor));
    const resumed = await back.waitFor((event) => event.type === "sync:resumed");
    expect(resumed).toEqual({ type: "sync:resumed", epoch: cursor.epoch, since: cursor.seq, until: missedUntil, replayed: missedUntil - cursor.seq });
    await waitUntil(() => back.messages.some((message) => message.seq === missedUntil));
    expect(back.events.some((event) => event.type === "office:snapshot")).toBe(false);
    const seqs = back.messages.flatMap((message) => (message.seq === undefined ? [] : [message.seq]));
    expect(seqs).toEqual(Array.from({ length: missedUntil - cursor.seq }, (_, i) => cursor.seq + 1 + i));
    expect(back.events.some((event) => event.type === "task:upserted" && event.task.id === id && event.task.status === "done")).toBe(true);
    expect(back.events.some((event) => event.type === "calendar:upserted" && event.calendarEvent.title === "Reunião perdida")).toBe(true);
    // A ordem: lista, sync:resumed, os perdidos e o uso atual.
    expect(back.events[0]!.type).toBe("workspaces:list");
    expect(back.events[1]!.type).toBe("sync:resumed");

    // Ao vivo continua numerado a partir dali.
    await post(host, "/calendar", { title: "Ao vivo", date: "2026-11-11" });
    const live = await back.waitFor((event) => event.type === "calendar:upserted" && event.calendarEvent.title === "Ao vivo");
    expect(back.messages.find((message) => message.event === live)!.seq).toBe(missedUntil + 1);

    // Nada perdido (since = seq atual): sync:resumed com 0 eventos.
    const again = await connect(host, workspaceSocketPath("principal", { epoch: cursor.epoch, seq: testApp.hub.seq }));
    const empty = await again.waitFor((event) => event.type === "sync:resumed");
    expect(empty.type === "sync:resumed" && empty.replayed).toBe(0);
    for (const client of [back, again]) client.socket.close();
    await Promise.all([back.closed, again.closed]);
  });

  it("epoch de outro boot ou since que o histórico já descartou: manda o snapshot", async () => {
    const testApp = await setupApp();
    const host = await listen(testApp);
    const otherBoot = await connect(host, workspaceSocketPath("principal", { epoch: "boot-anterior", seq: 3 }));
    const snapshot = await otherBoot.waitFor((event) => event.type === "office:snapshot");
    expect(snapshot.type === "office:snapshot" && snapshot.epoch).toBe(testApp.hub.epoch);
    expect(otherBoot.events.some((event) => event.type === "sync:resumed")).toBe(false);

    // Mais eventos do que o histórico guarda (5000): o since antigo já não dá para reenviar.
    const since = testApp.hub.seq;
    for (let i = 0; i < 5001; i++) testApp.hub.publish({ type: "calendar:deleted", id: `nao-existe-${i}` });
    const stale = await connect(host, workspaceSocketPath("principal", { epoch: testApp.hub.epoch, seq: since }));
    const fresh = await stale.waitFor((event) => event.type === "office:snapshot");
    expect(fresh.type === "office:snapshot" && fresh.seq).toBe(testApp.hub.seq);
    // Since à frente do hub (cliente confuso) também cai no snapshot.
    const ahead = await connect(host, workspaceSocketPath("principal", { epoch: testApp.hub.epoch, seq: testApp.hub.seq + 10 }));
    await ahead.waitFor((event) => event.type === "office:snapshot");
    for (const client of [otherBoot, stale, ahead]) client.socket.close();
    await Promise.all([otherBoot.closed, stale.closed, ahead.closed]);
  });
});
