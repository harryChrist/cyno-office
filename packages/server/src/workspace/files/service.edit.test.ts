import { chmod, lstat, mkdir, readdir, readFile, stat, symlink, truncate, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import path from "node:path";
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
  const ro = path.join(base, "leitura");
  const outside = path.join(base, "fora");
  await Promise.all([mkdir(data), mkdir(work), mkdir(ro), mkdir(outside)]);
  const sentinel = path.join(outside, "sentinela.txt");
  await writeFile(sentinel, "intacto");
  const folders: WorkFolder[] = [
    { id: "projeto", name: "Projeto", path: work, mode: "write" },
    { id: "leitura", name: "Leitura", path: ro, mode: "read" },
  ];
  const service = new FilesService({ dataDir: data, folders: () => folders, ...extra });
  return { service, data, work, ro, outside, sentinel, base };
}

const status = async (promise: Promise<unknown>): Promise<number | undefined> => promise.then(() => undefined, (error: unknown) => (error instanceof HttpError ? error.statusCode : -1));
const message = async (promise: Promise<unknown>): Promise<string> => promise.then(() => "", (error: unknown) => (error as Error).message);
const asRead = (value: FileReadResponse) => {
  if ("unchanged" in value) throw new Error("inesperado");
  return value;
};
const stream = (data: string | Buffer) => Readable.from([Buffer.from(data)]);
const exists = (target: string) => lstat(target).then(() => true, () => false);

describe("FilesService: raízes graváveis", () => {
  it("dados e pasta só leitura não são graváveis", async () => {
    const { service } = await setup();
    const { roots } = await service.roots();
    expect(roots.map((r) => [r.id, r.writable])).toEqual([[FILE_ROOT_DATA, false], ["projeto", true], ["leitura", false]]);
  });
});

describe("FilesService: raízes que não alteram", () => {
  it("recusa toda alteração nos dados e na pasta só leitura, e a contagem funciona", async () => {
    const { service, data, ro } = await setup();
    await writeFile(path.join(data, "a.txt"), "x");
    await writeFile(path.join(ro, "a.txt"), "x");
    await mkdir(path.join(ro, "sub"));
    for (const [root, text] of [[FILE_ROOT_DATA, "dados"], ["leitura", "só leitura"]] as const) {
      const calls = [
        service.write(root, "a.txt", "novo"),
        service.create(root, "n.txt", "file"),
        service.create(root, "n", "dir"),
        service.rename(root, "a.txt", "b.txt"),
        service.delete(root, "a.txt"),
        service.upload(root, "", "u.txt", false, stream("x")),
        service.read(root, "a.txt", undefined, true),
      ];
      for (const call of calls) expect(await status(call)).toBe(403);
      expect(await message(service.delete(root, "a.txt"))).toMatch(text === "dados" ? /dados do workspace/ : /só leitura/);
    }
    expect(await readFile(path.join(ro, "a.txt"), "utf8")).toBe("x");
    expect(await service.count("leitura", "")).toMatchObject({ files: 1, dirs: 1, truncated: false });
    expect(await service.count(FILE_ROOT_DATA, "")).toMatchObject({ files: 1, dirs: 0 });
  });

  it("raiz desconhecida dá 404", async () => {
    const { service } = await setup();
    expect(await status(service.write("xyz", "a.txt", "x"))).toBe(404);
    expect(await status(service.count("xyz", ""))).toBe(404);
  });
});

describe("FilesService: edit=1", () => {
  it("devolve o texto exato, sem máscara, e a leitura normal marca masked", async () => {
    const { service, work } = await setup();
    const text = "﻿API_KEY=sk-abcdef1234567890abcdef1234567890\r\nsenha=1\r\n";
    await writeFile(path.join(work, "c.txt"), text);
    const edit = asRead(await service.read("projeto", "c.txt", undefined, true));
    expect(edit.text).toBe(text);
    expect(edit.truncated).toBe(false);
    expect(edit.masked).toBeUndefined();
    const normal = asRead(await service.read("projeto", "c.txt"));
    if (normal.text !== text) expect(normal.masked).toBe(true);
    await writeFile(path.join(work, "limpo.txt"), "oi");
    expect(asRead(await service.read("projeto", "limpo.txt")).masked).toBeUndefined();
  });

  it("recusa arquivo grande, binário, não UTF-8, pasta, trancado e raiz só leitura", async () => {
    const { service, work, ro } = await setup();
    await writeFile(path.join(work, "g.txt"), "");
    await truncate(path.join(work, "g.txt"), FILE_LIMITS.editBytes + 1);
    expect(await message(service.read("projeto", "g.txt", undefined, true))).toBe("Este arquivo é grande demais para editar por aqui.");
    await writeFile(path.join(work, "b.bin"), Buffer.from([1, 0, 2]));
    expect(await status(service.read("projeto", "b.bin", undefined, true))).toBe(400);
    await writeFile(path.join(work, "i.png"), "x");
    expect(await status(service.read("projeto", "i.png", undefined, true))).toBe(400);
    await writeFile(path.join(work, "l1.txt"), Buffer.from([0xff, 0xfe, 0x41]));
    expect(await message(service.read("projeto", "l1.txt", undefined, true))).toBe("Este arquivo não está em UTF-8 e não pode ser editado por aqui.");
    await mkdir(path.join(work, "pasta"));
    expect(await status(service.read("projeto", "pasta", undefined, true))).toBe(400);
    await writeFile(path.join(work, ".env"), "A=1");
    expect(await status(service.read("projeto", ".env", undefined, true))).toBe(403);
    await writeFile(path.join(ro, "a.txt"), "x");
    expect(await status(service.read("leitura", "a.txt", undefined, true))).toBe(403);
  });
});

describe("FilesService: write", () => {
  it("cria, salva por cima, mantém permissões e grava CRLF e BOM byte a byte, sem temporários", async () => {
    const { service, work } = await setup();
    const created = await service.write("projeto", "novo.txt", "oi");
    expect(created).toMatchObject({ path: "novo.txt", name: "novo.txt", size: 2 });
    const file = path.join(work, "script.sh");
    await writeFile(file, "antigo");
    await chmod(file, 0o755);
    const exact = "﻿linha1\r\nlinha2\r\n";
    const saved = await service.write("projeto", "script.sh", exact);
    expect(await readFile(file)).toEqual(Buffer.from(exact, "utf8"));
    expect((await stat(file)).mode & 0o777).toBe(0o755);
    expect(saved.size).toBe(Buffer.byteLength(exact));
    expect((await readdir(work)).sort()).toEqual(["novo.txt", "script.sh"]);
  });

  it("conflito de versão, arquivo sumido e salvar por cima sem versão", async () => {
    const { service, work } = await setup();
    await writeFile(path.join(work, "a.txt"), "um");
    const v1 = (await service.write("projeto", "a.txt", "dois")).version;
    await writeFile(path.join(work, "a.txt"), "outro conteúdo");
    expect(await message(service.write("projeto", "a.txt", "meu", v1))).toBe("O arquivo mudou no disco depois que você abriu.");
    expect(await status(service.write("projeto", "a.txt", "meu", v1))).toBe(409);
    expect(await readFile(path.join(work, "a.txt"), "utf8")).toBe("outro conteúdo");
    expect(await status(service.write("projeto", "sumiu.txt", "x", "1-1"))).toBe(409);
    expect(await message(service.write("projeto", "sumiu.txt", "x", "1-1"))).toBe("Esse arquivo não existe mais no disco.");
    await service.write("projeto", "a.txt", "por cima");
    expect(await readFile(path.join(work, "a.txt"), "utf8")).toBe("por cima");
    const current = asRead(await service.read("projeto", "a.txt", undefined, true)).version;
    expect((await service.write("projeto", "a.txt", "ok", current)).size).toBe(2);
  });

  it("texto grande demais, arquivo do disco grande demais e pasta", async () => {
    const { service, work } = await setup();
    expect(await message(service.write("projeto", "a.txt", "é".repeat(FILE_LIMITS.editBytes / 2 + 1)))).toBe("O texto é grande demais para salvar por aqui.");
    await writeFile(path.join(work, "g.txt"), "");
    await truncate(path.join(work, "g.txt"), FILE_LIMITS.editBytes + 1);
    expect(await status(service.write("projeto", "g.txt", "x"))).toBe(400);
    await mkdir(path.join(work, "pasta"));
    expect(await status(service.write("projeto", "pasta", "x"))).toBe(400);
    expect(await status(service.write("projeto", "nao/existe/a.txt", "x"))).toBe(404);
    expect((await readdir(work)).sort()).toEqual(["g.txt", "pasta"]);
  });

  it("link para dentro escreve no alvo e mantém o link; link para fora é recusado", async () => {
    const { service, work, outside, sentinel } = await setup();
    await writeFile(path.join(work, "alvo.txt"), "a");
    await symlink(path.join(work, "alvo.txt"), path.join(work, "atalho.txt"));
    await service.write("projeto", "atalho.txt", "novo");
    expect((await lstat(path.join(work, "atalho.txt"))).isSymbolicLink()).toBe(true);
    expect(await readFile(path.join(work, "alvo.txt"), "utf8")).toBe("novo");
    await symlink(sentinel, path.join(work, "saida.txt"));
    await symlink(outside, path.join(work, "pasta-fora"));
    expect(await status(service.write("projeto", "saida.txt", "x"))).toBe(403);
    expect(await status(service.write("projeto", "pasta-fora/novo.txt", "x"))).toBe(403);
    expect(await status(service.upload("projeto", "pasta-fora", "novo.txt", false, stream("x")))).toBe(403);
    expect(await status(service.upload("projeto", "", "saida.txt", true, stream("x")))).toBe(403);
    expect(await readFile(sentinel, "utf8")).toBe("intacto");
    expect(await readdir(outside)).toEqual(["sentinela.txt"]);
  });

  it("trancados: item, ancestral e nome trancado", async () => {
    const { service, work } = await setup();
    await writeFile(path.join(work, ".env"), "A=1");
    await mkdir(path.join(work, ".ssh"));
    await writeFile(path.join(work, ".ssh", "config"), "x");
    expect(await status(service.write("projeto", ".env", "x"))).toBe(403);
    expect(await status(service.write("projeto", ".ssh/config", "x"))).toBe(403);
    expect(await status(service.write("projeto", ".ssh/novo.txt", "x"))).toBe(403);
    expect(await status(service.write("projeto", "id_rsa", "x"))).toBe(400);
    expect(await status(service.write("projeto", "senha.pem", "x"))).toBe(400);
    expect(await readFile(path.join(work, ".env"), "utf8")).toBe("A=1");
  });
});

describe("FilesService: create", () => {
  it("cria arquivo e pasta; já existe, pai inexistente, nome ruim e trancado", async () => {
    const { service, work } = await setup();
    expect(await service.create("projeto", "a.txt", "file")).toEqual({ root: "projeto", path: "a.txt", kind: "file" });
    expect((await stat(path.join(work, "a.txt"))).size).toBe(0);
    await service.create("projeto", "d", "dir");
    await service.create("projeto", "d/e.txt", "file");
    expect((await stat(path.join(work, "d"))).isDirectory()).toBe(true);
    expect(await message(service.create("projeto", "a.txt", "file"))).toBe("Já existe um item com esse nome.");
    expect(await status(service.create("projeto", "d", "dir"))).toBe(409);
    expect(await status(service.create("projeto", "x/y/z", "dir"))).toBe(404);
    expect(await status(service.create("projeto", "a.txt/z", "file"))).toBe(400);
    expect(await status(service.create("projeto", ".env", "file"))).toBe(400);
    expect(await status(service.create("projeto", ".ssh", "dir"))).toBe(400);
    expect(await status(service.create("projeto", "", "dir"))).toBe(400);
    await mkdir(path.join(work, ".aws"));
    expect(await status(service.create("projeto", ".aws/x.txt", "file"))).toBe(403);
  });
});

describe("FilesService: rename", () => {
  it("renomeia, move, destino existente com e sem overwrite, pasta sobre pasta e para dentro dela mesma", async () => {
    const { service, work } = await setup();
    await writeFile(path.join(work, "a.txt"), "A");
    await writeFile(path.join(work, "b.txt"), "B");
    await mkdir(path.join(work, "d"));
    await mkdir(path.join(work, "d", "sub"));
    await mkdir(path.join(work, "e"));
    expect(await service.rename("projeto", "a.txt", "c.txt")).toEqual({ root: "projeto", path: "c.txt" });
    expect(await exists(path.join(work, "a.txt"))).toBe(false);
    await service.rename("projeto", "c.txt", "d/c.txt");
    expect(await readFile(path.join(work, "d", "c.txt"), "utf8")).toBe("A");
    await writeFile(path.join(work, "x.txt"), "X");
    expect(await message(service.rename("projeto", "x.txt", "b.txt"))).toBe("Já existe um item com esse nome.");
    expect(await readFile(path.join(work, "b.txt"), "utf8")).toBe("B");
    await service.rename("projeto", "x.txt", "b.txt", true);
    expect(await readFile(path.join(work, "b.txt"), "utf8")).toBe("X");
    expect(await status(service.rename("projeto", "d", "e", true))).toBe(409);
    expect(await status(service.rename("projeto", "b.txt", "e", true))).toBe(409);
    expect(await message(service.rename("projeto", "d", "d/sub/d"))).toBe("Não dá para mover uma pasta para dentro dela mesma.");
    expect(await status(service.rename("projeto", "d", "d/novo"))).toBe(400);
    expect(await status(service.rename("projeto", "nada", "z"))).toBe(404);
    expect(await status(service.rename("projeto", "b.txt", "sem/pasta/b.txt"))).toBe(404);
    await service.rename("projeto", "d", "renomeada");
    expect(await exists(path.join(work, "renomeada", "sub"))).toBe(true);
  });

  it("trancados: de, para, ancestral e nome trancado", async () => {
    const { service, work } = await setup();
    await writeFile(path.join(work, ".env"), "A=1");
    await writeFile(path.join(work, "a.txt"), "a");
    await mkdir(path.join(work, ".gnupg"));
    await writeFile(path.join(work, ".gnupg", "k.txt"), "k");
    expect(await status(service.rename("projeto", ".env", "env2.txt"))).toBe(403);
    expect(await status(service.rename("projeto", ".gnupg/k.txt", "k.txt"))).toBe(403);
    expect(await status(service.rename("projeto", ".gnupg", "g"))).toBe(403);
    expect(await status(service.rename("projeto", "a.txt", ".gnupg/a.txt"))).toBe(403);
    expect(await status(service.rename("projeto", "a.txt", ".env"))).toBe(400);
    expect(await status(service.rename("projeto", "a.txt", "chave.key"))).toBe(400);
    expect(await status(service.rename("projeto", "", "x"))).toBe(400);
    expect(await readFile(path.join(work, ".env"), "utf8")).toBe("A=1");
    expect(await exists(path.join(work, "a.txt"))).toBe(true);
  });

  it("link para fora: renomear mexe só no link e a sentinela fica", async () => {
    const { service, work, sentinel } = await setup();
    await symlink(sentinel, path.join(work, "saida.txt"));
    await service.rename("projeto", "saida.txt", "outro.txt");
    expect((await lstat(path.join(work, "outro.txt"))).isSymbolicLink()).toBe(true);
    expect(await readFile(sentinel, "utf8")).toBe("intacto");
    await writeFile(path.join(work, "z.txt"), "z");
    expect(await status(service.rename("projeto", "z.txt", "outro.txt", true))).toBe(409);
    expect(await readFile(sentinel, "utf8")).toBe("intacto");
  });
});

describe("FilesService: delete e count", () => {
  it("apaga arquivo, pasta com conteúdo (contagem certa) e recusa a raiz", async () => {
    const { service, work } = await setup();
    await writeFile(path.join(work, "a.txt"), "a");
    expect(await service.delete("projeto", "a.txt")).toEqual({ root: "projeto", path: "a.txt", deleted: 1 });
    await mkdir(path.join(work, "d", "sub"), { recursive: true });
    await writeFile(path.join(work, "d", "1.txt"), "1");
    await writeFile(path.join(work, "d", "sub", "2.txt"), "2");
    expect(await service.count("projeto", "d")).toEqual({ root: "projeto", path: "d", files: 2, dirs: 1, truncated: false });
    expect((await service.delete("projeto", "d")).deleted).toBe(4);
    expect(await exists(path.join(work, "d"))).toBe(false);
    expect(await status(service.delete("projeto", ""))).toBe(400);
    expect(await status(service.delete("projeto", "nada"))).toBe(404);
    expect(await exists(work)).toBe(true);
  });

  it("trancados e ancestral trancado não apagam", async () => {
    const { service, work } = await setup();
    await writeFile(path.join(work, ".env"), "A=1");
    await mkdir(path.join(work, ".kube"));
    await writeFile(path.join(work, ".kube", "x.txt"), "x");
    expect(await status(service.delete("projeto", ".env"))).toBe(403);
    expect(await status(service.delete("projeto", ".kube/x.txt"))).toBe(403);
    expect(await status(service.delete("projeto", ".kube"))).toBe(403);
    expect(await exists(path.join(work, ".kube", "x.txt"))).toBe(true);
  });

  it("apagar um link remove só o link; pasta com link para fora não toca o alvo", async () => {
    const { service, work, outside, sentinel } = await setup();
    await symlink(sentinel, path.join(work, "saida.txt"));
    await symlink(outside, path.join(work, "pasta-fora"));
    expect((await service.delete("projeto", "saida.txt")).deleted).toBe(1);
    expect(await exists(path.join(work, "saida.txt"))).toBe(false);
    expect(await readFile(sentinel, "utf8")).toBe("intacto");
    expect(await status(service.delete("projeto", "pasta-fora/sentinela.txt"))).toBe(403);
    await mkdir(path.join(work, "d"));
    await symlink(outside, path.join(work, "d", "ln"));
    expect((await service.delete("projeto", "d")).deleted).toBe(2);
    expect(await readFile(sentinel, "utf8")).toBe("intacto");
    expect((await service.delete("projeto", "pasta-fora")).deleted).toBe(1);
    expect(await readdir(outside)).toEqual(["sentinela.txt"]);
  });

  it("travessia por link para fora não renomeia nem apaga a sentinela", async () => {
    const { service, work, outside, sentinel } = await setup();
    await symlink(outside, path.join(work, "pasta-fora"));
    expect(await status(service.rename("projeto", "pasta-fora/sentinela.txt", "x.txt"))).toBe(403);
    expect(await status(service.delete("projeto", "pasta-fora/sentinela.txt"))).toBe(403);
    expect(await status(service.write("projeto", "pasta-fora/sentinela.txt", "x"))).toBe(403);
    expect(await readFile(sentinel, "utf8")).toBe("intacto");
  });

  it("count respeita o teto", async () => {
    const { service, work } = await setup({ countScan: 5 });
    for (let i = 0; i < 8; i += 1) await writeFile(path.join(work, `f${i}.txt`), "x");
    expect(await service.count("projeto", "")).toMatchObject({ files: 5, dirs: 0, truncated: true });
    await writeFile(path.join(work, ".env"), "A=1");
    await mkdir(path.join(work, ".ssh"));
    expect(await status(service.count("projeto", ".ssh"))).toBe(403);
    expect(await status(service.count("projeto", "f0.txt"))).toBe(400);
  });
});

describe("FilesService: upload", () => {
  it("grava, recusa existente, aceita overwrite e não deixa temporário", async () => {
    const { service, work } = await setup();
    await mkdir(path.join(work, "d"));
    const sent = await service.upload("projeto", "d", "a.bin", false, stream(Buffer.from([0, 1, 2, 3])));
    expect(sent).toMatchObject({ path: "d/a.bin", name: "a.bin", size: 4 });
    expect(await message(service.upload("projeto", "d", "a.bin", false, stream("x")))).toBe("Já existe um item com esse nome.");
    expect(await readFile(path.join(work, "d", "a.bin"))).toEqual(Buffer.from([0, 1, 2, 3]));
    await chmod(path.join(work, "d", "a.bin"), 0o700);
    await service.upload("projeto", "d", "a.bin", true, stream("novo"));
    expect(await readFile(path.join(work, "d", "a.bin"), "utf8")).toBe("novo");
    expect((await stat(path.join(work, "d", "a.bin"))).mode & 0o777).toBe(0o700);
    await mkdir(path.join(work, "d", "pasta"));
    expect(await status(service.upload("projeto", "d", "pasta", true, stream("x")))).toBe(409);
    expect(await readdir(path.join(work, "d"))).toEqual(expect.arrayContaining(["a.bin", "pasta"]));
    expect(await readdir(path.join(work, "d"))).toHaveLength(2);
  });

  it("trancados e nome trancado", async () => {
    const { service, work } = await setup();
    await mkdir(path.join(work, ".ssh"));
    await writeFile(path.join(work, ".env"), "A=1");
    expect(await status(service.upload("projeto", ".ssh", "a.txt", false, stream("x")))).toBe(403);
    expect(await status(service.upload("projeto", "", ".env", true, stream("x")))).toBe(400);
    expect(await status(service.upload("projeto", "", "a/b.txt", false, stream("x")))).toBe(400);
    expect(await status(service.upload("projeto", "nao-existe", "a.txt", false, stream("x")))).toBe(404);
    expect(await readFile(path.join(work, ".env"), "utf8")).toBe("A=1");
  });

  it("passou do teto: 413 e sem temporário; conexão cortada também limpa", async () => {
    const { service, work } = await setup({ uploadBytes: 10 });
    expect(await status(service.upload("projeto", "", "g.bin", false, stream("x".repeat(11))))).toBe(413);
    expect(await message(service.upload("projeto", "", "g.bin", false, stream("x".repeat(11))))).toBe("Arquivo grande demais para enviar por aqui.");
    expect(await readdir(work)).toEqual([]);
    expect((await service.upload("projeto", "", "ok.bin", false, stream("x".repeat(10)))).size).toBe(10);
    const broken = new Readable({
      read() {
        this.push(Buffer.from("abc"));
        setImmediate(() => this.destroy(new Error("cortou")));
      },
    });
    expect(await status(service.upload("projeto", "", "c.bin", false, broken))).toBeDefined();
    expect(await readdir(work)).toEqual(["ok.bin"]);
  });
});
