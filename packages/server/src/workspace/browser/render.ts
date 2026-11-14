import { chromium, type Browser } from "playwright-core";
import type { UrlPolicy } from "./url-policy";

/** Lado máximo da página renderizada (px) e tempo máximo de uma renderização. */
export const RENDER_MAX_SIDE = 4096;
export const RENDER_TIMEOUT_MS = 20_000;

/** Endereço fictício em que o HTML entra (assim o JavaScript pode ficar desligado: nada de setContent). */
const RENDER_URL = "http://cyno-render.invalid/";

export type RenderInput = {
  html: string;
  width: number;
  height: number;
  format: "png" | "jpeg";
  scale: 1 | 2;
  /** Captura a página inteira em vez de só a janela (a altura é a do conteúdo): os relatórios da Gestão são mais altos que a tela. */
  fullPage?: boolean;
};

/** Abre o Chromium só para uma renderização (os testes podem trocar). */
export type RenderLauncher = () => Promise<Browser>;

const defaultLauncher: RenderLauncher = () => chromium.launch({ channel: "chromium", headless: true, args: ["--disable-dev-shm-usage", "--no-first-run", "--no-default-browser-check"] });

/** Uma renderização por vez: cada uma sobe um Chromium e a memória é curta. */
let tail: Promise<unknown> = Promise.resolve();

/**
 * Renderiza HTML em imagem num contexto NOVO e isolado (sem o perfil com logins do workspace):
 * JavaScript desligado, mesma política de rede do navegador (nada de rede local; a internet vale,
 * para as fontes da web carregarem), viewport limitado a 4096 px e prazo de 20 s no total.
 */
export function renderHtml(input: RenderInput, policy: Pick<UrlPolicy, "allowsRequest">, launch: RenderLauncher = defaultLauncher): Promise<Buffer> {
  const run = tail.then(() => render(input, policy, launch));
  tail = run.catch(() => undefined);
  return run;
}

async function render(input: RenderInput, policy: Pick<UrlPolicy, "allowsRequest">, launch: RenderLauncher): Promise<Buffer> {
  const width = Math.min(RENDER_MAX_SIDE, Math.max(1, Math.round(input.width)));
  const height = Math.min(RENDER_MAX_SIDE, Math.max(1, Math.round(input.height)));
  let browser: Browser | undefined;
  const work = (async () => {
    browser = await launch();
    const context = await browser.newContext({
      viewport: { width, height },
      deviceScaleFactor: input.scale,
      javaScriptEnabled: false,
      acceptDownloads: false,
      serviceWorkers: "block",
      locale: "pt-BR",
      timezoneId: "America/Sao_Paulo",
    });
    await context.route("**/*", async (route) => {
      const url = route.request().url();
      if (url === RENDER_URL) {
        await route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", headers: { "content-security-policy": "script-src 'none'" }, body: input.html });
      } else if (await policy.allowsRequest(url, false)) await route.fallback();
      else await route.abort("blockedbyclient");
    });
    const page = await context.newPage();
    await page.goto(RENDER_URL, { waitUntil: "load", timeout: RENDER_TIMEOUT_MS });
    // Fontes e imagens da web: espera a rede acalmar (sem passar do prazo).
    await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => undefined);
    return page.screenshot({ type: input.format, ...(input.format === "jpeg" ? { quality: 92 } : {}), fullPage: input.fullPage === true, timeout: RENDER_TIMEOUT_MS });
  })();
  const deadline = new Promise<never>((_, reject) => {
    const timer = setTimeout(() => reject(new Error(`Rendering took longer than ${RENDER_TIMEOUT_MS / 1000}s`)), RENDER_TIMEOUT_MS);
    timer.unref();
    work.then(() => clearTimeout(timer), () => clearTimeout(timer));
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    await browser?.close().catch(() => undefined);
  }
}
