import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { deflateRawSync } from "node:zlib";
import type { AppSkillSpec } from "@cyno/shared";
import { afterEach, describe, expect, it } from "vitest";
import { RUNTIMES } from "./runtimes";
import { matchesPattern, stageSkill } from "./skill-stage";
import { defaultExecutors, stepEnvironment, type ExecFn, type StepContext } from "./steps";
import { unzipTo } from "./unzip";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 60 })));
});
async function temp() {
  const dir = await mkdtemp(path.join(tmpdir(), "cyno-vrt-"));
  dirs.push(dir);
  return dir;
}

type ZipItem = { name: string; data?: Buffer; mode?: number; deflate?: boolean };

/** Monta um .zip mínimo (stored ou deflate) para os testes. */
function makeZip(items: ZipItem[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const item of items) {
    const name = Buffer.from(item.name);
    const data = item.data ?? Buffer.alloc(0);
    const method = item.deflate === false ? 0 : 8;
    const body = method === 8 ? deflateRawSync(data) : data;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((item.mode ?? 0o100644) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + body.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(items.length, 8);
  end.writeUInt16LE(items.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, end]);
}

describe("runtimes de vídeo (ffmpeg e Chrome)", () => {
  it("cada alvo tem URL https e sha256 de 64 hex; ffmpeg traz só ffmpeg e ffprobe; o Chrome é .zip", () => {
    for (const def of Object.values(RUNTIMES)) {
      for (const [platform, target] of Object.entries(def.targets)) {
        expect(target.url, `${def.id} ${platform}`).toMatch(/^https:\/\//);
        expect(target.sha256, `${def.id} ${platform}`).toMatch(/^[0-9a-f]{64}$/);
      }
    }
    expect(RUNTIMES.ffmpeg).toMatchObject({ archive: "tar.xz", bin: "bin/ffmpeg", only: ["*/bin/ffmpeg", "*/bin/ffprobe"] });
    expect(RUNTIMES.ffmpeg.targets["linux-x64"]!.url).toContain("autobuild-2026-10-31-12-59");
    expect(RUNTIMES.chrome).toMatchObject({ archive: "zip", version: "152.0.7977.30" });
  });

  async function context(fetchBody: Buffer, exec: ExecFn) {
    const root = await temp();
    const appDir = path.join(root, "apps", "x");
    const runtimesRoot = path.join(root, "runtimes");
    await mkdir(appDir, { recursive: true });
    const logs: string[] = [];
    const ctx: StepContext = {
      appId: "x",
      appDir,
      runtimesRoot,
      env: stepEnvironment(appDir, runtimesRoot, { PATH: "/usr/bin" }),
      log: (line) => logs.push(line),
      signal: new AbortController().signal,
      timeoutMs: 1000,
      exec,
      fetch: (async () => new Response(new Uint8Array(fetchBody), { status: 200, headers: { "content-length": String(fetchBody.length) } })) as typeof fetch,
      which: () => undefined,
      platform: "linux-x64",
      createdRuntimes: new Set(),
    };
    return { ctx, runtimesRoot, appDir, logs };
  }

  it("o runtime ffmpeg só vale se o arquivo baixado bate com o sha256 (e não deixa nada pela metade)", async () => {
    const { ctx, runtimesRoot } = await context(Buffer.from("isto não é o ffmpeg"), async () => undefined);
    await expect(defaultExecutors["download-runtime"]({ run: "download-runtime", runtime: "ffmpeg" }, ctx)).rejects.toThrow(/sha256/);
    await expect(stat(path.join(runtimesRoot, "ffmpeg", "bin", "ffmpeg"))).rejects.toThrow();
    expect(createHash("sha256").update("x").digest("hex")).toHaveLength(64);
  });

  it("com o arquivo certo, extrai só ffmpeg e ffprobe (tar sem shell, com --wildcards e strip) e anota a versão", async () => {
    const body = Buffer.from("conteúdo fixo do pacote de teste");
    const original = RUNTIMES.ffmpeg.targets["linux-x64"]!;
    const calls: { file: string; args: readonly string[] }[] = [];
    const { ctx, runtimesRoot } = await context(body, async (file, args) => {
      calls.push({ file, args });
      // Faz de conta que o tar extraiu: cria o binário onde o runtime espera.
      const into = args[args.indexOf("-C") + 1]!;
      await writeFile(path.join(into, "ffmpeg"), "bin");
      await writeFile(path.join(into, "ffprobe"), "bin");
    });
    const patched = { ...original, sha256: createHash("sha256").update(body).digest("hex") };
    RUNTIMES.ffmpeg.targets["linux-x64"] = patched;
    try {
      await defaultExecutors["download-runtime"]({ run: "download-runtime", runtime: "ffmpeg" }, ctx);
    } finally {
      RUNTIMES.ffmpeg.targets["linux-x64"] = original;
    }
    expect(calls).toHaveLength(1);
    expect(calls[0]!.file).toBe("tar");
    expect(calls[0]!.args).toEqual(expect.arrayContaining(["-xf", "--strip-components=2", "--wildcards", "*/bin/ffmpeg", "*/bin/ffprobe"]));
    expect(await readFile(path.join(runtimesRoot, "ffmpeg", "VERSION"), "utf8")).toContain("8.1.3");
    expect(ctx.createdRuntimes.has("ffmpeg")).toBe(true);
    // Segunda vez: já existe, não baixa de novo.
    await defaultExecutors["download-runtime"]({ run: "download-runtime", runtime: "ffmpeg" }, ctx);
    expect(calls).toHaveLength(1);
  });

  it("o PATH dos apps inclui runtimes/ffmpeg/bin", () => {
    const env = stepEnvironment("/d/apps/x", "/d/runtimes", { PATH: "/usr/bin" });
    expect(env.PATH).toContain(path.join("/d/runtimes", "ffmpeg", "bin"));
  });
});

describe("unzipTo (o Chrome vem em .zip e a máquina não tem unzip)", () => {
  it("extrai com deflate e stored, tira o nível de pasta e mantém o bit de execução", async () => {
    const dir = await temp();
    const zip = path.join(dir, "a.zip");
    await writeFile(
      zip,
      makeZip([
        { name: "pacote/", mode: 0o040755 },
        { name: "pacote/chrome", data: Buffer.from("binario ".repeat(500)), mode: 0o100755 },
        { name: "pacote/locales/pt.pak", data: Buffer.from("texto"), mode: 0o100644, deflate: false },
        { name: "pacote/vazio.txt", data: Buffer.alloc(0) },
      ]),
    );
    const out = path.join(dir, "out");
    const result = await unzipTo(zip, out, { strip: 1 });
    expect(result.files).toBe(3);
    expect((await stat(path.join(out, "chrome"))).mode & 0o111).not.toBe(0);
    expect((await stat(path.join(out, "locales", "pt.pak"))).mode & 0o111).toBe(0);
    expect(await readFile(path.join(out, "locales", "pt.pak"), "utf8")).toBe("texto");
    expect((await readFile(path.join(out, "chrome"), "utf8")).length).toBe(4000);
  });

  it("recusa caminho que escapa, link simbólico e zip corrompido", async () => {
    const dir = await temp();
    const bad = path.join(dir, "bad.zip");
    await writeFile(bad, makeZip([{ name: "../fora.txt", data: Buffer.from("x") }]));
    await expect(unzipTo(bad, path.join(dir, "o1"))).rejects.toThrow(/suspeito/);
    await writeFile(bad, makeZip([{ name: "/abs.txt", data: Buffer.from("x") }]));
    await expect(unzipTo(bad, path.join(dir, "o2"))).rejects.toThrow(/suspeito/);
    await writeFile(bad, makeZip([{ name: "link", data: Buffer.from("/etc/passwd"), mode: 0o120777 }]));
    await expect(unzipTo(bad, path.join(dir, "o3"))).rejects.toThrow(/link simbólico/);
    await writeFile(bad, Buffer.from("não é zip"));
    await expect(unzipTo(bad, path.join(dir, "o4"))).rejects.toThrow(/zip/);
    await expect(stat(path.join(dir, "fora.txt"))).rejects.toThrow();
  });
});

describe("skills que o app entrega (cópia só do que é permitido)", () => {
  it("padrões: `*` não atravessa pasta", () => {
    expect(matchesPattern("SKILL.md", "SKILL.md")).toBe(true);
    expect(matchesPattern("references/*.md", "references/a.md")).toBe(true);
    expect(matchesPattern("references/*.md", "references/types/a.md")).toBe(false);
    expect(matchesPattern("*.md", "dir/a.md")).toBe(false);
    expect(matchesPattern("a.b", "axb")).toBe(false);
  });

  it("copia só os arquivos do `include` para .skills/<n>, dentro da pasta do app", async () => {
    const appDir = await temp();
    const src = path.join(appDir, "src", "skills", "video");
    await mkdir(path.join(src, "references", "types"), { recursive: true });
    await mkdir(path.join(src, "assets"), { recursive: true });
    await writeFile(path.join(src, "SKILL.md"), "---\nname: video\ndescription: x\n---\n# v");
    await writeFile(path.join(src, "references", "a.md"), "a");
    await writeFile(path.join(src, "references", "types", "b.md"), "b");
    await writeFile(path.join(src, "assets", "big.html"), "x".repeat(300_000));
    await symlink("/etc/passwd", path.join(src, "references", "link.md"));
    const spec: AppSkillSpec = { from: "src/skills/video", include: ["SKILL.md", "references/*.md", "references/types/*.md"] };
    const dir = await stageSkill(appDir, spec, 0);
    expect(dir).toBe(path.join(appDir, ".skills", "0"));
    await expect(stat(path.join(dir, "assets"))).rejects.toThrow();
    expect(await readFile(path.join(dir, "references", "types", "b.md"), "utf8")).toBe("b");
    // O link simbólico nunca é copiado.
    await expect(stat(path.join(dir, "references", "link.md"))).rejects.toThrow();
  });

  it("recusa pasta sem SKILL.md, caminho fora do app e pasta acima do limite de tamanho", async () => {
    const appDir = await temp();
    await mkdir(path.join(appDir, "s"), { recursive: true });
    await expect(stageSkill(appDir, { from: "s", include: ["SKILL.md"] }, 0)).rejects.toThrow(/SKILL\.md/);
    await expect(stageSkill(appDir, { from: "../fora", include: ["SKILL.md"] }, 0)).rejects.toThrow(/fora da pasta/);
    await writeFile(path.join(appDir, "s", "SKILL.md"), "x".repeat(250 * 1024));
    await expect(stageSkill(appDir, { from: "s", include: ["SKILL.md"] }, 0, { maxBytes: 100 * 1024, maxFiles: 60, maxPathLength: 240, maxDepth: 12 })).rejects.toThrow(/teto técnico/);
  });
});
