import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileCountPath, fileCreatePath, fileDeletePath, fileListPath, fileRawPath, fileRenamePath, fileUploadPath, fileWritePath, fileReadPath, fileRootsPath, fileSearchPath, FILE_LIMITS, FILE_ROOT_DATA, type FileListResponse, type FileReadResponse, type FileRootsResponse, type FileSearchResponse } from "@cyno/shared";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { useTempDirs } from "../dev/test-utils";
import { installErrorHandlers } from "../platform/http/errors";
import { FilesService } from "../workspace/files/service";
import { registerFileRoutes } from "./files";

const tempDir = useTempDirs();
const closers: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

async function setup() {
  const base = await tempDir();
  const data = path.join(base, "dados");
  const work = path.join(base, "projeto");
  await Promise.all([mkdir(data), mkdir(work)]);
  const files = new FilesService({ dataDir: data, folders: () => [{ id: "projeto", name: "Projeto", path: work, mode: "write" }, { id: "sumiu", name: "Sumiu", path: path.join(base, "sumiu"), mode: "read" }] });
  const app: FastifyInstance = Fastify();
  installErrorHandlers(app);
  await app.register(async (scope) => registerFileRoutes(scope, () => files), { prefix: "/api/w/:ws" });
  closers.push(() => app.close());
  return { app, work, data, base };
}

describe("rotas de arquivos", () => {
  it("raízes, lista, leitura e busca", async () => {
    const { app, work } = await setup();
    await writeFile(path.join(work, "léia-me.md"), "# Oi");
    const roots = (await app.inject({ method: "GET", url: fileRootsPath("w") })).json<FileRootsResponse>().roots;
    expect(roots.map((r) => r.id)).toEqual([FILE_ROOT_DATA, "projeto", "sumiu"]);
    expect(roots[2]!.error).toBeTruthy();
    const list = (await app.inject({ method: "GET", url: fileListPath("w", "projeto", "", { filter: "LÉIA" }) })).json<FileListResponse>();
    expect(list).toMatchObject({ total: 1, more: false });
    const read = (await app.inject({ method: "GET", url: fileReadPath("w", "projeto", "léia-me.md") })).json<FileReadResponse>();
    expect(read).toMatchObject({ view: "markdown", text: "# Oi" });
    const version = "version" in read ? read.version : "";
    expect((await app.inject({ method: "GET", url: fileReadPath("w", "projeto", "léia-me.md", version) })).json()).toEqual({ unchanged: true, version });
    const search = (await app.inject({ method: "GET", url: fileSearchPath("w", "projeto", "léia") })).json<FileSearchResponse>();
    expect(search.matches).toEqual([{ path: "léia-me.md", name: "léia-me.md", kind: "file" }]);
  });

  it("raw: imagem na tela, anexo para o resto e imagem grande demais", async () => {
    const { app, work } = await setup();
    await writeFile(path.join(work, "p.png"), "png");
    await writeFile(path.join(work, "relatório.txt"), "texto");
    const image = await app.inject({ method: "GET", url: fileRawPath("w", "projeto", "p.png") });
    expect(image.headers["content-type"]).toBe("image/png");
    expect(image.headers["content-length"]).toBe("3");
    expect(image.headers["content-disposition"]).toBeUndefined();
    expect(image.headers["x-content-type-options"]).toBe("nosniff");
    expect(image.headers["content-security-policy"]).toBe("sandbox");
    expect(image.headers["cache-control"]).toBe("no-store");
    const forced = await app.inject({ method: "GET", url: fileRawPath("w", "projeto", "p.png", true) });
    expect(forced.headers["content-type"]).toBe("application/octet-stream");
    expect(forced.headers["content-disposition"]).toContain("attachment");
    const text = await app.inject({ method: "GET", url: fileRawPath("w", "projeto", "relatório.txt") });
    expect(text.headers["content-type"]).toBe("application/octet-stream");
    expect(text.headers["content-disposition"]).toContain("filename*=UTF-8''relat%C3%B3rio.txt");
    expect(text.body).toBe("texto");
    const big = path.join(work, "g.png");
    const { truncate } = await import("node:fs/promises");
    await writeFile(big, "");
    await truncate(big, FILE_LIMITS.imageBytes + 1);
    const huge = await app.inject({ method: "GET", url: fileRawPath("w", "projeto", "g.png") });
    expect(huge.headers["content-type"]).toBe("application/octet-stream");
    expect(huge.headers["content-disposition"]).toContain("attachment");
  });

  it("404, 403 e travessia 400", async () => {
    const { app, work, base } = await setup();
    await mkdir(path.join(base, "fora"));
    await symlink(path.join(base, "fora"), path.join(work, "saida"));
    await writeFile(path.join(work, ".env"), "A=1");
    const get = async (url: string) => app.inject({ method: "GET", url });
    expect((await get(fileReadPath("w", "projeto", "nada.txt"))).statusCode).toBe(404);
    expect((await get(fileReadPath("w", "desconhecida", ""))).statusCode).toBe(404);
    expect((await get(fileListPath("w", "projeto", "saida"))).statusCode).toBe(403);
    expect((await get(fileRawPath("w", "projeto", ".env"))).statusCode).toBe(403);
    expect((await get(fileReadPath("w", "projeto", "../x"))).statusCode).toBe(400);
    expect((await get(fileRawPath("w", "projeto", "/etc/passwd"))).statusCode).toBe(400);
    expect((await get(fileListPath("w", "projeto", "a/../../x"))).statusCode).toBe(400);
    expect((await get(fileRawPath("w", "projeto", "."))).statusCode).toBe(400);
  });

  it("leitura para edição, gravação, criação, renomeação, contagem e exclusão", async () => {
    const { app, work } = await setup();
    await writeFile(path.join(work, "c.txt"), "API_KEY=sk-abcdef1234567890abcdef1234567890\r\n");
    const edit = (await app.inject({ method: "GET", url: fileReadPath("w", "projeto", "c.txt", undefined, true) })).json<{ text: string; version: string }>();
    expect(edit.text).toBe("API_KEY=sk-abcdef1234567890abcdef1234567890\r\n");
    const put = await app.inject({ method: "PUT", url: fileWritePath("w"), payload: { root: "projeto", path: "c.txt", text: "novo", baseVersion: edit.version } });
    expect(put.statusCode).toBe(200);
    const stale = await app.inject({ method: "PUT", url: fileWritePath("w"), payload: { root: "projeto", path: "c.txt", text: "x", baseVersion: "1-1" } });
    expect(stale.statusCode).toBe(409);
    expect((await app.inject({ method: "POST", url: fileCreatePath("w"), payload: { root: "projeto", path: "d", kind: "dir" } })).statusCode).toBe(201);
    expect((await app.inject({ method: "POST", url: fileCreatePath("w"), payload: { root: "projeto", path: "d", kind: "dir" } })).statusCode).toBe(409);
    const moved = await app.inject({ method: "POST", url: fileRenamePath("w"), payload: { root: "projeto", from: "c.txt", to: "d/c.txt" } });
    expect(moved.json()).toEqual({ root: "projeto", path: "d/c.txt" });
    expect((await app.inject({ method: "GET", url: fileCountPath("w", "projeto", "") })).json()).toMatchObject({ files: 1, dirs: 1 });
    const del = await app.inject({ method: "POST", url: fileDeletePath("w"), payload: { root: "projeto", path: "d" } });
    expect(del.json()).toMatchObject({ deleted: 2 });
    expect(await readFile(path.join(work, "x.txt")).catch(() => "nada")).toBe("nada");
  });

  it("alterações: travessia 400, raiz desconhecida 404, dados e só leitura 403", async () => {
    const { app } = await setup();
    const send = (method: "PUT" | "POST", url: string, payload: unknown) => app.inject({ method, url, payload: payload as object });
    expect((await send("PUT", fileWritePath("w"), { root: "projeto", path: "../x", text: "" })).statusCode).toBe(400);
    expect((await send("PUT", fileWritePath("w"), { root: "projeto", path: "/etc/x", text: "" })).statusCode).toBe(400);
    expect((await send("POST", fileCreatePath("w"), { root: "projeto", path: "a/../../x", kind: "file" })).statusCode).toBe(400);
    expect((await send("POST", fileRenamePath("w"), { root: "projeto", from: "a", to: "../b" })).statusCode).toBe(400);
    expect((await send("POST", fileDeletePath("w"), { root: "projeto", path: "" })).statusCode).toBe(400);
    expect((await send("POST", fileDeletePath("w"), { root: "nada", path: "x" })).statusCode).toBe(404);
    expect((await send("POST", fileCreatePath("w"), { root: FILE_ROOT_DATA, path: "x", kind: "file" })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: fileUploadPath("w", "projeto", "", "../x") , payload: "x", headers: { "content-type": "application/octet-stream" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: fileUploadPath("w", "nada", "", "x"), payload: "x", headers: { "content-type": "application/octet-stream" } })).statusCode).toBe(404);
  });

  it("envio de bytes crus: 201, 409 e overwrite", async () => {
    const { app, work } = await setup();
    const headers = { "content-type": "application/octet-stream" };
    const first = await app.inject({ method: "POST", url: fileUploadPath("w", "projeto", "", "dado.bin"), payload: Buffer.from([0, 255, 7]), headers });
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({ path: "dado.bin", size: 3 });
    expect((await app.inject({ method: "POST", url: fileUploadPath("w", "projeto", "", "dado.bin"), payload: "x", headers })).statusCode).toBe(409);
    expect((await app.inject({ method: "POST", url: fileUploadPath("w", "projeto", "", "dado.bin", true), payload: "novo", headers })).statusCode).toBe(201);
    expect(await readFile(path.join(work, "dado.bin"), "utf8")).toBe("novo");
  });
});
