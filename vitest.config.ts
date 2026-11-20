import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "packages/cena/{client/src,shared}/**/*.test.ts"],
    environment: "node",
    // A máquina do CI é bem mais lenta que a local: o limite de 5 s por teste estourava em testes que sobem processos.
    testTimeout: process.env.CI ? 20_000 : 5_000,
    hookTimeout: process.env.CI ? 30_000 : 10_000,
    // Sem a cerca de arquivos (Landlock) nos testes comuns: os programas falsos moram na pasta do repositório, fora da lista do que pode. Os testes da cerca ligam por injeção.
    env: { CYNO_FENCE: "off" },
  },
});
