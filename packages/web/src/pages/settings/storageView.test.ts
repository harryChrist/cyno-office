import { describe, expect, it } from "vitest";
import { anyComputing, barSegments, foldersTotal, shareLabel, storageLabel, storageTitle } from "./storageView";

const at = "2026-11-16T14:32:00.000Z";

describe("storageView", () => {
  it("rótulo: tamanho, calculando e sem acesso", () => {
    expect(storageLabel({ bytes: 1_288_490_189, state: "ready", computedAt: at })).toBe("1,2 GB");
    expect(storageLabel({ bytes: 0, state: "computing", computedAt: null })).toBe("calculando…");
    expect(storageLabel({ bytes: 2048, state: "computing", computedAt: at })).toBe("2 KB");
    expect(storageLabel({ bytes: 0, state: "error", computedAt: null })).toBe("sem acesso");
  });

  it("title: arquivos e quando foi medido", () => {
    const text = storageTitle({ bytes: 5, files: 1234, state: "ready", computedAt: at }, new Date("2026-11-16T15:00:00Z"));
    expect(text).toContain("1234 arquivos");
    expect(text).toContain("medido em");
    expect(storageTitle({ bytes: 5, files: 1, state: "ready", computedAt: at })).toContain("1 arquivo ·");
    expect(storageTitle({ bytes: 0, files: 0, state: "error", computedAt: null })).toContain("Não foi possível");
  });

  it("anyComputing olha o workspace e as pastas", () => {
    expect(anyComputing(null)).toBe(false);
    expect(anyComputing({ workspace: { state: "ready" }, folders: [{ state: "ready" }] })).toBe(false);
    expect(anyComputing({ workspace: { state: "ready" }, folders: [{ state: "computing" }] })).toBe(true);
    expect(anyComputing({ workspace: { state: "computing" }, folders: [] })).toBe(true);
  });

  it("total das pastas separa o que falta e o que falhou", () => {
    expect(
      foldersTotal([
        { bytes: 100, state: "ready", computedAt: at },
        { bytes: 0, state: "computing", computedAt: null },
        { bytes: 0, state: "error", computedAt: null },
        { bytes: 50, state: "computing", computedAt: at },
      ]),
    ).toEqual({ bytes: 150, pending: 1, failed: 1 });
  });

  it("barra só tem partes com bytes; legenda arredonda", () => {
    const segments = barSegments([
      { id: "media", label: "Mídia", bytes: 750 },
      { id: "agents", label: "Agentes", bytes: 250 },
      { id: "logs", label: "Registros", bytes: 0 },
    ]);
    expect(segments.map((s) => s.id)).toEqual(["media", "agents"]);
    expect(segments[0]!.share).toBe(0.75);
    expect(shareLabel(0.75)).toBe("75%");
    expect(shareLabel(0.002)).toBe("<1%");
    expect(shareLabel(0)).toBe("0%");
  });
});
