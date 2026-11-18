import { readFile } from "node:fs/promises";
import path from "node:path";
import { BOARD_SHARE_TOKEN_PATTERN } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { useTempDirs } from "../../dev/test-utils";
import { BoardShareStore } from "./share-store";

const tempDir = useTempDirs();

async function setup() {
  const dir = await tempDir();
  const file = path.join(dir, "board-shares.json");
  let clock = Date.parse("2026-11-18T12:00:00.000Z");
  const now = () => new Date(clock);
  const open = () => BoardShareStore.open(file, now);
  return { file, open, advance: (ms: number) => (clock += ms) };
}

describe("BoardShareStore", () => {
  it("cria, troca a validade, troca o token, desliga", async () => {
    const { open, advance } = await setup();
    const store = await open();
    expect(await store.get("principal", "Q-0001")).toEqual({ shared: false });

    const first = await store.set("principal", "Q-0001");
    if (!first.shared) throw new Error("devia estar compartilhado");
    expect(first.token).toMatch(BOARD_SHARE_TOKEN_PATTERN);
    expect(first.path).toBe(`/api/share/${first.token}`);
    expect(first.expiresAt).toBeUndefined();
    expect(await store.find(first.token)).toEqual({ ws: "principal", boardId: "Q-0001" });

    // Ligar de novo só troca a validade: o token é o mesmo.
    const week = await store.set("principal", "Q-0001", 7);
    if (!week.shared) throw new Error("devia estar compartilhado");
    expect(week.token).toBe(first.token);
    expect(week.expiresAt).toBe(new Date(Date.parse("2026-11-18T12:00:00.000Z") + 7 * 86_400_000).toISOString());
    advance(1000);
    expect(await store.set("principal", "Q-0001", 0)).toMatchObject({ token: first.token });
    expect((await store.get("principal", "Q-0001")) as { expiresAt?: string }).not.toHaveProperty("expiresAt");

    await store.set("principal", "Q-0001", 1);
    const rotated = await store.rotate("principal", "Q-0001");
    if (!rotated?.shared) throw new Error("devia trocar");
    expect(rotated.token).not.toBe(first.token);
    expect(rotated.expiresAt).toBeDefined();
    expect(await store.find(first.token)).toBeUndefined();
    expect(await store.find(rotated.token)).toEqual({ ws: "principal", boardId: "Q-0001" });
    expect(await store.rotate("principal", "Q-0009")).toBeUndefined();

    await store.remove("principal", "Q-0001");
    await store.remove("principal", "Q-0001");
    expect(await store.find(rotated.token)).toBeUndefined();
    expect(await store.get("principal", "Q-0001")).toEqual({ shared: false });
  });

  it("um link por quadro e token malformado não é achado", async () => {
    const { open } = await setup();
    const store = await open();
    const a = await store.set("principal", "Q-0001");
    const b = await store.set("principal", "Q-0002");
    const other = await store.set("outro", "Q-0001");
    if (!a.shared || !b.shared || !other.shared) throw new Error("x");
    expect(new Set([a.token, b.token, other.token]).size).toBe(3);
    expect(await store.find("curto")).toBeUndefined();
    expect(await store.find(`${a.token}x`)).toBeUndefined();
  });

  it("vence: some do achar e a entrada é apagada do arquivo", async () => {
    const { open, advance, file } = await setup();
    const store = await open();
    const link = await store.set("principal", "Q-0001", 1);
    if (!link.shared) throw new Error("x");
    advance(86_400_000 - 1);
    expect(await store.find(link.token)).toBeDefined();
    advance(1);
    expect(await store.find(link.token)).toBeUndefined();
    await store.idle();
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual([]);
    expect(await store.get("principal", "Q-0001")).toEqual({ shared: false });
  });

  it("persiste e recarrega (arquivo com os tokens, mapa pelo hash na memória)", async () => {
    const { open, file } = await setup();
    const store = await open();
    const link = await store.set("principal", "Q-0001", 30);
    if (!link.shared) throw new Error("x");
    await store.idle();
    const saved = JSON.parse(await readFile(file, "utf8")) as { token: string; ws: string; boardId: string; expiresAt?: string }[];
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ token: link.token, ws: "principal", boardId: "Q-0001" });
    const again = await open();
    expect(await again.find(link.token)).toEqual({ ws: "principal", boardId: "Q-0001" });
    expect(await again.get("principal", "Q-0001")).toEqual(link);
  });
});
