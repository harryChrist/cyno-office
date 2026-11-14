import { mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import type { ServerEvent } from "@cyno/shared";
import { afterEach, describe, expect, it } from "vitest";
import { WriteQueue } from "../../store/write-queue";
import { useTempDirs } from "../../dev/test-utils";
import { MediaService, MediaToolError } from "./media-service";
import { fakePng } from "./test-files";
import { contentMatchesMime, imageSize, sniffMime } from "./sniff";

const tempDir = useTempDirs();
/** As gravações pendentes terminam antes de a pasta temporária ser apagada. */
const queues: WriteQueue[] = [];
afterEach(async () => {
  await Promise.all(queues.splice(0).map((queue) => queue.idle()));
});

async function setup() {
  const dir = await tempDir();
  const events: ServerEvent[] = [];
  const queue = new WriteQueue();
  queues.push(queue);
  const media = new MediaService([], {
    dir: path.join(dir, "media"),
    file: path.join(dir, "media", "media.json"),
    filesDir: path.join(dir, "media", "files"),
    queue,
    publish: (event) => events.push(event),
    log: { warn: () => undefined, error: () => undefined },
    now: () => new Date("2026-11-10T12:00:00.000Z"),
  });
  return { dir, events, media, queue };
}

describe("MediaService", () => {
  it("guarda a imagem com id sequencial, dimensões, arquivo e índice, e avisa", async () => {
    const { dir, events, media, queue } = await setup();
    const a = await media.addBuffer(fakePng(1200, 630), "image/png", { title: "Capa", createdBy: "clara", origin: "html", taskId: "t1", rootTaskId: "t0" });
    const b = await media.addBuffer(fakePng(10, 20), "image/png", { title: "Outra", createdBy: "clara", origin: "html" });
    expect(a).toMatchObject({ id: "M-0001", kind: "image", width: 1200, height: 630, status: "rascunho", taskId: "t1", rootTaskId: "t0", origin: "html" });
    expect(b.id).toBe("M-0002");
    await queue.idle();
    expect((await stat(path.join(dir, "media", "files", "M-0001.png"))).size).toBe(33);
    const index = JSON.parse(await readFile(path.join(dir, "media", "media.json"), "utf8")) as { id: string }[];
    expect(index.map((item) => item.id)).toEqual(["M-0001", "M-0002"]);
    expect(events.map((event) => event.type)).toEqual(["media:upserted", "media:upserted"]);
    expect(media.list({ limit: 1 })[0]!.id).toBe("M-0002");
    expect(media.list({ q: "capa" }).map((item) => item.id)).toEqual(["M-0001"]);
    expect(media.list({ taskId: "t0" }).map((item) => item.id)).toEqual(["M-0001"]);
  });

  it("recusa mime fora da lista e conteúdo que não bate com o tipo", async () => {
    const { media } = await setup();
    await expect(media.addBuffer(Buffer.from("MZ"), "application/x-msdownload", { title: "x", createdBy: "u", origin: "upload" })).rejects.toMatchObject({ statusCode: 415 });
    await expect(media.addBuffer(Buffer.from("isto não é um png"), "image/png", { title: "x", createdBy: "u", origin: "upload" })).rejects.toMatchObject({ statusCode: 415 });
    expect(media.list()).toHaveLength(0);
  });

  it("upload por fluxo respeita o limite do tipo durante o recebimento e não deixa sobra", async () => {
    const { dir, media } = await setup();
    const ok = await media.addStream(Readable.from([fakePng(5, 5)]), "image/png; charset=binary", { title: "ok", createdBy: "usuario", origin: "upload", fileName: "ok.png" });
    expect(ok.size).toBe(33);
    // Vídeo acima de 300 MB: simula com um fluxo que passa do limite sem alocar tudo.
    const huge = Readable.from(
      (function* () {
        const chunk = Buffer.alloc(8 * 1024 * 1024);
        for (let i = 0; i < 40; i++) yield chunk;
      })(),
    );
    await expect(media.addStream(huge, "video/mp4", { title: "v", createdBy: "usuario", origin: "upload" })).rejects.toMatchObject({ statusCode: 413 });
    const { readdir } = await import("node:fs/promises");
    expect((await readdir(path.join(dir, "media", "files"))).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect(media.list()).toHaveLength(1);
  });

  it("update, vínculo com o Para você e aprovação (só rascunho vira aprovado)", async () => {
    const { events, media } = await setup();
    const a = await media.addBuffer(fakePng(1, 1), "image/png", { title: "a", createdBy: "clara", origin: "html" });
    const b = await media.addBuffer(fakePng(1, 1), "image/png", { title: "b", createdBy: "clara", origin: "html" });
    media.update(b.id, { status: "publicado", publishedUrl: "https://linkedin.com/posts/1", where: "Post no LinkedIn" });
    media.linkForYou([a.id, b.id], "A-0003");
    expect(media.get(a.id).forYouIds).toEqual(["A-0003"]);
    media.approve([a.id, b.id]);
    expect(media.get(a.id).status).toBe("aprovado");
    expect(media.get(b.id)).toMatchObject({ status: "publicado", publishedUrl: "https://linkedin.com/posts/1" });
    media.update(b.id, { publishedUrl: null });
    expect(media.get(b.id).publishedUrl).toBeUndefined();
    expect(media.missing([a.id, "M-0099"])).toEqual(["M-0099"]);
    expect(events.at(-1)).toMatchObject({ type: "media:upserted" });
  });

  it("apagar remove o arquivo e a entrada", async () => {
    const { dir, events, media } = await setup();
    const a = await media.addBuffer(fakePng(1, 1), "image/png", { title: "a", createdBy: "clara", origin: "html" });
    await media.delete(a.id);
    await expect(stat(path.join(dir, "media", "files", "M-0001.png"))).rejects.toThrow();
    expect(media.find(a.id)).toBeUndefined();
    expect(events.at(-1)).toEqual({ type: "media:deleted", id: a.id });
    await expect(media.delete(a.id)).rejects.toMatchObject({ statusCode: 404 });
  });

  it("importFile: só dentro da pasta do agente (.., absoluto e link simbólico para fora são recusados)", async () => {
    const { dir, media } = await setup();
    const agent = path.join(dir, "agents", "clara");
    await mkdir(agent, { recursive: true });
    await writeFile(path.join(agent, "arte.png"), fakePng(40, 30));
    await writeFile(path.join(dir, "segredo.png"), fakePng(1, 1));
    await symlink(path.join(dir, "segredo.png"), path.join(agent, "atalho.png"));
    await writeFile(path.join(agent, "falso.png"), "isto é texto");
    await writeFile(path.join(agent, "script.sh"), "echo oi");

    const item = await media.importFile(agent, "arte.png", { title: "Arte", createdBy: "clara", taskId: "t1" });
    expect(item).toMatchObject({ kind: "image", width: 40, height: 30, origin: "arquivo", fileName: "arte.png", taskId: "t1" });
    await expect(media.importFile(agent, "../../segredo.png", { title: "x", createdBy: "clara" })).rejects.toThrow(/inside your own agent folder/);
    await expect(media.importFile(agent, path.join(dir, "segredo.png"), { title: "x", createdBy: "clara" })).rejects.toThrow(/inside your own agent folder/);
    await expect(media.importFile(agent, "atalho.png", { title: "x", createdBy: "clara" })).rejects.toThrow(/inside your own agent folder/);
    await expect(media.importFile(agent, "falso.png", { title: "x", createdBy: "clara" })).rejects.toBeInstanceOf(MediaToolError);
    await expect(media.importFile(agent, "script.sh", { title: "x", createdBy: "clara" })).rejects.toThrow(/not accepted/);
    await expect(media.importFile(agent, "nao-existe.png", { title: "x", createdBy: "clara" })).rejects.toThrow(/not found/);
    expect(media.list()).toHaveLength(1);
  });
});

describe("sniff", () => {
  it("dimensões de png, gif e jpeg, e assinatura de pdf/mp4", () => {
    expect(imageSize(fakePng(7, 9))).toEqual({ width: 7, height: 9 });
    const gif = Buffer.alloc(13);
    gif.write("GIF89a", 0, "ascii");
    gif.writeUInt16LE(30, 6);
    gif.writeUInt16LE(20, 8);
    expect(imageSize(gif)).toEqual({ width: 30, height: 20 });
    // JPEG: SOI, um APP0 curto, depois o SOF0 com altura 50 e largura 80.
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x32, 0x00, 0x50, 0x03, 0x01, 0x11, 0x00]);
    expect(imageSize(jpeg)).toEqual({ width: 80, height: 50 });
    expect(sniffMime(Buffer.from("%PDF-1.7 ..."))).toBe("application/pdf");
    expect(sniffMime(Buffer.concat([Buffer.alloc(4), Buffer.from("ftypisom")]))).toBe("video/mp4");
    expect(contentMatchesMime("text/plain", Buffer.from([65, 0, 66]))).toBe(false);
    expect(contentMatchesMime("image/svg+xml", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBe(true);
  });
});
