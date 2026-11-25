import { existsSync } from "node:fs";
import { readdir as fsReaddir, realpath as fsRealpath, stat as fsStat } from "node:fs/promises";
import path from "node:path";
import {
  FS_BROWSE_LIMIT,
  FS_BROWSE_PATH,
  fsBrowseQuerySchema,
  type FsBrowseEntry,
  type FsBrowseResponse,
} from "@cyno/shared";
import type { FastifyInstance } from "fastify";
import { HttpError } from "../platform/http/errors";
import { isWindows, samePath, userHomeDir } from "../platform/os";
import { relativePathError } from "../platform/workspaces/folders";

/** Entrada mínima devolvida por `readdir` (compatível com `fs.Dirent` e dublês de teste). */
export type FsBrowseDirEntry = {
  name: string;
  isDirectory: () => boolean;
  isSymbolicLink?: () => boolean;
};

/** Dependências injetáveis para testar Linux e Windows (simulado) no mesmo ambiente. */
export type FsBrowseDeps = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  readdir?: (dir: string) => Promise<readonly FsBrowseDirEntry[]>;
  exists?: (target: string) => boolean;
  realpath?: (target: string) => Promise<string>;
  stat?: (target: string) => Promise<{ isDirectory: () => boolean }>;
  limit?: number;
};

const WINDOWS_DRIVE_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** Mensagens em pt-BR sem vazar detalhes internos do sistema operacional. */
export const FS_BROWSE_ERRORS = {
  missing: "Esta pasta não existe.",
  denied: "Sem permissão para abrir esta pasta.",
  notDirectory: "Este caminho é um arquivo, não uma pasta.",
  unreadable: "Não foi possível abrir esta pasta.",
} as const;

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

function toBrowseHttpError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  const code = errorCode(error);
  if (code === "EACCES" || code === "EPERM") return new HttpError(403, FS_BROWSE_ERRORS.denied);
  if (code === "ENOENT") return new HttpError(404, FS_BROWSE_ERRORS.missing);
  if (code === "ENOTDIR") return new HttpError(400, FS_BROWSE_ERRORS.notDirectory);
  return new HttpError(400, FS_BROWSE_ERRORS.unreadable);
}

function isAbsoluteForPlatform(target: string, platform: NodeJS.Platform): boolean {
  if (isWindows(platform)) return /^[A-Za-z]:[\\/]|^\\\\[^\\]+\\[^\\]+/.test(target);
  return path.posix.isAbsolute(target);
}

function safeExists(exists: (target: string) => boolean, target: string): boolean {
  try {
    return exists(target);
  } catch {
    return false;
  }
}

/** Unidades existentes no Windows (`A:\` a `Z:\`) ou `["/"]` no Linux/macOS. */
export function listRoots(platform: NodeJS.Platform = process.platform, exists: (target: string) => boolean = existsSync): string[] {
  if (!isWindows(platform)) return ["/"];
  const roots: string[] = [];
  for (const letter of WINDOWS_DRIVE_LETTERS) {
    const drive = `${letter}:\\`;
    if (safeExists(exists, drive)) roots.push(drive);
  }
  return roots;
}

/**
 * Navega por uma pasta do servidor devolvendo apenas subpastas (nunca arquivos).
 * - Sem `path`: abre a pasta pessoal do usuário (`home`).
 * - Caminho relativo: 400 em pt-BR.
 * - Links simbólicos só entram após `realpath` confirmar uma pasta legível; entradas ilegíveis são ignoradas.
 */
export async function browseFolders(
  input: { path?: string; hidden?: boolean } = {},
  deps: FsBrowseDeps = {},
): Promise<FsBrowseResponse> {
  const platform = deps.platform ?? process.platform;
  const pathApi = isWindows(platform) ? path.win32 : path.posix;
  const exists = deps.exists ?? existsSync;
  const hasCustomFs = deps.readdir !== undefined || deps.exists !== undefined;
  const readdir = deps.readdir ?? ((dir: string) => fsReaddir(dir, { withFileTypes: true }));
  const realpath = deps.realpath ?? (hasCustomFs ? async (target: string) => pathApi.resolve(target) : fsRealpath);
  const stat =
    deps.stat ??
    (hasCustomFs
      ? async (target: string) => {
          if (!safeExists(exists, target)) {
            const missing = new Error("ENOENT") as NodeJS.ErrnoException;
            missing.code = "ENOENT";
            throw missing;
          }
          return { isDirectory: () => true };
        }
      : fsStat);

  const home = userHomeDir(deps.env, platform);
  const roots = listRoots(platform, exists);
  const rawPath = input.path?.trim();
  const requested = rawPath && rawPath.length > 0 ? rawPath : home;

  if (!isAbsoluteForPlatform(requested, platform)) {
    throw new HttpError(400, relativePathError(platform));
  }

  let resolved: string;
  try {
    resolved = await realpath(requested);
  } catch (error) {
    throw toBrowseHttpError(error);
  }

  let info: { isDirectory: () => boolean };
  try {
    info = await stat(resolved);
  } catch (error) {
    throw toBrowseHttpError(error);
  }
  if (!info.isDirectory()) {
    throw new HttpError(400, FS_BROWSE_ERRORS.notDirectory);
  }

  let rawEntries: readonly FsBrowseDirEntry[];
  try {
    rawEntries = await readdir(resolved);
  } catch (error) {
    throw toBrowseHttpError(error);
  }

  const includeHidden = input.hidden === true;
  const dirs: { name: string; path: string }[] = [];

  for (const entry of rawEntries) {
    if (!entry.name) continue;
    if (!includeHidden && entry.name.startsWith(".")) continue;
    const candidate = pathApi.join(resolved, entry.name);
    try {
      if (entry.isDirectory()) {
        dirs.push({ name: entry.name, path: candidate });
      } else if (entry.isSymbolicLink?.()) {
        // Links simbólicos só entram depois de resolver o destino real e confirmar que é pasta.
        const target = await realpath(candidate);
        const targetInfo = await stat(target);
        if (targetInfo.isDirectory()) {
          dirs.push({ name: entry.name, path: target });
        }
      }
    } catch {
      // Entrada ilegível ou link quebrado: ignora em silêncio.
    }
  }

  dirs.sort((a, b) => {
    const cmp = a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    return cmp !== 0 ? cmp : a.name.localeCompare(b.name);
  });

  const limit = deps.limit ?? FS_BROWSE_LIMIT;
  const truncated = dirs.length > limit;
  const visible = truncated ? dirs.slice(0, limit) : dirs;
  const entries: FsBrowseEntry[] = visible.map((dir) => ({
    name: dir.name,
    path: dir.path,
    isGitRepo: safeExists(exists, pathApi.join(dir.path, ".git")),
  }));

  const root = pathApi.parse(resolved).root;
  const up = samePath(resolved, root, platform) ? null : pathApi.dirname(resolved);
  const parent = up && !samePath(up, resolved, platform) ? up : null;

  return {
    path: resolved,
    parent,
    entries,
    roots,
    home,
    truncated,
  };
}

/** Rota global `GET /api/fs/browse` (atrás da autenticação global de `/api`). */
export function registerFsBrowseRoutes(app: FastifyInstance, deps: FsBrowseDeps = {}): void {
  app.get(FS_BROWSE_PATH, async (request): Promise<FsBrowseResponse> => {
    const query = fsBrowseQuerySchema.parse(request.query ?? {});
    return browseFolders({ path: query.path, hidden: query.hidden === "1" }, deps);
  });
}
