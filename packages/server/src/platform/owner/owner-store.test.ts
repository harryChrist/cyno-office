import { readFile } from "node:fs/promises";
import path from "node:path";
import { AWAY_MIN_MS } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { useTempDirs } from "../../dev/test-utils";
import { OwnerStore } from "./owner-store";

const tempDir = useTempDirs();
const T0 = Date.parse("2026-11-12T12:00:00.000Z");
const MIN = 60_000;

describe("OwnerStore: a presença do dono", () => {
  it("a primeira presença da instalação não abre ausência", () => {
    const store = OwnerStore.inMemory();
    expect(store.presence(T0)).toBe(false);
    expect(store.lastActiveAt()).toBe(new Date(T0).toISOString());
    expect(store.episode()).toBeUndefined();
  });

  it("presença seguida (a cada minuto) nunca abre ausência; ausência curta (menos de 30 min) também não", () => {
    const store = OwnerStore.inMemory();
    store.presence(T0);
    for (let i = 1; i <= 10; i += 1) expect(store.presence(T0 + i * MIN)).toBe(false);
    expect(store.presence(T0 + 10 * MIN + AWAY_MIN_MS - 1)).toBe(false);
    expect(store.pending()).toBeUndefined();
  });

  it("30 minutos exatos ou mais sem presença abre a ausência, de quando saiu a quando voltou", () => {
    const store = OwnerStore.inMemory();
    store.presence(T0);
    expect(store.presence(T0 + AWAY_MIN_MS)).toBe(true);
    expect(store.pending()).toEqual({ since: new Date(T0).toISOString(), returnedAt: new Date(T0 + AWAY_MIN_MS).toISOString() });
    // A presença seguinte (outro navegador, um minuto depois) continua vendo a mesma ausência pendente.
    expect(store.presence(T0 + AWAY_MIN_MS + MIN)).toBe(true);
    expect(store.pending()!.since).toBe(new Date(T0).toISOString());
  });

  it("\"Ok, vi\" vale para todos os navegadores: depois dele ninguém tem ausência pendente", () => {
    const store = OwnerStore.inMemory();
    store.presence(T0);
    store.presence(T0 + 2 * 3_600_000);
    expect(store.markSeen(T0 + 2 * 3_600_000 + 5_000)).toBe(true);
    expect(store.pending()).toBeUndefined();
    expect(store.presence(T0 + 2 * 3_600_000 + MIN)).toBe(false);
    // O registro da última ausência continua (o Cyno responde "o que aconteceu enquanto eu estava fora?").
    expect(store.episode()).toMatchObject({ since: new Date(T0).toISOString(), seenAt: expect.any(String) });
    // Confirmar de novo sem ausência pendente não faz nada.
    expect(store.markSeen(T0 + 3 * 3_600_000)).toBe(false);
  });

  it("uma ausência nova com a anterior ainda não confirmada junta as duas (cobre desde a mais antiga)", () => {
    const store = OwnerStore.inMemory();
    store.presence(T0);
    store.presence(T0 + 2 * 3_600_000);
    store.presence(T0 + 2 * 3_600_000 + MIN);
    store.presence(T0 + 5 * 3_600_000);
    expect(store.pending()!.since).toBe(new Date(T0).toISOString());
    expect(store.pending()!.returnedAt).toBe(new Date(T0 + 5 * 3_600_000).toISOString());
  });

  it("depois de confirmada, a ausência seguinte começa da última presença", () => {
    const store = OwnerStore.inMemory();
    store.presence(T0);
    store.presence(T0 + 2 * 3_600_000);
    store.markSeen(T0 + 2 * 3_600_000);
    store.presence(T0 + 2 * 3_600_000 + 10 * MIN);
    store.presence(T0 + 6 * 3_600_000);
    expect(store.pending()!.since).toBe(new Date(T0 + 2 * 3_600_000 + 10 * MIN).toISOString());
  });

  it("grava em disco e volta igual depois de um reinício", async () => {
    const file = path.join(await tempDir(), "platform", "owner.json");
    const store = await OwnerStore.load(file);
    store.presence(T0);
    store.presence(T0 + 3_600_000);
    await store.flush();
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ lastActiveAt: new Date(T0 + 3_600_000).toISOString(), episode: { since: new Date(T0).toISOString() } });
    const again = await OwnerStore.load(file);
    expect(again.pending()).toMatchObject({ since: new Date(T0).toISOString() });
    again.markSeen(T0 + 3_600_000 + MIN);
    await again.flush();
    expect((await OwnerStore.load(file)).pending()).toBeUndefined();
  });

  it("arquivo quebrado: começa limpo, sem ausência", async () => {
    const file = path.join(await tempDir(), "owner.json");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(file, "{ não é json");
    const store = await OwnerStore.load(file);
    expect(store.presence(T0)).toBe(false);
  });
});
