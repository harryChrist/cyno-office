import type { MediaItem } from "@cyno/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildEntries, carouselTitle, commonStatus, entryItems, entryMatches, loadDensity, loadScope, saveDensity, saveScope, scopeKey, slideInfo, timeSections, type GalleryEntry, type Located } from "./mediaGroups";
import { NO_FILTERS } from "./mediaView";

const item = (over: Partial<MediaItem>): MediaItem => ({
  id: "M-0001",
  kind: "image",
  mime: "image/png",
  fileName: "a.png",
  title: "Post",
  size: 10,
  width: 1080,
  height: 1080,
  createdAt: "2026-11-10T10:00:00.000Z",
  createdBy: "davi",
  origin: "html",
  status: "rascunho",
  ...over,
});
const at = (ws: string, over: Partial<MediaItem>): Located => ({ ws, item: item(over) });
const names = () => "Davi";

describe("agrupamento da galeria", () => {
  it("lê o número do slide e só agrupa quando o título diz 'slide N de M' no mesmo pedido", () => {
    expect(slideInfo("Carrossel · slide 2 de 3")).toMatchObject({ n: 2, total: 3, label: "Carrossel" });
    expect(slideInfo("Post bolo de laranja")).toBeNull();
    const slides = [1, 2, 3].map((n) => at("a", { id: `M-000${n}`, title: `Carrossel · slide ${n} de 3`, taskId: "T1", createdAt: `2026-11-10T10:00:0${n}.000Z` }));
    const other = at("a", { id: "M-0004", title: "Carrossel · slide 1 de 3", taskId: "T2" });
    const entries = buildEntries([...slides, other, at("a", { id: "M-0005", title: "Foto solta" })], false);
    const carousel = entries.find((entry) => entry.type === "carousel")!;
    expect(carousel.type === "carousel" && carousel.slides.map((slide) => slide.item.id)).toEqual(["M-0001", "M-0002", "M-0003"]);
    expect(carouselTitle((carousel as Extract<GalleryEntry, { type: "carousel" }>).slides)).toBe("Carrossel · 3 slides");
    expect(entries).toHaveLength(3);
    expect(commonStatus(carousel)).toBe("rascunho");
  });

  it("slides de workspaces diferentes nunca se juntam, mesmo com o mesmo pedido", () => {
    const entries = buildEntries([at("a", { id: "M-0001", title: "Carrossel · slide 1 de 2", taskId: "T1" }), at("b", { id: "M-0001", title: "Carrossel · slide 2 de 2", taskId: "T1" })], false);
    expect(entries.every((entry) => entry.type === "single")).toBe(true);
  });

  it("versões descartadas e mais antigas ficam dentro da atual; o interruptor as mostra também soltas", () => {
    const old = at("a", { id: "M-0001", taskId: "T1", status: "descartado", createdAt: "2026-11-10T09:00:00.000Z" });
    const current = at("a", { id: "M-0002", taskId: "T1", status: "aprovado", createdAt: "2026-11-10T09:30:00.000Z" });
    const hidden = buildEntries([old, current], false);
    expect(hidden).toHaveLength(1);
    expect(hidden[0]).toMatchObject({ type: "single", versions: [{ item: { id: "M-0001" } }] });
    expect(entryItems(hidden[0]!).map((part) => part.item.id)).toEqual(["M-0002", "M-0001"]);
    expect(buildEntries([old, current], true)).toHaveLength(2);
  });

  it("descartado sem versão atual, de outra dimensão ou de outro pedido não é agrupado", () => {
    const entries = buildEntries(
      [
        at("a", { id: "M-0001", taskId: "T1", status: "descartado" }),
        at("a", { id: "M-0002", taskId: "T2", createdAt: "2026-11-10T11:00:00.000Z" }),
        at("a", { id: "M-0003", taskId: "T1", width: 500, height: 500, createdAt: "2026-11-10T11:00:00.000Z" }),
      ],
      true,
    );
    expect(entries).toHaveLength(3);
    expect(entries.every((entry) => entry.type === "single" && entry.versions.length === 0)).toBe(true);
    // sem o interruptor, o descartado solto some (quem filtra é entryMatches)
    expect(buildEntries([at("a", { id: "M-0001", status: "descartado" })], false)).toHaveLength(1);
  });

  it("filtros: descartado só com o interruptor ou filtrando por Descartado; carrossel passa se um slide passar", () => {
    const discarded = buildEntries([at("a", { id: "M-0001", status: "descartado", title: "Velha" })], true)[0]!;
    expect(entryMatches(discarded, NO_FILTERS, false, names)).toBe(false);
    expect(entryMatches(discarded, NO_FILTERS, true, names)).toBe(true);
    expect(entryMatches(discarded, { ...NO_FILTERS, status: "descartado" }, false, names)).toBe(true);
    const slides = [at("a", { id: "M-0001", title: "Receita · slide 1 de 2", taskId: "T", status: "aprovado" }), at("a", { id: "M-0002", title: "Receita · slide 2 de 2", taskId: "T", status: "rascunho" })];
    const carousel = buildEntries(slides, false)[0]!;
    expect(entryMatches(carousel, { ...NO_FILTERS, status: "aprovado" }, false, names)).toBe(true);
    expect(entryMatches(carousel, { ...NO_FILTERS, status: "publicado" }, false, names)).toBe(false);
    expect(commonStatus(carousel)).toBeNull();
    expect(entryMatches(carousel, { ...NO_FILTERS, q: "DAVI" }, false, names)).toBe(true);
  });
});

describe("seções por tempo", () => {
  const now = new Date("2026-11-11T15:00:00");
  const entry = (n: number, iso: string): GalleryEntry => ({ key: `a:M-${n}`, type: "single", main: at("a", { id: `M-${String(n).padStart(4, "0")}`, createdAt: new Date(iso).toISOString() }), versions: [], time: new Date(iso).toISOString() });

  it("menos de 9 cartões: uma seção só, sem título", () => {
    const sections = timeSections([entry(1, "2026-11-11T10:00:00"), entry(2, "2026-10-01T10:00:00")], now);
    expect(sections).toHaveLength(1);
    expect(sections[0]).toMatchObject({ title: null });
  });

  it("com 9 ou mais: Hoje, Esta semana e Antes, sem seção vazia", () => {
    const list = [...Array.from({ length: 4 }, (_, i) => entry(i + 1, "2026-11-11T08:00:00")), ...Array.from({ length: 3 }, (_, i) => entry(i + 5, "2026-11-07T08:00:00")), ...Array.from({ length: 2 }, (_, i) => entry(i + 8, "2026-10-20T08:00:00"))];
    expect(timeSections(list, now).map((section) => [section.title, section.entries.length])).toEqual([
      ["Hoje", 4],
      ["Esta semana", 3],
      ["Antes", 2],
    ]);
    expect(timeSections(list.slice(0, 9).map((e, i) => (i < 9 ? entry(i + 1, "2026-11-11T08:00:00") : e)), now).map((section) => section.title)).toEqual(["Hoje"]);
  });
});

describe("escopo lembrado", () => {
  let store: Map<string, string>;
  beforeEach(() => {
    store = new Map();
    vi.stubGlobal("localStorage", { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => void store.set(key, value) });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("padrão é Este workspace; guarda e lê o escopo e o outro workspace", () => {
    expect(loadScope()).toEqual({ scope: "este", other: null });
    saveScope("outro", "estudio");
    expect(loadScope()).toEqual({ scope: "outro", other: "estudio" });
    saveScope("todos", null);
    expect(loadScope()).toEqual({ scope: "todos", other: "estudio" });
  });

  it("valor estranho volta ao padrão e armazenamento bloqueado não derruba", () => {
    store.set("cyno.media.scope", "xyz");
    expect(loadScope().scope).toBe("este");
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("bloqueado");
      },
      setItem: () => {
        throw new Error("bloqueado");
      },
    });
    expect(loadScope()).toEqual({ scope: "este", other: null });
    expect(() => saveScope("este", null)).not.toThrow();
  });
});

describe("chave do escopo e densidade da grade", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("a chave separa os escopos e cada 'outro' workspace", () => {
    expect(scopeKey("este", "lume")).toBe("este");
    expect(scopeKey("todos", "lume")).toBe("todos");
    expect(scopeKey("outro", "lume")).toBe("outro:lume");
    expect(scopeKey("outro", "norte")).not.toBe(scopeKey("outro", "lume"));
    expect(scopeKey("outro", null)).toBe("outro:");
  });

  it("a densidade é confortável por padrão e fica guardada", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => void store.set(key, value) });
    expect(loadDensity()).toBe("confortavel");
    saveDensity("compacta");
    expect(loadDensity()).toBe("compacta");
    store.set("cyno.media.density", "qualquer");
    expect(loadDensity()).toBe("confortavel");
  });

  it("sem armazenamento, a densidade não quebra", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("bloqueado");
      },
      setItem: () => {
        throw new Error("bloqueado");
      },
    });
    expect(loadDensity()).toBe("confortavel");
    expect(() => saveDensity("compacta")).not.toThrow();
  });
});
