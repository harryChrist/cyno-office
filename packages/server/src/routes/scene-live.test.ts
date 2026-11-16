import { readdirSync, statSync } from "node:fs";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { AUTH_COOKIE, parseSceneMessage, SCENE_LIVE_PATH, WS_CLOSE_WORKSPACE_NOT_FOUND, type SceneFull, type SceneLiveMessage } from "@cyno/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { useTestApp, type TestApp } from "../dev/test-app";
import { writeAuthFile } from "../platform/auth/store";

vi.setConfig({ testTimeout: 30_000 });
const setupApp = useTestApp();
const FAST_SCRYPT = { N: 1024, r: 8, p: 1, keylen: 64 } as const;
const PASSWORD = "senha-de-teste-1";

afterEach(() => vi.unstubAllEnvs());

async function listen(testApp: TestApp): Promise<string> {
  await testApp.app.listen({ port: 0, host: "127.0.0.1" });
  return `127.0.0.1:${(testApp.app.server.address() as AddressInfo).port}`;
}

/** Abre o socket: resolve com o código HTTP da recusa, ou 101 com o socket aberto. */
function open(host: string, query = "?workspace=principal", headers: Record<string, string> = {}) {
  return new Promise<{ status: number; socket?: WebSocket; messages: SceneLiveMessage[] }>((resolve) => {
    const socket = new WebSocket(`ws://${host}${SCENE_LIVE_PATH}${query}`, { headers });
    // As mensagens já podem vir junto da resposta do upgrade: o ouvinte entra antes de o `open` devolver o socket.
    const messages = collect(socket);
    socket.on("unexpected-response", (_request, response) => {
      resolve({ status: response.statusCode ?? 0, messages });
      socket.terminate();
    });
    socket.on("open", () => resolve({ status: 101, socket, messages }));
    socket.on("error", () => undefined);
  });
}

function collect(socket: WebSocket): SceneLiveMessage[] {
  const messages: SceneLiveMessage[] = [];
  socket.on("message", (data) => {
    const message = parseSceneMessage(String(data));
    if (message) messages.push(message);
  });
  return messages;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error("condição não ficou verdadeira a tempo");
    await wait(10);
  }
}

/** Todos os arquivos da pasta, com tamanho e data: uma foto para comparar antes e depois. */
function listing(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        const info = statSync(full);
        out.push(`${path.relative(dir, full)}|${info.size}|${info.mtimeMs}`);
      }
    }
  };
  walk(dir);
  return out.sort();
}

describe("WebSocket /ws/scene (cena ao vivo)", () => {
  it("com a chave desligada (padrão) a rota recusa a conexão e nada do serviço existe", async () => {
    const testApp = await setupApp();
    const host = await listen(testApp);
    expect((await open(host)).status).toBe(404);
    expect(testApp.workspaces.find("principal")?.sceneLive).toBeUndefined();
  });

  it("com a chave ligada: scene:hello e scene:full ao conectar; a simulação liga com a conexão e a folga cuida de desligar", async () => {
    vi.stubEnv("CYNO_SCENE_LIVE", "1");
    vi.stubEnv("SCENE_LIVE_IDLE_MS", "60000");
    const testApp = await setupApp();
    const host = await listen(testApp);
    const live = testApp.workspaces.find("principal")!.sceneLive!;
    expect(live.active).toBe(false);
    const { status, socket, messages } = await open(host);
    expect(status).toBe(101);
    await until(() => messages.length >= 2);
    expect(messages[0]!.t).toBe("scene:hello");
    const full = messages[1] as SceneFull;
    expect(full.t).toBe("scene:full");
    expect(full.layout.rooms.length).toBeGreaterThan(0);
    expect(live.active).toBe(true);
    expect(live.subscribers).toBe(1);
    socket!.close();
    await until(() => live.subscribers === 0);
    // Reassinar dentro da folga mantém a simulação ligada.
    expect(live.active).toBe(true);
  });

  it("workspace inexistente fecha com 4404, como o /ws", async () => {
    vi.stubEnv("CYNO_SCENE_LIVE", "1");
    const testApp = await setupApp();
    const host = await listen(testApp);
    const { socket } = await open(host, "?workspace=nao-existe");
    const code = await new Promise<number>((resolve) => socket!.once("close", (c) => resolve(c)));
    expect(code).toBe(WS_CLOSE_WORKSPACE_NOT_FOUND);
  });

  it("exige a mesma autenticação do /ws: sem sessão 401, com a sessão entra", async () => {
    vi.stubEnv("CYNO_SCENE_LIVE", "1");
    const testApp = await setupApp({ auth: { open: false } });
    await writeAuthFile(testApp.dataDir, PASSWORD, new Date(), FAST_SCRYPT);
    const host = await listen(testApp);
    expect((await open(host)).status).toBe(401);
    const login = await testApp.app.inject({ method: "POST", url: "/api/auth/login", payload: { password: PASSWORD } });
    const raw = login.headers["set-cookie"];
    const cookie = String(Array.isArray(raw) ? raw[0] : raw).split(";")[0]!;
    expect(cookie.startsWith(`${AUTH_COOKIE}=`)).toBe(true);
    const { status, socket } = await open(host, "?workspace=principal", { cookie });
    expect(status).toBe(101);
    socket!.close();
  });

  it("a chave desligada recusa também com a sessão válida", async () => {
    const testApp = await setupApp({ auth: { open: false } });
    await writeAuthFile(testApp.dataDir, PASSWORD, new Date(), FAST_SCRYPT);
    const host = await listen(testApp);
    const login = await testApp.app.inject({ method: "POST", url: "/api/auth/login", payload: { password: PASSWORD } });
    const raw = login.headers["set-cookie"];
    const cookie = String(Array.isArray(raw) ? raw[0] : raw).split(";")[0]!;
    expect((await open(host, "?workspace=principal", { cookie })).status).toBe(404);
  });

  it("nada é escrito em disco enquanto alguém assiste", async () => {
    vi.stubEnv("CYNO_SCENE_LIVE", "1");
    vi.stubEnv("CYNO_TIMELINE", "0");
    const testApp = await setupApp();
    const host = await listen(testApp);
    await wait(300);
    const before = listing(testApp.dataDir);
    const { socket, messages } = await open(host);
    await until(() => messages.length >= 2);
    await wait(1200);
    expect(messages.length).toBeGreaterThanOrEqual(2);
    expect(listing(testApp.dataDir)).toEqual(before);
    socket!.close();
  });
});
