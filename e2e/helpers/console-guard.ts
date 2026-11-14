import type { Page } from "@playwright/test";

/** Coleta tudo que indica problema no navegador: console error/warning, pageerror e requests falhas. */
export function watchConsole(page: Page): { problems: string[] } {
  const problems: string[] = [];
  page.on("console", (message) => {
    const type = message.type();
    if (type === "error" || type === "warning") {
      problems.push(`console.${type}: ${message.text()} (${message.location().url})`);
    }
  });
  page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
  page.on("requestfailed", (request) => {
    // Desmontar a cena (trocar de workspace, recarregar, fechar a página) aborta o carregamento do manifesto das imagens
    // do motor (`destroy()` aborta o `fetch`): é esperado, não é falha.
    if (request.failure()?.errorText === "net::ERR_ABORTED" && new URL(request.url()).pathname.startsWith("/cena/assets/")) return;
    problems.push(`requestfailed: ${request.method()} ${request.url()} (${request.failure()?.errorText})`);
  });
  page.on("response", (response) => {
    if (response.status() >= 400) problems.push(`HTTP ${response.status()}: ${response.url()}`);
  });
  return { problems };
}
