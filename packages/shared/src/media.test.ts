import { describe, expect, it } from "vitest";
import { forYouItemSchema, forYouSourceSchema } from "./api";
import { FOR_YOU_SOURCE_LIMITS, normalizeSources, type ForYouSource } from "./for-you";
import { MEDIA_MAX_BYTES, mediaItemSchema, nextMediaId, updateMediaBodySchema } from "./media";

const AT = "2026-11-10T12:00:00.000Z";

describe("mídia: schemas", () => {
  it("item com status padrão rascunho e id M-0001", () => {
    const item = mediaItemSchema.parse({ id: "M-0001", kind: "image", mime: "image/png", fileName: "a.png", title: "Capa", size: 10, createdAt: AT, createdBy: "clara", origin: "html" });
    expect(item.status).toBe("rascunho");
    expect(() => mediaItemSchema.parse({ ...item, id: "X-1" })).toThrow();
  });

  it("ids sequenciais por workspace e limites por tipo", () => {
    expect(nextMediaId([])).toBe("M-0001");
    expect(nextMediaId([{ id: "M-0001" }, { id: "M-0009" }])).toBe("M-0010");
    expect(MEDIA_MAX_BYTES.image).toBe(25 * 1024 * 1024);
    expect(MEDIA_MAX_BYTES.video).toBe(300 * 1024 * 1024);
  });

  it("PATCH aceita null para limpar e recusa campo desconhecido", () => {
    expect(updateMediaBodySchema.parse({ publishedUrl: null, status: "publicado" })).toEqual({ publishedUrl: null, status: "publicado" });
    expect(() => updateMediaBodySchema.parse({ createdBy: "x" })).toThrow();
  });
});

describe("Para você: fontes (sources)", () => {
  const base = { id: "A-0001", agentId: "clara", roomId: "conteudo", type: "outro", status: "pendente", meta: {}, text: "t", originalText: "t", editedByUser: false, createdAt: AT };

  it("item antigo (sem sources/mediaIds) continua carregando", () => {
    expect(forYouItemSchema.parse(base).sources).toBeUndefined();
  });

  it("item com fontes e mídia passa pelo schema", () => {
    const source: ForYouSource = { kind: "post", url: "https://lnkd.in/p/x", author: "Mayk", content: "texto inteiro", summary: "resumo", facts: [{ label: "Conexões em comum", value: "22" }], mediaIds: ["M-0001"] };
    expect(forYouItemSchema.parse({ ...base, sources: [source], mediaIds: ["M-0002"] }).sources).toEqual([source]);
    expect(() => forYouSourceSchema.parse({ kind: "x" })).toThrow();
    expect(() => forYouSourceSchema.parse({ kind: "post", content: "a".repeat(FOR_YOU_SOURCE_LIMITS.content + 1) })).toThrow();
  });

  it("normalizeSources corta em vez de recusar, tira vazios e respeita os máximos", () => {
    const long = "palavra ".repeat(2000);
    const out = normalizeSources([
      { kind: "post", content: long, summary: "s".repeat(900), title: "  ", facts: Array.from({ length: 12 }, (_, i) => ({ label: `l${i}`, value: "v" })).concat([{ label: "", value: "x" }]), mediaIds: ["M-0001", "M-0001", " "] },
      { kind: "other" },
      ...Array.from({ length: 8 }, (_, i): ForYouSource => ({ kind: "page", url: `https://x.com/${i}` })),
    ])!;
    expect(out).toHaveLength(FOR_YOU_SOURCE_LIMITS.sources);
    expect(out[0]!.content!.length).toBe(FOR_YOU_SOURCE_LIMITS.content);
    expect(out[0]!.content!.endsWith("…")).toBe(true);
    expect(out[0]!.summary!.length).toBe(FOR_YOU_SOURCE_LIMITS.summary);
    expect(out[0]!.title).toBeUndefined();
    expect(out[0]!.facts).toHaveLength(FOR_YOU_SOURCE_LIMITS.facts);
    expect(out[0]!.mediaIds).toEqual(["M-0001"]);
    expect(out[1]!.url).toBe("https://x.com/0");
    // O resultado sempre cabe no schema.
    for (const source of out) expect(() => forYouSourceSchema.parse(source)).not.toThrow();
    expect(normalizeSources(undefined)).toBeUndefined();
    expect(normalizeSources([{ kind: "post" }])).toBeUndefined();
  });
});
