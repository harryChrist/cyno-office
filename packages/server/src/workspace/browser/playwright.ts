import type { BrowserType } from "playwright-core";

let cached: Promise<BrowserType> | undefined;

/**
 * Carrega `playwright-core` sob demanda. No pacote desktop autônomo ele fica fora do bundle
 * para manter o instalador enxuto; quando ausente, falha com mensagem clara só ao usar o recurso.
 */
export async function loadChromium(): Promise<BrowserType> {
  if (!cached) {
    cached = import("playwright-core").then(
      (mod) => mod.chromium,
      (error: unknown) => {
        cached = undefined;
        const code = (error as NodeJS.ErrnoException | null | undefined)?.code;
        if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") {
          throw new Error("playwright-core não está instalado neste pacote (o navegador integrado não faz parte do instalador autônomo).");
        }
        throw error;
      },
    );
  }
  return cached;
}
