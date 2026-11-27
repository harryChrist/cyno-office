import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// No macOS e no Windows o disco não diferencia maiúsculas de minúsculas. Com `Markdown.tsx` e `markdown.ts` na mesma
// pasta, `import ... from "./Markdown"` acha primeiro `markdown.ts` (o Vite tenta `.ts` antes de `.tsx`) e o build
// quebra lá, embora passe no Linux do CI. Este teste barra dois módulos que só mudam na caixa das letras.
const packages = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MODULE = /\.(?:[cm]?[jt]sx?)$/;
const SKIP = new Set(["node_modules", "dist", ".vite", "coverage"]);

function collisions(dir: string, found: string[] = []): string[] {
  const seen = new Map<string, string>();
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP.has(entry.name)) collisions(path.join(dir, entry.name), found);
      continue;
    }
    if (!MODULE.test(entry.name) || /\.d\.ts$/.test(entry.name)) continue;
    const key = entry.name.replace(/\.test(?=\.)/, "#test").replace(MODULE, "").toLowerCase();
    const other = seen.get(key);
    const base = entry.name.replace(MODULE, "");
    if (other !== undefined && other !== base) found.push(path.relative(packages, path.join(dir, `${other} ↔ ${entry.name}`)));
    else seen.set(key, base);
  }
  return found;
}

describe("nomes de arquivo", () => {
  it("nenhum módulo difere de outro só em maiúsculas e minúsculas (quebra o build no macOS e no Windows)", () => {
    expect(collisions(packages)).toEqual([]);
  });
});
