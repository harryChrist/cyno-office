import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { catalogAppSchema, type ServerEvent } from "@cyno/shared";
import { afterEach, describe, expect, it } from "vitest";
import { LibraryService } from "../library-service";
import { appsPaths } from "./paths";
import { AppToolRunner } from "./tool-runner";
import { stageSkill } from "./skill-stage";

const AVATAR = { skin: "#f", hair: "#f", hairColor: "#f", shirt: "#f", pants: "#f" };
const dirs: string[] = [];
const services: LibraryService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 60 });
});

const TOOL = `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(process.argv[2], "conteudo do video");
console.log("feito");
`;

const entry = catalogAppSchema.parse({
  id: "fake",
  name: "Fake",
  area: "video",
  status: "disponivel",
  summary: "x",
  repo: "https://github.com/exemplo/fake",
  version: { kind: "npm", ref: "1.0.0" },
  recipeVersion: "1",
  license: { spdx: "MIT", level: "livre" },
  recipe: [{ run: "write-file", to: "a.txt", content: "a" }],
  provides: {
    connector: {
      kind: "app",
      name: "Fake",
      description: "App de mentira",
      tools: [
        {
          name: "render",
          description: "Renders.",
          params: [{ type: "path", name: "output", description: "Out.", must: "new-file", ext: [".mp4"] }],
          command: ["bin/tool", "{output}"],
          output: { param: "output", kind: "video" },
        },
      ],
    },
  },
  test: { tool: "render", args: { output: "test/out.mp4" }, expect: { matches: "^RENDERED file test/out\\.mp4" } },
  resources: { ramMB: 1, diskMB: 1 },
});

async function setup() {
  const dataDir = await mkdtemp(path.join(tmpdir(), "cyno-appconn-"));
  dirs.push(dataDir);
  const paths = appsPaths(dataDir);
  const appDir = paths.appDir("fake");
  await mkdir(path.join(appDir, "bin"), { recursive: true });
  await writeFile(path.join(appDir, "bin", "tool"), TOOL);
  await chmod(path.join(appDir, "bin", "tool"), 0o755);
  const agentDir = path.join(dataDir, "agents", "clara");
  await mkdir(agentDir, { recursive: true });
  const events: ServerEvent[] = [];
  const library = await LibraryService.open({
    libraryDir: paths.libraryDir,
    publishPlatform: (event) => events.push(event),
    claudeList: { command: "/nao-existe/claude" },
    autoTest: false,
    allowStdio: true,
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    now: () => new Date("2026-11-11T12:00:00.000Z"),
  });
  services.push(library);
  const saved: { file: string; origin?: string; where?: string; createdBy: string }[] = [];
  library.attach("a", {
    name: () => "Principal",
    agents: () => [{ id: "clara", name: "Clara", avatar: AVATAR, maestro: false }],
    publish: () => undefined,
    appRun: {
      agentDir: () => agentDir,
      currentTask: () => ({ id: "T-1", projectId: "P-1" }),
      media: {
        importFile: async (root, requested, meta) => {
          saved.push({ file: path.relative(root, path.resolve(root, requested)), origin: meta.origin, where: meta.where, createdBy: meta.createdBy });
          return { id: "M-0001", title: meta.title } as never;
        },
      },
    },
  });
  const runner = new AppToolRunner({ paths, resolve: (id) => (id === "fake" ? { entry, installed: true } : undefined), publish: () => undefined, now: () => new Date(), env: { PATH: process.env.PATH ?? "" }, log: { warn: () => undefined }, niceness: 0 });
  library.setAppRunner(runner);
  return { library, runner, agentDir, appDir, saved, events };
}

describe("conector kind:app na Biblioteca", () => {
  it("nasce sem liberação, o mini teste passa, e a ferramenta só aparece para quem recebeu", async () => {
    const { library, agentDir, saved } = await setup();
    const id = await library.appPort().upsertAppConnector({ appId: "fake", kind: "app", name: "Fake", description: "App de mentira", env: {}, warnings: ["cuidado"] });
    expect(library.get(id)).toMatchObject({ kind: "app", origin: "app", appId: "fake", enabled: true, grants: {}, warnings: ["cuidado"] });

    const test = await library.appPort().miniTest(id, { tool: "render", args: { output: "test/out.mp4" }, expect: { matches: "^RENDERED file test/out\\.mp4" }, timeoutSec: 30 }, ["render"]);
    expect(test).toMatchObject({ ok: true, tool: "render" });
    expect(library.get(id).status).toMatchObject({ state: "connected" });
    expect(library.get(id).status.tools.map((tool) => tool.name)).toEqual(["render"]);

    // Ninguém recebeu: nenhuma ferramenta.
    expect(library.toolsFor("a", "clara")).toEqual([]);
    await library.setGrants(id, { a: { agentIds: ["clara"] } });
    const tools = library.toolsFor("a", "clara");
    expect(tools.map((tool) => tool.name)).toEqual(["fake__render"]);
    expect(tools[0]!.description).toContain("[Connector Fake]");

    const result = await tools[0]!.call({ output: "videos/clip.mp4" });
    expect(result.isError ?? false).toBe(false);
    expect(result.text).toContain("RENDERED media M-0001");
    expect(saved).toEqual([{ file: "videos/clip.mp4", origin: "app", where: "app:fake", createdBy: "clara" }]);
    expect(await readFile(path.join(agentDir, "videos", "clip.mp4"), "utf8")).toBe("conteudo do video");

    // Caminho fora da pasta do agente: recusado antes de rodar qualquer coisa.
    const bad = await tools[0]!.call({ output: "../../fora.mp4" });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain("inside your own folder");

    // Tirar a liberação some a ferramenta; chamar com o vínculo velho também falha.
    await library.setGrants(id, {});
    expect(library.toolsFor("a", "clara")).toEqual([]);
    expect((await tools[0]!.call({ output: "x.mp4" })).isError).toBe(true);
  });

  it("remover os conectores do app tira as liberações; skills do app entram e saem junto", async () => {
    const { library, appDir } = await setup();
    const id = await library.appPort().upsertAppConnector({ appId: "fake", kind: "app", name: "Fake", description: "x", env: {}, warnings: [] });
    await library.setGrants(id, { a: { agentIds: ["clara"] } });
    // Skill do app: copia só o permitido e registra na Biblioteca (só leitura).
    const src = path.join(appDir, "src", "skills", "demo");
    await mkdir(path.join(src, "references"), { recursive: true });
    await writeFile(path.join(src, "SKILL.md"), "---\nname: demo\ndescription: Demo skill.\n---\n# Demo");
    await writeFile(path.join(src, "references", "a.md"), "a");
    const stage = await stageSkill(appDir, { from: "src/skills/demo", include: ["SKILL.md", "references/*.md"] }, 0);
    const skillId = await library.appPort().registerAppSkill("fake", "src/skills/demo", stage);
    expect(library.skillGet(skillId)).toMatchObject({ readonly: true, origin: { kind: "app", appId: "fake", path: "src/skills/demo" } });
    await library.skills.setGrants(skillId, { a: { agentIds: ["clara"] } });

    expect(await library.appPort().removeAppConnectors("fake")).toEqual([id]);
    expect(await library.appPort().removeAppSkills("fake")).toEqual([skillId]);
    expect(library.list()).toEqual([]);
    expect(library.skillList().filter((skill) => skill.id === skillId)).toEqual([]);
    expect(library.toolsFor("a", "clara")).toEqual([]);
  });

  it("avisos longos do catálogo (até 300 caracteres) sobrevivem ao reinício (connectors.json volta a abrir)", async () => {
    const { library, appDir } = await setup();
    const long = "x".repeat(300);
    const id = await library.appPort().upsertAppConnector({ appId: "fake", kind: "app", name: "Fake", description: "x", env: {}, warnings: [long] });
    await library.close();
    const reopened = await LibraryService.open({
      libraryDir: path.join(path.dirname(path.dirname(appDir)), "library"),
      publishPlatform: () => undefined,
      claudeList: { command: "/nao-existe/claude" },
      autoTest: false,
      log: { info: () => undefined, warn: () => undefined, error: () => undefined },
      now: () => new Date("2026-11-11T12:00:00.000Z"),
    });
    services.push(reopened);
    expect(reopened.get(id).warnings).toEqual([long]);
  });
});
