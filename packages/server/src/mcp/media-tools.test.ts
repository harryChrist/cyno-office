import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { workspaceAccess, type OfficeState } from "@cyno/shared";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { BrowserService } from "../workspace/browser/service";
import { startTestSite } from "../workspace/browser/test-site";
import { UrlPolicy } from "../workspace/browser/url-policy";
import { MediaService } from "../workspace/media/media-service";
import { fakePng } from "../workspace/media/test-files";
import { WriteQueue } from "../store/write-queue";
import { useTempDirs } from "../dev/test-utils";
import { officeToolsFor, type OfficeToolsDeps } from "./office-tools";
import { handleMcpPayload } from "./protocol";

const silent = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined } as never;

const STATE = {
  rooms: [
    { id: "gerencia", name: "Sala do Maestro", kind: "maestro" },
    { id: "conteudo", name: "Conteúdo", kind: "team" },
  ],
  teams: [
    { id: "t-ger", roomId: "gerencia", name: "Gerência", focus: "coordenar" },
    { id: "t-cont", roomId: "conteudo", name: "Conteúdo", focus: "textos" },
  ],
  agents: [
    { id: "maestro", teamId: "t-ger", name: "Maestro" },
    { id: "clara", teamId: "t-cont", name: "Clara" },
  ],
  tasks: [{ id: "sub-1" }],
} as unknown as OfficeState;

let site: Awaited<ReturnType<typeof startTestSite>>;
beforeAll(async () => {
  site = await startTestSite();
});
afterAll(async () => {
  await site.close();
});

const tempDir = useTempDirs();
const services: BrowserService[] = [];
const queues: WriteQueue[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
  await Promise.all(queues.splice(0).map((queue) => queue.idle()));
});

async function setup() {
  const dir = await tempDir();
  const queue = new WriteQueue();
  queues.push(queue);
  const media = new MediaService([], {
    dir: path.join(dir, "media"),
    file: path.join(dir, "media", "media.json"),
    filesDir: path.join(dir, "media", "files"),
    queue,
    publish: () => undefined,
    log: { warn: () => undefined, error: () => undefined },
    now: () => new Date("2026-11-10T12:00:00.000Z"),
  });
  const browser = new BrowserService({
    profileDir: path.join(dir, "browser", "profile"),
    policy: new UrlPolicy({ allowPrivateNetwork: true }),
    idleMs: 0,
    approvalsRequired: () => true,
    ownerName: (owner) => owner,
    publish: () => undefined,
    now: () => new Date(),
    log: silent,
  });
  services.push(browser);
  const render = vi.fn(async () => fakePng(1200, 630));
  const runner = { requestApproval: vi.fn(() => "Approval request sent."), hasActive: () => true, currentTaskId: () => "sub-1" };
  const maestro = { requestApproval: vi.fn(() => "Approval request A-0001 sent.") };
  const task = { id: "sub-1", projectId: "req-1" };
  const forYou = { list: () => [{ id: "A-0001", agentId: "clara", taskId: "sub-1", status: "pendente", kind: undefined, type: "outro" }], update: vi.fn(async () => ({ answers: {} })), cancel: vi.fn() };
  const deps = {
    state: { read: () => STATE },
    maestro,
    runner,
    forYou,
    forYouTypes: { list: () => [], define: vi.fn() },
    structure: {},
    browser: { browser, access: () => workspaceAccess({}), approve: vi.fn(), media: { library: media, currentTask: () => task } },
    media: { media, agentDir: (id: string) => path.join(dir, "agents", id), currentTask: () => task, render },
  } as unknown as OfficeToolsDeps;
  const call = async (agentId: string, name: string, args: Record<string, unknown> = {}) => {
    const response = (await handleMcpPayload({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, () => officeToolsFor(agentId, deps))) as {
      result?: { content: { type: string; text?: string }[]; isError: boolean };
      error?: { message: string };
    };
    if (!response.result) throw new Error(response.error?.message);
    return { isError: response.result.isError, text: response.result.content.map((block) => block.text ?? "").join("\n") };
  };
  return { dir, media, render, runner, maestro, forYou, call, browser };
}

describe("ferramentas media_*", () => {
  it("media_render_html guarda a imagem ligada à tarefa atual e devolve id e caminho", async () => {
    const { media, render, call } = await setup();
    const result = await call("clara", "media_render_html", { html: "<h1>Oi</h1>", width: 1200, height: 630, title: "Capa do post", scale: 2 });
    expect(result.isError).toBe(false);
    expect(result.text).toContain("M-0001");
    // Nunca devolve o caminho da biblioteca (fora da pasta do agente): devolve a prévia relativa.
    expect(result.text).not.toContain(media.fileOf(media.get("M-0001")));
    expect(result.text).toContain("previa/M-0001.png");
    expect(render).toHaveBeenCalledWith({ html: "<h1>Oi</h1>", width: 1200, height: 630, format: "png", scale: 2 });
    expect(media.get("M-0001")).toMatchObject({ origin: "html", createdBy: "clara", taskId: "sub-1", rootTaskId: "req-1", width: 1200, height: 630 });
    // Tamanho acima de 4096 nem chega ao render (o schema recusa).
    expect(await call("clara", "media_render_html", { html: "x", width: 5000, height: 100, title: "t" })).toMatchObject({ isError: true, text: expect.stringContaining("width") });
  });

  it("a prévia fica na pasta do agente, reduzida (lado maior 1024), e media_view abre qualquer item", async () => {
    const { dir, render, call } = await setup();
    const result = await call("clara", "media_render_html", { html: "<h1>Oi</h1>", width: 1200, height: 630, title: "Capa" });
    expect(result.text).toContain("LOOK AT IT");
    expect(result.text).toContain("Reduced to 1024x538");
    // A segunda chamada ao render é a redução, com a imagem em data: URI no tamanho final.
    expect(render).toHaveBeenCalledTimes(2);
    const second = (render.mock.calls[1] as unknown as [{ width: number; height: number; format: string; html: string }])[0];
    expect(second).toMatchObject({ width: 1024, height: 538, format: "png" });
    expect(second.html).toContain("data:image/png;base64,");
    expect((await stat(path.join(dir, "agents", "clara", "previa", "M-0001.png"))).isFile()).toBe(true);
    // Imagem que já cabe: só copia (o render não é chamado de novo).
    render.mockResolvedValueOnce(fakePng(800, 800));
    await call("clara", "media_render_html", { html: "x", width: 800, height: 800, title: "Quadrada" });
    expect(render).toHaveBeenCalledTimes(3);
    const view = await call("clara", "media_view", { id: "M-0002" });
    expect(view.isError).toBe(false);
    expect(view.text).toContain('"previa/M-0002.png"');
    expect(render).toHaveBeenCalledTimes(3);
    expect((await call("clara", "media_view", { id: "M-0099" })).isError).toBe(true);
  });

  it("media_save_file copia só da pasta do próprio agente", async () => {
    const { dir, media, call } = await setup();
    const own = path.join(dir, "agents", "clara");
    await mkdir(own, { recursive: true });
    await writeFile(path.join(own, "arte.png"), fakePng(10, 10));
    await writeFile(path.join(dir, "fora.png"), fakePng(10, 10));
    const ok = await call("clara", "media_save_file", { path: "arte.png", title: "Arte", note: "v2" });
    expect(ok.isError).toBe(false);
    expect(media.get("M-0001")).toMatchObject({ origin: "arquivo", note: "v2", rootTaskId: "req-1" });
    const out = await call("clara", "media_save_file", { path: "../../fora.png", title: "Fora" });
    expect(out.isError).toBe(true);
    expect(out.text).toContain("inside your own agent folder");
  });

  it("media_list e media_update (publicado com a URL; aprovado e apagar não existem para o agente)", async () => {
    const { call, media } = await setup();
    await call("clara", "media_render_html", { html: "x", width: 100, height: 100, title: "A" });
    expect((await call("clara", "media_list", { taskId: "req-1" })).text).toContain("M-0001");
    expect((await call("clara", "media_list", { status: "publicado" })).text).toBe("No media found.");
    const updated = await call("clara", "media_update", { id: "M-0001", status: "publicado", publishedUrl: "https://linkedin.com/posts/9", where: "Post no LinkedIn" });
    expect(updated.isError).toBe(false);
    expect(media.get("M-0001")).toMatchObject({ status: "publicado", publishedUrl: "https://linkedin.com/posts/9", where: "Post no LinkedIn" });
    expect(await call("clara", "media_update", { id: "M-0001", status: "aprovado" })).toMatchObject({ isError: true, text: expect.stringContaining("status") });
    expect((await call("clara", "media_update", { id: "M-0042", title: "x" })).isError).toBe(true);
    expect((await call("clara", "media_update", { id: "M-0001" })).isError).toBe(true);
  });
});

describe("pastas e arquivo original para o agente", () => {
  it("media_save_file com pasta, media_list por pasta, media_list_folders e media_update movendo", async () => {
    const { dir, media, call } = await setup();
    const own = path.join(dir, "agents", "clara");
    await mkdir(own, { recursive: true });
    await writeFile(path.join(own, "livro.epub"), Buffer.from([0x50, 0x4b, 0x03, 0x04, 1]));
    await writeFile(path.join(own, "arte.png"), fakePng(10, 10));
    expect((await call("clara", "media_list_folders")).text).toContain("No folders yet");
    const saved = await call("clara", "media_save_file", { path: "livro.epub", title: "Livro", folder: "Livros/Matemática" });
    expect(saved.isError).toBe(false);
    expect(saved.text).toContain("folder Livros/Matemática");
    await call("clara", "media_save_file", { path: "arte.png", title: "Arte" });
    expect(media.get("M-0001")).toMatchObject({ kind: "document", folder: "Livros/Matemática" });
    const folders = (await call("clara", "media_list_folders")).text;
    expect(folders).toContain("Livros/Matemática — 1 item");
    expect(folders).toContain("Livros — 0 items (1 with subfolders)");
    expect((await call("clara", "media_list", { folder: "Livros/Matemática" })).text).toMatch(/M-0001.*folder: Livros\/Matemática/);
    expect((await call("clara", "media_list", { folder: "" })).text).toContain("M-0002");
    expect((await call("clara", "media_list", { folder: "" })).text).not.toContain("M-0001");
    const moved = await call("clara", "media_update", { id: "M-0002", folder: "Imagens" });
    expect(moved.isError).toBe(false);
    expect(media.get("M-0002").folder).toBe("Imagens");
    expect((await call("clara", "media_update", { id: "M-0002", folder: "" })).isError).toBe(false);
    expect(media.get("M-0002").folder).toBeUndefined();
    expect((await call("clara", "media_update", { id: "M-0002", folder: "../x" })).isError).toBe(true);
  });

  it("media_get_file copia o original para midia/ na pasta do agente e media_view de documento aponta para ela", async () => {
    const { dir, media, call } = await setup();
    const own = path.join(dir, "agents", "clara");
    await mkdir(own, { recursive: true });
    await writeFile(path.join(own, "Plano 2026.xlsx"), Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]));
    await call("clara", "media_save_file", { path: "Plano 2026.xlsx", title: "Plano" });
    const view = await call("clara", "media_view", { id: "M-0001" });
    expect(view.text).toContain("media_get_file");
    expect(view.text).not.toContain("cannot be viewed");
    const got = await call("clara", "media_get_file", { id: "M-0001" });
    expect(got.isError).toBe(false);
    expect(got.text).toContain('"midia/M-0001-Plano_2026.xlsx"');
    expect(got.text).toContain("COPY");
    expect((await stat(path.join(own, "midia", "M-0001-Plano_2026.xlsx"))).size).toBe(7);
    expect(got.text).not.toContain(media.fileOf(media.get("M-0001")));
    expect(media.get("M-0001").size).toBe(7);
    expect((await call("clara", "media_get_file", { id: "M-0099" })).isError).toBe(true);
    expect((await call("clara", "media_get_file", { id: "xx" })).isError).toBe(true);
  });
});

describe("request_approval com mediaIds e sources", () => {
  it("valida os ids e repassa mídia e fontes (agente e Maestro)", async () => {
    const { runner, maestro, call } = await setup();
    await call("clara", "media_render_html", { html: "x", width: 100, height: 100, title: "A" });
    const source = { kind: "post", author: "Mayk Brito", authorDetail: "55 mil seguidores", url: "https://lnkd.in/p/x", content: "texto inteiro do post", summary: "resumo", facts: [{ label: "Conexões em comum", value: "22" }], mediaIds: ["M-0001"] };
    const ok = await call("clara", "request_approval", { question: "Posso comentar?", text: "Ótimo post!", where: "Comentário", mediaIds: ["M-0001"], sources: [source] });
    expect(ok.isError).toBe(false);
    expect(runner.requestApproval).toHaveBeenCalledWith("clara", "Posso comentar?", { type: undefined, text: "Ótimo post!", where: "Comentário", to: undefined, mediaIds: ["M-0001"], sources: [source] });

    const missing = await call("clara", "request_approval", { question: "?", text: "t", mediaIds: ["M-0077"] });
    expect(missing).toMatchObject({ isError: true });
    expect(missing.text).toContain("M-0077");
    const missingInSource = await call("maestro", "request_approval", { question: "?", sources: [{ kind: "page", mediaIds: ["M-0078"] }] });
    expect(missingInSource.isError).toBe(true);
    expect(runner.requestApproval).toHaveBeenCalledTimes(1);

    const viaMaestro = await call("maestro", "request_approval", { question: "Convite?", text: "Oi!", sources: [{ kind: "profile", content: "Dev Go em SP" }], mediaIds: ["M-0001"] });
    expect(viaMaestro.isError).toBe(false);
    expect(maestro.requestApproval).toHaveBeenCalledWith(expect.objectContaining({ question: "Convite?", mediaIds: ["M-0001"], sources: [{ kind: "profile", content: "Dev Go em SP" }] }));
  });

  it("a descrição manda sempre mandar as fontes (as duas versões) e aceita conteúdo longo (o server corta depois)", async () => {
    const { call, runner } = await setup();
    const listed = (await handleMcpPayload({ jsonrpc: "2.0", id: 1, method: "tools/list" }, () => [])) as unknown;
    expect(listed).toBeTruthy();
    const long = await call("clara", "request_approval", { question: "?", text: "t", sources: [{ kind: "post", content: "p".repeat(20_000) }] });
    expect(long.isError).toBe(false);
    expect(runner.requestApproval).toHaveBeenCalled();
  });

  it("update_pending_item aceita sources (e recusa mídia que não existe)", async () => {
    const { call, forYou } = await setup();
    const ok = await call("clara", "update_pending_item", { id: "A-0001", sources: [{ kind: "post", author: "Ana", content: "texto" }] });
    expect(ok.text).toContain("updated");
    expect(forYou.update).toHaveBeenCalledWith("A-0001", { sources: [{ kind: "post", author: "Ana", content: "texto" }] }, "agente");
    const bad = await call("clara", "update_pending_item", { id: "A-0001", sources: [{ kind: "post", mediaIds: ["M-0050"] }] });
    expect(bad.isError).toBe(true);
  });
});

describe("browser_upload e browser_screenshot(saveToMedia)", () => {
  it("anexa só mídia da biblioteca a um campo de arquivo (nome original e tipo chegam à página)", async () => {
    const { call, browser } = await setup();
    await call("clara", "media_render_html", { html: "x", width: 100, height: 100, title: "Capa" });
    await browser.open("clara", `${site.url}/upload`, false);
    const result = await call("clara", "browser_upload", { selector: "input[type=file]", mediaIds: ["M-0001"] });
    expect(result.text).not.toMatch(/^Error/);
    expect(await browser.currentUrl("clara")).toContain("/upload");
    expect(result.text).toContain("Capa.png");
    expect(result.text).toContain(":image/png");
  });

  it("recusa id inexistente, descartado, e campo que não é de arquivo", async () => {
    const { call, browser, media } = await setup();
    await call("clara", "media_render_html", { html: "x", width: 100, height: 100, title: "Capa" });
    await browser.open("clara", `${site.url}/upload`, false);
    expect((await call("clara", "browser_upload", { selector: "input[type=file]", mediaIds: ["M-0009"] })).isError).toBe(true);
    media.update("M-0001", { status: "descartado" });
    expect((await call("clara", "browser_upload", { selector: "input[type=file]", mediaIds: ["M-0001"] })).text).toContain("discarded");
    media.update("M-0001", { status: "rascunho" });
    expect((await call("clara", "browser_upload", { selector: "#t", mediaIds: ["M-0001"] })).text).toMatch(/not a file input/);
  });

  it("screenshot com saveToMedia guarda na biblioteca (origem screenshot) e devolve o id", async () => {
    const { call, browser, media } = await setup();
    await browser.open("clara", `${site.url}/feed`, false);
    const result = await call("clara", "browser_screenshot", { saveToMedia: true, title: "Post da Ana" });
    expect(result.text).toContain("M-0001");
    expect(media.get("M-0001")).toMatchObject({ origin: "screenshot", kind: "image", mime: "image/jpeg", title: "Post da Ana", createdBy: "clara", rootTaskId: "req-1" });
    const plain = await call("clara", "browser_screenshot", {});
    expect(plain.text).not.toContain("Saved to the media library");
    expect(media.list()).toHaveLength(1);
  });
});
