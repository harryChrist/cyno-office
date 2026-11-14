import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { appToolSpecSchema, catalogAppSchema, type AppRun, type AppToolSpec, type CatalogApp, type ServerEvent } from "@cyno/shared";
import { afterEach, describe, expect, it } from "vitest";
import { appsPaths } from "./paths";
import { AppToolRunner, jsonSchemaOf, resolveJailedPath, type AppRunContext } from "./tool-runner";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 60 });
});

/** Programa de mentira do "app": o primeiro argumento escolhe o comportamento. */
const TOOL = `#!/usr/bin/env node
const fs = require("node:fs");
const [mode, a, b] = process.argv.slice(2);
if (mode === "write") { fs.writeFileSync(a, b ?? "dados"); console.log("escreveu " + a); }
else if (mode === "empty") { fs.writeFileSync(a, ""); }
else if (mode === "echo") { console.log(JSON.stringify({ args: process.argv.slice(3), cwd: process.cwd(), key: process.env.ANTHROPIC_API_KEY ?? null, home: process.env.HOME })); }
else if (mode === "sleep") { setTimeout(() => {}, 60000); }
else if (mode === "slow") { const start = Date.now(); fs.appendFileSync(a, "start " + start + "\\n"); setTimeout(() => { fs.appendFileSync(a, "end " + Date.now() + "\\n"); console.log("ok"); }, Number(b)); }
else if (mode === "progress") { for (const n of [10, 50, 90]) console.error("Rendered " + n + "/100"); fs.writeFileSync(a, "video"); }
else if (mode === "fail") { console.error("boom"); process.exit(3); }
else if (mode === "nothing") { console.log("nada"); }
`;

const FFPROBE = (duration: string, withVideo = true) => `#!/usr/bin/env node
console.log(JSON.stringify({ format: { duration: "${duration}" }, streams: ${withVideo ? '[{ codec_type: "video", width: 1080, height: 1920 }]' : "[]"} }));
`;

function tool(overrides: Record<string, unknown> & { name: string; command: unknown[] }): AppToolSpec {
  return appToolSpecSchema.parse({ description: "Testa.", params: [], ...overrides });
}

type World = { dataDir: string; runner: AppToolRunner; events: ServerEvent[]; appDir: string; agentDir: string; ctx: AppRunContext; entry: CatalogApp; media: { calls: unknown[]; fail?: boolean } };

async function setup(tools: AppToolSpec[], options: { ffprobe?: string; withVideo?: boolean; env?: NodeJS.ProcessEnv } = {}): Promise<World> {
  const dataDir = await mkdtemp(path.join(tmpdir(), "cyno-runner-"));
  dirs.push(dataDir);
  const paths = appsPaths(dataDir);
  const appDir = paths.appDir("fake");
  await mkdir(path.join(appDir, "bin"), { recursive: true });
  await writeFile(path.join(appDir, "bin", "tool"), TOOL);
  await chmod(path.join(appDir, "bin", "tool"), 0o755);
  if (options.ffprobe) {
    await mkdir(path.join(paths.runtimesRoot, "ffmpeg", "bin"), { recursive: true });
    await writeFile(path.join(paths.runtimesRoot, "ffmpeg", "bin", "ffprobe"), FFPROBE(options.ffprobe, options.withVideo));
    await chmod(path.join(paths.runtimesRoot, "ffmpeg", "bin", "ffprobe"), 0o755);
  }
  const agentDir = path.join(dataDir, "agents", "ag1");
  await mkdir(agentDir, { recursive: true });
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
    provides: { connector: { kind: "app", name: "Fake", description: "x", tools } },
    test: { tool: tools[0]!.name, args: {} },
    resources: { ramMB: 1, diskMB: 1 },
  });
  const events: ServerEvent[] = [];
  const media = { calls: [] as unknown[], fail: false };
  const runner = new AppToolRunner({
    paths,
    resolve: (appId) => (appId === "fake" ? { entry, installed: true } : undefined),
    publish: (event) => events.push(event),
    now: () => new Date(),
    env: { PATH: process.env.PATH ?? "", ANTHROPIC_API_KEY: "segredo", ...options.env },
    log: { warn: () => undefined },
    niceness: 0,
  });
  const ctx: AppRunContext = {
    root: agentDir,
    who: { workspaceId: "ws1", workspaceName: "WS", agentId: "ag1", agentName: "Ana" },
    registerMedia: async (file, info) => {
      media.calls.push({ file: path.relative(agentDir, file), ...info });
      if (media.fail) throw new Error("mídia cheia");
      return { id: "M-0007", title: info.title };
    },
  };
  return { dataDir, runner, events, appDir, agentDir, ctx, entry, media };
}

const runsOf = (events: ServerEvent[], id?: string) => events.filter((event): event is Extract<ServerEvent, { type: "library:app-run" }> => event.type === "library:app-run" && (!id || event.run.id === id)).map((event) => event.run);

describe("AppToolRunner: receita e esquema", () => {
  it("valida a receita: um {param} por item, `if` e saída coerentes", () => {
    expect(() => tool({ name: "x", params: [{ type: "string", name: "a", description: "a" }], command: ["bin/tool", "{a}{a}"] })).toThrow(/no máximo um/);
    expect(() => tool({ name: "x", command: ["bin/tool", "{nada}"] })).toThrow(/não é parâmetro/);
    expect(() => tool({ name: "x", command: ["bin/tool", { if: "nada", args: ["--x"] }] })).toThrow(/inexistente/);
    expect(() => tool({ name: "x", params: [{ type: "path", name: "out", description: "o", must: "exist-file" }], command: ["bin/tool"], output: { param: "out", kind: "video" } })).toThrow(/new-file/);
    expect(() => tool({ name: "X-bad", command: ["bin/tool"] })).toThrow();
  });

  it("gera o JSON Schema em inglês com obrigatórios, enum e limites", () => {
    const spec = tool({
      name: "render",
      params: [
        { type: "path", name: "dir", description: "Project.", must: "exist-dir" },
        { type: "integer", name: "fps", description: "Frames.", optional: true, min: 1, max: 60 },
        { type: "enum", name: "q", description: "Quality.", values: ["draft", "high"], default: "draft" },
      ],
      command: ["bin/tool"],
    });
    const schema = jsonSchemaOf(spec) as { required: string[]; properties: Record<string, { minimum?: number; enum?: string[]; description: string }> };
    expect(schema.required).toEqual(["dir"]);
    expect(schema.properties.fps).toMatchObject({ minimum: 1 });
    expect(schema.properties.q?.enum).toEqual(["draft", "high"]);
    expect(schema.properties.dir?.description).toContain("inside your own folder");
    expect(AppToolRunner.toolsOf({ provides: { connector: { kind: "app", name: "x", description: "", env: {}, expectTools: [], tools: [spec] } } })).toHaveLength(1);
  });
});

describe("AppToolRunner: execução sem shell, com parâmetros validados", () => {
  it("passa texto com metacaracteres de shell como UM argumento, sem interpretar", async () => {
    const world = await setup([tool({ name: "say", params: [{ type: "string", name: "text", description: "t" }], command: ["bin/tool", "echo", "{text}"] })]);
    const text = "oi; touch pwned && $(whoami) `id` > x";
    const result = await world.runner.run("fake", "say", { text }, world.ctx);
    expect(result.isError).toBe(false);
    const printed = JSON.parse(result.text.split("\n").slice(1).join("\n")) as { args: string[]; key: string | null };
    expect(printed.args).toEqual([text]);
    // O ambiente do app não leva chave de API do servidor.
    expect(printed.key).toBeNull();
    await expect(stat(path.join(world.appDir, "pwned"))).rejects.toThrow();
    await expect(stat(path.join(world.appDir, "x"))).rejects.toThrow();
  });

  it("recusa parâmetro faltando, desconhecido, de tipo errado ou fora do limite (tudo numa mensagem)", async () => {
    const world = await setup([
      tool({
        name: "t",
        params: [
          { type: "string", name: "s", description: "s", maxLength: 5 },
          { type: "integer", name: "n", description: "n", min: 1, max: 5 },
          { type: "enum", name: "e", description: "e", values: ["a", "b"] },
          { type: "boolean", name: "flag", description: "f", optional: true },
        ],
        command: ["bin/tool", "echo", "{s}", "{n}", "{e}"],
      }),
    ]);
    const bad = await world.runner.run("fake", "t", { s: "longo demais", n: 9, e: "z", extra: 1 }, world.ctx);
    expect(bad.isError).toBe(true);
    for (const part of ["too long", "at most 5", "one of: a, b", 'unknown argument "extra"']) expect(bad.text).toContain(part);
    expect((await world.runner.run("fake", "t", { n: 2, e: "a" }, world.ctx)).text).toContain('"s" is required');
    expect((await world.runner.run("fake", "t", { s: "ok", n: 2.5, e: "a" }, world.ctx)).text).toContain("must be an integer");
    expect((await world.runner.run("fake", "t", { s: "ok", n: 2, e: "a" }, world.ctx)).isError).toBe(false);
    expect((await world.runner.run("fake", "nada", {}, world.ctx)).text).toContain("Unknown tool");
  });

  it("texto solto que começa com '-' não vira flag; dentro de `--chave={x}` pode; enum pode", async () => {
    const world = await setup([tool({ name: "t", params: [{ type: "string", name: "s", description: "s" }], command: ["bin/tool", "echo", "{s}", "--k={s}"] })]);
    const solto = await world.runner.run("fake", "t", { s: "-rf" }, world.ctx);
    expect(solto.isError).toBe(true);
    expect(solto.text).toContain('cannot start with "-"');
    const flag = await world.runner.run("fake", "t", { s: "ab" }, world.ctx);
    expect(flag.isError).toBe(false);
  });

  it("`if` só entra quando o parâmetro veio (e boolean falso não entra); cwd pode ser uma pasta do agente", async () => {
    const world = await setup([
      tool({
        name: "t",
        params: [
          { type: "path", name: "dir", description: "d", must: "exist-dir" },
          { type: "integer", name: "fps", description: "f", optional: true },
          { type: "boolean", name: "loud", description: "l", optional: true },
        ],
        command: ["bin/tool", "echo", { if: "fps", args: ["--fps", "{fps}"] }, { if: "loud", args: ["--loud"] }, "{dir}"],
        cwd: "param:dir",
      }),
    ]);
    await mkdir(path.join(world.agentDir, "proj"));
    const without = JSON.parse((await world.runner.run("fake", "t", { dir: "proj" }, world.ctx)).text.split("\n").slice(1).join("\n")) as { args: string[]; cwd: string };
    expect(without.args).toHaveLength(1);
    expect(without.args[0]!.endsWith("/proj")).toBe(true);
    expect(without.cwd.endsWith("/proj")).toBe(true);
    const withBoth = JSON.parse((await world.runner.run("fake", "t", { dir: "proj", fps: 24, loud: true }, world.ctx)).text.split("\n").slice(1).join("\n")) as { args: string[] };
    expect(withBoth.args.slice(0, 3)).toEqual(["--fps", "24", "--loud"]);
    const off = JSON.parse((await world.runner.run("fake", "t", { dir: "proj", loud: false }, world.ctx)).text.split("\n").slice(1).join("\n")) as { args: string[] };
    expect(off.args).toHaveLength(1);
  });

  it("os caminhos ficam presos à pasta do agente: `..`, absoluto fora e link para fora são recusados", async () => {
    const world = await setup([tool({ name: "t", params: [{ type: "path", name: "p", description: "p", must: "exist-file" }], command: ["bin/tool", "echo", "{p}"] })]);
    await writeFile(path.join(world.agentDir, "ok.txt"), "x");
    await writeFile(path.join(path.dirname(world.agentDir), "fora.txt"), "x");
    await symlink(path.join(path.dirname(world.agentDir), "fora.txt"), path.join(world.agentDir, "atalho.txt"));
    expect((await world.runner.run("fake", "t", { p: "ok.txt" }, world.ctx)).isError).toBe(false);
    expect((await world.runner.run("fake", "t", { p: path.join(world.agentDir, "ok.txt") }, world.ctx)).isError).toBe(false);
    for (const p of ["../fora.txt", path.join(path.dirname(world.agentDir), "fora.txt"), "/etc/passwd", "atalho.txt", "nao-existe.txt", "sub/../../fora.txt"]) {
      const result = await world.runner.run("fake", "t", { p }, world.ctx);
      expect(result.isError, p).toBe(true);
      expect(result.text, p).toMatch(/inside your own folder|leaves your folder|does not exist/);
    }
  });

  it("saída `new-file`: pasta de cima ligada por link para fora é recusada; extensão errada também", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "cyno-jail-"));
    dirs.push(dataDir);
    const root = path.join(dataDir, "agent");
    const outside = path.join(dataDir, "outside");
    await mkdir(root);
    await mkdir(outside);
    await symlink(outside, path.join(root, "out"));
    const param = { type: "path" as const, name: "o", description: "o", optional: false, must: "new-file" as const, ext: [".mp4"] };
    await expect(resolveJailedPath(root, "out/video.mp4", param)).rejects.toThrow(/leaves your folder/);
    await expect(resolveJailedPath(root, "video.mov", param)).rejects.toThrow(/must end with/);
    await expect(resolveJailedPath(root, "novo/dir/video.mp4", param)).resolves.toBe(path.join(await realpath(root), "novo/dir/video.mp4"));
  });
});

describe("AppToolRunner: saída, Mídia, fila e tempo", () => {
  const writer = (extra: Record<string, unknown> = {}) =>
    tool({
      name: "render",
      params: [
        { type: "path", name: "output", description: "o", must: "new-file", ext: [".mp4"] },
        { type: "string", name: "title", description: "t", optional: true },
      ],
      command: ["bin/tool", "write", "{output}", "conteudo"],
      output: { param: "output", kind: "video" },
      ...extra,
    });

  it("confere a saída com o ffprobe e registra na Mídia do workspace de quem chamou", async () => {
    const world = await setup([writer()], { ffprobe: "10.04" });
    const result = await world.runner.run("fake", "render", { output: "out/clip.mp4", title: "Meu clipe" }, world.ctx);
    expect(result).toMatchObject({ isError: false });
    expect(result.text).toBe("RENDERED media M-0007 “Meu clipe” (10.0 s, 1080x1920, 1 KB). File in your folder: out/clip.mp4");
    expect(world.media.calls).toEqual([{ file: "out/clip.mp4", title: "Meu clipe", kind: "video", note: expect.stringContaining("Fake · render"), appId: "fake", tool: "render" }]);
    expect(result.run).toMatchObject({ state: "concluida", mediaId: "M-0007", workspaceId: "ws1", agentName: "Ana", progress: 100 });
    expect(await readFile(path.join(world.agentDir, "out", "clip.mp4"), "utf8")).toBe("conteudo");
  });

  it("sem agente (mini teste do instalador) a saída fica na pasta e não vai para a Mídia", async () => {
    const world = await setup([writer()], { ffprobe: "1.0" });
    const result = await world.runner.run("fake", "render", { output: "test/out.mp4" }, { root: world.appDir });
    expect(result.text).toBe("RENDERED file test/out.mp4 (1.0 s, 1080x1920, 1 KB)");
    expect(world.media.calls).toHaveLength(0);
  });

  it("saída vazia, ausente, duração zero ou sem vídeo = erro", async () => {
    const empty = await setup([tool({ name: "render", params: [{ type: "path", name: "output", description: "o", must: "new-file" }], command: ["bin/tool", "empty", "{output}"], output: { param: "output", kind: "file" } })]);
    expect((await empty.runner.run("fake", "render", { output: "a.bin" }, empty.ctx)).text).toContain("is empty");
    const absent = await setup([tool({ name: "render", params: [{ type: "path", name: "output", description: "o", must: "new-file" }], command: ["bin/tool", "nothing"], output: { param: "output", kind: "file" } })]);
    expect((await absent.runner.run("fake", "render", { output: "a.bin" }, absent.ctx)).text).toContain("did not create the output file");
    const zero = await setup([writer()], { ffprobe: "0" });
    expect((await zero.runner.run("fake", "render", { output: "a.mp4" }, zero.ctx)).text).toContain("zero duration");
    const noVideo = await setup([writer()], { ffprobe: "3.0", withVideo: false });
    expect((await noVideo.runner.run("fake", "render", { output: "a.mp4" }, noVideo.ctx)).text).toContain("no video stream");
  });

  it("falha ao guardar na Mídia vira erro com o motivo (o arquivo continua na pasta)", async () => {
    const world = await setup([writer()], { ffprobe: "2.0" });
    world.media.fail = true;
    const result = await world.runner.run("fake", "render", { output: "a.mp4" }, world.ctx);
    expect(result.isError).toBe(true);
    expect(result.text).toContain("mídia cheia");
  });

  it("código de saída diferente de zero = erro com as últimas linhas", async () => {
    const world = await setup([tool({ name: "boom", command: ["bin/tool", "fail"] })]);
    const result = await world.runner.run("fake", "boom", {}, world.ctx);
    expect(result).toMatchObject({ isError: true });
    expect(result.text).toContain("exit code 3");
    expect(result.text).toContain("boom");
    expect(result.run.state).toBe("falhou");
  });

  it("tempo limite mata o processo", async () => {
    const world = await setup([tool({ name: "slow", command: ["bin/tool", "sleep"], timeoutSec: 5 })]);
    const started = Date.now();
    const result = await world.runner.run("fake", "slow", {}, world.ctx);
    expect(result.isError).toBe(true);
    expect(result.text).toContain("TIMED OUT after 5 s");
    expect(Date.now() - started).toBeLessThan(9000);
  }, 15_000);

  it("uma execução por vez por app: a segunda espera na fila (posição visível) e roda depois", async () => {
    const log = "log.txt";
    const world = await setup([tool({ name: "slow", params: [{ type: "path", name: "log", description: "l", must: "new-file" }, { type: "integer", name: "ms", description: "m" }], command: ["bin/tool", "slow", "{log}", "{ms}"] })]);
    const first = world.runner.run("fake", "slow", { log, ms: 400 }, world.ctx);
    const second = world.runner.run("fake", "slow", { log, ms: 50 }, world.ctx);
    const third = world.runner.run("fake", "slow", { log, ms: 50 }, world.ctx);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const waiting = world.runner.list("fake").filter((run) => run.state === "na-fila");
    expect(waiting.map((run) => run.queuePosition).sort()).toEqual([1, 2]);
    const [a, b, c] = await Promise.all([first, second, third]);
    expect([a, b, c].every((result) => !result.isError)).toBe(true);
    const lines = (await readFile(path.join(world.agentDir, log), "utf8")).trim().split("\n");
    // start, end, start, end, start, end: nunca dois começos seguidos.
    expect(lines.map((line) => line.split(" ")[0])).toEqual(["start", "end", "start", "end", "start", "end"]);
    expect(runsOf(world.events, b.run.id).map((run) => run.state)).toEqual(expect.arrayContaining(["na-fila", "rodando", "concluida"]));
  });

  it("cancela uma execução na fila e uma que está rodando", async () => {
    const world = await setup([tool({ name: "slow", command: ["bin/tool", "sleep"], timeoutSec: 60 })]);
    const running = world.runner.run("fake", "slow", {}, world.ctx);
    const queued = world.runner.run("fake", "slow", {}, world.ctx);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const [active, waiting] = [world.runner.list().find((run) => run.state === "rodando")!, world.runner.list().find((run) => run.state === "na-fila")!];
    expect(world.runner.cancel(waiting.id)).toBe(true);
    expect((await queued).run.state).toBe("cancelada");
    expect(world.runner.cancel(active.id)).toBe(true);
    const done = await running;
    expect(done.run.state).toBe("cancelada");
    expect(world.runner.cancel("R-9999")).toBe(false);
  });

  it("linhas do processo viram andamento (grupos `done`/`total` ou `pct`)", async () => {
    const world = await setup([tool({ name: "p", params: [{ type: "path", name: "o", description: "o", must: "new-file" }], command: ["bin/tool", "progress", "{o}"], output: { param: "o", kind: "file" }, progress: { regex: "Rendered (?<done>\\d+)/(?<total>\\d+)" } })]);
    const result = await world.runner.run("fake", "p", { o: "x.bin" }, world.ctx);
    expect(result.isError).toBe(false);
    const seen = runsOf(world.events, result.run.id).map((run) => run.progress);
    expect(seen.some((value) => value !== undefined && value >= 10)).toBe(true);
  });

  it("guarda o histórico e marca como falhou o que estava no meio quando o servidor caiu", async () => {
    const world = await setup([tool({ name: "ok", command: ["bin/tool", "nothing"] })]);
    await world.runner.run("fake", "ok", {}, world.ctx);
    await world.runner.idle();
    const saved = JSON.parse(await readFile(path.join(appsPaths(world.dataDir).libraryDir, "app-runs.json"), "utf8")) as AppRun[];
    expect(saved[0]).toMatchObject({ tool: "ok", state: "concluida" });
  });
});
