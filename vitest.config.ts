import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "packages/cena/{client/src,shared}/**/*.test.ts"],
    environment: "node",
    // Sem a cerca de arquivos (Landlock) nos testes comuns: os programas falsos moram na pasta do repositório, fora da lista do que pode. Os testes da cerca ligam por injeção.
    env: { CYNO_FENCE: "off" },
  },
});
