import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { useTempDirs } from "../../dev/test-utils";
import { WriteQueue } from "../../store/write-queue";
import { SkillLibrary } from "./skill-library";
import { librarySkillPaths } from "./store";

const tempDir = useTempDirs();
const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };
const md = (body = "Corpo.\n") => `---\nname: Skill Grande\ndescription: Use quando precisar de uma skill bem grande.\n---\n${body}`;
const small = { maxBytes: 600 * 1024, maxFiles: 40, maxPathLength: 240, maxDepth: 12 };

/** Uma pasta de ~450 KB em 29 arquivos, como a `ui-ux-pro-max`. */
async function bigSkill(dir: string, skillBody?: string) {
  await mkdir(path.join(dir, "data"), { recursive: true });
  await writeFile(path.join(dir, "SKILL.md"), md(skillBody));
  for (let i = 0; i < 28; i++) await writeFile(path.join(dir, "data", `f${i}.csv`), "x".repeat(16 * 1024));
}

async function open(home: string, ceiling?: typeof small) {
  const root = await tempDir();
  return SkillLibrary.open({
    paths: librarySkillPaths(path.join(root, "library")),
    queue: new WriteQueue(),
    workspaceExists: () => true,
    agentExists: () => true,
    workspaceName: (ws) => ws,
    agentName: (_ws, agent) => agent,
    onChange: () => undefined,
    local: { homeDir: home, ...(ceiling ? { ceiling } : {}) },
    log: silent,
    now: () => new Date(Date.UTC(2026, 10, 12)),
  });
}

describe("skills grandes", () => {
  it("importação do computador: 450 KB em 29 arquivos é candidata sem problema e importa", async () => {
    const home = await tempDir();
    await bigSkill(path.join(home, ".claude", "skills", "ui-ux-pro-max"));
    const library = await open(home);
    const { candidates } = await library.importCandidates();
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ files: 29 });
    expect(candidates[0]!.problem).toBeUndefined();
    expect(candidates[0]!.bytes).toBeGreaterThan(440 * 1024);
    const result = await library.importLocal([candidates[0]!.key]);
    expect(result.failed).toEqual([]);
    expect(result.imported[0]).toMatchObject({ files: 29 });
  });

  it("SKILL.md grande importa com aviso", async () => {
    const home = await tempDir();
    await mkdir(path.join(home, ".claude", "skills", "g"), { recursive: true });
    await writeFile(path.join(home, ".claude", "skills", "g", "SKILL.md"), md("y".repeat(40_000)));
    const library = await open(home);
    const [candidate] = (await library.importCandidates()).candidates;
    const result = await library.importLocal([candidate!.key]);
    expect(result.imported[0]!.warnings.join(" ")).toMatch(/SKILL\.md é grande/);
  });

  it("o teto técnico recusa na importação do computador, com a mensagem certa", async () => {
    const home = await tempDir();
    await bigSkill(path.join(home, ".claude", "skills", "ui-ux-pro-max"));
    const library = await open(home, { ...small, maxBytes: 100 * 1024 });
    const [candidate] = (await library.importCandidates()).candidates;
    expect(candidate!.problem).toMatch(/teto técnico de segurança/);
    const result = await library.importLocal([candidate!.key]);
    expect(result.imported).toEqual([]);
    expect(result.failed[0]!.reason).toMatch(/teto técnico/);
  });

  it("envio de pasta: 29 arquivos / 450 KB entram; passando do teto injetado, 413", async () => {
    const library = await open(await tempDir(), small);
    const files = [{ path: "SKILL.md", dataBase64: Buffer.from(md()).toString("base64") }, ...Array.from({ length: 28 }, (_, i) => ({ path: `data/f${i}.csv`, dataBase64: Buffer.alloc(16 * 1024, 120).toString("base64") }))];
    expect(await library.upload({ files })).toMatchObject({ files: 29 });
    const tight = await open(await tempDir(), { ...small, maxFiles: 20 });
    await expect(tight.upload({ files })).rejects.toMatchObject({ statusCode: 413 });
  });

  it("executável continua recusado mesmo numa skill grande", async () => {
    const library = await open(await tempDir(), small);
    const files = [
      { path: "SKILL.md", dataBase64: Buffer.from(md()).toString("base64") },
      { path: "bin/tool", dataBase64: Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1, 2]).toString("base64") },
    ];
    await expect(library.upload({ files })).rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/executável/) });
  });
});
