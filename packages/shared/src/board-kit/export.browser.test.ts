import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BOARD_EXAMPLE_CATALOG_HTML, buildBoardDocument, exampleCatalogData } from "./index";

/**
 * Teste do comportamento da exportação num Chromium de verdade (o Vitest daqui não tem DOM). Pula sozinho quando
 * não há Chromium ou playwright-core na máquina.
 */
// O código de dentro de page.evaluate roda no navegador (este pacote compila sem a lib "dom").
/* eslint-disable @typescript-eslint/no-explicit-any */
declare const document: any;
declare const window: any;

type Page = {
  setContent(html: string, o?: unknown): Promise<void>;
  route(url: string, handler: (route: { fulfill(o: { status: number; contentType: string; body: string }): Promise<void> }) => unknown): Promise<void>;
  goto(url: string): Promise<unknown>;
  evaluate<T>(fn: string | ((arg: never) => T | Promise<T>), arg?: unknown): Promise<T>;
  waitForFunction(fn: string, arg?: unknown, o?: unknown): Promise<unknown>;
};
type Browser = { newPage(): Promise<Page>; close(): Promise<void> };

let browser: Browser | undefined;
try {
  const pw = (await import("playwright-core")) as unknown as { chromium: { launch(o: unknown): Promise<Browser> } };
  browser = await pw.chromium.launch({ channel: "chromium", headless: true, args: ["--no-first-run", "--disable-gpu", "--disable-dev-shm-usage"] });
} catch {
  browser = undefined;
}

const COUNT = 300;
const data = exampleCatalogData(COUNT) as { works: Record<string, Record<string, unknown>> } & Record<string, unknown>;
// Nome que começa com "=" para provar a proteção contra injeção de fórmula, e um com "|" e quebra de linha.
data.works.w001!.name = "=HYPERLINK(1)";
data.works.w002!.name = "Pipe | e\nquebra";
const doc = buildBoardDocument({ html: BOARD_EXAMPLE_CATALOG_HTML, data, meta: { id: "Q-0001", title: "Catálogo de teste", description: "Descrição de teste" } });

describe.skipIf(!browser)("exportação no navegador", () => {
  let page: Page;
  beforeAll(async () => {
    page = await browser!.newPage();
    await page.setContent(doc, { waitUntil: "load" });
    await page.waitForFunction("window.__quadroSettled === true", undefined, { timeout: 10_000 });
  });
  afterAll(async () => {
    await (page as unknown as { close(): Promise<void> }).close();
    await browser?.close();
  });

  it("window.__quadroSettled vira true", async () => {
    expect(await page.evaluate("window.__quadroSettled")).toBe(true);
  });

  it("toMarkdown traz as 300 linhas, o título, os cartões e os gráficos", async () => {
    const md = await page.evaluate<string>("Quadro.toMarkdown()");
    // Cabeçalho + separador + 300 linhas na tabela de obras.
    const worksTable = md.slice(md.indexOf("| Obra |"));
    expect(worksTable.split("\n").filter((l) => l.startsWith("| ")).length).toBe(COUNT + 2);
    expect(md).toContain("**Obras:** 300");
    expect(md).toContain("## Todas as obras");
    expect(md).toContain("| Rótulo | Valor | Parte |");
    expect(md).toContain("Pipe \\| e quebra");
    expect(md).not.toContain("[object");
    expect(md.startsWith("# Catálogo de obras")).toBe(true);
  });

  it("toCsv começa com BOM, usa ; e traz 300 linhas, protegendo fórmula", async () => {
    const csv = await page.evaluate<string>("Quadro.toCsv()");
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv.split("\r\n").filter(Boolean)).toHaveLength(COUNT + 1);
    expect(csv.split("\r\n")[0]).toBe("﻿Obra;Status;Último cap.;Progresso;Atualizada");
    expect(csv).toContain("'=HYPERLINK(1)");
    expect(csv).toContain("\r\nPipe | e quebra;");
  });

  it("expandAll deixa as 300 linhas no DOM", async () => {
    expect(await page.evaluate("document.querySelectorAll('#works tbody tr').length")).toBe(25);
    expect(await page.evaluate("Quadro.expandAll()")).toBe(1);
    expect(await page.evaluate("document.querySelectorAll('#works tbody tr').length")).toBe(COUNT);
  });

  it("responde quadro:export dentro de um iframe sandbox", async () => {
    const mae = await browser!.newPage();
    // Página-mãe com endereço de verdade (um iframe sandbox dentro de about:blank derruba este Chromium).
    await mae.route("http://mae.test/", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><body></body>" }));
    await mae.goto("http://mae.test/");
    const result = await mae.evaluate(
      (srcdoc: never) =>
        new Promise<Record<string, unknown>[]>((resolve) => {
          const frame = document.createElement("iframe");
          frame.setAttribute("sandbox", "allow-scripts");
          const got: Record<string, unknown>[] = [];
          window.addEventListener("message", (e: any) => {
            const m = e.data as Record<string, unknown>;
            if (e.source !== frame.contentWindow || !m) return;
            if (m.type === "quadro:ready") {
              for (const [i, f] of ["md", "csv", "xml"].entries()) frame.contentWindow!.postMessage({ type: "quadro:export", requestId: "r" + i, format: f }, "*");
            }
            if (m.type === "quadro:export-result") {
              got.push(m);
              if (got.length === 3) resolve(got);
            }
          });
          frame.srcdoc = srcdoc as string;
          document.body.appendChild(frame);
        }),
      doc as never,
    );
    const byId = Object.fromEntries(result.map((r) => [String(r.requestId), r]));
    expect(byId.r0).toMatchObject({ type: "quadro:export-result", format: "md", ok: true });
    expect(String(byId.r0!.text)).toContain("| Obra |");
    expect(byId.r1).toMatchObject({ format: "csv", ok: true });
    expect(String(byId.r1!.text).charCodeAt(0)).toBe(0xfeff);
    expect(byId.r2).toMatchObject({ format: "xml", ok: false });
    expect(String(byId.r2!.error)).toContain("xml");
    await (mae as unknown as { close(): Promise<void> }).close();
  });
});
