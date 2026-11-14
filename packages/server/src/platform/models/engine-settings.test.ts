import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { useTempDirs } from "../../dev/test-utils";
import { EngineSettingsStore } from "./engine-settings";

const tempDir = useTempDirs();

describe("a opção 'Cercar os arquivos do agente' (fence)", () => {
  it("nasce ligada (também para dados antigos que não têm o campo) e a escolha sobrevive a reabrir", async () => {
    const file = path.join(await tempDir(), "engines.json");
    // Dados de antes da cerca: o arquivo não tem `fence`.
    await writeFile(file, JSON.stringify({ paths: { hermes: "/usr/bin/hermes" }, tests: {}, choices: {}, spent: {}, verify: {}, account: { hermes: { mode: "program", location: "cyno" } } }));
    const store = await EngineSettingsStore.load(file);
    expect(store.fence("hermes")).toBe(true);
    expect(store.fence("openclaw")).toBe(true);
    // O resto do que já estava gravado continua valendo.
    expect(store.paths().hermes).toBe("/usr/bin/hermes");
    expect(store.account("hermes")).toEqual({ mode: "program", location: "cyno" });

    await store.setFence("hermes", false);
    await store.flush();
    const again = await EngineSettingsStore.load(file);
    expect(again.fence("hermes")).toBe(false);
    expect(again.fence("openclaw")).toBe(true);
    expect(again.paths().hermes).toBe("/usr/bin/hermes");
  });

  it("valor que não é verdadeiro/falso no arquivo é ignorado (volta ao padrão)", async () => {
    const file = path.join(await tempDir(), "engines.json");
    await writeFile(file, JSON.stringify({ fence: { hermes: "nao", openclaw: false } }));
    const store = await EngineSettingsStore.load(file);
    expect(store.fence("hermes")).toBe(true);
    expect(store.fence("openclaw")).toBe(false);
  });
});
