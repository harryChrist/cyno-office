import { stat } from "node:fs/promises";
import path from "node:path";
import { isMaestroAgent, type ApiErrorBody, type Connector, type ConnectorImportResponse } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import type { McpClient } from "../library/connectors/mcp-client";
import { call, wsApi } from "../dev/test-api";
import { useTestApp } from "../dev/test-app";

const setupApp = useTestApp();
const API = wsApi();
const SECRET = "Bearer tok-rota-123456";

/** Cliente falso: duas ferramentas e eco nas chamadas (nenhuma rede nos testes de rota). */
const fakeClient = (): McpClient => ({
  listTools: async () => [{ name: "create_page", description: "Cria", inputSchema: { type: "object", properties: {} } }, { name: "search" }],
  callTool: async (name, args) => ({ content: [{ type: "text", text: `${name}: ${JSON.stringify(args)}` }], isError: false }),
  close: async () => undefined,
});

describe("API: conectores", () => {
  it("cria, lista, edita e apaga sem nunca devolver os segredos", async () => {
    const { app, dir, log } = await setupApp();
    const created = await call<Connector>(app, "POST", `${API}/connectors`, {
      name: "Notion",
      kind: "http",
      url: "https://mcp.notion.com/mcp",
      headers: { Authorization: SECRET },
      icon: { kind: "brand", slug: "notion" },
    });
    expect(created).toMatchObject({ id: "notion", secretHeaders: ["Authorization"], icon: { kind: "brand", slug: "notion" } });
    const list = await call<Connector[]>(app, "GET", `${API}/connectors`);
    expect(list).toHaveLength(1);
    const patched = await call<Connector>(app, "PATCH", `${API}/connectors/notion`, { name: "Notion da firma", enabled: false });
    expect(patched).toMatchObject({ name: "Notion da firma", enabled: false, status: { state: "disabled" } });
    const everything = JSON.stringify([created, list, patched, log.events]);
    expect(everything).not.toContain("tok-rota");
    // Os conectores moram na Biblioteca da plataforma (não mais na pasta do workspace).
    expect((await stat(path.join(dir, "..", "..", "platform", "library", "connectors.json"))).mode & 0o777).toBe(0o600);
    await call(app, "DELETE", `${API}/connectors/notion`);
    expect(await call<Connector[]>(app, "GET", `${API}/connectors`)).toEqual([]);
    expect(log.events.some((event) => event.type === "connector:deleted" && event.id === "notion")).toBe(true);
  });

  it("valida o corpo (URL, tipo, cabeçalho reservado) e 404 para conector que não existe", async () => {
    const { app } = await setupApp();
    await call(app, "POST", `${API}/connectors`, { name: "X", kind: "http", url: "javascript:alert(1)" }, 400);
    await call(app, "POST", `${API}/connectors`, { name: "X", kind: "ftp", url: "https://x.com" }, 400);
    await call(app, "POST", `${API}/connectors`, { name: "X", kind: "http", url: "https://x.com", headers: { Host: "evil" } }, 400);
    const body = await call<ApiErrorBody>(app, "PATCH", `${API}/connectors/nao-existe`, { name: "x" }, 404);
    expect(body.error).toBe('Conector "nao-existe" não encontrado');
    await call(app, "POST", `${API}/connectors/nao-existe/test`, undefined, 404);
  });

  it("liga ao Maestro e a agentes; cada agente só vê as ferramentas dos conectores dele; agente removido sai", async () => {
    const { app, workspaces } = await setupApp({ connectors: { autoTest: false, gateway: { createClient: fakeClient } } });
    await call(app, "POST", `${API}/connectors`, { name: "Notion", kind: "http", url: "https://n.com/mcp" });
    await call(app, "POST", `${API}/connectors`, { name: "Pastebin", kind: "http", url: "https://p.com/mcp" });
    await call(app, "POST", `${API}/connectors/notion/test`, undefined, 200);
    await call(app, "POST", `${API}/connectors/pastebin/test`, undefined, 200);
    const runtime = workspaces.get("principal");
    const state = runtime.state.read();
    const maestro = state.agents.find((agent) => isMaestroAgent(state, agent))!;

    const mine = await call<Connector[]>(app, "PATCH", `${API}/agents/${maestro.id}/connectors`, { connectorIds: ["notion", "pastebin"] }, 200);
    expect(mine.map((c) => c.id)).toEqual(["notion", "pastebin"]);
    await call(app, "PATCH", `${API}/agents/clara/connectors`, { connectorIds: ["pastebin"] }, 200);
    await call(app, "PATCH", `${API}/agents/fantasma/connectors`, { connectorIds: [] }, 404);

    const names = (agentId: string) => runtime.officeTools(agentId).map((tool) => tool.name);
    expect(names(maestro.id)).toEqual(expect.arrayContaining(["get_team", "notion__create_page", "notion__search", "pastebin__create_page", "pastebin__search"]));
    expect(names("clara")).toEqual(expect.arrayContaining(["submit_result", "pastebin__create_page", "pastebin__search"]));
    expect(names("clara").some((name) => name.startsWith("notion__"))).toBe(false);
    expect(names("beto").some((name) => name.includes("__"))).toBe(false);

    const call1 = await runtime.officeTools("clara").find((tool) => tool.name === "pastebin__create_page")!.call({ title: "x" });
    expect(call1).toMatchObject({ content: [{ type: "text", text: 'create_page: {"title":"x"}' }], isError: false });

    // get_team do Maestro lista os conectores e quem usa.
    const team = await runtime.officeTools(maestro.id).find((tool) => tool.name === "get_team")!.call({});
    expect(team.text).toContain("## Conectores (servidores MCP externos)");
    expect(team.text).toMatch(/Pastebin \(ferramentas pastebin__\*; 2 ferramentas; estado: connected\) — usado por: .*Clara/);

    await call(app, "DELETE", `${API}/agents/clara`);
    await expect.poll(() => runtime.connectors.list().find((c) => c.id === "pastebin")!.agentIds).toEqual([maestro.id]);
  });

  it("ícone próprio: PNG aceito e servido com nosniff; SVG/texto recusados", async () => {
    const { app } = await setupApp();
    await call(app, "POST", `${API}/connectors`, { name: "Meu sistema", kind: "http", url: "https://s.com/mcp" });
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);
    await call(app, "POST", `${API}/connectors/meu-sistema/icon`, { mime: "image/svg+xml", dataBase64: Buffer.from("<svg/>").toString("base64") }, 400);
    await call(app, "POST", `${API}/connectors/meu-sistema/icon`, { mime: "image/png", dataBase64: Buffer.from("<svg onload=x>").toString("base64") }, 400);
    const updated = await call<Connector>(app, "POST", `${API}/connectors/meu-sistema/icon`, { mime: "image/png", dataBase64: png.toString("base64") }, 200);
    expect(updated.icon).toEqual({ kind: "custom", version: 1 });
    const response = await app.inject({ method: "GET", url: `${API}/connectors/meu-sistema/icon` });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("image/png");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.rawPayload.equals(png)).toBe(true);
  });

  it("importar do Claude Code: sem a CLI, diz que não dá (sem erro)", async () => {
    const { app } = await setupApp();
    const result = await call<ConnectorImportResponse>(app, "GET", `${API}/connectors/import/claude`, undefined, 200);
    expect(result).toEqual({ available: false, reason: "o Claude Code (claude) não está instalado neste computador", candidates: [] });
  });
});
