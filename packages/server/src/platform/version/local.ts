import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { formatVersionLabel, type VersionCommit, type VersionInfo } from "@cyno/shared";
import { runGit } from "./git";
import { parseOrigin, type ParsedOrigin } from "./origin";

/** Arquivo gerado no build quando não há `.git` (imagem Docker): veja `scripts/write-version.mjs`. */
export const VERSION_FILE = "version.json";

export type LocalVersion = {
  info: VersionInfo;
  /** `origin` conhecido (do git ou do arquivo de versão). */
  origin: ParsedOrigin | null;
  /** Pasta com `.git` onde dá para rodar git; null sem repositório. */
  gitCwd: string | null;
};

/** Sobe a partir de `startDir` até a pasta do package.json com `workspaces` (a raiz do monorepo); sem achar, devolve `startDir`. */
export function locateRoot(startDir: string): string {
  for (let dir = path.resolve(startDir); ; dir = path.dirname(dir)) {
    try {
      const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as { workspaces?: unknown };
      if (pkg.workspaces) return dir;
    } catch {
      // sem package.json aqui
    }
    if (dir === path.dirname(dir)) return path.resolve(startDir);
  }
}

function readPackageVersion(rootDir: string): string {
  try {
    const pkg = JSON.parse(readFileSync(path.join(rootDir, "package.json"), "utf8")) as { version?: unknown };
    if (typeof pkg.version === "string" && pkg.version) return pkg.version;
  } catch {
    // sem package.json legível
  }
  return "0.0.0";
}

type Raw = { commit: VersionCommit; branch: string | null; build: number | null; dirty: boolean; origin: string | null };

const shortOf = (hash: string) => hash.slice(0, 7);

async function readFromGit(rootDir: string): Promise<Raw | null> {
  const cwd = rootDir;
  const [show, count, branch, status, origin] = await Promise.all([
    runGit(["log", "-1", "--format=%H%x1f%cI%x1f%s", "HEAD"], { cwd }),
    runGit(["rev-list", "--count", "HEAD"], { cwd }),
    runGit(["symbolic-ref", "--short", "-q", "HEAD"], { cwd }),
    runGit(["status", "--porcelain", "--untracked-files=no"], { cwd, timeoutMs: 10_000 }),
    runGit(["config", "--get", "remote.origin.url"], { cwd }),
  ]);
  if (!show.ok) return null;
  const [hash = "", date = "", ...subject] = show.stdout.trim().split("\x1f");
  if (!/^[0-9a-f]{40,64}$/.test(hash)) return null;
  const build = count.ok ? Number.parseInt(count.stdout.trim(), 10) : Number.NaN;
  return {
    commit: { hash, short: shortOf(hash), date, subject: subject.join("\x1f").trim() },
    branch: branch.ok && branch.stdout.trim() ? branch.stdout.trim() : null,
    build: Number.isFinite(build) ? build : null,
    dirty: status.ok && status.stdout.trim() !== "",
    origin: origin.ok && origin.stdout.trim() ? origin.stdout.trim() : null,
  };
}

function readFromFile(rootDir: string): Raw | null {
  try {
    const data = JSON.parse(readFileSync(path.join(rootDir, VERSION_FILE), "utf8")) as Record<string, unknown>;
    const hash = data.commit;
    if (typeof hash !== "string" || !/^[0-9a-f]{40,64}$/.test(hash)) return null;
    const str = (value: unknown) => (typeof value === "string" ? value : "");
    return {
      commit: { hash, short: shortOf(hash), date: str(data.date), subject: str(data.subject) },
      branch: str(data.branch) || null,
      build: typeof data.count === "number" && Number.isInteger(data.count) && data.count >= 0 ? data.count : null,
      dirty: data.dirty === true,
      origin: str(data.origin) || null,
    };
  } catch {
    return null;
  }
}

/** Descobre a versão SEM rede: git local, se houver `.git`; senão o arquivo gerado no build; senão só o package.json. */
export async function readLocalVersion(rootDir: string): Promise<LocalVersion> {
  const version = readPackageVersion(rootDir);
  const hasGit = existsSync(path.join(rootDir, ".git"));
  const fromGit = hasGit ? await readFromGit(rootDir) : null;
  const fromFile = fromGit ? null : readFromFile(rootDir);
  const raw = fromGit ?? fromFile;
  const source = fromGit ? "git" : fromFile ? "file" : "package";
  const origin = parseOrigin(raw?.origin);
  const base = { version, build: raw?.build ?? null, commit: raw?.commit ?? null, branch: raw?.branch ?? null, dirty: raw?.dirty ?? false };
  return {
    info: { ...base, source, repoUrl: origin?.github?.webUrl ?? null, label: formatVersionLabel(base) },
    origin,
    gitCwd: source === "git" ? rootDir : null,
  };
}
