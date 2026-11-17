import type { MediaItem } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { fakePng } from "../workspace/media/test-files";
import { call, createWorkspace, wsApi } from "../dev/test-api";
import { useTestApp } from "../dev/test-app";
import { parseRange } from "./media";

const setupApp = useTestApp();

const upload = (app: Awaited<ReturnType<typeof setupApp>>["app"], body: Buffer | string, mime: string, query = "fileName=capa.png&title=Capa") =>
  app.inject({ method: "POST", url: `${wsApi()}/media?${query}`, payload: body, headers: { "content-type": mime } });

describe("API: biblioteca de mídia", () => {
  it("upload cru do usuário -> item; lista, detalhe, PATCH e DELETE", async () => {
    const { app } = await setupApp();
    const response = await upload(app, fakePng(300, 200), "image/png");
    expect(response.statusCode, response.body).toBe(201);
    const item = response.json<MediaItem>();
    expect(item).toMatchObject({ id: "M-0001", kind: "image", width: 300, height: 200, createdBy: "usuario", origin: "upload", title: "Capa", status: "rascunho" });

    expect((await call<MediaItem[]>(app, "GET", `${wsApi()}/media?kind=image&agentId=usuario&q=capa`)).map((entry) => entry.id)).toEqual(["M-0001"]);
    expect(await call<MediaItem[]>(app, "GET", `${wsApi()}/media?kind=video`)).toEqual([]);
    expect((await call<MediaItem>(app, "GET", `${wsApi()}/media/M-0001`)).title).toBe("Capa");

    const patched = await call<MediaItem>(app, "PATCH", `${wsApi()}/media/M-0001`, { status: "publicado", publishedUrl: "https://linkedin.com/posts/1", where: "Post no LinkedIn", tags: ["post"] });
    expect(patched).toMatchObject({ status: "publicado", publishedUrl: "https://linkedin.com/posts/1", where: "Post no LinkedIn", tags: ["post"] });
    expect((await app.inject({ method: "PATCH", url: `${wsApi()}/media/M-0001`, payload: { status: "voando" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: `${wsApi()}/media/M-0099` })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `${wsApi()}/media/xyz` })).statusCode).toBe(400);

    await call(app, "DELETE", `${wsApi()}/media/M-0001`);
    expect((await app.inject({ method: "GET", url: `${wsApi()}/media/M-0001/file` })).statusCode).toBe(404);
  });

  it("valida o upload: conteúdo falso, vazio e sem nome; tipo desconhecido e tamanho grande são aceitos", async () => {
    const { app } = await setupApp();
    expect((await upload(app, "não sou png", "image/png")).statusCode).toBe(415);
    expect((await upload(app, Buffer.alloc(0), "image/png")).statusCode).toBeGreaterThanOrEqual(400);
    expect((await upload(app, fakePng(1, 1), "image/png", "title=sem-nome")).statusCode).toBe(400);
    const exe = await upload(app, "MZ...", "application/x-msdownload", "fileName=programa.exe");
    expect(exe.statusCode, exe.body).toBe(201);
    expect(exe.json<MediaItem>()).toMatchObject({ kind: "other", mime: "application/octet-stream", fileName: "programa.exe" });
    const noType = await app.inject({ method: "POST", url: `${wsApi()}/media?fileName=Orcamento.xlsx`, payload: Buffer.from([0x50, 0x4b, 0x03, 0x04, 9]), headers: { "content-type": "application/octet-stream" } });
    expect(noType.json<MediaItem>()).toMatchObject({ kind: "document", mime: expect.stringContaining("spreadsheetml") });
    // Acima dos antigos 25 MB de imagem (e do bodyLimit padrão de 1 MB): passa, em fluxo.
    const big = await app.inject({ method: "POST", url: `${wsApi()}/media?fileName=imenso.dat`, payload: Buffer.alloc(60 * 1024 * 1024, 1), headers: { "content-type": "application/octet-stream" } });
    expect(big.statusCode, big.body).toBe(201);
    expect(big.json<MediaItem>().size).toBe(60 * 1024 * 1024);
  });

  it("o que o app não exibe vai como download (attachment) com nosniff + CSP sandbox", async () => {
    const { app } = await setupApp();
    await app.inject({ method: "POST", url: `${wsApi()}/media?fileName=Plano.xlsx`, payload: Buffer.from([0x50, 0x4b, 0x03, 0x04, 9]), headers: { "content-type": "application/octet-stream" } });
    await app.inject({ method: "POST", url: `${wsApi()}/media?fileName=dados.zzz`, payload: "oi", headers: { "content-type": "application/octet-stream" } });
    for (const id of ["M-0001", "M-0002"]) {
      const file = await app.inject({ method: "GET", url: `${wsApi()}/media/${id}/file` });
      expect(file.headers["content-disposition"]).toMatch(/^attachment;/);
      expect(file.headers).toMatchObject({ "x-content-type-options": "nosniff", "content-security-policy": "sandbox" });
    }
    await app.inject({ method: "POST", url: `${wsApi()}/media?fileName=a.png`, payload: fakePng(2, 2), headers: { "content-type": "image/png" } });
    expect((await app.inject({ method: "GET", url: `${wsApi()}/media/M-0003/file` })).headers["content-disposition"]).toMatch(/^inline;/);
  });

  it("pastas: criar, enviar para a pasta, mover, renomear e apagar pela API", async () => {
    const { app } = await setupApp();
    const created = await call<{ folders: string[]; folder: string }>(app, "POST", `${wsApi()}/media/folders`, { name: "Livros" });
    expect(created).toEqual({ folders: ["Livros"], folder: "Livros" });
    await call(app, "POST", `${wsApi()}/media/folders`, { name: "Matemática", parent: "Livros" });
    expect((await app.inject({ method: "POST", url: `${wsApi()}/media/folders`, payload: { name: "Livros" } })).statusCode).toBe(409);
    expect((await app.inject({ method: "POST", url: `${wsApi()}/media/folders`, payload: { name: "..", parent: "" } })).statusCode).toBe(400);
    const sent = await upload(app, fakePng(3, 3), "image/png", `fileName=a.png&folder=${encodeURIComponent("Livros/Matemática")}`);
    expect(sent.json<MediaItem>().folder).toBe("Livros/Matemática");
    expect((await upload(app, fakePng(3, 3), "image/png", "fileName=b.png&folder=..%2Fx")).statusCode).toBe(400);
    expect((await call<MediaItem[]>(app, "GET", `${wsApi()}/media?folder=${encodeURIComponent("Livros/Matemática")}`)).map((item) => item.id)).toEqual(["M-0001"]);
    expect(await call<MediaItem[]>(app, "GET", `${wsApi()}/media?folder=`)).toEqual([]);
    await upload(app, fakePng(3, 3), "image/png", "fileName=b.png");
    const moved = await call<{ items: MediaItem[]; folders: string[] }>(app, "POST", `${wsApi()}/media/move`, { ids: ["M-0002", "M-0001"], folder: "Arquivo" }, 200);
    expect(moved.items.map((item) => item.folder)).toEqual(["Arquivo", "Arquivo"]);
    expect(moved.folders).toContain("Arquivo");
    expect((await call<MediaItem>(app, "PATCH", `${wsApi()}/media/M-0002`, { folder: null })).folder).toBeUndefined();
    const renamed = await call<{ folder: string }>(app, "PATCH", `${wsApi()}/media/folders`, { path: "Arquivo", name: "Guardados" });
    expect(renamed.folder).toBe("Guardados");
    expect((await call<MediaItem>(app, "GET", `${wsApi()}/media/M-0001`)).folder).toBe("Guardados");
    const removed = await call<{ folders: string[]; folder: string }>(app, "DELETE", `${wsApi()}/media/folders?path=Guardados`, undefined, 200);
    expect(removed.folder).toBe("");
    expect((await call<MediaItem>(app, "GET", `${wsApi()}/media/M-0001`)).folder).toBeUndefined();
    expect((await app.inject({ method: "GET", url: `${wsApi()}/media/M-0001/file` })).statusCode).toBe(200);
    expect((await call<{ folders: string[] }>(app, "GET", `${wsApi()}/media/folders`)).folders).toEqual(["Livros", "Livros/Matemática"]);
  });

  it("upload de JSON e de texto também chega cru (o parser é só desta rota) e as outras rotas seguem com JSON", async () => {
    const { app } = await setupApp();
    const json = await upload(app, '{"a":1}', "application/json", "fileName=dados.json");
    expect(json.statusCode, json.body).toBe(201);
    expect(json.json<MediaItem>()).toMatchObject({ kind: "document", mime: "application/json", size: 7 });
    const patched = await call<MediaItem>(app, "PATCH", `${wsApi()}/media/M-0001`, { title: "Dados" });
    expect(patched.title).toBe("Dados");
  });

  it("serve o arquivo com nosniff + CSP sandbox, Range (206/416) e HTML/Markdown como texto puro", async () => {
    const { app } = await setupApp();
    const png = fakePng(2, 2);
    await upload(app, png, "image/png", "fileName=a.png");
    const full = await app.inject({ method: "GET", url: `${wsApi()}/media/M-0001/file` });
    expect(full.statusCode).toBe(200);
    expect(full.headers).toMatchObject({ "x-content-type-options": "nosniff", "content-security-policy": "sandbox", "content-type": "image/png", "accept-ranges": "bytes" });
    expect(full.rawPayload.equals(png)).toBe(true);

    const part = await app.inject({ method: "GET", url: `${wsApi()}/media/M-0001/file`, headers: { range: "bytes=8-15" } });
    expect(part.statusCode).toBe(206);
    expect(part.headers["content-range"]).toBe("bytes 8-15/33");
    expect(part.rawPayload.equals(png.subarray(8, 16))).toBe(true);
    const tail = await app.inject({ method: "GET", url: `${wsApi()}/media/M-0001/file`, headers: { range: "bytes=-3" } });
    expect(tail.rawPayload.equals(png.subarray(30))).toBe(true);
    const bad = await app.inject({ method: "GET", url: `${wsApi()}/media/M-0001/file`, headers: { range: "bytes=99-120" } });
    expect(bad.statusCode).toBe(416);
    expect(bad.headers["content-range"]).toBe("bytes */33");

    await upload(app, "<script>alert(1)</script>", "text/html", "fileName=pagina.html");
    const html = await app.inject({ method: "GET", url: `${wsApi()}/media/M-0002/file` });
    expect(html.headers["content-type"]).toBe("text/plain; charset=utf-8");
    expect(html.headers["content-security-policy"]).toBe("sandbox");
    await upload(app, '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', "image/svg+xml", "fileName=a.svg");
    const svg = await app.inject({ method: "GET", url: `${wsApi()}/media/M-0003/file` });
    expect(svg.headers).toMatchObject({ "content-type": "image/svg+xml", "content-security-policy": "sandbox", "x-content-type-options": "nosniff" });
    const download = await app.inject({ method: "GET", url: `${wsApi()}/media/M-0001/file?download=1` });
    expect(download.headers["content-disposition"]).toContain("attachment");
  });

  it("workspace inexistente é 404", async () => {
    const { app } = await setupApp();
    expect((await app.inject({ method: "GET", url: "/api/w/nao-existe/media" })).statusCode).toBe(404);
  });
});

describe("parseRange", () => {
  it("faixas válidas e inválidas", () => {
    expect(parseRange("bytes=0-99", 1000)).toEqual({ start: 0, end: 99 });
    expect(parseRange("bytes=900-", 1000)).toEqual({ start: 900, end: 999 });
    expect(parseRange("bytes=-100", 1000)).toEqual({ start: 900, end: 999 });
    expect(parseRange("bytes=0-5000", 1000)).toEqual({ start: 0, end: 999 });
    expect(parseRange("bytes=1000-1001", 1000)).toBeNull();
    expect(parseRange("bytes=5-2", 1000)).toBeNull();
    expect(parseRange("items=0-1", 1000)).toBeNull();
    expect(parseRange("bytes=0-1,5-6", 1000)).toBeNull();
  });

  it("traz a mídia de outro workspace: copia o arquivo, guarda a origem e não mexe no original", async () => {
    const { app, workspaces } = await setupApp();
    const design = await createWorkspace(app, "Design");
    const posts = await createWorkspace(app, "Posts");
    const art = await workspaces.get(design.id).media.addBuffer(fakePng(40, 30), "image/png", { title: "Arte", createdBy: "ana", origin: "html" });
    // Ler outro workspace é só trocar o :ws da rota de listagem.
    expect((await call<MediaItem[]>(app, "GET", `${wsApi(design.id)}/media`)).map((item) => item.id)).toEqual([art.id]);

    const copy = await call<MediaItem>(app, "POST", `${wsApi(posts.id)}/media/bring`, { workspace: design.id, mediaId: art.id }, 201);
    expect(copy).toMatchObject({ id: "M-0001", title: "Arte", origin: "mural", status: "rascunho", note: `Veio de Design · ${art.id}` });
    expect((await call<MediaItem[]>(app, "GET", `${wsApi(design.id)}/media`)).length).toBe(1);
    expect((await app.inject({ method: "GET", url: `${wsApi(posts.id)}/media/M-0001/file` })).statusCode).toBe(200);

    await call(app, "POST", `${wsApi(design.id)}/media/bring`, { workspace: design.id, mediaId: art.id }, 409);
    await call(app, "POST", `${wsApi(posts.id)}/media/bring`, { workspace: design.id, mediaId: "M-0099" }, 404);
    await call(app, "POST", `${wsApi(posts.id)}/media/bring`, { workspace: "nada", mediaId: art.id }, 404);
    await call(app, "POST", `${wsApi(posts.id)}/media/bring`, { workspace: design.id }, 400);
  });
});
