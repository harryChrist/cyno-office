import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { locateRoot, readLocalVersion } from "./local";
import { git, makeFixture, tempDir, type Fixture } from "./test-repo";
import { rmSync } from "node:fs";

let fixture: Fixture | undefined;
afterEach(() => {
  fixture?.cleanup();
  fixture = undefined;
});

describe("readLocalVersion", () => {
  it("versão, build, hash, ramo e origin do repositório", async () => {
    fixture = makeFixture();
    const local = await readLocalVersion(fixture.clone);
    const head = git(fixture.clone, "rev-parse", "HEAD");
    expect(local.info.version).toBe("1.2.3");
    expect(local.info.build).toBe(2);
    expect(local.info.commit).toMatchObject({ hash: head, short: head.slice(0, 7), subject: "segundo" });
    expect(local.info.commit?.date).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(local.info.branch).toBe("main");
    expect(local.info.dirty).toBe(false);
    expect(local.info.source).toBe("git");
    expect(local.info.label).toBe(`v1.2.3 · build 2 · ${head.slice(0, 7)}`);
    expect(local.gitCwd).toBe(fixture.clone);
    expect(local.origin?.clean).toBe(fixture.origin);
    expect(local.info.repoUrl).toBeNull();
  });

  it("mudança local em arquivo versionado marca modificado; arquivo novo solto não", async () => {
    fixture = makeFixture();
    writeFileSync(path.join(fixture.clone, "novo.txt"), "x");
    expect((await readLocalVersion(fixture.clone)).info.dirty).toBe(false);
    writeFileSync(path.join(fixture.clone, "a.txt"), "mudou\n");
    const local = await readLocalVersion(fixture.clone);
    expect(local.info.dirty).toBe(true);
    expect(local.info.label).toMatch(/ · modificado$/);
  });

  it("HEAD solto (detached) fica sem ramo", async () => {
    fixture = makeFixture();
    git(fixture.clone, "checkout", "--detach", "HEAD~1");
    const local = await readLocalVersion(fixture.clone);
    expect(local.info.branch).toBeNull();
    expect(local.info.build).toBe(1);
  });

  it("sem .git e sem arquivo de versão: só o package.json", async () => {
    const dir = tempDir();
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ version: "0.4.0" }));
    const local = await readLocalVersion(dir);
    expect(local.info).toMatchObject({ version: "0.4.0", build: null, commit: null, source: "package", label: "v0.4.0" });
    expect(local.gitCwd).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  it("sem .git, usa o version.json gerado no build (Docker)", async () => {
    const dir = tempDir();
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ version: "0.4.0" }));
    const hash = "a".repeat(40);
    writeFileSync(
      path.join(dir, "version.json"),
      JSON.stringify({ commit: hash, date: "2026-01-02T03:04:05Z", subject: "algo", branch: "main", count: 7, dirty: false, origin: "https://github.com/dono/repo.git" }),
    );
    const local = await readLocalVersion(dir);
    expect(local.info).toMatchObject({ source: "file", build: 7, branch: "main", repoUrl: "https://github.com/dono/repo", label: "v0.4.0 · build 7 · aaaaaaa" });
    expect(local.gitCwd).toBeNull();
    expect(local.origin?.github?.repo).toBe("repo");
    rmSync(dir, { recursive: true, force: true });
  });

  it("version.json quebrado é ignorado", async () => {
    const dir = tempDir();
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ version: "0.4.0" }));
    writeFileSync(path.join(dir, "version.json"), "{ não é json");
    expect((await readLocalVersion(dir)).info.source).toBe("package");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("locateRoot", () => {
  it("sobe até o package.json com workspaces", () => {
    const dir = tempDir();
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ workspaces: ["packages/*"] }));
    mkdirSync(path.join(dir, "packages/server/src"), { recursive: true });
    writeFileSync(path.join(dir, "packages/server/package.json"), JSON.stringify({ name: "s" }));
    expect(locateRoot(path.join(dir, "packages/server/src"))).toBe(dir);
    rmSync(dir, { recursive: true, force: true });
  });
});
