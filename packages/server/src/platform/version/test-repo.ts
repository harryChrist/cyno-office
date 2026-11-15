import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** Repositórios git temporários para os testes (nunca o repositório real). */
export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=Teste", "-c", "user.email=teste@example.invalid", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
  }).trim();
}

export function tempDir(prefix = "cyno-version-"): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

export function commit(repo: string, file: string, subject: string): string {
  writeFileSync(path.join(repo, file), `${subject}\n`);
  git(repo, "add", file);
  git(repo, "commit", "-m", subject);
  return git(repo, "rev-parse", "HEAD");
}

export type Fixture = { base: string; origin: string; clone: string; cleanup: () => void };

/** Um "origin" bare e um clone com `main`, package.json de monorepo e 2 commits. */
export function makeFixture(options: { version?: string } = {}): Fixture {
  const base = tempDir();
  const origin = path.join(base, "origin.git");
  const clone = path.join(base, "clone");
  mkdirSync(origin);
  git(origin, "init", "--bare", "-b", "main");
  git(base, "clone", origin, clone);
  writeFileSync(path.join(clone, "package.json"), JSON.stringify({ name: "x", version: options.version ?? "1.2.3", workspaces: ["packages/*"] }));
  git(clone, "add", "package.json");
  git(clone, "commit", "-m", "primeiro");
  commit(clone, "a.txt", "segundo");
  git(clone, "push", "-u", "origin", "main");
  return { base, origin, clone, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

/** Empurra N commits novos para o origin por um segundo clone (o primeiro fica atrás, sem os objetos). */
export function pushFromOther(fixture: Fixture, subjects: string[], extraFiles: Record<string, string> = {}): string {
  const other = path.join(fixture.base, "other");
  git(fixture.base, "clone", fixture.origin, other);
  let last = "";
  for (const [index, subject] of subjects.entries()) last = commit(other, `n${index}.txt`, subject);
  for (const [file, content] of Object.entries(extraFiles)) {
    writeFileSync(path.join(other, file), content);
    git(other, "add", file);
    last = (git(other, "commit", "-m", `muda ${file}`), git(other, "rev-parse", "HEAD"));
  }
  git(other, "push", "origin", "main");
  return last;
}
