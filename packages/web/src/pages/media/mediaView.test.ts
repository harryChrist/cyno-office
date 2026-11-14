import type { MediaItem } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { agentOptions, cameFrom, creatorLabel, filterMedia, formatBytes, kindOptions, mediaByIds, mimeForFile, NO_FILTERS, ratioLabel, safeHttpUrl, sortForGallery, statusOptions, uploadProblem } from "./mediaView";

const item = (over: Partial<MediaItem>): MediaItem => ({
  id: "M-0001",
  kind: "image",
  mime: "image/png",
  fileName: "a.png",
  title: "Post",
  size: 10,
  createdAt: "2026-11-10T10:00:00.000Z",
  createdBy: "clara",
  origin: "html",
  status: "rascunho",
  ...over,
});
const agents = new Map([["clara", "Clara"]]);

describe("filtros", () => {
  const items = [item({ id: "M-0001" }), item({ id: "M-0002", kind: "video", createdBy: "usuario", status: "publicado", title: "Vídeo de lançamento" }), item({ id: "M-0003", kind: "document", note: "Relatório mensal" })];
  it("filtra por tipo, estado e agente", () => {
    expect(filterMedia(items, { ...NO_FILTERS, kind: "video" }, agents).map((i) => i.id)).toEqual(["M-0002"]);
    expect(filterMedia(items, { ...NO_FILTERS, kind: "file" }, agents).map((i) => i.id)).toEqual(["M-0003"]);
    expect(filterMedia(items, { ...NO_FILTERS, status: "rascunho" }, agents).map((i) => i.id)).toEqual(["M-0001", "M-0003"]);
    expect(filterMedia(items, { ...NO_FILTERS, agent: "usuario" }, agents).map((i) => i.id)).toEqual(["M-0002"]);
  });
  it("busca sem acento e pelo nome do agente", () => {
    expect(filterMedia(items, { ...NO_FILTERS, q: "relatorio" }, agents).map((i) => i.id)).toEqual(["M-0003"]);
    expect(filterMedia(items, { ...NO_FILTERS, q: "clara" }, agents).map((i) => i.id)).toEqual(["M-0001", "M-0003"]);
    expect(filterMedia(items, { ...NO_FILTERS, q: "voce" }, agents).map((i) => i.id)).toEqual(["M-0002"]);
  });
  it("opções com contagem; o selecionado fica mesmo vazio", () => {
    expect(kindOptions(items, "todos").map((o) => [o.value, o.count])).toEqual([
      ["todos", 3],
      ["image", 1],
      ["video", 1],
      ["file", 1],
    ]);
    expect(kindOptions(items, "audio").some((o) => o.value === "audio" && o.count === 0)).toBe(true);
    expect(statusOptions(items, "todos").map((o) => o.value)).toEqual(["todos", "rascunho", "publicado"]);
    expect(agentOptions(items, agents, "todos").map((o) => o.label)).toEqual(["Todos", "Clara", "Você"]);
  });
});

describe("rótulos e formatos", () => {
  it("quem fez", () => {
    expect(creatorLabel("usuario", agents)).toBe("Você");
    expect(creatorLabel("clara", agents)).toBe("Clara");
    expect(creatorLabel("sumiu", agents)).toBe("sumiu");
  });
  it("proporção da peça", () => {
    expect(ratioLabel(1080, 1080)).toBe("1:1");
    expect(ratioLabel(1080, 1350)).toBe("4:5");
    expect(ratioLabel(1080, 1920)).toBe("9:16");
    expect(ratioLabel(1200, 628)).toBe("≈ 1,91:1");
  });
  it("tamanho", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(1.5 * 1024 * 1024)).toBe("1,5 MB");
  });
  it("só abre endereço http(s)", () => {
    expect(safeHttpUrl("https://x.com/p")).toBe("https://x.com/p");
    expect(safeHttpUrl("javascript:alert(1)")).toBeUndefined();
    expect(safeHttpUrl(undefined)).toBeUndefined();
  });
  it("mais novas primeiro", () => {
    const sorted = sortForGallery([item({ id: "M-0001" }), item({ id: "M-0002", createdAt: "2026-11-10T12:00:00.000Z" })]);
    expect(sorted.map((i) => i.id)).toEqual(["M-0002", "M-0001"]);
  });
  it("de onde veio uma mídia trazida", () => {
    expect(cameFrom(item({ origin: "mural", note: "Veio de Design · M-0003" }))).toEqual({ workspace: "Design", mediaId: "M-0003" });
    expect(cameFrom(item({ origin: "mural", note: "Do mural: Design · N-0001 — capa" }))).toEqual({ workspace: "Design" });
    expect(cameFrom(item({ origin: "html", note: "Veio de Design · M-0003" }))).toBeNull();
  });
  it("mídias na ordem pedida, ignorando as que faltam", () => {
    const items = [item({ id: "M-0001" }), item({ id: "M-0002" })];
    expect(mediaByIds(items, ["M-0002", "M-0009", "M-0001"]).map((i) => i.id)).toEqual(["M-0002", "M-0001"]);
    expect(mediaByIds(null, ["M-0001"])).toEqual([]);
  });
});

describe("envio", () => {
  it("usa a extensão quando o navegador não diz o mime", () => {
    expect(mimeForFile({ name: "nota.md", type: "" })).toBe("text/markdown");
  });
  it("recusa tipo desconhecido, vazio e grande demais", () => {
    expect(uploadProblem({ name: "a.exe", type: "application/x-msdownload", size: 10 })).toMatch(/não aceito/);
    expect(uploadProblem({ name: "a.png", type: "image/png", size: 0 })).toMatch(/vazio/);
    expect(uploadProblem({ name: "a.png", type: "image/png", size: 30 * 1024 * 1024 })).toMatch(/grande demais/);
    expect(uploadProblem({ name: "a.png", type: "image/png", size: 1000 })).toBeNull();
  });
});
