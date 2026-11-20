import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "packages/cena/{client/src,shared}/**/*.test.ts"],
    environment: "node",
    // A máquina do CI é bem mais lenta que a local: o limite de 5 s por teste estourava em testes que sobem processos.
    testTimeout: process.env.CI ? 20_000 : 5_000,
    hookTimeout: process.env.CI ? 30_000 : 10_000,
    // Vários testes dependem de tempo real (processos, Chromium). No CI, uma lentidão pontual não deve derrubar a execução: 2 novas tentativas, e o Vitest lista o que precisou delas.
    retry: process.env.CI ? 2 : 0,
    // Sem a cerca de arquivos (Landlock) nos testes comuns: os programas falsos moram na pasta do repositório, fora da lista do que pode. Os testes da cerca ligam por injeção.
    env: { CYNO_FENCE: "off" },
  },
});
