import { describe, expect, it } from "vitest";
import { extractForbiddenMessage, forbiddenReason } from "./mcp-client";

const DISABLED = "Gmail MCP API has not been used in project 123456 before or it is disabled. Enable it by visiting https://console.developers.google.com/apis/api/gmailmcp.googleapis.com/overview?project=123456 then retry. If you enabled this API recently, wait a few minutes.";

describe("mensagem do HTTP 403", () => {
  it("lê error.message no JSON-RPC", () => {
    expect(extractForbiddenMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32001, message: "sem permissão" } }))).toBe("sem permissão");
  });

  it("lê result.content[].text quando isError é true (e ignora quando não é)", () => {
    const erro = { jsonrpc: "2.0", id: 1, result: { isError: true, content: [{ type: "text", text: "escopo" }, { type: "text", text: "faltando" }] } };
    expect(extractForbiddenMessage(JSON.stringify(erro))).toBe("escopo faltando");
    expect(extractForbiddenMessage(JSON.stringify({ result: { isError: false, content: [{ type: "text", text: "ok" }] } }))).toBeUndefined();
  });

  it("lê error.message no formato de erro do Google e em SSE", () => {
    expect(extractForbiddenMessage(JSON.stringify({ error: { code: 403, message: "Request had insufficient authentication scopes.", status: "PERMISSION_DENIED" } }))).toBe("Request had insufficient authentication scopes.");
    expect(extractForbiddenMessage(`event: message\ndata: ${JSON.stringify({ error: { message: "via sse" } })}\n\n`)).toBe("via sse");
  });

  it("corpo vazio, HTML ou JSON sem mensagem: sem mensagem legível", () => {
    for (const body of ["", "<html>Forbidden</html>", "{}", "[1,2]", "{ quebrado"]) expect(extractForbiddenMessage(body)).toBeUndefined();
    expect(forbiddenReason("<html>x</html>")).toBe("o servidor recusou o acesso (HTTP 403)");
  });

  it("mensagem comum vira o motivo, cortada em 300 caracteres", () => {
    expect(forbiddenReason(JSON.stringify({ error: { message: "sem permissão" } }))).toBe("o servidor recusou a chamada (HTTP 403): sem permissão");
    const long = forbiddenReason(JSON.stringify({ error: { message: "x".repeat(900) } }));
    expect(long).toBe(`o servidor recusou a chamada (HTTP 403): ${"x".repeat(300)}`);
  });

  it("API desativada: motivo claro em português com o endereço de ativação do Google", () => {
    const reason = forbiddenReason(JSON.stringify({ error: { message: DISABLED } }));
    expect(reason).toMatch(/^a API deste servidor não está ativada no projeto do Google Cloud\. Ative-a em https:\/\/console\.developers\.google\.com\/apis\/api\/gmailmcp\.googleapis\.com\/overview\?project=123456 e teste de novo em alguns minutos/);
    expect(reason.length).toBeLessThan(300);
  });

  it("API desativada com endereço de outro host (ou http): o endereço não entra", () => {
    for (const url of ["https://evil.exemplo/apis/x", "http://console.developers.google.com/x", "https://console.developers.google.com.evil.exemplo/x"]) {
      const reason = forbiddenReason(JSON.stringify({ error: { message: `Gmail MCP API has not been used in project 1 before or it is disabled. Enable it by visiting ${url} then retry.` } }));
      expect(reason).toMatch(/não está ativada/);
      expect(reason).not.toContain("evil");
      expect(reason).not.toContain("http://");
    }
  });
});
