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

  it("valida o upload: tipo fora da lista, conteúdo falso, vazio e acima do limite declarado", async () => {
    const { app } = await setupApp();
    expect((await upload(app, "MZ...", "application/x-msdownload")).statusCode).toBe(415);
    expect((await upload(app, "não sou png", "image/png")).statusCode).toBe(415);
    expect((await upload(app, Buffer.alloc(0), "image/png")).statusCode).toBeGreaterThanOrEqual(400);
    expect((await upload(app, fakePng(1, 1), "image/png", "title=sem-nome")).statusCode).toBe(400);
    const tooBig = await app.inject({ method: "POST", url: `${wsApi()}/media?fileName=a.png`, payload: fakePng(1, 1), headers: { "content-type": "image/png", "content-length": String(26 * 1024 * 1024) } });
    expect([400, 413]).toContain(tooBig.statusCode);
    expect(await call<MediaItem[]>(app, "GET", `${wsApi()}/media`)).toEqual([]);
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
