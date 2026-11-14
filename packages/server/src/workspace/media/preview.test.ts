import { mkdir, readdir, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import type { MediaItem } from "@cyno/shared";
import { describe, expect, it, vi } from "vitest";
import { useTempDirs } from "../../dev/test-utils";
import { fitSide, PREVIEW_KEEP, writePreview } from "./preview";
import { fakePng } from "./test-files";

const tempDir = useTempDirs();
const item = (patch: Partial<MediaItem>): MediaItem => ({ id: "M-0001", kind: "image", mime: "image/png", fileName: "a.png", title: "A", size: 100, createdAt: "2026-11-10T00:00:00.000Z", createdBy: "clara", origin: "html", status: "rascunho", ...patch }) as MediaItem;

describe("prévia de mídia", () => {
  it("fitSide mantém a proporção com o lado maior em 1024", () => {
    expect(fitSide(2160, 1080)).toEqual({ width: 1024, height: 512 });
    expect(fitSide(800, 600)).toEqual({ width: 800, height: 600 });
  });

  it("imagem pequena é copiada; grande é reduzida pelo render; sem render vai sem reduzir", async () => {
    const dir = await tempDir();
    const file = path.join(dir, "lib.png");
    await writeFile(file, fakePng(1080, 1080));
    const agent = path.join(dir, "agent");
    const render = vi.fn(async () => fakePng(1024, 1024));
    const small = await writePreview(item({ width: 900, height: 900 }), file, agent, { render });
    expect(small.files).toEqual(["previa/M-0001.png"]);
    expect(render).not.toHaveBeenCalled();
    const big = await writePreview(item({ width: 1080, height: 1080 }), file, agent, { render });
    expect(big.note).toContain("Reduced to 1024x1024");
    expect(render).toHaveBeenCalledTimes(1);
    const plain = await writePreview(item({ id: "M-0002", width: 1080, height: 1080 }), file, agent);
    expect(plain.files).toEqual(["previa/M-0002.png"]);
  });

  it("vídeo sem ffmpeg avisa; áudio não tem prévia; as cópias antigas são limpas", async () => {
    const dir = await tempDir();
    const file = path.join(dir, "v.mp4");
    await writeFile(file, "x");
    const agent = path.join(dir, "agent");
    expect((await writePreview(item({ kind: "video", mime: "video/mp4" }), file, agent)).note).toContain("No video tool");
    expect((await writePreview(item({ kind: "audio", mime: "audio/mpeg" }), file, agent)).files).toEqual([]);
    const previa = path.join(agent, "previa");
    await mkdir(previa, { recursive: true });
    for (let i = 0; i < PREVIEW_KEEP + 5; i++) {
      const old = path.join(previa, `velha-${i}.png`);
      await writeFile(old, "x");
      await utimes(old, new Date(2020, 0, 1, 0, i), new Date(2020, 0, 1, 0, i));
    }
    const png = path.join(dir, "n.png");
    await writeFile(png, fakePng(10, 10));
    await writePreview(item({ id: "M-0009", width: 10, height: 10 }), png, agent);
    const left = await readdir(previa);
    expect(left).toHaveLength(PREVIEW_KEEP);
    expect(left).toContain("M-0009.png");
  });
});
