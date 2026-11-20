import { mkdir, readFile, symlink, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { stat } from "node:fs/promises";
import { FILE_LIMITS, FILE_ROOT_DATA, type FileReadResponse, type WorkFolder } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { useTempDirs } from "../../dev/test-utils";
import { HttpError } from "../../platform/http/errors";
import { FilesService } from "./service";

const tempDir = useTempDirs();

async function setup(extra: Partial<ConstructorParameters<typeof FilesService>[0]> = {}) {
  const base = await tempDir();
  const data = path.join(base, "dados");
  const work = path.join(base, "projeto");
  const outside = path.join(base, "fora");
  await Promise.all([mkdir(data), mkdir(work), mkdir(outside)]);
  const folders: WorkFolder[] = [{ id: "projeto", name: "Projeto", path: work, mode: "write" }];
  const service = new FilesService({ dataDir: data, folders: () => folders, ...extra });
  return { service, data, work, outside, base, folders };
}

const status = async (promise: Promise<unknown>): Promise<number | undefined> => promise.then(() => undefined, (error: unknown) => (error instanceof HttpError ? error.statusCode : -1));
const asRead = (value: FileReadResponse) => {
  if ("unchanged" in value) throw new Error("inesperado");
  return value;
};

describe("FilesService: raízes", () => {
  it("lista dados e pastas de trabalho, e marca raiz que não existe mais", async () => {
    const { service, data, work, folders } = await setup();
    folders.push({ id: "sumiu", name: "Sumiu", path: path.join(work, "nao-existe"), mode: "read" });
    const { roots } = await service.roots();
    expect(roots[0]).toMatchObject({ id: FILE_ROOT_DATA, kind: "data", name: "Dados do workspace", path: data });
    expect(roots[0]!.error).toBeUndefined();
    expect(roots[1]).toMatchObject({ id: "projeto", kind: "folder", path: work });
    expect(roots[2]!.error).toMatch(/não existe mais/);
  });

  it("raiz desconhecida dá 404", async () => {
    const { service } = await setup();
    expect(await status(service.list("xyz", "", { offset: 0, limit: 10 }))).toBe(404);
  });
});

describe("FilesService: lista", () => {
  it("ordena (pastas primeiro, natural), filtra, pagina e só mede a página", async () => {
    const measured: string[] = [];
    const { service, work } = await setup({ stat: async (target) => (measured.push(target), stat(target)) });
    await mkdir(path.join(work, "pasta"));
    for (let i = 1; i <= 300; i += 1) await writeFile(path.join(work, `v0_i${i}.txt`), "x");
    await writeFile(path.join(work, "Outro.md"), "x");
    const first = await service.list("projeto", "", { offset: 0, limit: 50 });
    expect(first.total).toBe(302);
    expect(first.more).toBe(true);
    expect(first.entries[0]).toMatchObject({ name: "pasta", kind: "dir" });
    expect(first.entries.slice(1, 4).map((e) => e.name)).toEqual(["Outro.md", "v0_i1.txt", "v0_i2.txt"]);
    expect(first.entries[2]!.size).toBe(1);
    expect(measured).toHaveLength(50);
    const last = await service.list("projeto", "", { offset: 300, limit: 50 });
    expect(last.entries).toHaveLength(2);
    expect(last.more).toBe(false);
    const filtered = await service.list("projeto", "", { offset: 0, limit: 10, filter: "V0_I29" });
    expect(filtered.total).toBe(11);
    expect(filtered.entries.map((e) => e.name).slice(0, 3)).toEqual(["v0_i29.txt", "v0_i290.txt", "v0_i291.txt"]);
  });

  it("link para fora vira trancado; link para dentro funciona", async () => {
    const { service, work, outside } = await setup();
    await writeFile(path.join(outside, "segredo.txt"), "oi");
    await writeFile(path.join(work, "real.txt"), "dentro");
    await symlink(outside, path.join(work, "saida"));
    await symlink(path.join(work, "real.txt"), path.join(work, "atalho.txt"));
    const { entries } = await service.list("projeto", "", { offset: 0, limit: 50 });
    expect(entries.find((e) => e.name === "saida")).toEqual({ name: "saida", kind: "dir", locked: true, link: true });
    expect(entries.find((e) => e.name === "atalho.txt")).toMatchObject({ link: true, size: 6 });
    expect(entries.find((e) => e.name === "atalho.txt")!.locked).toBeUndefined();
    expect(await status(service.list("projeto", "saida", { offset: 0, limit: 10 }))).toBe(403);
    expect(await status(service.read("projeto", "saida/segredo.txt"))).toBe(403);
    expect(await status(service.raw("projeto", "saida/segredo.txt", true))).toBe(403);
    expect(asRead(await service.read("projeto", "atalho.txt")).text).toBe("dentro");
  });

  it("tranca arquivos, pastas e tudo dentro de pasta trancada", async () => {
    const { service, work } = await setup();
    await writeFile(path.join(work, ".env"), "A=1");
    await writeFile(path.join(work, ".env.example"), "A=");
    await mkdir(path.join(work, "sub", ".ssh"), { recursive: true });
    await writeFile(path.join(work, "sub", ".ssh", "config"), "x");
    const { entries } = await service.list("projeto", "", { offset: 0, limit: 50 });
    expect(entries.find((e) => e.name === ".env")!.locked).toBe(true);
    expect(entries.find((e) => e.name === ".env.example")!.locked).toBeUndefined();
    const sub = await service.list("projeto", "sub", { offset: 0, limit: 50 });
    expect(sub.entries[0]).toMatchObject({ name: ".ssh", locked: true });
    expect(await status(service.list("projeto", "sub/.ssh", { offset: 0, limit: 10 }))).toBe(403);
    expect(await status(service.read("projeto", "sub/.ssh/config"))).toBe(403);
    expect(await status(service.raw("projeto", "sub/.ssh/config", false))).toBe(403);
    expect(await status(service.raw("projeto", ".env", false))).toBe(403);
    expect(asRead(await service.read("projeto", ".env"))).toMatchObject({ view: "locked" });
    expect(asRead(await service.read("projeto", ".env")).text).toBeUndefined();
  });

  it("`browser` só é trancado no primeiro nível da raiz de dados", async () => {
    const { service, data, work } = await setup();
    await mkdir(path.join(data, "browser", "perfil"), { recursive: true });
    await writeFile(path.join(data, "browser", "perfil", "Cookies"), "x");
    await mkdir(path.join(data, "agentes", "browser"), { recursive: true });
    await mkdir(path.join(work, "browser"));
    expect((await service.list(FILE_ROOT_DATA, "", { offset: 0, limit: 10 })).entries.find((e) => e.name === "browser")!.locked).toBe(true);
    expect(await status(service.list(FILE_ROOT_DATA, "browser", { offset: 0, limit: 10 }))).toBe(403);
    expect(await status(service.read(FILE_ROOT_DATA, "browser/perfil/Cookies"))).toBe(403);
    expect((await service.list(FILE_ROOT_DATA, "agentes", { offset: 0, limit: 10 })).entries[0]!.locked).toBeUndefined();
    expect((await service.list("projeto", "", { offset: 0, limit: 10 })).entries[0]!.locked).toBeUndefined();
  });

  it("404 para inexistente, 400 para pasta no lugar de arquivo", async () => {
    const { service, work } = await setup();
    await mkdir(path.join(work, "p"));
    expect(await status(service.list("projeto", "nada", { offset: 0, limit: 10 }))).toBe(404);
    expect(await status(service.read("projeto", "nada.txt"))).toBe(404);
    expect(await status(service.read("projeto", "p"))).toBe(400);
    expect(await status(service.raw("projeto", "p", false))).toBe(400);
  });
});

describe("FilesService: leitura", () => {
  it("Markdown, texto e binário por conteúdo", async () => {
    const { service, work } = await setup();
    await writeFile(path.join(work, "a.md"), "# Oi");
    await writeFile(path.join(work, "semext"), "texto simples");
    await writeFile(path.join(work, "dados.bin"), Buffer.from([1, 2, 0, 3]));
    await writeFile(path.join(work, "foto.png"), "x");
    expect(asRead(await service.read("projeto", "a.md"))).toMatchObject({ view: "markdown", text: "# Oi", truncated: false });
    expect(asRead(await service.read("projeto", "semext"))).toMatchObject({ view: "text", text: "texto simples" });
    expect(asRead(await service.read("projeto", "dados.bin"))).toMatchObject({ view: "binary" });
    expect(asRead(await service.read("projeto", "dados.bin")).text).toBeUndefined();
    expect(asRead(await service.read("projeto", "foto.png")).view).toBe("image");
  });

  it("corta em fronteira de caractere UTF-8", async () => {
    const { service, work } = await setup();
    // "é" tem 2 bytes: com previewBytes par o corte cai entre os bytes se começar deslocado por 1.
    const text = `a${"é".repeat(FILE_LIMITS.previewBytes)}`;
    await writeFile(path.join(work, "grande.txt"), text);
    const result = asRead(await service.read("projeto", "grande.txt"));
    expect(result.truncated).toBe(true);
    expect(result.text).not.toContain("�");
    expect(Buffer.byteLength(result.text!)).toBe(FILE_LIMITS.previewBytes - 1);
  });

  it("known sem mudança e depois de mudar o arquivo", async () => {
    const { service, work } = await setup();
    const file = path.join(work, "n.txt");
    await writeFile(file, "um");
    const first = asRead(await service.read("projeto", "n.txt"));
    expect(await service.read("projeto", "n.txt", first.version)).toEqual({ unchanged: true, version: first.version });
    await writeFile(file, "dois!");
    await utimes(file, new Date(), new Date(Date.now() + 5000));
    const next = asRead(await service.read("projeto", "n.txt", first.version));
    expect(next.text).toBe("dois!");
    expect(next.version).not.toBe(first.version);
  });

  it("mascara segredos no texto", async () => {
    const { service, work } = await setup();
    await writeFile(path.join(work, "c.txt"), "chave sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 fim");
    expect(asRead(await service.read("projeto", "c.txt")).text).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
  });

  it("imagem grande demais vira binária e raw vira anexo", async () => {
    const { service, work } = await setup();
    const small = path.join(work, "p.png");
    await writeFile(small, "png");
    const inline = await service.raw("projeto", "p.png", false);
    expect(inline.inlineMime).toBe("image/png");
    inline.stream.destroy();
    const download = await service.raw("projeto", "p.png", true);
    expect(download.inlineMime).toBeUndefined();
    download.stream.destroy();
    // Arquivo esparso maior que o limite, sem gastar disco.
    const big = path.join(work, "g.png");
    const { truncate } = await import("node:fs/promises");
    await writeFile(big, "");
    await truncate(big, FILE_LIMITS.imageBytes + 1);
    expect(asRead(await service.read("projeto", "g.png")).view).toBe("binary");
    const raw = await service.raw("projeto", "g.png", false);
    expect(raw.inlineMime).toBeUndefined();
    raw.stream.destroy();
    expect(await readFile(small, "utf8")).toBe("png");
  });
});

describe("FilesService: busca", () => {
  it("acha por nome, pula node_modules, trancados e links", async () => {
    const { service, work, outside } = await setup();
    await mkdir(path.join(work, "node_modules"));
    await writeFile(path.join(work, "node_modules", "alvo.js"), "x");
    await mkdir(path.join(work, "src", ".ssh"), { recursive: true });
    await writeFile(path.join(work, "src", ".ssh", "alvo-chave"), "x");
    await writeFile(path.join(work, "src", "Alvo.ts"), "x");
    await writeFile(path.join(work, "alvo.env.key"), "x");
    await writeFile(path.join(outside, "alvo-fora.txt"), "x");
    await symlink(outside, path.join(work, "alvo-link"));
    const result = await service.search("projeto", "ALVO");
    expect(result.matches.map((m) => m.path)).toEqual(["src/Alvo.ts"]);
    expect(result.truncated).toBe(false);
  });

  it("para no teto de itens e de resultados", async () => {
    const { service, work } = await setup({ searchScan: 20, searchResults: 5 });
    for (let i = 0; i < 40; i += 1) await writeFile(path.join(work, `f${i}.txt`), "x");
    const scan = await service.search("projeto", "zzz");
    expect(scan.truncated).toBe(true);
    const results = await service.search("projeto", "f");
    expect(results.matches).toHaveLength(5);
    expect(results.truncated).toBe(true);
  });
});
