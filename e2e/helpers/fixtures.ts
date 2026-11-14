import { test as base, expect } from "@playwright/test";
import { watchConsole } from "./console-guard";

/**
 * `test` com guarda de console automática: qualquer console error/warning,
 * pageerror ou request com falha durante o teste reprova o teste.
 */
export const test = base.extend<{ consoleGuard: { problems: string[] } }>({
  consoleGuard: [
    async ({ page }, use) => {
      const guard = watchConsole(page);
      await use(guard);
      expect(guard.problems, "o navegador não pode emitir erros nem avisos").toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };
