import { z } from "zod";
import { MAX_ID_LENGTH, SAFE_ID_PATTERN } from "./ids";
import { OFFICE_MCP_SERVER } from "./terminal";

/**
 * Conectores: servidores MCP externos (Notion, GitHub, um sistema próprio…) cadastrados por
 * workspace e ligados ao Maestro e a cada agente. Os agentes NUNCA falam direto com eles: o server
 * é um "gateway" — o agente só conhece o nosso servidor MCP "office" (token por agente), e o server
 * conecta no conector (HTTP: com os cabeçalhos secretos; stdio: sobe o processo com as variáveis
 * secretas) e mostra as ferramentas dele com um prefixo (ex.: `notion__create_page`), só para os
 * agentes ligados a ele. Segredos ficam só no server (connectors.json, modo 0600): a API devolve
 * apenas os NOMES dos cabeçalhos/variáveis definidos, nunca os valores.
 */

/** Tipo do conector: "http" (Streamable HTTP, uma URL) ou "stdio" (um comando local). */
export const CONNECTOR_KINDS = ["http", "stdio"] as const;
export type ConnectorKind = (typeof CONNECTOR_KINDS)[number];

/**
 * Estado do conector (o último teste ou a última chamada):
 * - unknown: nunca testado; connected: initialize + tools/list deram certo;
 * - needs_auth: o servidor pediu login/credencial (HTTP 401/403);
 * - error: falhou (motivo em `reason`); disabled: desligado pelo usuário.
 */
export const CONNECTOR_STATES = ["unknown", "connected", "needs_auth", "error", "disabled"] as const;
export type ConnectorState = (typeof CONNECTOR_STATES)[number];

/** De onde veio o cadastro. */
export const CONNECTOR_ORIGINS = ["manual", "claude-code"] as const;
export type ConnectorOrigin = (typeof CONNECTOR_ORIGINS)[number];

/** Ícone: marca do simple-icons (slug), imagem enviada (PNG/WebP, `version` muda a cada envio) ou monograma. */
export type ConnectorIcon = { kind: "brand"; slug: string } | { kind: "custom"; version: number } | { kind: "monogram" };

/** Ferramenta de um conector (como o servidor dele a anuncia). */
export type ConnectorToolInfo = { name: string; description?: string };

export type ConnectorStatus = {
  state: ConnectorState;
  /** Por que não conectou (sem segredos). */
  reason?: string;
  /** ISO 8601 do último teste. */
  checkedAt?: string;
  /** Ferramentas do último tools/list que deu certo (cache: vale mesmo com o conector fora do ar). */
  tools: ConnectorToolInfo[];
};

/** Conector como a API mostra (sem segredos). */
export type Connector = {
  id: string;
  name: string;
  kind: ConnectorKind;
  /** http: a URL, com os valores de query mascarados (podem ser chaves). */
  url?: string;
  /** stdio: o executável e os argumentos (sem shell). */
  command?: string;
  args?: string[];
  /** Nomes dos cabeçalhos HTTP secretos definidos (ex.: "Authorization"). Valores: nunca. */
  secretHeaders: string[];
  /** Nomes das variáveis de ambiente secretas definidas (stdio). Valores: nunca. */
  secretEnv: string[];
  icon: ConnectorIcon;
  /** Cor de fundo do ícone (#rrggbb): a da marca, ou a escolhida para o monograma. */
  color?: string;
  enabled: boolean;
  /** Agentes (inclusive o Maestro) que usam este conector. */
  agentIds: string[];
  /** Prefixo das ferramentas para os agentes (`<prefixo>__<ferramenta>`). */
  toolPrefix: string;
  origin: ConnectorOrigin;
  status: ConnectorStatus;
  createdAt: string;
  updatedAt: string;
};

/** Algo que um agente fez com um conector agora (para o "pulso" do ícone e o balão sobre o agente). */
export type ConnectorActivity = {
  connectorId: string;
  agentId: string;
  /** Nome original da ferramenta no conector. */
  tool: string;
  phase: "started" | "finished";
  ok?: boolean;
  at: string;
};

// ---------- Nomes das ferramentas ----------

/** Separador entre o prefixo do conector e a ferramenta (as ferramentas do escritório não têm "__"). */
export const CONNECTOR_TOOL_SEPARATOR = "__";
/** Prefixo com que o Claude Code/Antigravity chamam as ferramentas do nosso servidor (`mcp__office__`). */
export const OFFICE_TOOL_PREFIX = `mcp__${OFFICE_MCP_SERVER}__`;
/** Nomes de ferramenta nas APIs dos modelos: [A-Za-z0-9_-], até 64; tiramos o `mcp__office__` que a CLI põe na frente. */
export const CONNECTOR_TOOL_NAME_MAX = 64 - OFFICE_TOOL_PREFIX.length;
export const CONNECTOR_PREFIX_MAX = 20;

/** Hash curto e estável (djb2, base36) para desempatar nomes cortados. */
function shortHash(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) hash = ((hash * 33) ^ text.charCodeAt(i)) >>> 0;
  return hash.toString(36).slice(0, 5).padStart(5, "0");
}

/** Prefixo de ferramentas a partir de um id de conector: [a-z0-9-], sem "__", até 20 caracteres. */
export function connectorToolPrefix(id: string): string {
  const base = id
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, CONNECTOR_PREFIX_MAX)
    .replace(/-+$/g, "");
  return base || "conector";
}

/**
 * Nome que o agente vê para a ferramenta `tool` do conector de prefixo `prefix`:
 * `<prefixo>__<ferramenta>` só com [A-Za-z0-9_-]; longo demais = cortado com um hash no fim.
 */
export function connectorToolName(prefix: string, tool: string): string {
  const clean = tool.replace(/[^A-Za-z0-9_-]+/g, "_") || "ferramenta";
  const full = `${prefix}${CONNECTOR_TOOL_SEPARATOR}${clean}`;
  if (clean === tool && full.length <= CONNECTOR_TOOL_NAME_MAX) return full;
  // Nome mexido (caracteres trocados ou cortado): o hash do original evita que dois nomes virem um.
  const hash = shortHash(tool);
  const room = CONNECTOR_TOOL_NAME_MAX - prefix.length - CONNECTOR_TOOL_SEPARATOR.length - hash.length - 1;
  return `${prefix}${CONNECTOR_TOOL_SEPARATOR}${clean.slice(0, room)}_${hash}`;
}

/**
 * Lê o nome de uma ferramenta de conector como aparece no log (`mcp__office__notion__create_page`
 * ou `notion__create_page`): { prefix, tool } ou null (ferramenta do escritório ou embutida).
 */
export function parseConnectorToolName(name: string): { prefix: string; tool: string } | null {
  const bare = name.startsWith(OFFICE_TOOL_PREFIX) ? name.slice(OFFICE_TOOL_PREFIX.length) : name.startsWith("mcp__") ? null : name;
  if (!bare) return null;
  const at = bare.indexOf(CONNECTOR_TOOL_SEPARATOR);
  if (at <= 0) return null;
  const prefix = bare.slice(0, at);
  const tool = bare.slice(at + CONNECTOR_TOOL_SEPARATOR.length);
  if (!tool || !/^[a-z0-9-]+$/.test(prefix)) return null;
  return { prefix, tool };
}

// ---------- Schemas da API ----------

export const connectorIdSchema = z.string().max(MAX_ID_LENGTH).regex(SAFE_ID_PATTERN, "id inválido");
const connectorNameSchema = z.string().trim().min(1).max(60);
/** Cabeçalho HTTP: token (sem os que o gateway controla). */
const RESERVED_HEADERS = new Set(["host", "content-length", "content-type", "accept", "mcp-session-id", "mcp-protocol-version", "connection", "transfer-encoding"]);
export const connectorHeaderNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/, "nome de cabeçalho inválido")
  .refine((name) => !RESERVED_HEADERS.has(name.toLowerCase()), "este cabeçalho é controlado pelo gateway");
export const connectorEnvNameSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/, "nome de variável inválido");
const secretValueSchema = z.string().min(1).max(8000).refine((value) => !/[\r\n\0]/.test(value), "o valor não pode ter quebra de linha");
const urlSchema = z
  .url({ protocol: /^https?$/, error: "URL inválida (use http:// ou https://)" })
  .trim()
  .max(2000)
  .refine((value) => !/^[a-z]+:\/\/[^/?#]*@/i.test(value), "sem usuário/senha na URL: credenciais vão nos cabeçalhos");
const commandSchema = z.string().trim().min(1).max(300).refine((value) => !value.startsWith("-") && !/[\0\n]/.test(value), "comando inválido");
const argsSchema = z.array(z.string().max(1000).refine((value) => !/[\0\n]/.test(value), "argumento inválido")).max(40);
export const connectorColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, "cor inválida (use #rrggbb)");
const brandSlugSchema = z.string().regex(/^[a-z0-9][a-z0-9.-]{0,63}$/, "ícone inválido");
/** Ícone escolhido pelo usuário (a imagem própria vai pelo envio de ícone). */
export const connectorIconChoiceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("brand"), slug: brandSlugSchema }),
  z.object({ kind: z.literal("monogram") }),
]);
const agentIdsSchema = z.array(connectorIdSchema).max(200);

/** POST /api/w/:ws/connectors */
export const createConnectorBodySchema = z
  .object({
    name: connectorNameSchema,
    kind: z.enum(CONNECTOR_KINDS),
    url: urlSchema.optional(),
    command: commandSchema.optional(),
    args: argsSchema.optional(),
    headers: z.record(connectorHeaderNameSchema, secretValueSchema).optional(),
    env: z.record(connectorEnvNameSchema, secretValueSchema).optional(),
    icon: connectorIconChoiceSchema.optional(),
    color: connectorColorSchema.optional(),
    enabled: z.boolean().optional(),
    agentIds: agentIdsSchema.optional(),
    origin: z.enum(CONNECTOR_ORIGINS).optional(),
  })
  .superRefine((body, ctx) => {
    if (body.kind === "http" && !body.url) ctx.addIssue({ code: "custom", path: ["url"], message: "conector HTTP precisa da URL" });
    if (body.kind === "stdio" && !body.command) ctx.addIssue({ code: "custom", path: ["command"], message: "conector stdio precisa do comando" });
  });
export type CreateConnectorBody = z.input<typeof createConnectorBodySchema>;

/**
 * PATCH /api/w/:ws/connectors/:id. Segredos: o nome com um valor = define/troca; com null = apaga;
 * ausente = fica como está (a UI nunca recebe os valores, então nunca os reenvia).
 */
export const updateConnectorBodySchema = z.object({
  name: connectorNameSchema.optional(),
  url: urlSchema.optional(),
  command: commandSchema.optional(),
  args: argsSchema.optional(),
  headers: z.record(connectorHeaderNameSchema, secretValueSchema.nullable()).optional(),
  env: z.record(connectorEnvNameSchema, secretValueSchema.nullable()).optional(),
  icon: connectorIconChoiceSchema.optional(),
  color: connectorColorSchema.nullable().optional(),
  enabled: z.boolean().optional(),
  agentIds: agentIdsSchema.optional(),
});
export type UpdateConnectorBody = z.input<typeof updateConnectorBodySchema>;

export const connectorParamsSchema = z.object({ connectorId: connectorIdSchema });
export const agentConnectorsParamsSchema = z.object({ agentId: connectorIdSchema });

/** PATCH /api/w/:ws/agents/:agentId/connectors: os conectores do agente (lista inteira). */
export const setAgentConnectorsBodySchema = z.object({ connectorIds: z.array(connectorIdSchema).max(100) });
export type SetAgentConnectorsBody = z.input<typeof setAgentConnectorsBodySchema>;

/** Tipos de imagem aceitos como ícone próprio (SVG não: poderia levar script). */
export const CONNECTOR_ICON_MIME_TYPES = ["image/png", "image/webp"] as const;
export type ConnectorIconMime = (typeof CONNECTOR_ICON_MIME_TYPES)[number];
export const CONNECTOR_ICON_MAX_BYTES = 256 * 1024;

/** POST /api/w/:ws/connectors/:id/icon: a imagem em base64 (sem multipart). */
export const uploadConnectorIconBodySchema = z.object({
  mime: z.enum(CONNECTOR_ICON_MIME_TYPES),
  dataBase64: z.string().min(8).max(Math.ceil((CONNECTOR_ICON_MAX_BYTES * 4) / 3) + 8).regex(/^[A-Za-z0-9+/]+=*$/, "base64 inválido"),
});
export type UploadConnectorIconBody = z.input<typeof uploadConnectorIconBodySchema>;

/** Um servidor MCP do Claude Code do usuário que dá para importar (sem segredos: esses o usuário preenche). */
export type ConnectorImportCandidate = {
  /** Nome como o `claude mcp list` mostra (ex.: "notion", "claude.ai Notion", "plugin:design:slack"). */
  sourceName: string;
  /** Nome sugerido para o conector. */
  name: string;
  kind: ConnectorKind;
  /** A URL (com chaves na query/caminho mascaradas: aí `urlMasked` e o usuário cola a URL inteira). */
  url?: string;
  urlMasked?: boolean;
  command?: string;
  args?: string[];
  /** Estado no Claude Code: "connected", "needs_auth", "failed", "pending", "not_configured" ou "unknown". */
  sourceStatus: string;
  /** Conectores do claude.ai usam o login do claude.ai (OAuth): aqui precisam de uma credencial própria. */
  hostedByClaudeAi: boolean;
  /** Já existe um conector com a mesma URL/comando neste workspace. */
  alreadyImported: boolean;
};

/** GET /api/w/:ws/connectors/import/claude */
export type ConnectorImportResponse = { available: boolean; reason?: string; candidates: ConnectorImportCandidate[] };
