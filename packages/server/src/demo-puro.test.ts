import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// A demonstração (shared/src/demo) é pura: nada de rede, arquivo, relógio nem aleatório do sistema. Nenhuma chamada ao servidor.
describe("shared/demo é puro", () => {
  const dir = path.resolve(__dirname, "../../shared/src/demo");
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))) {
    it(file, () => {
      const source = readFileSync(path.join(dir, file), "utf8");
      expect(source).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|WebSocket|node:|Math\.random|Date\.now|new Date\(\)|localStorage/);
    });
  }
});
