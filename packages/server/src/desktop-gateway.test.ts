import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { applyDesktopDefaults, DEFAULT_DESKTOP_WEB_PORT, resolveDesktopWebDir, resolveDesktopWebPort, sameFilePath, stripWindowsVerbatimPrefix } from "./desktop-entry";
import { DESKTOP_GATEWAY_HOST, isProxyPath, startDesktopGateway, type DesktopGateway } from "./desktop-gateway";

type Cleanup = () => Promise<void>;

/** Obtém uma porta livre em 127.0.0.1 e a libera imediatamente (simula backend desligado). */
async function getClosedPort(): Promise<number> {
  const srv = net.createServer();
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const addr = srv.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  await new Promise<void>((resolve) => srv.close(() => resolve()));
  return port;
}

/** Faz uma requisição HTTP bruta sem normalizar `/../` (o `fetch` normalizaria antes de enviar). */
function rawHttpGet(port: number, rawPath: string): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method: "GET", path: rawPath }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ statusCode: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("desktop-gateway", () => {
  const cleanups: Cleanup[] = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      const fn = cleanups.pop()!;
      await fn().catch(() => undefined);
    }
  });

  async function createWebFixture(): Promise<{ parentDir: string; webDir: string }> {
    const parentDir = await mkdtemp(path.join(os.tmpdir(), "cyno-gw-test-"));
    cleanups.push(() => rm(parentDir, { recursive: true, force: true }));
    const webDir = path.join(parentDir, "web");
    await mkdir(path.join(webDir, "assets"), { recursive: true });
    await writeFile(path.join(parentDir, "secret.txt"), "segredo-fora-da-web", "utf8");
    await writeFile(path.join(webDir, "index.html"), "<!doctype html><html><body>Cyno SPA</body></html>", "utf8");
    await writeFile(path.join(webDir, "assets", "app-AbCd1234.js"), "console.log('ok');", "utf8");
    await writeFile(path.join(webDir, "assets", "style-XyZ98765.css"), "body { color: #fff; }", "utf8");
    await writeFile(path.join(webDir, "sw.js"), "// service worker", "utf8");
    return { parentDir, webDir };
  }

  async function startMockBackend(): Promise<{ port: number; server: http.Server; wss: WebSocketServer; lastHeaders: Record<string, http.IncomingHttpHeaders> }> {
    const lastHeaders: Record<string, http.IncomingHttpHeaders> = {};
    const server = http.createServer((req, res) => {
      const url = req.url ?? "/";
      lastHeaders[url] = req.headers;
      if (url === "/api/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (url.startsWith("/api/echo")) {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              method: req.method,
              url: req.url,
              body: Buffer.concat(chunks).toString("utf8"),
              xfwd: {
                for: req.headers["x-forwarded-for"],
                host: req.headers["x-forwarded-host"],
                proto: req.headers["x-forwarded-proto"],
                port: req.headers["x-forwarded-port"],
              },
            }),
          );
        });
        return;
      }
      res.writeHead(404);
      res.end("not found");
    });

    const wss = new WebSocketServer({ noServer: true });
    server.on("upgrade", (req, socket, head) => {
      const url = req.url ?? "/";
      lastHeaders[`ws:${url}`] = req.headers;
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.send(JSON.stringify({ hello: url, xForwardedFor: req.headers["x-forwarded-for"] ?? null }));
        ws.on("message", (data) => {
          ws.send(`eco:${String(data)}`);
        });
      });
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    cleanups.push(async () => {
      for (const client of wss.clients) client.terminate();
      wss.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    return { port, server, wss, lastHeaders };
  }

  async function startGateway(webDir: string, apiPort: number): Promise<DesktopGateway> {
    const gw = await startDesktopGateway({ webPort: 0, apiPort, webDir, healthTimeoutMs: 500 });
    cleanups.push(() => gw.close());
    return gw;
  }

  it("identifica corretamente prefixos de proxy /api e /ws", () => {
    expect(isProxyPath("/api")).toBe(true);
    expect(isProxyPath("/api/health")).toBe(true);
    expect(isProxyPath("/ws")).toBe(true);
    expect(isProxyPath("/ws/live")).toBe(true);
    expect(isProxyPath("/api-docs.png")).toBe(false);
    expect(isProxyPath("/ws-icon.svg")).toBe(false);
    expect(isProxyPath("/")).toBe(false);
  });

  it("serve arquivos estáticos com MIME e cache adequados, além de fallback SPA em 127.0.0.1", async () => {
    const { webDir } = await createWebFixture();
    const closedPort = await getClosedPort();
    const gw = await startGateway(webDir, closedPort);

    expect(gw.host).toBe(DESKTOP_GATEWAY_HOST);

    const root = await fetch(`http://127.0.0.1:${gw.port}/`);
    expect(root.status).toBe(200);
    expect(root.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(root.headers.get("cache-control")).toBe("no-cache");
    expect(await root.text()).toContain("Cyno SPA");

    const js = await fetch(`http://127.0.0.1:${gw.port}/assets/app-AbCd1234.js`);
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toBe("application/javascript; charset=utf-8");
    expect(js.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(await js.text()).toBe("console.log('ok');");

    const css = await fetch(`http://127.0.0.1:${gw.port}/assets/style-XyZ98765.css`);
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toBe("text/css; charset=utf-8");

    const sw = await fetch(`http://127.0.0.1:${gw.port}/sw.js`);
    expect(sw.status).toBe(200);
    expect(sw.headers.get("cache-control")).toBe("no-cache");

    // Rota SPA sem extensão cai no index.html com no-cache
    const spa = await fetch(`http://127.0.0.1:${gw.port}/workspace/principal/tasks`);
    expect(spa.status).toBe(200);
    expect(spa.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(spa.headers.get("cache-control")).toBe("no-cache");
    expect(await spa.text()).toContain("Cyno SPA");

    // Asset inexistente com extensão devolve 404
    const missingAsset = await fetch(`http://127.0.0.1:${gw.port}/assets/nao-existe.js`);
    expect(missingAsset.status).toBe(404);
  });

  it("bloqueia traversal (..), caminhos codificados, barras invertidas e symlinks fora da pasta web", async () => {
    const { parentDir, webDir } = await createWebFixture();
    const closedPort = await getClosedPort();
    const gw = await startGateway(webDir, closedPort);

    for (const attackPath of ["/../secret.txt", "/%2e%2e/secret.txt", "/assets/../../secret.txt", "/..%5csecret.txt", "/..\\secret.txt"]) {
      const res = await rawHttpGet(gw.port, attackPath);
      expect(res.statusCode, `esperava bloqueio para ${attackPath}`).toBe(403);
      expect(res.body).not.toContain("segredo-fora-da-web");
    }

    // Symlink dentro da pasta web apontando para fora também deve ser recusado.
    const linkPath = path.join(webDir, "escape.txt");
    await symlink(path.join(parentDir, "secret.txt"), linkPath);
    const linkRes = await rawHttpGet(gw.port, "/escape.txt");
    expect(linkRes.statusCode).toBe(403);
    expect(linkRes.body).not.toContain("segredo-fora-da-web");
  });

  it("faz proxy HTTP para /api repassando x-forwarded-* e responde /__backend-health", async () => {
    const { webDir } = await createWebFixture();
    const backend = await startMockBackend();
    const gw = await startGateway(webDir, backend.port);

    const health = await fetch(`http://127.0.0.1:${gw.port}/__backend-health`);
    expect(health.status).toBe(200);
    expect(health.headers.get("cache-control")).toBe("no-store");
    expect(await health.json()).toEqual({ up: true });

    const apiHealth = await fetch(`http://127.0.0.1:${gw.port}/api/health`);
    expect(apiHealth.status).toBe(200);
    expect(await apiHealth.json()).toEqual({ ok: true });

    const echo = await fetch(`http://127.0.0.1:${gw.port}/api/echo?foo=bar`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "ola-cyno",
    });
    expect(echo.status).toBe(200);
    const payload = (await echo.json()) as { method: string; url: string; body: string; xfwd: Record<string, string> };
    expect(payload.method).toBe("POST");
    expect(payload.url).toBe("/api/echo?foo=bar");
    expect(payload.body).toBe("ola-cyno");
    expect(payload.xfwd.for).toContain("127.0.0.1");
    expect(payload.xfwd.host).toBe(`127.0.0.1:${gw.port}`);
    expect(payload.xfwd.proto).toBe("http");
    expect(payload.xfwd.port).toBe(String(gw.port));
  });

  it("faz proxy de WebSocket em /ws e em /api/... com servidor falso", async () => {
    const { webDir } = await createWebFixture();
    const backend = await startMockBackend();
    const gw = await startGateway(webDir, backend.port);

    for (const targetPath of ["/ws?workspace=principal", "/api/w/principal/maestro/terminal"]) {
      const ws = new WebSocket(`ws://127.0.0.1:${gw.port}${targetPath}`);
      const firstMsg = await new Promise<string>((resolve, reject) => {
        ws.once("message", (data) => resolve(String(data)));
        ws.once("error", reject);
      });
      const parsed = JSON.parse(firstMsg) as { hello: string; xForwardedFor: string | null };
      expect(parsed.hello).toBe(targetPath);
      expect(parsed.xForwardedFor).toContain("127.0.0.1");

      const echoPromise = new Promise<string>((resolve, reject) => {
        ws.once("message", (data) => resolve(String(data)));
        ws.once("error", reject);
      });
      ws.send("ping-gateway");
      expect(await echoPromise).toBe("eco:ping-gateway");

      // Encerramento abrupto não pode derrubar o gateway.
      ws.terminate();
    }

    // Gateway continua saudável após desconexão abrupta dos WebSockets.
    const health = await fetch(`http://127.0.0.1:${gw.port}/__backend-health`);
    expect(await health.json()).toEqual({ up: true });
  });

  it("devolve 502 no HTTP/WS e { up: false } em /__backend-health quando o backend está fora", async () => {
    const { webDir } = await createWebFixture();
    const closedPort = await getClosedPort();
    const gw = await startGateway(webDir, closedPort);

    const health = await fetch(`http://127.0.0.1:${gw.port}/__backend-health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ up: false });

    const apiRes = await fetch(`http://127.0.0.1:${gw.port}/api/health`);
    expect(apiRes.status).toBe(502);

    const wsStatus = await new Promise<number>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${gw.port}/ws`);
      ws.once("unexpected-response", (_req, res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      ws.once("open", () => {
        ws.close();
        reject(new Error("não deveria abrir WS com backend desligado"));
      });
      ws.once("error", () => {
        // esperado após unexpected-response
      });
    });
    expect(wsStatus).toBe(502);
  });
});

describe("desktop-entry helpers", () => {
  it("aplica padrões desktop sem sobrescrever overrides explícitos", () => {
    const env: NodeJS.ProcessEnv = {};
    applyDesktopDefaults(env);
    expect(env.CYNO_UPDATE_APPLY).toBe("off");
    expect(env.CYNO_UPDATE_CHECK).toBe("off");
    expect(env.HOST).toBe("127.0.0.1");

    const custom: NodeJS.ProcessEnv = { CYNO_UPDATE_CHECK: "on", CYNO_UPDATE_APPLY: "1", HOST: "127.0.0.1" };
    applyDesktopDefaults(custom);
    expect(custom.CYNO_UPDATE_CHECK).toBe("on");
    expect(custom.CYNO_UPDATE_APPLY).toBe("1");
  });

  it("resolve pasta web relativa ao entry.mjs e aceita override CYNO_WEB_DIR", () => {
    const fakeEntryUrl = pathToFileURL(path.resolve("/tmp/app/resources/server/entry.mjs")).href;
    expect(resolveDesktopWebDir({}, fakeEntryUrl)).toBe(path.resolve("/tmp/app/resources/web"));
    expect(resolveDesktopWebDir({ CYNO_WEB_DIR: "/custom/web" }, fakeEntryUrl)).toBe(path.resolve("/custom/web"));
  });

  it("tira o prefixo \\\\?\\ do Windows, que a casca Tauri passa em argv[1]", () => {
    expect(stripWindowsVerbatimPrefix("\\\\?\\C:\\Cyno Office\\resources\\server\\entry.mjs")).toBe("C:\\Cyno Office\\resources\\server\\entry.mjs");
    expect(stripWindowsVerbatimPrefix("\\\\?\\UNC\\servidor\\pasta\\entry.mjs")).toBe("\\\\servidor\\pasta\\entry.mjs");
    expect(stripWindowsVerbatimPrefix("C:\\normal\\entry.mjs")).toBe("C:\\normal\\entry.mjs");
    expect(stripWindowsVerbatimPrefix("/usr/lib/entry.mjs")).toBe("/usr/lib/entry.mjs");
  });

  it("reconhece o mesmo arquivo com prefixo \\\\?\\ e caixa diferente no Windows, e só no Windows", () => {
    const literal = "\\\\?\\C:\\Users\\Ana\\AppData\\Local\\Cyno Office\\resources\\server\\entry.mjs";
    const normal = "c:\\users\\ana\\appdata\\local\\cyno office\\resources\\server\\entry.mjs";
    expect(sameFilePath(literal, normal, "win32")).toBe(true);
    expect(sameFilePath(literal, "C:\\outra\\pasta\\entry.mjs", "win32")).toBe(false);
    // Fora do Windows o prefixo não existe e a caixa importa.
    expect(sameFilePath(literal, normal, "linux")).toBe(false);
  });

  it("lê e valida WEB_PORT", () => {
    expect(resolveDesktopWebPort({})).toBe(DEFAULT_DESKTOP_WEB_PORT);
    expect(resolveDesktopWebPort({ WEB_PORT: "4000" })).toBe(4000);
    expect(() => resolveDesktopWebPort({ WEB_PORT: "0" })).toThrow(/WEB_PORT inválido/);
    expect(() => resolveDesktopWebPort({ WEB_PORT: "abc" })).toThrow(/WEB_PORT inválido/);
  });
});
