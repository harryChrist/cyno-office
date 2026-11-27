import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import net from "node:net";
import path from "node:path";

/** Host exclusivo do gateway desktop (nunca 0.0.0.0). */
export const DESKTOP_GATEWAY_HOST = "127.0.0.1";

const BENIGN_SOCKET_CODES = new Set(["ECONNRESET", "EPIPE", "ERR_STREAM_PREMATURE_CLOSE", "ECANCELED"]);

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};

export type DesktopGatewayOptions = {
  /** Porta HTTP da interface (padrão 3067; 0 para porta livre em testes). */
  webPort: number;
  /** Porta do backend Fastify em 127.0.0.1 (padrão 3068). */
  apiPort: number;
  /** Pasta com os arquivos estáticos compilados do `@cyno/web` (`index.html`, `assets/`, ...). */
  webDir: string;
  /** Tempo limite da sonda `/__backend-health` em ms (padrão 1500). */
  healthTimeoutMs?: number;
  /** Callback opcional para erros inesperados de proxy/IO (nunca derruba o processo). */
  onError?: (error: Error) => void;
};

export type DesktopGateway = {
  /** Endereço em escuta (`127.0.0.1`) e porta real (útil quando `webPort` é 0). */
  host: typeof DESKTOP_GATEWAY_HOST;
  port: number;
  server: http.Server;
  /** Fecha o servidor HTTP e encerra conexões/túneis WebSocket ativos. */
  close: () => Promise<void>;
};

function isBenignSocketError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null | undefined)?.code;
  return typeof code === "string" && BENIGN_SOCKET_CODES.has(code);
}

/** Decide se o caminho deve ser encaminhado para o backend Fastify (`/api` ou `/ws`). */
export function isProxyPath(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/") || pathname === "/ws" || pathname.startsWith("/ws/");
}

function pathnameFromUrl(rawUrl: string | undefined): string {
  const url = rawUrl ?? "/";
  const queryIndex = url.indexOf("?");
  return queryIndex >= 0 ? url.slice(0, queryIndex) : url;
}

function mimeTypeFor(filePath: string): string {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

function cacheControlFor(rootDir: string, filePath: string): string {
  const rel = path.relative(rootDir, filePath).split(path.sep).join("/");
  const base = path.basename(filePath);
  if (base === "index.html" || base === "sw.js") return "no-cache";
  // Assets gerados pelo Vite em `assets/<nome>-<hash>.<ext>` são imutáveis.
  if (rel.startsWith("assets/") && /-[A-Za-z0-9_-]{6,}\.[^.]+$/.test(base)) {
    return "public, max-age=31536000, immutable";
  }
  return "public, max-age=3600";
}

function isContainedIn(rootDir: string, targetPath: string): boolean {
  const rel = path.relative(rootDir, targetPath);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function sanitizeHeaderValue(value: string): string {
  return value.replace(/[\r\n]+/g, " ");
}

function forwardedHeaders(req: IncomingMessage, listenPort: number): Record<string, string> {
  const remoteAddr = req.socket.remoteAddress || DESKTOP_GATEWAY_HOST;
  const prevFor = req.headers["x-forwarded-for"];
  const xForwardedFor = typeof prevFor === "string" && prevFor.trim()
    ? `${prevFor}, ${remoteAddr}`
    : Array.isArray(prevFor) && prevFor.length > 0
      ? `${prevFor.join(", ")}, ${remoteAddr}`
      : remoteAddr;

  const prevHost = req.headers["x-forwarded-host"];
  const hostHeader = Array.isArray(prevHost) ? prevHost[0] : prevHost;
  const xForwardedHost = hostHeader?.trim() || req.headers.host || `${DESKTOP_GATEWAY_HOST}:${listenPort}`;

  const prevProto = req.headers["x-forwarded-proto"];
  const protoHeader = Array.isArray(prevProto) ? prevProto[0] : prevProto;
  const xForwardedProto = protoHeader?.trim() || "http";

  const prevPort = req.headers["x-forwarded-port"];
  const portHeader = Array.isArray(prevPort) ? prevPort[0] : prevPort;
  const xForwardedPort = portHeader?.trim() || String(listenPort);

  return {
    "x-forwarded-for": sanitizeHeaderValue(xForwardedFor),
    "x-forwarded-host": sanitizeHeaderValue(xForwardedHost),
    "x-forwarded-proto": sanitizeHeaderValue(xForwardedProto),
    "x-forwarded-port": sanitizeHeaderValue(xForwardedPort),
  };
}

/** Sonda direta em `127.0.0.1:<apiPort>/api/health`, espelhando `packages/web/vite.config.ts`. */
function probeBackendHealth(apiPort: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.request(
      { host: DESKTOP_GATEWAY_HOST, port: apiPort, path: "/api/health", method: "GET", timeout: timeoutMs },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      },
    );
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(false));
    req.end();
  });
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  if (res.writableEnded) return;
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": String(Buffer.byteLength(payload)),
  });
  res.end(payload);
}

function sendPlain(res: ServerResponse, statusCode: number, text: string): void {
  if (res.writableEnded) return;
  res.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": String(Buffer.byteLength(text)),
  });
  res.end(text);
}

/**
 * Sobe o gateway HTTP+WebSocket do modo desktop em `127.0.0.1:<webPort>`:
 * - serve os arquivos estáticos de `webDir` com MIME, cache e fallback de SPA (`index.html`);
 * - responde `/__backend-health` igual ao `vite.config.ts`;
 * - faz proxy HTTP e WebSocket upgrade de `/api` e `/ws` para `127.0.0.1:<apiPort>`.
 */
export async function startDesktopGateway(options: DesktopGatewayOptions): Promise<DesktopGateway> {
  const rootDir = path.resolve(options.webDir);
  const realRootDir = await realpath(rootDir).catch(() => rootDir);
  const healthTimeoutMs = options.healthTimeoutMs ?? 1500;
  const reportError = (error: unknown) => {
    if (isBenignSocketError(error)) return;
    if (options.onError && error instanceof Error) options.onError(error);
  };

  let listenPort = options.webPort;
  const activeSockets = new Set<net.Socket>();

  const serveFile = async (req: IncomingMessage, res: ServerResponse, filePath: string, forceNoCache = false): Promise<boolean> => {
    let fileStat;
    try {
      fileStat = await stat(filePath);
    } catch {
      return false;
    }
    if (!fileStat.isFile()) return false;

    let realFile: string;
    try {
      realFile = await realpath(filePath);
    } catch {
      return false;
    }
    if (!isContainedIn(realRootDir, realFile)) {
      sendPlain(res, 403, "Forbidden");
      return true;
    }

    const headers: http.OutgoingHttpHeaders = {
      "Content-Type": mimeTypeFor(filePath),
      "Content-Length": String(fileStat.size),
      "Cache-Control": forceNoCache ? "no-cache" : cacheControlFor(rootDir, filePath),
    };
    res.writeHead(200, headers);
    if (req.method === "HEAD") {
      res.end();
      return true;
    }

    const stream = createReadStream(realFile);
    stream.on("error", (error) => {
      reportError(error);
      if (!res.headersSent) sendPlain(res, 500, "Internal Server Error");
      else if (!res.writableEnded) res.destroy();
    });
    res.on("close", () => {
      if (!stream.destroyed) stream.destroy();
    });
    stream.pipe(res);
    return true;
  };

  const handleStatic = async (req: IncomingMessage, res: ServerResponse, rawPath: string): Promise<void> => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      sendPlain(res, 405, "Method Not Allowed");
      return;
    }

    // Bloqueia `..` e `\` tanto antes quanto depois da decodificação URL.
    if (rawPath.includes("\\") || rawPath.split("/").some((segment) => segment === "..")) {
      sendPlain(res, 403, "Forbidden");
      return;
    }

    let decoded: string;
    try {
      decoded = decodeURIComponent(rawPath);
    } catch {
      sendPlain(res, 400, "Bad Request");
      return;
    }

    if (decoded.includes("\0")) {
      sendPlain(res, 400, "Bad Request");
      return;
    }
    if (decoded.includes("\\") || decoded.split("/").some((segment) => segment === "..")) {
      sendPlain(res, 403, "Forbidden");
      return;
    }

    const normalized = decoded.startsWith("/") ? decoded : `/${decoded}`;
    const candidate = path.resolve(rootDir, `.${normalized}`);
    if (!isContainedIn(rootDir, candidate)) {
      sendPlain(res, 403, "Forbidden");
      return;
    }

    // Arquivo direto ou `index.html` dentro de diretório (ex.: `/`).
    let target = candidate;
    try {
      const info = await stat(candidate);
      if (info.isDirectory()) target = path.join(candidate, "index.html");
    } catch {
      // não existe: segue para fallback SPA ou 404
    }

    if (await serveFile(req, res, target)) return;

    // Fallback de SPA para rotas sem extensão (ex.: `/settings`, `/workspace/principal`).
    if (!path.extname(normalized)) {
      const indexFile = path.join(rootDir, "index.html");
      if (await serveFile(req, res, indexFile, true)) return;
    }

    sendPlain(res, 404, "Not Found");
  };

  const handleHttpProxy = (req: IncomingMessage, res: ServerResponse): void => {
    const xfwd = forwardedHeaders(req, listenPort);
    const headers: http.OutgoingHttpHeaders = {
      ...req.headers,
      ...xfwd,
    };

    const proxyReq = http.request(
      {
        host: DESKTOP_GATEWAY_HOST,
        port: options.apiPort,
        method: req.method,
        path: req.url ?? "/",
        headers,
      },
      (proxyRes) => {
        proxyRes.on("error", (error) => {
          reportError(error);
          if (!res.writableEnded) res.destroy();
        });
        if (!res.headersSent) {
          res.writeHead(proxyRes.statusCode ?? 502, proxyRes.statusMessage, proxyRes.headers);
        }
        proxyRes.pipe(res);
      },
    );

    proxyReq.on("error", (error) => {
      reportError(error);
      if (!res.headersSent) {
        sendJson(res, 502, { error: "Backend indisponível" });
      } else if (!res.writableEnded) {
        res.destroy();
      }
    });

    req.on("error", (error) => {
      reportError(error);
      if (!proxyReq.destroyed) proxyReq.destroy();
    });

    res.on("error", (error) => {
      reportError(error);
      if (!proxyReq.destroyed) proxyReq.destroy();
    });

    req.on("aborted", () => {
      if (!proxyReq.destroyed) proxyReq.destroy();
    });

    req.pipe(proxyReq);
  };

  const server = http.createServer((req, res) => {
    res.on("error", reportError);
    const rawPath = pathnameFromUrl(req.url);

    if (rawPath === "/__backend-health" && (req.method === "GET" || req.method === "HEAD")) {
      void probeBackendHealth(options.apiPort, healthTimeoutMs).then((up) => {
        if (res.writableEnded) return;
        const payload = JSON.stringify({ up });
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
          "Content-Length": String(Buffer.byteLength(payload)),
        });
        res.end(req.method === "HEAD" ? undefined : payload);
      });
      return;
    }

    if (isProxyPath(rawPath)) {
      handleHttpProxy(req, res);
      return;
    }

    void handleStatic(req, res, rawPath).catch((error) => {
      reportError(error);
      if (!res.headersSent) sendPlain(res, 500, "Internal Server Error");
      else if (!res.writableEnded) res.destroy();
    });
  });

  server.on("connection", (socket) => {
    activeSockets.add(socket);
    socket.on("close", () => activeSockets.delete(socket));
    socket.on("error", reportError);
  });

  server.on("upgrade", (req, rawClientSocket, head) => {
    const clientSocket = rawClientSocket as net.Socket;
    activeSockets.add(clientSocket);
    clientSocket.on("close", () => activeSockets.delete(clientSocket));

    const rawPath = pathnameFromUrl(req.url);
    if (!isProxyPath(rawPath)) {
      clientSocket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      return;
    }

    const upstreamSocket = net.connect({ host: DESKTOP_GATEWAY_HOST, port: options.apiPort });
    activeSockets.add(upstreamSocket);
    upstreamSocket.on("close", () => activeSockets.delete(upstreamSocket));

    let connected = false;

    const tearDown = () => {
      if (!clientSocket.destroyed) clientSocket.destroy();
      if (!upstreamSocket.destroyed) upstreamSocket.destroy();
    };

    clientSocket.on("error", (error) => {
      reportError(error);
      tearDown();
    });

    upstreamSocket.on("error", (error) => {
      reportError(error);
      if (!connected && !clientSocket.destroyed) {
        clientSocket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
      } else {
        tearDown();
      }
    });

    clientSocket.on("close", () => {
      if (!upstreamSocket.destroyed) upstreamSocket.destroy();
    });

    upstreamSocket.on("close", () => {
      if (!clientSocket.destroyed) clientSocket.destroy();
    });

    upstreamSocket.on("connect", () => {
      connected = true;
      const xfwd = forwardedHeaders(req, listenPort);
      const xfwdNames = new Set(Object.keys(xfwd));
      const lines: string[] = [`${req.method || "GET"} ${req.url || "/"} HTTP/1.1`];

      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const name = req.rawHeaders[i];
        const value = req.rawHeaders[i + 1];
        if (!name || value === undefined) continue;
        if (xfwdNames.has(name.toLowerCase())) continue;
        lines.push(`${sanitizeHeaderValue(name)}: ${sanitizeHeaderValue(value)}`);
      }
      for (const [name, value] of Object.entries(xfwd)) {
        lines.push(`${name}: ${value}`);
      }
      lines.push("", "");

      upstreamSocket.write(lines.join("\r\n"));
      if (head && head.length > 0) upstreamSocket.write(head);

      upstreamSocket.pipe(clientSocket);
      clientSocket.pipe(upstreamSocket);
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(options.webPort, DESKTOP_GATEWAY_HOST);
  });

  const address = server.address();
  listenPort = typeof address === "object" && address ? address.port : options.webPort;

  const close = async (): Promise<void> => {
    for (const socket of activeSockets) {
      socket.destroy();
    }
    activeSockets.clear();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  };

  return { host: DESKTOP_GATEWAY_HOST, port: listenPort, server, close };
}
