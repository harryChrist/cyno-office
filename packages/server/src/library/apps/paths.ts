import path from "node:path";
import { platformPaths } from "../../store/paths";

/** Onde os apps moram: `data/platform/apps/<id>/` (código e ambientes) e `data/platform/runtimes/` (compartilhados). */
export type AppsPaths = {
  appsRoot: string;
  runtimesRoot: string;
  libraryDir: string;
  appsFile: string;
  jobsDir: string;
  appDir: (appId: string) => string;
  runtimeDir: (runtimeId: string) => string;
};

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function appsPaths(dataDir: string): AppsPaths {
  const root = platformPaths(dataDir).root;
  const libraryDir = path.join(root, "library");
  const appsRoot = path.join(root, "apps");
  const runtimesRoot = path.join(root, "runtimes");
  return {
    appsRoot,
    runtimesRoot,
    libraryDir,
    appsFile: path.join(libraryDir, "apps.json"),
    jobsDir: path.join(libraryDir, "jobs"),
    appDir: (appId) => {
      if (!SLUG.test(appId)) throw new Error(`id de app inválido: "${appId}"`);
      return path.join(appsRoot, appId);
    },
    runtimeDir: (runtimeId) => {
      if (!SLUG.test(runtimeId)) throw new Error(`id de runtime inválido: "${runtimeId}"`);
      return path.join(runtimesRoot, runtimeId);
    },
  };
}

/** Resolve `relative` dentro de `root`; recusa caminho absoluto, `..` e qualquer coisa que escape da pasta. */
export function resolveInside(root: string, relative: string): string {
  if (!relative || relative.includes("\0") || path.isAbsolute(relative)) throw new Error(`caminho fora da pasta permitida: "${relative}"`);
  const base = path.resolve(root);
  const full = path.resolve(base, relative);
  if (full !== base && !full.startsWith(base + path.sep)) throw new Error(`caminho fora da pasta permitida: "${relative}"`);
  return full;
}

/** `target` está dentro de uma das pastas (ou é uma delas)? */
export function isInside(target: string, roots: readonly string[]): boolean {
  const full = path.resolve(target);
  return roots.some((root) => {
    const base = path.resolve(root);
    return full === base || full.startsWith(base + path.sep);
  });
}
