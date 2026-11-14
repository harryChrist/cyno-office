import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig(
  globalIgnores([
    "**/dist/",
    "**/node_modules/",
    "test-results/",
    "playwright-report/",
    "blob-report/",
    "qa/",
    "data/",
    // Cópias de trabalho dos agentes (git worktree) ficam aqui dentro.
    ".claude/",
    // Código de terceiros (motor do Habblaud, MIT) copiado quase intacto: não se reescreve para agradar ao lint.
    // As alterações nossas estão marcadas com CYNO-PATCH e listadas em packages/cena/PATCHES.md.
    "packages/cena/",
  ]),
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.node },
    },
  },
  {
    // Prefixo "_" = "de propósito não usado" (desestruturar para tirar um campo, argumento obrigatório de callback).
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", destructuredArrayIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_", ignoreRestSiblings: true },
      ],
    },
  },
  {
    // O service worker roda fora da página: `self` e companhia, sem `window`.
    files: ["packages/web/public/sw.js"],
    languageOptions: { sourceType: "script", globals: { ...globals.serviceworker } },
  },
  {
    files: ["packages/site/src/**/*.{ts,tsx}"],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { "react-hooks": reactHooks },
    rules: reactHooks.configs.flat.recommended.rules,
  },
  {
    files: ["packages/web/src/**/*.{ts,tsx}"],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { "react-hooks": reactHooks },
    rules: reactHooks.configs.flat.recommended.rules,
  },
);
