import { connectorToolName, OFFICE_MCP_SERVER, OFFICE_TOOL_PREFIX } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { antigravitySessionSettings } from "../../engines/terminals/antigravity-adapter";
import { ClaudeCliAdapter, DEFAULT_AGENT_TOOLS } from "../../engines/terminals/claude-adapter";

/**
 * As ferramentas de conector chegam pelo nosso servidor "office" (gateway), então as regras de
 * permissão que já liberam o servidor inteiro liberam também `<prefixo>__<ferramenta>`; e nenhum
 * arquivo que o agente lê (mcp.json, .agents/mcp_config.json) leva segredo de conector.
 */
describe("conectores: permissões das CLIs", () => {
  const spec = { agentId: "clara", cwd: "/dados/agents/clara", systemPrompt: "x", mcpConfigFile: "/dados/agents/clara/mcp.json", tools: DEFAULT_AGENT_TOOLS };

  it("Claude Code: --allowedTools libera o servidor office inteiro (mcp__office cobre mcp__office__notion__create_page)", () => {
    const { args } = new ClaudeCliAdapter().command(spec, { sessionId: "s", resume: false });
    const allowed = args[args.indexOf("--allowedTools") + 1]!.split(",");
    expect(allowed).toContain(`mcp__${OFFICE_MCP_SERVER}`);
    const full = `${OFFICE_TOOL_PREFIX}${connectorToolName("notion", "create_page")}`;
    expect(full).toBe("mcp__office__notion__create_page");
    expect(full.length).toBeLessThanOrEqual(64);
    // A configuração MCP do agente só tem o servidor office (com o token dele), nenhum conector.
    const files = new ClaudeCliAdapter().agentFiles({ spec, mcpUrl: "http://127.0.0.1:3001/mcp", token: "t" });
    const mcp = JSON.parse(files.find((file) => file.path === spec.mcpConfigFile)!.content) as { mcpServers: Record<string, unknown> };
    expect(Object.keys(mcp.mcpServers)).toEqual([OFFICE_MCP_SERVER]);
  });

  it("Antigravity: a permissão mcp(office/*) cobre as ferramentas de conector", () => {
    const settings = antigravitySessionSettings(spec.cwd) as { permissions: { allow: string[] } };
    expect(settings.permissions.allow).toContain(`mcp(${OFFICE_MCP_SERVER}/*)`);
  });
});
