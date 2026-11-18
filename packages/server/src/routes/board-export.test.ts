import { boardExportPath } from "@cyno/shared";
import { describe, expect, it, vi } from "vitest";
import { wsApi } from "../dev/test-api";
import { useTestApp } from "../dev/test-app";

const render = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("../workspace/browser/render-board", async (importOriginal) => ({ ...(await importOriginal<typeof import("../workspace/browser/render-board")>()), renderBoardPdf: render.fn }));
const { BoardPdfTimeoutError } = await import("../workspace/browser/render-board");

const setupApp = useTestApp();

async function app() {
  const test = await setupApp();
  await test.workspaces.get("principal").boards.create({ title: "Obras de Maio", description: "Catálogo", source: "sync.py", html: "<p>oi</p>", createdBy: "clara" });
  return test;
}

describe("GET /boards/:id/export?format=pdf", () => {
  it("devolve o PDF como anexo com o nome do quadro e um documento sem ids", async () => {
    render.fn.mockReset().mockResolvedValue(Buffer.from("%PDF-1.4 teste"));
    const { app: server } = await app();
    const response = await server.inject({ method: "GET", url: `${wsApi()}${boardExportPath("Q-0001", "pdf")}` });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("application/pdf");
    expect(String(response.headers["content-disposition"])).toContain('attachment; filename="obras-de-maio.pdf"');
    expect(response.rawPayload.subarray(0, 4).toString()).toBe("%PDF");
    const html = render.fn.mock.calls[0]![0] as string;
    expect(html).toContain("Obras de Maio");
    for (const secret of ["Q-0001", "clara", "sync.py"]) expect(html, secret).not.toContain(secret);
  });

  it("formato inválido 400, quadro inexistente 404, estouro de prazo 504, falha 502", async () => {
    const { app: server } = await app();
    expect((await server.inject({ method: "GET", url: `${wsApi()}/boards/Q-0001/export?format=docx` })).statusCode).toBe(400);
    expect((await server.inject({ method: "GET", url: `${wsApi()}/boards/Q-0001/export` })).statusCode).toBe(400);
    expect((await server.inject({ method: "GET", url: `${wsApi()}/boards/Q-0099/export?format=pdf` })).statusCode).toBe(404);
    render.fn.mockReset().mockRejectedValue(new BoardPdfTimeoutError());
    const late = await server.inject({ method: "GET", url: `${wsApi()}/boards/Q-0001/export?format=pdf` });
    expect(late.statusCode).toBe(504);
    expect(late.json<{ error: string }>().error).toContain("demorou demais");
    render.fn.mockReset().mockRejectedValue(new Error("falhou\ndetalhe"));
    expect((await server.inject({ method: "GET", url: `${wsApi()}/boards/Q-0001/export?format=pdf` })).statusCode).toBe(502);
  });
});
