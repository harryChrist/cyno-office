import { fstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startDesktopGateway, type DesktopGateway } from "./desktop-gateway";
import { startServer, type RunningServer } from "./start";

export const DEFAULT_DESKTOP_WEB_PORT = 3067;

/**
 * Define padrões exclusivos do pacote desktop autônomo antes de carregar a configuração:
 * - desliga verificação/aplicação de atualização via git (quem atualiza é o updater do Tauri);
 * - garante `HOST=127.0.0.1`.
 */
export function applyDesktopDefaults(env: NodeJS.ProcessEnv = process.env): void {
  if (!env.CYNO_UPDATE_APPLY) env.CYNO_UPDATE_APPLY = "off";
  if (!env.CYNO_UPDATE_CHECK) env.CYNO_UPDATE_CHECK = "off";
  if (!env.HOST) env.HOST = "127.0.0.1";
}

/** Resolve a pasta estática da web (`CYNO_WEB_DIR` ou `../web` relativo ao `entry.mjs`). */
export function resolveDesktopWebDir(env: NodeJS.ProcessEnv = process.env, entryUrl: string = import.meta.url): string {
  const override = env.CYNO_WEB_DIR?.trim();
  if (override) return path.resolve(override);
  const entryDir = path.dirname(fileURLToPath(entryUrl));
  return path.resolve(entryDir, "..", "web");
}

/** Lê `WEB_PORT` do ambiente com validação segura (padrão 3067). */
export function resolveDesktopWebPort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.WEB_PORT?.trim();
  if (!raw) return DEFAULT_DESKTOP_WEB_PORT;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`WEB_PORT inválido: "${raw}" (use um inteiro entre 1 e 65535)`);
  }
  return parsed;
}

function hasPipedStdin(): boolean {
  if (process.stdin.isTTY) return false;
  try {
    const info = fstatSync(0);
    return info.isFIFO() || info.isSocket();
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  applyDesktopDefaults(process.env);
  const webPort = resolveDesktopWebPort(process.env);
  const webDir = resolveDesktopWebDir(process.env, import.meta.url);

  let running: RunningServer;
  try {
    running = await startServer({ loadEnvFile: false });
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }

  let gateway: DesktopGateway;
  try {
    gateway = await startDesktopGateway({
      webPort,
      apiPort: running.config.port,
      webDir,
      onError: (error) => running.app.log.warn({ err: error }, "erro no gateway web desktop"),
    });
  } catch (error) {
    running.app.log.error({ err: error, webPort, webDir }, "não foi possível iniciar o gateway web desktop");
    await running.close("GATEWAY_START_FAILED");
    process.exit(1);
  }

  running.app.log.info({ host: gateway.host, webPort: gateway.port, apiPort: running.config.port, webDir }, "gateway web desktop em escuta");

  let closing = false;
  const shutdown = async (reason: string): Promise<void> => {
    if (closing) return;
    closing = true;
    try {
      await Promise.race([gateway.close(), new Promise((resolve) => setTimeout(resolve, 2000).unref())]);
    } catch {
      // ignora erro no encerramento do gateway para garantir fechamento limpo do backend
    }
    await running.close(reason);
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  // Quando o processo pai (casca Tauri) encerra ou trava no Windows, o pipe de stdin fecha:
  // sair imediatamente evita deixar o servidor Node órfão em segundo plano.
  if (hasPipedStdin()) {
    process.stdin.resume();
    process.stdin.on("end", () => void shutdown("STDIN_EOF"));
    process.stdin.on("close", () => void shutdown("STDIN_CLOSE"));
    process.stdin.on("error", () => undefined);
  }
}

function sameFilePath(a: string, b: string): boolean {
  const resolveReal = (target: string) => {
    try {
      return realpathSync(target);
    } catch {
      return path.resolve(target);
    }
  };
  const left = resolveReal(a);
  const right = resolveReal(b);
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

// Evita autoexecução caso funções auxiliares sejam importadas em testes.
const isDirectExecution = Boolean(process.argv[1]) && sameFilePath(process.argv[1]!, fileURLToPath(import.meta.url));
if (isDirectExecution) {
  await main();
}
