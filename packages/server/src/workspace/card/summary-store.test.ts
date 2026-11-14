import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { useTempDirs } from "../../dev/test-utils";
import { WriteQueue } from "../../store/write-queue";
import { CardSummaryStore } from "./summary-store";

const tempDir = useTempDirs();
const now = () => new Date("2026-11-11T12:00:00Z");

async function open() {
  const dir = await tempDir();
  const file = path.join(dir, "card.json");
  const queue = new WriteQueue();
  const store = await CardSummaryStore.open({ file, queue, now });
  return { store, file, queue, reopen: () => CardSummaryStore.open({ file, queue, now }) };
}

describe("CardSummaryStore (a frase da ficha)", () => {
  it("sem arquivo, sem frase; o dono escreve e a frase sobrevive ao reabrir", async () => {
    const { store, file, queue, reopen } = await open();
    expect(store.get().summary).toBe("");
    const result = await store.write("  Posts   do perfil  ", "dono");
    expect(result.stored).toBe("frase");
    await queue.idle();
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ summary: "Posts do perfil", by: "dono", at: "2026-11-11T12:00:00.000Z" });
    expect((await reopen()).get().summary).toBe("Posts do perfil");
  });

  it("o Maestro escreve se não há frase do dono; sobre a do dono vira sugestão", async () => {
    const { store } = await open();
    expect((await store.write("Frase do Maestro", "maestro")).stored).toBe("frase");
    expect(store.get().by).toBe("maestro");
    await store.write("Frase do dono", "dono");
    const result = await store.write("Outra do Maestro", "maestro");
    expect(result.stored).toBe("sugestao");
    expect(store.get()).toMatchObject({ summary: "Frase do dono", by: "dono", proposal: { summary: "Outra do Maestro", by: "maestro" } });
    // A mesma sugestão de novo não muda nada; o dono ignora.
    expect((await store.write("Outra do Maestro", "maestro")).stored).toBe("igual");
    expect((await store.dismissProposal()).proposal).toBeUndefined();
  });

  it("o dono escreve por cima (a sugestão pendente some); aceitar é escrever o mesmo texto", async () => {
    const { store } = await open();
    await store.write("Frase do dono", "dono");
    await store.write("Sugestão", "cyno");
    await store.write("Sugestão", "dono");
    expect(store.get()).toMatchObject({ summary: "Sugestão", by: "dono" });
    expect(store.get().proposal).toBeUndefined();
  });

  it("recusa frase acima de 280 caracteres e avisa os ouvintes quando muda", async () => {
    const { store } = await open();
    await expect(store.write("x".repeat(281), "dono")).rejects.toThrow(/280/);
    const listener = vi.fn();
    store.onChange(listener);
    await store.write("Nova", "dono");
    await store.write("Nova", "dono");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("arquivo estragado é ignorado", async () => {
    const dir = await tempDir();
    const file = path.join(dir, "card.json");
    await writeFile(file, "{não é json");
    expect((await CardSummaryStore.open({ file, queue: new WriteQueue(), now })).get().summary).toBe("");
  });
});
