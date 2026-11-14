import type { MuralEntry } from "@cyno/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api/client";
import { muralBadge } from "../pages/cyno/cynoRequests";
import { useCynoStore } from "./cynoStore";
import { useMuralStore } from "./muralStore";

const entry = (id: string, extra: Partial<MuralEntry> = {}): MuralEntry => ({
  id,
  kind: "media",
  workspace: "design",
  by: "design/maestro",
  title: `Item ${id}`,
  note: "",
  mediaRef: { workspace: "design", mediaId: "M-0001" },
  mediaKind: "image",
  tags: [],
  createdAt: "2026-11-11T12:00:00.000Z",
  seenBy: {},
  usedBy: [],
  status: "ativo",
  ...extra,
});

describe("muralStore", () => {
  beforeEach(() => {
    useMuralStore.setState({ entries: [], news: {}, loaded: false, error: null, busy: [] });
  });
  afterEach(() => vi.restoreAllMocks());

  it("carrega os itens e as novidades por workspace", async () => {
    vi.spyOn(api, "mural").mockResolvedValue({ entries: [entry("N-0001")], news: { posts: 1, design: 0 } });
    await useMuralStore.getState().load();
    expect(useMuralStore.getState()).toMatchObject({ loaded: true, news: { posts: 1 } });
    expect(useMuralStore.getState().entries.map((item) => item.id)).toEqual(["N-0001"]);
  });

  it("trazer para o workspace recarrega, devolve o id da mídia nova e mostra o erro quando falha", async () => {
    const use = vi.spyOn(api, "useFromMural").mockResolvedValue({ mediaId: "M-0002", workspace: "posts", entry: entry("N-0001", { usedBy: ["posts"] }) });
    vi.spyOn(api, "mural").mockResolvedValue({ entries: [entry("N-0001", { usedBy: ["posts"] })], news: {} });
    expect(await useMuralStore.getState().use("N-0001", "posts")).toBe("M-0002");
    expect(use).toHaveBeenCalledWith("N-0001", "posts");
    expect(useMuralStore.getState().entries[0]!.usedBy).toEqual(["posts"]);
    expect(useMuralStore.getState().busy).toEqual([]);
    use.mockRejectedValue(new Error("falhou"));
    expect(await useMuralStore.getState().use("N-0001", "posts")).toBeUndefined();
    expect(useMuralStore.getState().error).toBeTruthy();
  });

  it("o evento mural:changed do Cyno busca de novo", () => {
    const load = vi.spyOn(useMuralStore.getState(), "load").mockResolvedValue();
    useCynoStore.getState().applyEvent({ type: "mural:changed" });
    expect(load).toHaveBeenCalled();
  });

  it("o selo da ficha: vazio sem novidade, singular e plural", () => {
    expect(muralBadge(0)).toBe("");
    expect(muralBadge(1)).toBe("1 novo no mural");
    expect(muralBadge(4)).toBe("4 novos no mural");
  });
});
