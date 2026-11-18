import { buildBoardDocument, exampleCatalogData, BOARD_EXAMPLE_CATALOG_HTML, BOARD_CSP_HEADER } from "@cyno/shared";
import type { Browser } from "playwright-core";
import { chromium } from "playwright-core";
import { describe, expect, it } from "vitest";
import { renderBoardPdf } from "./render-board";

/** Navegador falso: grava as chamadas e devolve um PDF de mentira. */
function fakeLauncher(options: { hasMarker?: boolean; hang?: boolean } = {}) {
  const calls: string[] = [];
  let routeHandler: ((route: unknown) => Promise<void>) | undefined;
  const routed: { url: string; action: string; headers?: Record<string, string> }[] = [];
  const page = {
    emulateMedia: async (arg: unknown) => void calls.push(`media:${JSON.stringify(arg)}`),
    goto: async () => {
      calls.push("goto");
      if (options.hang) await new Promise(() => undefined);
      const make = (url: string) => ({
        request: () => ({ url: () => url }),
        fulfill: async (init: { headers: Record<string, string> }) => void routed.push({ url, action: "fulfill", headers: init.headers }),
        abort: async () => void routed.push({ url, action: "abort" }),
      });
      await routeHandler!(make("http://cyno-board.invalid/"));
      await routeHandler!(make("https://exemplo.test/rastreador.js"));
    },
    evaluate: async (script: string) => {
      calls.push(`eval:${script.slice(0, 20)}`);
      return options.hasMarker ?? true;
    },
    waitForFunction: async () => void calls.push("settled"),
    waitForTimeout: async () => void calls.push("fallback"),
    pdf: async (arg: unknown) => {
      calls.push(`pdf:${JSON.stringify(arg)}`);
      return Buffer.from("%PDF-falso");
    },
  };
  const context = {
    route: async (_glob: string, handler: (route: unknown) => Promise<void>) => void (routeHandler = handler),
    newPage: async () => page,
    close: async () => void calls.push("context-closed"),
  };
  const state = { closed: false, contextOptions: undefined as unknown };
  const browser = {
    newContext: async (opts: unknown) => {
      state.contextOptions = opts;
      return context;
    },
    close: async () => void (state.closed = true),
  } as unknown as Browser;
  return { launch: async () => browser, calls, routed, state };
}

describe("renderBoardPdf (navegador falso)", () => {
  it("contexto isolado com JS, só o documento passa, mídia print, espera o desenho e fecha tudo", async () => {
    const fake = fakeLauncher();
    const pdf = await renderBoardPdf("<html>doc</html>", fake.launch);
    expect(pdf.toString()).toBe("%PDF-falso");
    expect(fake.state.contextOptions).toMatchObject({ javaScriptEnabled: true, viewport: { width: 1280, height: 900 }, serviceWorkers: "block", acceptDownloads: false });
    expect(fake.routed).toEqual([
      { url: "http://cyno-board.invalid/", action: "fulfill", headers: { "content-security-policy": BOARD_CSP_HEADER } },
      { url: "https://exemplo.test/rastreador.js", action: "abort" },
    ]);
    expect(fake.calls[0]).toBe('media:{"media":"print"}');
    expect(fake.calls).toContain("settled");
    expect(fake.calls.some((call) => call.startsWith("pdf:") && call.includes('"printBackground":true') && call.includes('"preferCSSPageSize":true') && call.includes('"format":"A4"') && call.includes('"landscape":true'))).toBe(true);
    expect(fake.calls.indexOf("settled")).toBeLessThan(fake.calls.findIndex((call) => call.startsWith("pdf:")));
    expect(fake.calls).toContain("context-closed");
    expect(fake.state.closed).toBe(true);
  });

  it("kit antigo, sem o marcador: segue depois de um tempo curto", async () => {
    const fake = fakeLauncher({ hasMarker: false });
    await renderBoardPdf("<html/>", fake.launch);
    expect(fake.calls).toContain("fallback");
    expect(fake.calls).not.toContain("settled");
  });
});

const hasChromium = await chromium
  .launch({ channel: "chromium", headless: true })
  .then((browser) => browser.close().then(() => true))
  .catch(() => false);

describe.skipIf(!hasChromium)("renderBoardPdf (Chromium de verdade)", () => {
  it("gera o PDF de um quadro de exemplo com mais de uma página", async () => {
    const html = buildBoardDocument({ html: BOARD_EXAMPLE_CATALOG_HTML, data: exampleCatalogData(300), meta: { title: "Catálogo de exemplo", description: "300 obras", dataUpdatedAt: "2026-11-18T12:00:00.000Z" } });
    const pdf = await renderBoardPdf(html);
    expect(pdf.subarray(0, 4).toString()).toBe("%PDF");
    const pages = (pdf.toString("latin1").match(/\/Type\s*\/Page[^s]/g) ?? []).length;
    console.info(`PDF real: ${pages} página(s), ${pdf.length} bytes`);
    expect(pages).toBeGreaterThan(1);
  }, 60_000);
});
