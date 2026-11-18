import { BOARD_CSP_HEADER } from "@cyno/shared";
import type { Browser } from "playwright-core";
import { enqueueRender, launchRenderBrowser, type RenderLauncher } from "./render";

/** Prazo total do PDF (abrir o navegador, desenhar o quadro e gerar). */
export const BOARD_PDF_TIMEOUT_MS = 30_000;
/** Quanto esperar o marcador `__quadroSettled` antes de seguir (um kit antigo não o tem). */
const SETTLE_WAIT_MS = 10_000;
const SETTLE_FALLBACK_MS = 1_500;

/** Endereço fictício em que o documento entra: o mesmo cabeçalho CSP do link dá à página uma origem opaca. */
const BOARD_URL = "http://cyno-board.invalid/";

export class BoardPdfTimeoutError extends Error {
  constructor() {
    super(`O PDF levou mais de ${BOARD_PDF_TIMEOUT_MS / 1000} s para ficar pronto`);
    this.name = "BoardPdfTimeoutError";
  }
}

/**
 * Gera o PDF de um documento de Quadro (o HTML completo de `buildBoardDocument`) num Chromium NOVO e isolado:
 * JavaScript ligado (o kit desenha tudo por JS), toda requisição de rede bloqueada menos o próprio documento,
 * mídia "print", espera o primeiro desenho, mostra todas as linhas das tabelas e imprime em A4 paisagem.
 * Uma renderização por vez (fila compartilhada com as imagens) e o contexto é sempre fechado.
 */
export function renderBoardPdf(documentHtml: string, launch: RenderLauncher = launchRenderBrowser): Promise<Buffer> {
  return enqueueRender(() => render(documentHtml, launch));
}

async function render(documentHtml: string, launch: RenderLauncher): Promise<Buffer> {
  let browser: Browser | undefined;
  const work = (async () => {
    browser = await launch();
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      javaScriptEnabled: true,
      acceptDownloads: false,
      serviceWorkers: "block",
      locale: "pt-BR",
      timezoneId: "America/Sao_Paulo",
    });
    try {
      await context.route("**/*", async (route) => {
        if (route.request().url() === BOARD_URL) {
          await route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", headers: { "content-security-policy": BOARD_CSP_HEADER }, body: documentHtml });
        } else await route.abort("blockedbyclient");
      });
      const page = await context.newPage();
      await page.emulateMedia({ media: "print" });
      await page.goto(BOARD_URL, { waitUntil: "load", timeout: BOARD_PDF_TIMEOUT_MS });
      // Kit novo: espera o marcador. Kit antigo (sem o marcador): segue depois de um tempo curto.
      const hasMarker = await page.evaluate<boolean>('"__quadroSettled" in window').catch(() => false);
      if (hasMarker) await page.waitForFunction("window.__quadroSettled === true", undefined, { timeout: SETTLE_WAIT_MS }).catch(() => undefined);
      else await page.waitForTimeout(SETTLE_FALLBACK_MS);
      await page.evaluate("window.Quadro && typeof window.Quadro.expandAll === 'function' && window.Quadro.expandAll()").catch(() => undefined);
      await page.evaluate("new Promise((resolve) => requestAnimationFrame(() => resolve(true)))").catch(() => undefined);
      const pdf = await page.pdf({ printBackground: true, preferCSSPageSize: true, format: "A4", landscape: true });
      return Buffer.from(pdf);
    } finally {
      await context.close().catch(() => undefined);
    }
  })();
  const deadline = new Promise<never>((_, reject) => {
    const timer = setTimeout(() => {
      reject(new BoardPdfTimeoutError());
    }, BOARD_PDF_TIMEOUT_MS);
    timer.unref();
    work.then(() => clearTimeout(timer), () => clearTimeout(timer));
  });
  // Se o prazo estourar, o trabalho solto não pode virar erro sem dono.
  work.catch(() => undefined);
  // E se o navegador só terminar de abrir depois do prazo, ele ainda é fechado.
  void work.then(() => undefined, () => undefined).then(() => browser?.close().catch(() => undefined));
  try {
    return await Promise.race([work, deadline]);
  } finally {
    await browser?.close().catch(() => undefined);
  }
}
