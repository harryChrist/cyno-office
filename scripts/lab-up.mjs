// `npm run lab:up`: sobe um app de teste ISOLADO (server + web), com DATA_DIR temporário, portas próprias
// e sem senha (CYNO_AUTH=off: um DATA_DIR novo não tem auth.json e o laboratório fica aberto), e roda o `lab:setup` contra ele.
// Nunca toca em data/, nas portas 3001/5173 nem no pm2. Ctrl+C derruba tudo e apaga o DATA_DIR
// (LAB_KEEP=1 mantém a pasta). Variáveis: LAB_SERVER_PORT (3101), LAB_WEB_PORT (5273), LAB_DATA_DIR,
// LAB_BROWSER=1 (liga o navegador dos agentes; o perfil do Chromium nasce novo dentro do DATA_DIR de teste),
// LAB_CONNECTORS_STDIO=1 (libera conectores stdio), ROUTINE_TICK_MS (intervalo do vigia das rotinas, só teste) e
// LAB_HISTORY_DAYS=21 (depois do lab:setup, para o server, semeia N dias de histórico fabricado — `source:"seed"` — e sobe de novo;
// só vale no DATA_DIR temporário `cyno-…` do laboratório: em qualquer outro a semente se recusa e o app sobe sem ela).
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverPort = Number(process.env.LAB_SERVER_PORT ?? 3101);
const webPort = Number(process.env.LAB_WEB_PORT ?? 5273);
if ([serverPort, webPort].some((port) => port === 3001 || port === 5173)) {
  console.error("lab:up: as portas 3001 e 5173 são do app real; escolha outras.");
  process.exit(1);
}
const dataDir = process.env.LAB_DATA_DIR ?? mkdtempSync(path.join(tmpdir(), "cyno-lab-"));
const api = `http://127.0.0.1:${serverPort}`;

/** Acha node_modules/.bin/<nome> subindo as pastas (o worktree pode usar o node_modules do checkout principal). */
function bin(name) {
  for (let dir = root; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, "node_modules", ".bin", name);
    if (existsSync(candidate)) return candidate;
    if (dir === path.dirname(dir)) throw new Error(`${name} não encontrado: rode npm install`);
  }
}

const env = {
  ...process.env,
  PORT: String(serverPort),
  HOST: "127.0.0.1",
  DATA_DIR: dataDir,
  WEB_PORT: String(webPort),
  WEB_HOST: process.env.WEB_HOST ?? "127.0.0.1",
  // O app de teste não consulta cotas, não abre Chromium (salvo LAB_BROWSER=1) nem liga o Remote Control por conta própria.
  CLAUDE_USAGE_POLL_MS: "0",
  ANTIGRAVITY_USAGE_POLL_MS: "0",
  RETENTION_AUTO: "0",
  BROWSER: process.env.LAB_BROWSER === "1" ? "1" : "0",
  CONNECTORS_STDIO: process.env.LAB_CONNECTORS_STDIO === "1" ? "1" : "0",
  MAESTRO_REMOTE_CONTROL: "0",
  // A semente de histórico só aceita este DATA_DIR (veja dev/history-seed.ts).
  CYNO_LAB_DATA_DIR: dataDir,
  SYSTEM_LOG_SAMPLE_MS: "0",
  // Laboratório descartável: sem senha o app fica aberto (sem o código de configuração do log). Só para desenvolvimento/testes.
  CYNO_AUTH: "off",
};
const children = [];
function start(command, args, cwd) {
  const child = spawn(command, args, { cwd, env, stdio: ["ignore", "inherit", "inherit"], detached: true });
  children.push(child);
  return child;
}
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      // já saiu
    }
  }
  setTimeout(() => {
    if (!process.env.LAB_KEEP && !process.env.LAB_DATA_DIR) rmSync(dataDir, { recursive: true, force: true });
    process.exit(code);
  }, 1500);
}
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));

console.log(`lab:up: DATA_DIR ${dataDir}, server ${api}, web http://${env.WEB_HOST}:${webPort}`);
const serverDir = path.join(root, "packages/server");
/** true enquanto o server de teste é parado de propósito (para semear): a queda não derruba o lab:up. */
let serverRestarting = false;
function startServer() {
  const child = start(bin("tsx"), ["src/index.ts"], serverDir);
  child.on("exit", (code) => {
    if (!stopping && !serverRestarting) {
      console.error(`lab:up: o server de teste caiu (código ${code}).`);
      stop(1);
    }
  });
  return child;
}
async function waitForServer() {
  for (let i = 0; i < 60 && !stopping; i++) {
    try {
      if ((await fetch(`${api}/api/health`, { signal: AbortSignal.timeout(1000) })).ok) return true;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  return false;
}
let server = startServer();
const up = await waitForServer();
if (!up) {
  if (!stopping) console.error("lab:up: o server de teste não subiu em 30 s.");
  stop(1);
} else {
  const setup = spawnSync(bin("tsx"), ["src/dev/lab-cli.ts"], { cwd: serverDir, env: { ...env, LAB_API_URL: api }, stdio: "inherit" });
  if (setup.status !== 0) stop(1);
  else {
    const historyDays = process.env.LAB_HISTORY_DAYS;
    if (historyDays) {
      // Os arquivos são escritos direto: o server para, a semente grava e o server sobe de novo.
      serverRestarting = true;
      const exited = new Promise((resolve) => server.once("exit", resolve));
      try {
        process.kill(-server.pid, "SIGTERM");
      } catch {
        // já saiu
      }
      await exited;
      const seeded = spawnSync(bin("tsx"), ["src/dev/history-seed.ts"], { cwd: serverDir, env: { ...env, LAB_HISTORY_DAYS: historyDays }, stdio: "inherit" });
      if (seeded.status !== 0) console.warn("lab:up: a semente de histórico foi ignorada (veja a mensagem acima); o app sobe sem ela.");
      serverRestarting = false;
      server = startServer();
      if (!(await waitForServer())) {
        if (!stopping) console.error("lab:up: o server de teste não subiu de novo depois da semente.");
        stop(1);
      }
    }
    if (!stopping) {
      start(bin("vite"), [], path.join(root, "packages/web"));
      console.log(`\nlab:up no ar (sem senha): web http://${env.WEB_HOST}:${webPort}, api ${api}. Ctrl+C derruba e apaga ${dataDir}.`);
    }
  }
}
