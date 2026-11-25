import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fsBrowsePath, type FsBrowseResponse } from "@cyno/shared";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../app";
import { useTempDirs } from "../dev/test-utils";
import { installErrorHandlers } from "../platform/http/errors";
import { relativePathError } from "../platform/workspaces/folders";
import { seedDataDir } from "../workspace/office/seed";
import {
  browseFolders,
  FS_BROWSE_ERRORS,
  listRoots,
  registerFsBrowseRoutes,
  type FsBrowseDeps,
  type FsBrowseDirEntry,
} from "./fs-browse";

const tempDir = useTempDirs();
const closers: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

async function setupRoute(deps: FsBrowseDeps = {}) {
  const app: FastifyInstance = Fastify();
  installErrorHandlers(app);
  registerFsBrowseRoutes(app, deps);
  closers.push(() => app.close());
  return app;
}

function fakeEntry(name: string, kind: "dir" | "file" | "symlink"): FsBrowseDirEntry {
  return {
    name,
    isDirectory: () => kind === "dir",
    isSymbolicLink: () => kind === "symlink",
  };
}

describe("navegação de pastas do servidor (Linux real)", () => {
  it("lista apenas pastas em ordem alfabética sem diferenciar maiúsculas, marca git e esconde ocultas por padrão", async () => {
    const base = await tempDir();
    await mkdir(path.join(base, "zebra"));
    await mkdir(path.join(base, "Beta"));
    await mkdir(path.join(base, "alpha"));
    await mkdir(path.join(base, "alpha", ".git"));
    await mkdir(path.join(base, ".oculta"));
    await writeFile(path.join(base, "leia-me.txt"), "oi");

    const app = await setupRoute({ env: { HOME: base } });
    const res = await app.inject({ method: "GET", url: fsBrowsePath() });
    expect(res.statusCode).toBe(200);
    const body = res.json<FsBrowseResponse>();
    expect(body.path).toBe(base);
    expect(body.home).toBe(base);
    expect(body.parent).toBe(path.dirname(base));
    expect(body.roots).toEqual(["/"]);
    expect(body.truncated).toBe(false);
    expect(body.entries).toEqual([
      { name: "alpha", path: path.join(base, "alpha"), isGitRepo: true },
      { name: "Beta", path: path.join(base, "Beta"), isGitRepo: false },
      { name: "zebra", path: path.join(base, "zebra"), isGitRepo: false },
    ]);

    const withHidden = (await app.inject({ method: "GET", url: fsBrowsePath(base, true) })).json<FsBrowseResponse>();
    expect(withHidden.entries.map((entry) => entry.name)).toEqual([".oculta", "alpha", "Beta", "zebra"]);
  });

  it("respeita limite de entradas (truncated) e trata links simbólicos com realpath ignorando links quebrados ou de arquivo", async () => {
    const base = await tempDir();
    const destino = await tempDir();
    await mkdir(path.join(base, "d1"));
    await mkdir(path.join(base, "d2"));
    await mkdir(path.join(base, "d3"));
    await mkdir(path.join(base, "d4"));
    await writeFile(path.join(base, "arq.txt"), "x");
    await symlink(destino, path.join(base, "a-link-pasta"));
    await symlink(path.join(base, "arq.txt"), path.join(base, "a-link-arquivo"));
    await symlink(path.join(base, "nao-existe"), path.join(base, "a-link-quebrado"));

    const limited = await browseFolders({ path: base }, { limit: 3 });
    expect(limited.truncated).toBe(true);
    expect(limited.entries).toHaveLength(3);
    expect(limited.entries[0]).toEqual({ name: "a-link-pasta", path: destino, isGitRepo: false });
    expect(limited.entries.map((entry) => entry.name)).toEqual(["a-link-pasta", "d1", "d2"]);
  });

  it("na raiz do Linux devolve parent null", async () => {
    const result = await browseFolders({ path: "/" }, { limit: 5 });
    expect(result.path).toBe("/");
    expect(result.parent).toBeNull();
    expect(result.roots).toEqual(["/"]);
  });

  it("devolve erros claros em pt-BR sem detalhes internos: relativo (400), inexistente (404), arquivo (400) e sem permissão (403)", async () => {
    const base = await tempDir();
    const file = path.join(base, "notas.txt");
    await writeFile(file, "texto");

    const app = await setupRoute({ env: { HOME: base } });

    const rel = await app.inject({ method: "GET", url: fsBrowsePath("relativo/pasta") });
    expect(rel.statusCode).toBe(400);
    expect(rel.json()).toEqual({ error: relativePathError("linux") });

    const til = await app.inject({ method: "GET", url: fsBrowsePath("~/projetos") });
    expect(til.statusCode).toBe(400);

    const missing = await app.inject({ method: "GET", url: fsBrowsePath(path.join(base, "nao-existe")) });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: FS_BROWSE_ERRORS.missing });

    const notDir = await app.inject({ method: "GET", url: fsBrowsePath(file) });
    expect(notDir.statusCode).toBe(400);
    expect(notDir.json()).toEqual({ error: FS_BROWSE_ERRORS.notDirectory });

    const deniedApp = await setupRoute({
      platform: "linux",
      env: { HOME: "/home/voce" },
      exists: () => true,
      readdir: async () => {
        const err = new Error("EACCES: /root") as NodeJS.ErrnoException;
        err.code = "EACCES";
        throw err;
      },
    });
    const denied = await deniedApp.inject({ method: "GET", url: fsBrowsePath("/root") });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toEqual({ error: FS_BROWSE_ERRORS.denied });
  });

  it("fica atrás da autenticação global quando o app exige login", async () => {
    const dataDir = await tempDir();
    await seedDataDir(dataDir);
    const app = await buildApp({ dataDir, auth: { open: false, failDelayMs: 0, blocksFile: null } });
    closers.push(() => app.close());

    const res = await app.inject({ method: "GET", url: fsBrowsePath() });
    expect(res.statusCode).toBe(401);
  });
});

describe("navegação de pastas do servidor (Windows simulado no Linux)", () => {
  const drives = new Set(["C:\\", "D:\\", "Z:\\"]);
  const tree: Record<string, FsBrowseDirEntry[]> = {
    "C:\\": [
      fakeEntry("Users", "dir"),
      fakeEntry("Projetos", "dir"),
      fakeEntry("pagefile.sys", "file"),
      fakeEntry(".oculto", "dir"),
    ],
    "C:\\Users\\voce": [
      fakeEntry("z-notas", "dir"),
      fakeEntry("App", "dir"),
      fakeEntry(".config", "dir"),
      fakeEntry("foto.png", "file"),
    ],
    "D:\\": [fakeEntry("Backups", "dir")],
  };
  const existing = new Set([
    ...drives,
    "C:\\Users",
    "C:\\Users\\voce",
    "C:\\Users\\voce\\App",
    "C:\\Users\\voce\\App\\.git",
    "C:\\Users\\voce\\z-notas",
    "C:\\Users\\voce\\.config",
    "C:\\Projetos",
    "D:\\Backups",
  ]);

  const winDeps = (extra: Partial<FsBrowseDeps> = {}): FsBrowseDeps => ({
    platform: "win32",
    env: { USERPROFILE: "C:\\Users\\voce" },
    exists: (target) => existing.has(target),
    readdir: async (dir) => {
      const list = tree[dir];
      if (!list) {
        const err = new Error("ENOENT") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      return list;
    },
    ...extra,
  });

  it("descobre as unidades existentes de A: a Z:", () => {
    expect(listRoots("win32", (target) => drives.has(target))).toEqual(["C:\\", "D:\\", "Z:\\"]);
  });

  it("sem path abre USERPROFILE, lista só pastas ordenadas e marca repositório git", async () => {
    const app = await setupRoute(winDeps());
    const res = await app.inject({ method: "GET", url: fsBrowsePath() });
    expect(res.statusCode).toBe(200);
    const body = res.json<FsBrowseResponse>();
    expect(body).toEqual({
      path: "C:\\Users\\voce",
      parent: "C:\\Users",
      home: "C:\\Users\\voce",
      roots: ["C:\\", "D:\\", "Z:\\"],
      truncated: false,
      entries: [
        { name: "App", path: "C:\\Users\\voce\\App", isGitRepo: true },
        { name: "z-notas", path: "C:\\Users\\voce\\z-notas", isGitRepo: false },
      ],
    });
  });

  it("na raiz da unidade devolve parent null e lista roots para o web voltar às unidades", async () => {
    const body = await browseFolders({ path: "C:\\", hidden: true }, winDeps());
    expect(body.path).toBe("C:\\");
    expect(body.parent).toBeNull();
    expect(body.roots).toEqual(["C:\\", "D:\\", "Z:\\"]);
    expect(body.entries.map((entry) => entry.name)).toEqual([".oculto", "Projetos", "Users"]);
  });

  it("aplica limite e sinaliza truncated no Windows", async () => {
    const body = await browseFolders({ path: "C:\\", hidden: true }, winDeps({ limit: 2 }));
    expect(body.truncated).toBe(true);
    expect(body.entries.map((entry) => entry.name)).toEqual([".oculto", "Projetos"]);
  });

  it("recusa caminhos relativos no Windows com exemplo de letra de unidade e trata erros", async () => {
    const app = await setupRoute(winDeps());
    for (const bad of ["projetos", "C:projetos", "/sem-unidade"]) {
      const res = await app.inject({ method: "GET", url: fsBrowsePath(bad) });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: "Use o caminho completo da pasta (ex.: C:\\Users\\voce\\projeto)." });
    }

    const missing = await app.inject({ method: "GET", url: fsBrowsePath("C:\\NaoExiste") });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: FS_BROWSE_ERRORS.missing });

    const fileApp = await setupRoute(
      winDeps({
        stat: async () => ({ isDirectory: () => false }),
      }),
    );
    const notDir = await fileApp.inject({ method: "GET", url: fsBrowsePath("C:\\Users\\voce") });
    expect(notDir.statusCode).toBe(400);
    expect(notDir.json()).toEqual({ error: FS_BROWSE_ERRORS.notDirectory });
  });
});
