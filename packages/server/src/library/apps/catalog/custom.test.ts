import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { APP_CATALOG } from "./index";
import { loadCustomCatalog } from "./custom";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 60 })));
});

describe("catálogo do dono (custom-catalog.json)", () => {
  it("acrescenta entradas válidas e ignora as inválidas, as repetidas e o arquivo quebrado", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "cyno-custom-"));
    dirs.push(dir);
    const warnings: string[] = [];
    const warn = (message: string) => warnings.push(message);
    // Sem arquivo: nada.
    expect(await loadCustomCatalog(dir, APP_CATALOG, warn)).toEqual([]);
    const base = APP_CATALOG.find((app) => app.id === "markitdown")!;
    await writeFile(path.join(dir, "custom-catalog.json"), JSON.stringify([{ ...base, id: "meu-app", name: "Meu app" }, { ...base, id: "markitdown" }, { ...base, id: "sem-receita", recipe: [] }, { id: "lixo" }]));
    const loaded = await loadCustomCatalog(dir, APP_CATALOG, warn);
    expect(loaded.map((app) => app.id)).toEqual(["meu-app"]);
    expect(warnings).toHaveLength(3);
    await writeFile(path.join(dir, "custom-catalog.json"), "{ quebrado");
    expect(await loadCustomCatalog(dir, APP_CATALOG, warn)).toEqual([]);
    expect(warnings.at(-1)).toMatch(/malformado/);
  });
});
