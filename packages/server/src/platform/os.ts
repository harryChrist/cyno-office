import { execFile as nodeExecFile } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Camada pequena de portabilidade Linux/Windows do servidor.
 * Toda função aceita `platform` opcional (padrão `process.platform`) para ser testada no Linux
 * simulando `win32` e `linux`, sem mudar o comportamento atual no Linux.
 */

export const DEFAULT_WINDOWS_PATHEXT = [".exe", ".cmd", ".bat", ".com"] as const;

export function isWindows(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "win32";
}

/** Separador do PATH (`;` no Windows, `:` no Linux/macOS). */
export function pathDelimiter(platform: NodeJS.Platform = process.platform): ";" | ":" {
  return isWindows(platform) ? ";" : ":";
}

/** Chave do PATH no ambiente (no Windows costuma ser `Path` ou `PATH`; no Linux é sempre `PATH`). */
export function pathKey(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (!isWindows(platform)) return "PATH";
  return Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
}

/** Lê o valor do PATH respeitando a capitalização no Windows. */
export function readPathEnv(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  return env[pathKey(env, platform)] ?? "";
}

/**
 * Pasta pessoal do usuário a partir do ambiente: no Windows prefere `USERPROFILE` (com fallback para
 * `HOME` e `os.homedir()`); no Linux prefere `HOME` (com fallback para `os.homedir()`).
 */
export function userHomeDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  const fromEnv = isWindows(platform) ? (env.USERPROFILE?.trim() || env.HOME?.trim()) : env.HOME?.trim();
  return fromEnv || os.homedir();
}

/**
 * Variáveis de isolamento de pasta pessoal para uma pasta `dir`:
 * - Linux: `{ HOME: dir }`
 * - Windows: `{ USERPROFILE: dir, HOME: dir, APPDATA: <dir>/AppData/Roaming, LOCALAPPDATA: <dir>/AppData/Local }`
 */
export function homeEnvFor(dir: string, platform: NodeJS.Platform = process.platform): Record<string, string> {
  if (!isWindows(platform)) return { HOME: dir };
  return {
    USERPROFILE: dir,
    HOME: dir,
    APPDATA: path.join(dir, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(dir, "AppData", "Local"),
  };
}

export type ShellSpec = {
  command: string;
  args: string[];
};

/**
 * Shell padrão do sistema:
 * - Linux: `/bin/bash` (ou `bash`) com `["-c"]` no modo `"command"` e `[]` no modo `"file"`;
 * - Windows: `powershell.exe` com `["-NoLogo", "-NoProfile", "-Command"]` ou `["-NoLogo", "-NoProfile", "-File"]`.
 */
export function defaultShell(
  mode: "command" | "file" = "command",
  platform: NodeJS.Platform = process.platform,
  exists: (file: string) => boolean = existsSync,
): ShellSpec {
  if (isWindows(platform)) {
    return {
      command: "powershell.exe",
      args: ["-NoLogo", "-NoProfile", mode === "file" ? "-File" : "-Command"],
    };
  }
  const command = exists("/bin/bash") ? "/bin/bash" : "bash";
  return { command, args: mode === "file" ? [] : ["-c"] };
}

/**
 * Opções de `spawn` para processos que precisam ser encerrados como árvore:
 * - Linux: `detached: true` cria grupo próprio para `process.kill(-pid, signal)`.
 * - Windows: `detached: true` abre janela/grupo diferente; usa `detached: false` + `windowsHide: true`
 *   e encerra a árvore inteira via `taskkill /pid <pid> /T /F`.
 */
export function detachedSpawnOptions(platform: NodeJS.Platform = process.platform): { detached: boolean; windowsHide?: boolean } {
  return isWindows(platform) ? { detached: false, windowsHide: true } : { detached: true };
}

export type KillProcessTreeOptions = {
  platform?: NodeJS.Platform;
  kill?: typeof process.kill;
  execFile?: typeof nodeExecFile;
};

/**
 * Encerra a árvore de processos liderada por `pid`:
 * - Linux: `process.kill(-pid, signal)` (com fallback para `process.kill(pid, signal)`).
 * - Windows: `taskkill /pid <pid> /T /F` via `execFile` (sem shell e sem abrir janela).
 */
export function killProcessTree(pid: number, signal: NodeJS.Signals = "SIGTERM", options: KillProcessTreeOptions = {}): void {
  if (!Number.isInteger(pid) || pid <= 1) return;
  const platform = options.platform ?? process.platform;
  if (isWindows(platform)) {
    const runExecFile = options.execFile ?? nodeExecFile;
    try {
      runExecFile("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }, () => {
        // processo já pode ter saído
      });
    } catch {
      // ignora erro síncrono se taskkill não estiver disponível
    }
    return;
  }
  const runKill = options.kill ?? process.kill;
  try {
    runKill(-pid, signal);
  } catch {
    try {
      runKill(pid, signal);
    } catch {
      // já saiu
    }
  }
}

export type IsProcessAliveOptions = {
  platform?: NodeJS.Platform;
  kill?: typeof process.kill;
  /** No Linux, checa o grupo de processos (`-pid`) em vez do processo único; no Windows sempre usa `pid`. */
  group?: boolean;
};

/** Confere se o processo (ou grupo no Linux) ainda existe. Nunca lança. */
export function isProcessAlive(pid: number | undefined, options: IsProcessAliveOptions = {}): boolean {
  if (!pid || !Number.isInteger(pid) || pid <= 1) return false;
  const platform = options.platform ?? process.platform;
  const runKill = options.kill ?? process.kill;
  const target = !isWindows(platform) && options.group ? -pid : pid;
  try {
    runKill(target, 0);
    return true;
  } catch (error) {
    // EPERM: o processo existe, só não é nosso.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Extensões executáveis no Windows (de `PATHEXT`, em minúsculas e com ponto). No Linux devolve `[]`. */
export function pathExtensions(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string[] {
  if (!isWindows(platform)) return [];
  const rawKey = Object.keys(env).find((key) => key.toLowerCase() === "pathext");
  const raw = rawKey ? env[rawKey] : undefined;
  if (!raw?.trim()) return [...DEFAULT_WINDOWS_PATHEXT];
  const parsed = raw
    .split(";")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
    .map((item) => (item.startsWith(".") ? item : `.${item}`));
  return parsed.length > 0 ? [...new Set(parsed)] : [...DEFAULT_WINDOWS_PATHEXT];
}

/**
 * Nomes candidatos de um executável ao procurar no PATH ou em caminhos privados:
 * - Linux: `[command]`.
 * - Windows: se já termina com uma extensão de `PATHEXT`, `[command]`; senão tenta primeiro as
 *   extensões (`command.exe`, `command.cmd`, `command.bat`…) para não cair no shim POSIX sem extensão
 *   do npm, e por último `[command]`.
 */
export function executableCandidates(command: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string[] {
  if (!isWindows(platform)) return [command];
  const exts = pathExtensions(env, platform);
  const lower = command.toLowerCase();
  if (exts.some((ext) => lower.endsWith(ext))) return [command];
  return [...exts.map((ext) => `${command}${ext}`), command];
}

/** Tipo do symlink de diretório: no Windows usa `"junction"` (não exige privilégio de administrador). */
export function dirSymlinkType(platform: NodeJS.Platform = process.platform): "junction" | undefined {
  return isWindows(platform) ? "junction" : undefined;
}

function pathApiFor(platform: NodeJS.Platform): typeof path.posix | typeof path.win32 {
  return isWindows(platform) ? path.win32 : path.posix;
}

function normalizeForCompare(target: string, platform: NodeJS.Platform): string {
  const api = pathApiFor(platform);
  const resolved = api.resolve(target);
  return isWindows(platform) ? resolved.toLowerCase() : resolved;
}

/** Os dois caminhos apontam para o mesmo lugar? (no Windows, ignora maiúsculas/minúsculas). */
export function samePath(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  return normalizeForCompare(a, platform) === normalizeForCompare(b, platform);
}

/**
 * `target` está dentro de `root` (ou é igual a `root`, salvo quando `strict: true`)?
 * Usa `path.relative` e normaliza maiúsculas/minúsculas no Windows, rejeitando `..` e unidades diferentes.
 */
export function isPathInside(target: string, root: string, options: { strict?: boolean; platform?: NodeJS.Platform } = {}): boolean {
  const platform = options.platform ?? process.platform;
  const api = pathApiFor(platform);
  const normRoot = normalizeForCompare(root, platform);
  const normTarget = normalizeForCompare(target, platform);
  const relative = api.relative(normRoot, normTarget);
  if (relative === "") return !options.strict;
  return relative !== ".." && !relative.startsWith(`..${api.sep}`) && !api.isAbsolute(relative);
}
