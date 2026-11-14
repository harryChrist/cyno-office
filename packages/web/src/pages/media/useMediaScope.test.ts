import type { MediaItem } from "@cyno/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const listMediaOf = vi.fn<(id: string) => Promise<MediaItem[]>>();
const agentNamesOf = vi.fn<(id: string) => Promise<{ id: string; name: string }[]>>();
vi.mock("../../api/client", () => ({
  api: { listMediaOf: (id: string) => listMediaOf(id), agentNamesOf: (id: string) => agentNamesOf(id) },
  describeError: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));

const { dropRemoteMedia, peekRemoteMedia, prefetchRemoteMedia, resetRemoteMediaCache } = await import("./useMediaScope");

const media = (id: string): MediaItem => ({ id, kind: "image", mime: "image/png", fileName: `${id}.png`, title: id, size: 1, createdAt: "2026-11-10T10:00:00.000Z", createdBy: "davi", origin: "html", status: "rascunho" });
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
};
const flush = () => new Promise((done) => setTimeout(done, 0));

beforeEach(() => {
  resetRemoteMediaCache();
  listMediaOf.mockReset();
  agentNamesOf.mockReset().mockResolvedValue([]);
});
afterEach(() => vi.useRealTimers());

describe("cache dos outros workspaces", () => {
  it("pede uma vez só, mesmo com vários avisos ao mesmo tempo, e guarda para a volta ser instantânea", async () => {
    listMediaOf.mockResolvedValue([media("M-1")]);
    prefetchRemoteMedia(["lume"]);
    prefetchRemoteMedia(["lume"]);
    await flush();
    expect(listMediaOf).toHaveBeenCalledTimes(1);
    expect(peekRemoteMedia("lume")?.items.map((item) => item.id)).toEqual(["M-1"]);
    // fresco: não pede de novo
    prefetchRemoteMedia(["lume"]);
    await flush();
    expect(listMediaOf).toHaveBeenCalledTimes(1);
  });

  it("revalida em segundo plano o que ficou velho, sem esvaziar enquanto isso", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(0);
    listMediaOf.mockResolvedValueOnce([media("M-1")]);
    prefetchRemoteMedia(["lume"]);
    await flush();
    vi.setSystemTime(31_000);
    expect(peekRemoteMedia("lume")).toMatchObject({ stale: true });
    const next = deferred<MediaItem[]>();
    listMediaOf.mockReturnValueOnce(next.promise);
    prefetchRemoteMedia(["lume"]);
    // a lista velha continua à mão enquanto a nova não chega
    expect(peekRemoteMedia("lume")?.items.map((item) => item.id)).toEqual(["M-1"]);
    next.resolve([media("M-1"), media("M-2")]);
    await flush();
    expect(peekRemoteMedia("lume")).toMatchObject({ stale: false });
    expect(peekRemoteMedia("lume")?.items).toHaveLength(2);
  });

  it("descarta o que a rede desmentiu (mídia nova pelo socket): o próximo uso pede de novo", async () => {
    listMediaOf.mockResolvedValue([media("M-1")]);
    prefetchRemoteMedia(["lume"]);
    await flush();
    dropRemoteMedia("lume");
    expect(peekRemoteMedia("lume")).toBeUndefined();
    prefetchRemoteMedia(["lume"]);
    await flush();
    expect(listMediaOf).toHaveBeenCalledTimes(2);
  });

  it("resposta atrasada de um workspace não mistura com o do outro (cada uma enche a própria chave)", async () => {
    const slow = deferred<MediaItem[]>();
    listMediaOf.mockImplementation((id) => (id === "lume" ? slow.promise : Promise.resolve([media("N-1")])));
    prefetchRemoteMedia(["lume"]);
    prefetchRemoteMedia(["norte"]);
    await flush();
    // "norte" chegou primeiro; "lume" ainda não: nada de meia lista nem de dado trocado
    expect(peekRemoteMedia("norte")?.items.map((item) => item.id)).toEqual(["N-1"]);
    expect(peekRemoteMedia("lume")).toBeUndefined();
    slow.resolve([media("L-1")]);
    await flush();
    expect(peekRemoteMedia("lume")?.items.map((item) => item.id)).toEqual(["L-1"]);
    expect(peekRemoteMedia("norte")?.items.map((item) => item.id)).toEqual(["N-1"]);
  });

  it("uma falha não guarda nada e pode ser tentada de novo", async () => {
    listMediaOf.mockRejectedValueOnce(new Error("sem rede")).mockResolvedValueOnce([media("M-1")]);
    prefetchRemoteMedia(["lume"]);
    await flush();
    expect(peekRemoteMedia("lume")).toBeUndefined();
    prefetchRemoteMedia(["lume"]);
    await flush();
    expect(peekRemoteMedia("lume")?.items).toHaveLength(1);
  });
});
