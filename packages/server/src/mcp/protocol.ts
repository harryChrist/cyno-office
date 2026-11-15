import { LEGACY_OFFICE_TOOL_NAMES } from "@cyno/shared";
import { z } from "zod";
import { errorMessage } from "../util/text";

/**
 * Servidor MCP mínimo (JSON-RPC 2.0 sobre o transporte "Streamable HTTP", só com respostas JSON:
 * sem SSE e sem sessão). Só o que as CLIs precisam para usar ferramentas: initialize, ping,
 * tools/list e tools/call; notificações (sem id) não têm resposta. Escrito à mão para não puxar o
 * SDK (e o express junto) para o server.
 */

/** `content`: blocos MCP prontos (ferramentas de conector repassam os do servidor externo); senão vira um bloco de texto. */
export type McpToolResult = { text: string; isError?: boolean; content?: unknown[] };

export type McpTool = {
  name: string;
  description: string;
  /** Schema zod dos argumentos (vira o JSON Schema do tools/list). */
  input: z.ZodObject;
  /** JSON Schema pronto para o tools/list (ferramentas de conector: o do servidor externo; `input` aceita tudo). */
  jsonSchema?: Record<string, unknown>;
  /** Dicas MCP (readOnlyHint etc.) repassadas no tools/list; só as ferramentas de conector trazem. */
  annotations?: Record<string, boolean>;
  call: (args: unknown) => McpToolResult | Promise<McpToolResult>;
  /** false = apelido antigo: continua chamável, mas não aparece no tools/list (o modelo só vê o nome novo). */
  listed?: boolean;
};

/** Define uma ferramenta com os argumentos tipados pelo schema zod. */
export function defineTool<S extends z.ZodObject>(tool: {
  name: string;
  description: string;
  input: S;
  call: (args: z.output<S>) => McpToolResult | Promise<McpToolResult>;
}): McpTool {
  return tool as unknown as McpTool;
}

/** Nome novo de uma ferramenta do escritório chamada pelo nome antigo (pt-BR), com ou sem o prefixo `mcp__office__`. */
export function renamedTool(name: string): string | undefined {
  return LEGACY_OFFICE_TOOL_NAMES[name.replace(/^mcp__office__/, "")];
}

/** Versões do protocolo que respondemos (a do cliente, se for uma destas; senão a mais nova). */
export const MCP_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

export const MCP_SERVER_INFO = { name: "agent-office", title: "Cyno", version: "0.1.0" };

type JsonRpcId = string | number | null;
type JsonRpcResponse = { jsonrpc: "2.0"; id: JsonRpcId; result?: unknown; error?: { code: number; message: string } };

const ERRORS = { parse: -32700, invalidRequest: -32600, methodNotFound: -32601, invalidParams: -32602, internal: -32603 } as const;

const requestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number(), z.null()]).optional(),
  method: z.string(),
  params: z.record(z.string(), z.unknown()).optional(),
});

const callParamsSchema = z.object({ name: z.string(), arguments: z.record(z.string(), z.unknown()).optional() });

/** JSON Schema de um objeto zod (sem o "$schema", que algumas CLIs estranham). */
export function toolInputSchema(input: z.ZodObject): Record<string, unknown> {
  const schema = z.toJSONSchema(input, { target: "draft-7", io: "input" }) as Record<string, unknown>;
  delete schema.$schema;
  return schema;
}

/**
 * Responde uma mensagem (ou um lote) JSON-RPC. Devolve undefined quando não há resposta
 * (só notificações/respostas do cliente): o HTTP responde 202 sem corpo.
 */
export async function handleMcpPayload(payload: unknown, tools: () => McpTool[], instructions?: string): Promise<JsonRpcResponse | JsonRpcResponse[] | undefined> {
  if (Array.isArray(payload)) {
    const out = (await Promise.all(payload.map((message) => handleOne(message, tools, instructions)))).filter((r): r is JsonRpcResponse => r !== undefined);
    return out.length > 0 ? out : undefined;
  }
  return handleOne(payload, tools, instructions);
}

async function handleOne(message: unknown, tools: () => McpTool[], instructions?: string): Promise<JsonRpcResponse | undefined> {
  // Resposta do cliente a algo nosso (não mandamos pedidos) ou notificação: nada a responder.
  if (typeof message === "object" && message !== null && !("method" in message)) return undefined;
  const parsed = requestSchema.safeParse(message);
  if (!parsed.success) return { jsonrpc: "2.0", id: null, error: { code: ERRORS.invalidRequest, message: "Invalid JSON-RPC request" } };
  const { id, method, params } = parsed.data;
  if (id === undefined) return undefined;
  const ok = (result: unknown): JsonRpcResponse => ({ jsonrpc: "2.0", id, result });
  const fail = (code: number, text: string): JsonRpcResponse => ({ jsonrpc: "2.0", id, error: { code, message: text } });

  switch (method) {
    case "initialize": {
      const requested = typeof params?.protocolVersion === "string" ? params.protocolVersion : undefined;
      const protocolVersion = requested && MCP_PROTOCOL_VERSIONS.includes(requested) ? requested : MCP_PROTOCOL_VERSIONS[0];
      return ok({ protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: MCP_SERVER_INFO, ...(instructions ? { instructions } : {}) });
    }
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools: tools().filter((tool) => tool.listed !== false).map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.jsonSchema ?? toolInputSchema(tool.input), ...(tool.annotations ? { annotations: tool.annotations } : {}) })) });
    case "tools/call": {
      const call = callParamsSchema.safeParse(params);
      if (!call.success) return fail(ERRORS.invalidParams, "tools/call without a tool name");
      const tool = tools().find((candidate) => candidate.name === call.data.name);
      if (!tool) {
        // Sessão retomada de antes da troca de nomes (pt-BR -> inglês): erro que o modelo lê, apontando o nome novo.
        const renamed = renamedTool(call.data.name);
        if (renamed) return ok({ content: [{ type: "text", text: `The tool "${call.data.name}" was renamed to "${renamed}" (all office tools now have English names and parameters; see tools/list). Call ${renamed} instead.` }], isError: true });
        return fail(ERRORS.invalidParams, `Unknown tool: ${call.data.name}`);
      }
      const args = tool.input.safeParse(call.data.arguments ?? {});
      if (!args.success) {
        const problems = args.error.issues.map((issue) => `${issue.path.join(".") || "(argumentos)"}: ${issue.message}`).join("; ");
        return ok({ content: [{ type: "text", text: `Invalid arguments: ${problems}` }], isError: true });
      }
      try {
        const result = await tool.call(args.data);
        return ok({ content: result.content ?? [{ type: "text", text: result.text }], isError: result.isError === true });
      } catch (error) {
        // Erro da ferramenta volta como resultado com isError (o modelo vê e pode corrigir).
        return ok({ content: [{ type: "text", text: `Error: ${errorMessage(error)}` }], isError: true });
      }
    }
    default:
      return fail(ERRORS.methodNotFound, `Method not supported: ${method}`);
  }
}
