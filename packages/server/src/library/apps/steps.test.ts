import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isInside, resolveInside } from "./paths";
import { availMemMB, whichInPath } from "./requirements";
import { appEnvironment, defaultExecutors, isForbiddenBinary, NeedsOwnerError, realExec, stepEnvironment, type ExecFn, type StepContext } from "./steps";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 60 })));
});
async function temp() {
  const dir = await mkdtemp(path.join(tmpdir(), "cyno-steps-"));
  dirs.push(dir);
  return dir;
}

type Call = { file: string; args: readonly string[]; cwd: string; env: NodeJS.ProcessEnv };

async function context(over: Partial<StepContext> = {}) {
  const root = await temp();
  const appDir = path.join(root, "apps", "x");
  const runtimesRoot = path.join(root, "runtimes");
  await mkdir(appDir, { recursive: true });
  const calls: Call[] = [];
  const exec: ExecFn = async (file, args, options) => {
    calls.push({ file, args, cwd: options.cwd, env: options.env });
  };
  const logs: string[] = [];
  const ctx: StepContext = { appId: "x", appDir, runtimesRoot, env: stepEnvironment(appDir, runtimesRoot, { PATH: "/usr/bin", ANTHROPIC_API_KEY: "segredo" }), log: (line) => logs.push(line), signal: new AbortController().signal, timeoutMs: 1000, exec, fetch, which: (bin) => (bin === "git" || bin === "npm" ? `/usr/bin/${bin}` : undefined), platform: "linux-x64", createdRuntimes: new Set(), ...over };
  return { ctx, calls, logs, appDir, runtimesRoot, root };
}

describe("passos da receita", () => {
  it("venv e pip-install usam o uv da pasta de runtimes, com argumentos separados e caches dentro do app", async () => {
    const { ctx, calls, appDir, runtimesRoot } = await context();
    await defaultExecutors.venv({ run: "venv", python: "3.12" }, ctx);
    await defaultExecutors["pip-install"]({ run: "pip-install", packages: ["laya[mcp]==0.4.31"], torchBackend: "cpu" }, ctx);
    expect(calls[0]).toMatchObject({ file: path.join(runtimesRoot, "uv", "bin", "uv"), args: ["venv", "--python", "3.12", path.join(appDir, ".venv")] });
    expect(calls[1]).toMatchObject({ file: path.join(runtimesRoot, "uv", "bin", "uv"), args: ["pip", "install", "--python", path.join(appDir, ".venv", "bin", "python"), "--torch-backend", "cpu", "laya[mcp]==0.4.31"] });
    const env = calls[1]!.env;
    // Tudo aponta para dentro do app ou dos runtimes; nenhuma chave de API chega ao processo.
    expect(env.UV_CACHE_DIR).toBe(path.join(appDir, ".cache", "uv"));
    expect(env.UV_PYTHON_INSTALL_DIR).toBe(path.join(runtimesRoot, "uv", "python"));
    expect(env.HOME).toBe(path.join(appDir, ".cache", "home"));
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    for (const key of ["XDG_CACHE_HOME", "XDG_DATA_HOME", "TMPDIR", "HF_HOME", "npm_config_cache", "PIP_CACHE_DIR"]) expect(isInside(env[key]!, [appDir]), key).toBe(true);
  });

  it("require-system devolve 'precisa de você' com o comando exato (e nunca roda sudo)", async () => {
    const { ctx, calls } = await context();
    await expect(defaultExecutors["require-system"]({ run: "require-system", bin: "ffmpeg", sudoHint: "sudo apt install ffmpeg", reason: "Falta o ffmpeg." }, ctx)).rejects.toMatchObject({ command: "sudo apt install ffmpeg", reason: "Falta o ffmpeg." });
    await expect(defaultExecutors["require-system"]({ run: "require-system", bin: "git", sudoHint: "x" }, ctx)).resolves.toBeUndefined();
    expect(calls).toEqual([]);
    expect(new NeedsOwnerError("a", "b")).toBeInstanceOf(Error);
  });

  it("exec só roda binário DENTRO da pasta do app e recusa shell e sudo", async () => {
    const { ctx, calls, appDir } = await context();
    await defaultExecutors.exec({ run: "exec", bin: ".venv/bin/python", args: ["-V"] }, ctx);
    expect(calls[0]).toMatchObject({ file: path.join(appDir, ".venv", "bin", "python"), args: ["-V"] });
    await expect(defaultExecutors.exec({ run: "exec", bin: "../../etc/passwd", args: [] }, ctx)).rejects.toThrow(/fora da pasta/);
    await expect(defaultExecutors.exec({ run: "exec", bin: "/bin/sh", args: ["-c", "x"] }, ctx)).rejects.toThrow(/fora da pasta/);
    await expect(defaultExecutors.exec({ run: "exec", bin: "bin/sudo", args: ["ls"] }, ctx)).rejects.toThrow(/não roda/);
    await expect(defaultExecutors.exec({ run: "exec", bin: "bin/bash", args: ["-c", "ls"] }, ctx)).rejects.toThrow(/não roda/);
    expect(calls).toHaveLength(1);
  });

  it("git-clone: init + fetch do commit fixado + checkout, dentro da pasta do app", async () => {
    const { ctx, calls, appDir } = await context();
    const ref = "a".repeat(40);
    await defaultExecutors["git-clone"]({ run: "git-clone", repo: "https://github.com/a/b", ref, to: "src" }, ctx);
    const src = path.join(appDir, "src");
    expect(calls.map((call) => call.args)).toEqual([
      ["-C", src, "init", "--quiet"],
      ["-C", src, "fetch", "--quiet", "--depth", "1", "https://github.com/a/b", ref],
      ["-C", src, "-c", "advice.detachedHead=false", "checkout", "--quiet", "FETCH_HEAD"],
    ]);
    expect(calls[1]!.args).toContain(ref);
    await expect(defaultExecutors["git-clone"]({ run: "git-clone", repo: "https://github.com/a/b", ref, to: "../fora" }, ctx)).rejects.toThrow(/fora da pasta/);
  });

  it("download-runtime baixa para runtimes/, confere o sha256 e descompacta com tar sem shell", async () => {
    const payload = Buffer.from("conteudo-do-uv");
    const { createHash } = await import("node:crypto");
    const good = createHash("sha256").update(payload).digest("hex");
    const { RUNTIMES } = await import("./runtimes");
    const original = RUNTIMES.uv.targets["linux-x64"]!;
    const saved = { ...original };
    try {
      original.sha256 = good;
      const { ctx, calls, runtimesRoot } = await context({ fetch: (async () => new Response(payload, { status: 200, headers: { "content-length": String(payload.length) } })) as typeof fetch });
      // Simula o tar: cria o binário que o tar criaria.
      ctx.exec = async (file, args) => {
        calls.push({ file, args, cwd: "", env: {} });
        await mkdir(path.join(runtimesRoot, "uv", "bin"), { recursive: true });
        await writeFile(path.join(runtimesRoot, "uv", "bin", "uv"), "bin");
      };
      await defaultExecutors["download-runtime"]({ run: "download-runtime", runtime: "uv" }, ctx);
      expect(calls[0]!.file).toBe("tar");
      expect(calls[0]!.args).toEqual(["-xf", path.join(runtimesRoot, "uv", "uv.tar.gz.download"), "--strip-components=1", "-C", path.join(runtimesRoot, "uv", "bin")]);
      expect((await stat(path.join(runtimesRoot, "uv", "bin", "uv"))).mode & 0o111).not.toBe(0);
      expect((await readFile(path.join(runtimesRoot, "uv", "VERSION"), "utf8")).trim()).toBe(RUNTIMES.uv.version);
      expect(ctx.createdRuntimes.has("uv")).toBe(true);
      // Segunda vez: o binário já existe, não baixa de novo.
      let fetched = false;
      const again = await context({ runtimesRoot, fetch: (async () => ((fetched = true), new Response("x"))) as typeof fetch });
      await defaultExecutors["download-runtime"]({ run: "download-runtime", runtime: "uv" }, again.ctx);
      expect(fetched).toBe(false);
      // sha256 errado: recusa e não deixa o arquivo.
      original.sha256 = "0".repeat(64);
      const bad = await context({ fetch: (async () => new Response(payload, { status: 200 })) as typeof fetch });
      await expect(defaultExecutors["download-runtime"]({ run: "download-runtime", runtime: "uv" }, bad.ctx)).rejects.toThrow(/sha256/);
      await expect(stat(path.join(bad.runtimesRoot, "uv", "uv.tar.gz.download"))).rejects.toThrow();
    } finally {
      Object.assign(original, saved);
    }
  });
});

describe("guardas de caminho e do exec real", () => {
  it("resolveInside recusa absoluto, '..' e vazio; isInside compara por pasta inteira", () => {
    expect(resolveInside("/a/b", "c/d")).toBe("/a/b/c/d");
    for (const bad of ["/etc", "../x", "c/../../x", "", "a\0b"]) expect(() => resolveInside("/a/b", bad)).toThrow();
    expect(isInside("/a/b/c", ["/a/b"])).toBe(true);
    expect(isInside("/a/bc", ["/a/b"])).toBe(false);
    expect(isInside("/a/b/../x", ["/a/b"])).toBe(false);
  });

  it("realExec roda sem shell: metacaracteres viram argumentos literais e shell/sudo são recusados", async () => {
    const dir = await temp();
    const lines: string[] = [];
    const run = (file: string, args: string[], timeoutMs = 5000) => realExec(file, args, { cwd: dir, env: { PATH: process.env.PATH }, signal: new AbortController().signal, timeoutMs, onLine: (line) => lines.push(line) });
    await run("echo", ["a; touch pwned && echo $HOME | cat"]);
    expect(lines).toEqual(["a; touch pwned && echo $HOME | cat"]);
    await expect(stat(path.join(dir, "pwned"))).rejects.toThrow();
    await expect(run("/bin/sh", ["-c", "echo oi"])).rejects.toThrow(/não roda/);
    await expect(run("sudo", ["ls"])).rejects.toThrow(/não roda/);
    expect(isForbiddenBinary("/usr/bin/bash")).toBe(true);
    await expect(run("programa-que-nao-existe", [])).rejects.toThrow(/não encontrado/);
  });

  it("realExec respeita o tempo limite e o cancelamento", async () => {
    const dir = await temp();
    const base = { cwd: dir, env: { PATH: process.env.PATH }, onLine: () => undefined };
    await expect(realExec("sleep", ["5"], { ...base, signal: new AbortController().signal, timeoutMs: 150 })).rejects.toThrow(/tempo limite/);
    const controller = new AbortController();
    const running = realExec("sleep", ["5"], { ...base, signal: controller.signal, timeoutMs: 10_000 });
    setTimeout(() => controller.abort(), 50);
    await expect(running).rejects.toThrow(/cancelado/);
  });

  it("o ambiente dos apps não herda chaves de API", () => {
    const env = stepEnvironment("/d/apps/x", "/d/runtimes", { PATH: "/usr/bin", OPENAI_API_KEY: "k", GEMINI_API_KEY: "k", HOME: "/home/dono" });
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.GEMINI_API_KEY).toBeUndefined();
    expect(env.HOME).toBe("/d/apps/x/.cache/home");
    expect(appEnvironment("/d/apps/x", "/d/runtimes", { PATH: "/usr/bin" }).PATH).toBe("/d/apps/x/.venv/bin:/d/runtimes/uv/bin:/d/runtimes/ffmpeg/bin:/usr/bin");
  });

  it("requirements no Windows (win32): availMemMB usa os.freemem e whichInPath respeita `;` e PATHEXT", async () => {
    const dir = await temp();
    await writeFile(path.join(dir, "ffmpeg.exe"), "fake-pe");
    expect(availMemMB("win32")).toBeGreaterThan(0);
    expect(whichInPath("ffmpeg", `C:\\nao-existe;${dir}`, { platform: "win32", env: { PATHEXT: ".EXE;.CMD" } })).toBe(path.join(dir, "ffmpeg.exe"));
    expect(whichInPath("ffmpeg", dir, { platform: "linux" })).toBeUndefined();
  });
});
