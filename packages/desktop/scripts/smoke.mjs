#!/usr/bin/env node
/**
 * Teste de fumaça do pacote autônomo desktop:
 * 1) executa `build-resources.mjs --platform host`;
 * 2) sobe `resources/server/entry.mjs` com o Node do host em portas livres e DATA_DIR temporário;
 * 3) valida `GET /api/health`, `GET /__backend-health`, `GET /` (HTML) e WebSocket `/ws`;
 * 4) encerra o processo de forma limpa e remove a pasta temporária.
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP_DIR = path.resolve(SCRIPT_DIR, "..");
const BUILD_SCRIPT = path.join(SCRIPT_DIR, "build-resources.mjs");
const SERVER_DIR = path.join(DESKTOP_DIR, "src-tauri", "resources", "server");
const ENTRY_FILE = path.join(SERVER_DIR, "entry.mjs");

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

async function waitForHealth(webPort, child, getLogs, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`entry.mjs encerrou cedo (código ${child.exitCode}).\n${getLogs()}`);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${webPort}/api/health`);
      if (res.status === 200) {
        const json = await res.json();
        if (json && json.ok === true) return json;
      }
    } catch {
      // servidor ainda subindo
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timeout (${timeoutMs}ms) aguardando GET /api/health na porta web ${webPort}.\n${getLogs()}`);
}

async function checkWebSocket(webPort, timeoutMs = 5_000) {
  if (typeof globalThis.WebSocket !== "function") {
    throw new Error("Node atual não expõe WebSocket nativo (esperado Node 22+).");
  }
  return new Promise((resolve, reject) => {
    const ws = new globalThis.WebSocket(`ws://127.0.0.1:${webPort}/ws`);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`Timeout (${timeoutMs}ms) aguardando mensagem inicial do WebSocket /ws.`));
    }, timeoutMs);

    ws.addEventListener("message", (event) => {
      clearTimeout(timer);
      const raw = String(event.data);
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        ws.close();
        reject(new Error(`Mensagem inicial do /ws não é JSON válido: ${raw.slice(0, 120)}`));
        return;
      }
      ws.close();
      resolve(parsed);
    });

    ws.addEventListener("error", (event) => {
      clearTimeout(timer);
      reject(new Error(`Erro no WebSocket /ws: ${event.message ?? "falha de conexão"}`));
    });
  });
}

async function stopChildCleanly(child, timeoutMs = 8_000) {
  if (child.exitCode !== null) return child.exitCode;
  const exitPromise = new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  child.kill("SIGTERM");
  const timer = setTimeout(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  }, timeoutMs);
  timer.unref();
  const outcome = await exitPromise;
  clearTimeout(timer);
  return outcome;
}

async function main() {
  console.log("[smoke] 1/5 Gerando recursos com build-resources.mjs --platform host...");
  const build = spawnSync(process.execPath, [BUILD_SCRIPT, "--platform", "host"], { stdio: "inherit" });
  if (build.status !== 0) {
    process.exit(build.status ?? 1);
  }

  const apiPort = await getFreePort();
  const webPort = await getFreePort();
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "cyno-desktop-smoke-"));
  const logs = [];

  console.log(`[smoke] 2/5 Subindo entry.mjs (web=127.0.0.1:${webPort}, api=127.0.0.1:${apiPort})...`);
  const child = spawn(process.execPath, [ENTRY_FILE], {
    cwd: SERVER_DIR,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      PORT: String(apiPort),
      WEB_PORT: String(webPort),
      HOST: "127.0.0.1",
      CYNO_AUTH: "off",
      BROWSER: "0",
      CLAUDE_USAGE_POLL_MS: "0",
      ANTIGRAVITY_USAGE_POLL_MS: "0",
      LOG_LEVEL: "warn",
    },
  });

  child.stdout.on("data", (chunk) => logs.push(`[stdout] ${String(chunk).trimEnd()}`));
  child.stderr.on("data", (chunk) => logs.push(`[stderr] ${String(chunk).trimEnd()}`));
  const getLogs = () => logs.slice(-40).join("\n");

  try {
    const health = await waitForHealth(webPort, child, getLogs);
    console.log(`[smoke] 3/5 /api/health via porta web OK: ${JSON.stringify(health)}`);

    const backendHealthRes = await fetch(`http://127.0.0.1:${webPort}/__backend-health`);
    const backendHealth = await backendHealthRes.json();
    if (backendHealthRes.status !== 200 || backendHealth.up !== true) {
      throw new Error(`/__backend-health inesperado: status=${backendHealthRes.status}, body=${JSON.stringify(backendHealth)}`);
    }

    const indexRes = await fetch(`http://127.0.0.1:${webPort}/`);
    const contentType = indexRes.headers.get("content-type") ?? "";
    const html = await indexRes.text();
    if (indexRes.status !== 200 || !contentType.includes("text/html") || !/<html/i.test(html)) {
      throw new Error(`GET / inválido: status=${indexRes.status}, content-type=${contentType}`);
    }
    console.log(`[smoke] 4/5 GET / devolveu HTML (${html.length} bytes) e /__backend-health = { up: true }`);

    const firstWsMsg = await checkWebSocket(webPort);
    console.log(`[smoke] 5/5 WebSocket /ws conectou e enviou evento inicial: type=${firstWsMsg.type}`);

    const outcome = await stopChildCleanly(child);
    if (outcome.code !== 0) {
      throw new Error(`Encerramento não retornou código 0 (code=${outcome.code}, signal=${outcome.signal}).\n${getLogs()}`);
    }
    console.log("[smoke] Encerramento limpo (exit code 0). Tudo OK!");
  } finally {
    if (child.exitCode === null) {
      await stopChildCleanly(child, 3_000);
    }
    rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`[smoke] Falhou: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
