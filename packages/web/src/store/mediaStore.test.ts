import type { MediaItem } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { applyMediaEvent, isMediaEvent } from "./mediaStore";

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
