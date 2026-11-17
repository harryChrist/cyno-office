import type { MediaItem } from "@cyno/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api/client";
import { applyMediaEvent, isMediaEvent, useMediaStore } from "./mediaStore";
import { useNavStore } from "./navStore";

const item = (id: string, createdAt: string, title = id): MediaItem => ({ id, kind: "image", mime: "image/png", fileName: `${id}.png`, title, size: 1, createdAt, createdBy: "clara", origin: "html", status: "rascunho" });

describe("applyMediaEvent", () => {
  const list = [item("M-0002", "2026-11-10T12:00:00.000Z"), item("M-0001", "2026-11-10T10:00:00.000Z")];

  it("mídia nova entra no topo (mais novas primeiro)", () => {
    const next = applyMediaEvent(list, { type: "media:upserted", media: item("M-0003", "2026-11-10T13:00:00.000Z") });
    expect(next.map((i) => i.id)).toEqual(["M-0003", "M-0002", "M-0001"]);
  });

  it("mídia alterada troca no lugar, sem duplicar", () => {
    const next = applyMediaEvent(list, { type: "media:upserted", media: { ...item("M-0001", "2026-11-10T10:00:00.000Z"), status: "publicado" } });
    expect(next).toHaveLength(2);
    expect(next.find((i) => i.id === "M-0001")?.status).toBe("publicado");
  });

  it("mídia excluída sai da lista", () => {
    expect(applyMediaEvent(list, { type: "media:deleted", id: "M-0002" }).map((i) => i.id)).toEqual(["M-0001"]);
  });

  it("reconhece só os eventos de mídia", () => {
    expect(isMediaEvent({ type: "media:deleted", id: "M-0001" })).toBe(true);
    expect(isMediaEvent({ type: "sync:resumed" } as never)).toBe(false);
  });
});

describe("pastas na store", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    useMediaStore.getState().reset();
  });

  it("mover troca a pasta dos itens na lista e guarda a lista de pastas que o servidor devolveu", async () => {
    useNavStore.setState({ workspaceId: "principal" });
    const moved = { ...item("M-0001", "2026-11-10T10:00:00.000Z"), folder: "Livros" };
    const spy = vi.spyOn(api, "moveMedia").mockResolvedValue({ items: [moved], folders: ["Livros"] });
    useMediaStore.setState({ items: [item("M-0002", "2026-11-10T12:00:00.000Z"), item("M-0001", "2026-11-10T10:00:00.000Z")], folders: [] });
    await useMediaStore.getState().moveItems(["M-0001"], "Livros");
    expect(spy).toHaveBeenCalledWith({ ids: ["M-0001"], folder: "Livros" });
    expect(useMediaStore.getState().items?.find((entry) => entry.id === "M-0001")?.folder).toBe("Livros");
    expect(useMediaStore.getState().folders).toEqual(["Livros"]);
    // Raiz: manda null.
    spy.mockResolvedValue({ items: [item("M-0001", "2026-11-10T10:00:00.000Z")], folders: ["Livros"] });
    await useMediaStore.getState().moveItems(["M-0001"], "");
    expect(spy).toHaveBeenLastCalledWith({ ids: ["M-0001"], folder: null });
  });

  it("criar, renomear e apagar pasta guardam a lista nova", async () => {
    vi.spyOn(api, "createMediaFolder").mockResolvedValue({ folders: ["A"], folder: "A" });
    vi.spyOn(api, "renameMediaFolder").mockResolvedValue({ folders: ["B"], folder: "B" });
    vi.spyOn(api, "deleteMediaFolder").mockResolvedValue({ folders: [], folder: "" });
    expect(await useMediaStore.getState().createFolder("A")).toBe("A");
    expect(useMediaStore.getState().folders).toEqual(["A"]);
    expect(await useMediaStore.getState().renameFolder("A", "B")).toBe("B");
    expect(useMediaStore.getState().folders).toEqual(["B"]);
    expect(await useMediaStore.getState().deleteFolder("B")).toBe("");
    expect(useMediaStore.getState().folders).toEqual([]);
  });
});
