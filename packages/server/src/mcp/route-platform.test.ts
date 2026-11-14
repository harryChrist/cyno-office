import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { WorkspaceManager } from "../platform/workspaces/manager";
import { defineTool, type McpTool } from "./protocol";
import { registerMcpRoute } from "./route";
import { McpTokens } from "./tokens";

const tool = (name: string): McpTool => defineTool({ name, description: name, input: z.object({}), call: () => ({ text: `${name} ok` }) });

/** Servidor com um workspace ("ws") e as ferramentas da plataforma (Cyno). */
async function setup() {
  const tokens = new McpTokens();
  const app = Fastify();
  const manager = { find: (id: string) => (id === "ws" ? { officeTools: (agentId: string) => [tool("delegate_task"), tool(`own_${agentId}`)] } : undefined) } as unknown as WorkspaceManager;
  registerMcpRoute(app, manager, tokens, { tools: () => [tool("list_workspaces"), tool("get_usage")] });
  await app.ready();
  const workspaceToken = tokens.issue({ workspaceId: "ws", agentId: "maestro" });
  const platformToken = tokens.issue({ workspaceId: "_platform", agentId: "cyno", scope: "platform" });
  const call = async (token: string | undefined, method: string, params?: Record<string, unknown>) => {
    const response = await app.inject({
      method: "POST",
      url: "/mcp",
      remoteAddress: "127.0.0.1",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      payload: { jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) },
    });
    return { status: response.statusCode, body: response.statusCode === 200 ? response.json<{ result?: { tools?: { name: string }[]; content?: { text: string }[]; isError?: boolean }; error?: { message: string } }>() : undefined };
  };
  const names = async (token: string) => (await call(token, "tools/list")).body?.result?.tools?.map((item) => item.name);
  return { app, call, names, workspaceToken, platformToken, tokens };
}

const apps: { close(): Promise<unknown> }[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("MCP: identidade de plataforma (Cyno)", () => {
  it("o token do Cyno enxerga só as ferramentas da plataforma, e o de um agente de workspace só as do workspace", async () => {
    const t = await setup();
    apps.push(t.app);
    expect(await t.names(t.platformToken)).toEqual(["list_workspaces", "get_usage"]);
    expect(await t.names(t.workspaceToken)).toEqual(["delegate_task", "own_maestro"]);
  });

  it("um token não chama a ferramenta do outro lado (ferramenta desconhecida)", async () => {
    const t = await setup();
    apps.push(t.app);
    const fromWorkspace = await t.call(t.workspaceToken, "tools/call", { name: "list_workspaces", arguments: {} });
    expect(fromWorkspace.body?.error?.message).toMatch(/Unknown tool/);
    const fromPlatform = await t.call(t.platformToken, "tools/call", { name: "delegate_task", arguments: {} });
    expect(fromPlatform.body?.error?.message).toMatch(/Unknown tool/);
    const own = await t.call(t.platformToken, "tools/call", { name: "get_usage", arguments: {} });
    expect(own.body?.result?.content?.[0]?.text).toBe("get_usage ok");
  });

  it("a identidade de plataforma não se disfarça de workspace: o workspaceId do token do Cyno nunca abre um runtime", async () => {
    const t = await setup();
    apps.push(t.app);
    // Mesmo com o workspaceId de um workspace real, o escopo "platform" manda: só as ferramentas da plataforma.
    const sneaky = t.tokens.issue({ workspaceId: "ws", agentId: "maestro", scope: "platform" });
    expect(await t.names(sneaky)).toEqual(["list_workspaces", "get_usage"]);
  });

  it("sem token, token revogado ou desconhecido: 401; sem o gancho da plataforma, o token do Cyno também", async () => {
    const t = await setup();
    apps.push(t.app);
    expect((await t.call(undefined, "tools/list")).status).toBe(401);
    expect((await t.call("token-que-nao-existe", "tools/list")).status).toBe(401);
    t.tokens.revoke(t.platformToken);
    expect((await t.call(t.platformToken, "tools/list")).status).toBe(401);

    const tokens = new McpTokens();
    const app = Fastify();
    registerMcpRoute(app, { find: () => undefined } as unknown as WorkspaceManager, tokens);
    await app.ready();
    apps.push(app);
    const platformToken = tokens.issue({ workspaceId: "_platform", agentId: "cyno", scope: "platform" });
    const response = await app.inject({ method: "POST", url: "/mcp", remoteAddress: "127.0.0.1", headers: { authorization: `Bearer ${platformToken}` }, payload: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
    expect(response.statusCode).toBe(401);
  });
});
