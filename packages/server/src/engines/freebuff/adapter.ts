import path from "node:path";
import { OFFICE_MCP_SERVER } from "@cyno/shared";
import { sanitizeChildEnv } from "../terminals/env";
import type { AgentFile, TerminalSpec } from "../terminals/types";

/**
 * O que muda no Freebuff em relação às outras CLIs: ele só tem tela (TUI), então não há comando de
 * "um turno" nem saída estruturada. O adaptador diz o comando, o ambiente e os arquivos da pasta de trabalho:
 * - `AGENTS.md`: as instruções do agente (o Freebuff lê da pasta);
 * - `.agents/mcp.json`: o servidor MCP "office" deste agente (formato `{"mcpServers":{nome:{type:"http",url}}}`),
 *   lido por `--trust-agents`; a ferramenta chega como `office__<nome>`.
 *
 * Cabeçalho `Authorization`: o campo `headers` do `mcp.json` existe na documentação da Codebuff, mas
 * ninguém tinha medido se o Freebuff o manda. Vai sempre; `tokenInUrl` (padrão desligado) acrescenta o token
 * na URL (`?t=`, só para 127.0.0.1) para o caso de ele não mandar, e o servidor MCP aceita os dois.
 */

export const FREEBUFF_MCP_FILE = path.join(".agents", "mcp.json");
export const FREEBUFF_INSTRUCTIONS_FILE = "AGENTS.md";

export function freebuffMcpConfig(mcpUrl: string, token: string, tokenInUrl: boolean): unknown {
  const url = tokenInUrl ? `${mcpUrl}${mcpUrl.includes("?") ? "&" : "?"}t=${encodeURIComponent(token)}` : mcpUrl;
  return { mcpServers: { [OFFICE_MCP_SERVER]: { type: "http", url, headers: { Authorization: `Bearer ${token}` } } } };
}

export function freebuffAgentFiles(input: { spec: TerminalSpec; mcpUrl: string; token: string; tokenInUrl?: boolean }): AgentFile[] {
  const { spec } = input;
  return [
    { path: path.join(spec.cwd, FREEBUFF_INSTRUCTIONS_FILE), content: `${spec.systemPrompt}\n` },
    { path: path.join(spec.cwd, FREEBUFF_MCP_FILE), content: `${JSON.stringify(freebuffMcpConfig(input.mcpUrl, input.token, input.tokenInUrl === true), null, 2)}\n`, secret: true },
  ];
}

/** Ambiente do processo: sem chave de API (o Freebuff usa o login da conta dele, em ~/.config/manicode). */
export function freebuffEnv(base: NodeJS.ProcessEnv, spec: TerminalSpec): NodeJS.ProcessEnv {
  return { ...sanitizeChildEnv(base, { GIT_CEILING_DIRECTORIES: path.dirname(spec.cwd) }), TERM: "xterm-256color", COLORTERM: "truecolor" };
}

/** O que o TerminalManager precisa do motor para gravar a pasta de trabalho (o resto está no FreebuffTerminal). */
export function freebuffAdapter(tokenInUrl: boolean): { provider: "freebuff"; agentFiles: (input: { spec: TerminalSpec; mcpUrl: string; token: string }) => AgentFile[] } {
  return { provider: "freebuff", agentFiles: (input) => freebuffAgentFiles({ ...input, tokenInUrl }) };
}
