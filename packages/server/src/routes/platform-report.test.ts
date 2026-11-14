import type { PlatformReport } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { call } from "../dev/test-api";
import { useTestApp } from "../dev/test-app";
import { renderPlatformReportHtml } from "../platform/reports/render-html";

const setupApp = useTestApp();

describe("API: a semana da plataforma (o bloco Gestão da página do Cyno)", () => {
  it("a semana fechada sai em json, html (página isolada, sem rede), md e text; formato ou período ruim dá erro", async () => {
    // Quinta, 12/11/2026: a última semana fechada é a W45.
    const now = () => new Date("2026-11-12T15:00:00.000Z");
    const setup = await setupApp({ now });
    const json = await call<PlatformReport>(setup.app, "GET", "/api/cyno/reports/week/latest");
    expect(json).toMatchObject({ kind: "week", period: "2026-W45" });
    expect(json.workspaces.map((block) => block.workspace)).toContain("principal");

    const html = await setup.app.inject({ method: "GET", url: "/api/cyno/reports/week/2026-W45?format=html" });
    expect(html.statusCode).toBe(200);
    expect(html.headers["content-type"]).toContain("text/html");
    expect(html.headers["content-security-policy"]).toBe("default-src 'none'; style-src 'unsafe-inline'; sandbox");
    expect(html.body).toContain("Semana da plataforma");
    expect(html.body).not.toMatch(/<script|src=|@import|https?:\/\//);
    const md = await setup.app.inject({ method: "GET", url: "/api/cyno/reports/week/latest?format=md" });
    expect(md.body).toContain("# Semana da plataforma");
    const text = await setup.app.inject({ method: "GET", url: "/api/cyno/reports/week/latest?format=text" });
    expect(text.body).toContain("Platform week 2026-W45");

    await call(setup.app, "GET", "/api/cyno/reports/week/latest?format=pdf", undefined, 400);
    await call(setup.app, "GET", "/api/cyno/reports/week/2026-W99", undefined, 404);
    // Uma semana que ainda não fechou não tem relatório da plataforma.
    await call(setup.app, "GET", "/api/cyno/reports/week/2026-W46", undefined, 404);
  });
});

describe("a página da semana da plataforma", () => {
  const digest = { deliveries: 4, spendUsd: 2.5, deliveryCostUsd: 2, costPerDelivery: 0.5, cycle: { median: 3_600_000, p90: null, n: 4 }, approvalWait: { median: null, p90: null, n: 0 }, failure: { hits: 0, n: 4 }, rejection: { hits: 1, n: 4 }, rework: { hits: 0, n: 4 }, edit: { hits: 2, n: 4 }, goals: { hit: 1, total: 2 }, quotaPeak: 72 };

  it("escapa o que vem dos dados e mostra a soma e um bloco por workspace", () => {
    const html = renderPlatformReportHtml({ v: 1, kind: "week", period: "2026-W45", from: "2026-11-02T03:00:00.000Z", to: "2026-11-09T03:00:00.000Z", generatedAt: "2026-11-09T11:30:00.000Z", total: digest, workspaces: [{ workspace: "x", name: "<b>Loja</b> & Cia", digest, deliveries: 4, bestAgent: "Clara" }] });
    expect(html).toContain("&lt;b&gt;Loja&lt;/b&gt; &amp; Cia");
    expect(html).not.toContain("<b>Loja");
    expect(html).toContain("Clara");
    expect(html).toContain("1 de 2");
    expect(html).toContain("equivalentes à API");
  });
});
