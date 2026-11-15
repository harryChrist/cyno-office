import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  CONNECTOR_BUILTINS,
  CONNECTOR_KINDS,
  CONNECTOR_ORIGINS,
  CONNECTOR_STATES,
  LIBRARY_CONNECTOR_KINDS,
  LIBRARY_CONNECTOR_ORIGINS,
  type Connector,
  type ConnectorIcon,
  type ConnectorStatus,
  type LibraryConnector,
  type LibraryUse,
} from "@cyno/shared";
import { z } from "zod";
import { DataFileError } from "../../store/files";
import { storedOAuthSchema, publicOAuth, oauthSecretValues, type StoredOAuth } from "./oauth/stored";

export type ConnectorLimits = { idleSec: number; startSec: number; callSec: number };

/** Ferramenta guardada no cache (com o JSON Schema de entrada, que só o gateway usa). */
export type StoredConnectorTool = { name: string; description?: string; inputSchema?: Record<string, unknown>; annotations?: Record<string, boolean> };

/** Conector da Biblioteca como fica no disco: com os segredos (cabeçalhos e variáveis), que nunca saem do server. */
export type StoredConnector = Omit<LibraryConnector, "secretHeaders" | "secretEnv" | "status" | "uses" | "oauth"> & {
  /** Tempos do processo stdio (segundos): parada por ociosidade, espera para subir e por chamada (apps pesados pedem mais). */
  limits?: ConnectorLimits;
  headers: Record<string, string>;
  env: Record<string, string>;
  /** Login OAuth (HTTP): descoberta, escopos, cliente e tokens. Só o server lê; a API mostra `publicOAuth`. */
  oauth?: StoredOAuth;
  status: Omit<ConnectorStatus, "tools"> & { tools: StoredConnectorTool[] };
};

const iconSchema: z.ZodType<ConnectorIcon> = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("brand"), slug: z.string().min(1).max(64) }),
  z.object({ kind: z.literal("custom"), version: z.number().int().nonnegative() }),
  z.object({ kind: z.literal("monogram") }),
]);

const storedToolSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(4000).optional(),
  inputSchema: z.record(z.string(), z.unknown()).optional(),
  annotations: z.record(z.string(), z.boolean()).optional(),
});

const statusSchema = z.object({
  state: z.enum(CONNECTOR_STATES),
  reason: z.string().optional(),
  checkedAt: z.string().optional(),
  tools: z.array(storedToolSchema).default([]),
});

const grantsSchema = z.record(z.string(), z.object({ agentIds: z.array(z.string()), grantedAt: z.string() })).default({});

export const storedConnectorSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(60),
  kind: z.enum(LIBRARY_CONNECTOR_KINDS),
  url: z.string().max(2000).optional(),
  builtin: z.enum(CONNECTOR_BUILTINS).optional(),
  command: z.string().max(300).optional(),
  args: z.array(z.string()).optional(),
  headers: z.record(z.string(), z.string()).default({}),
  env: z.record(z.string(), z.string()).default({}),
  icon: iconSchema,
  color: z.string().optional(),
  enabled: z.boolean(),
  toolPrefix: z.string().min(1).max(20),
  origin: z.enum(LIBRARY_CONNECTOR_ORIGINS).default("manual"),
  description: z.string().max(300).default(""),
  warnings: z.array(z.string().max(300)).default([]),
  appId: z.string().optional(),
  limits: z.object({ idleSec: z.number(), startSec: z.number(), callSec: z.number() }).optional(),
  oauth: storedOAuthSchema.optional(),
  weightTokens: z.number().int().default(0),
  grants: grantsSchema,
  status: statusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});

/** Conector de antes da Biblioteca: por workspace, com `agentIds` (só a migração lê). */
export type LegacyStoredConnector = Omit<StoredConnector, "grants" | "description" | "warnings" | "weightTokens" | "appId" | "kind" | "origin"> & {
  kind: (typeof CONNECTOR_KINDS)[number];
  origin: (typeof CONNECTOR_ORIGINS)[number];
  agentIds: string[];
};

export const legacyConnectorSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(60),
  kind: z.enum(CONNECTOR_KINDS),
  url: z.string().max(2000).optional(),
  command: z.string().max(300).optional(),
  args: z.array(z.string()).optional(),
  headers: z.record(z.string(), z.string()).default({}),
  env: z.record(z.string(), z.string()).default({}),
  icon: iconSchema,
  color: z.string().optional(),
  enabled: z.boolean(),
  agentIds: z.array(z.string()),
  toolPrefix: z.string().min(1).max(20),
  origin: z.enum(CONNECTOR_ORIGINS).default("manual"),
  status: statusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const CONNECTORS_FILE_VERSION = 1;
const connectorsFileSchema = z.object({ version: z.literal(CONNECTORS_FILE_VERSION), connectors: z.array(storedConnectorSchema) });
const legacyFileSchema = z.object({ version: z.literal(CONNECTORS_FILE_VERSION), connectors: z.array(legacyConnectorSchema) });

/** Onde os conectores moram: connectors.json (0600) e connectors/<id>/ (ícone, cwd do stdio). */
export type ConnectorPaths = { file: string; dir: (connectorId: string) => string; iconFile: (connectorId: string) => string };

function pathsIn(base: string, file: string): ConnectorPaths {
  const dir = (connectorId: string) => {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(connectorId)) throw new Error(`id de conector inválido: "${connectorId}"`);
    return path.join(base, connectorId);
  };
  return { file, dir, iconFile: (connectorId) => path.join(dir(connectorId), "icon.bin") };
}

/** Conectores da Biblioteca: `<data>/platform/library/connectors.json` e `connectors/<id>/`. */
export function libraryConnectorPaths(libraryRoot: string): ConnectorPaths {
  return pathsIn(path.join(libraryRoot, "connectors"), path.join(libraryRoot, "connectors.json"));
}

/** Conectores antigos de um workspace (só a migração): `connectors.json` e `connectors/<id>/` na pasta dele. */
export function legacyConnectorPaths(workspaceRoot: string): ConnectorPaths {
  return pathsIn(path.join(workspaceRoot, "connectors"), path.join(workspaceRoot, "connectors.json"));
}

async function readJsonFile(file: string): Promise<unknown | undefined> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new DataFileError(file, ["JSON malformado"]);
  }
}

const issuesOf = (error: z.ZodError) => error.issues.map((issue) => `${issue.path.join(".") || "(raiz)"}: ${issue.message}`);

/** connectors.json ausente = nenhum conector ainda. */
export async function readConnectorsFile(file: string): Promise<StoredConnector[]> {
  const data = await readJsonFile(file);
  if (data === undefined) return [];
  const result = connectorsFileSchema.safeParse(data);
  if (!result.success) throw new DataFileError(file, issuesOf(result.error));
  return result.data.connectors as StoredConnector[];
}

/** connectors.json do formato antigo (por workspace). */
export async function readLegacyConnectorsFile(file: string): Promise<LegacyStoredConnector[]> {
  const data = await readJsonFile(file);
  if (data === undefined) return [];
  const result = legacyFileSchema.safeParse(data);
  if (!result.success) throw new DataFileError(file, issuesOf(result.error));
  return result.data.connectors as LegacyStoredConnector[];
}

export function toConnectorsFile(connectors: readonly StoredConnector[]) {
  return { version: CONNECTORS_FILE_VERSION, connectors };
}

// ---------- Segredos ----------

const MASK = "•••";

/** Pedaço de caminho com cara de chave (longo, com letras e números): some da URL mostrada. */
const looksLikeKey = (segment: string) => segment.length >= 20 && /[0-9]/.test(segment) && /[A-Za-z]/.test(segment);

/**
 * URL para mostrar: valores de query e pedaços de caminho com cara de chave viram "•••" (há
 * servidores MCP que levam a chave na URL). A URL de verdade só o gateway usa.
 */
export function maskUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.pathname = url.pathname
      .split("/")
      .map((segment) => (looksLikeKey(decodeURIComponent(segment)) ? MASK : segment))
      .join("/");
    const params = [...url.searchParams.keys()];
    if (params.length === 0) return url.toString().replace(/%E2%80%A2/g, "•");
    const query = params.map((key) => `${encodeURIComponent(key)}=${MASK}`).join("&");
    url.search = "";
    return `${url.toString().replace(/%E2%80%A2/g, "•")}?${query}`;
  } catch {
    return MASK;
  }
}

/** Todos os valores secretos de um conector (para apagar de mensagens de erro e do log). */
export function secretValues(record: Pick<StoredConnector, "headers" | "env" | "url"> & { oauth?: StoredOAuth }): string[] {
  const values = [...Object.values(record.headers), ...Object.values(record.env), ...(record.oauth ? oauthSecretValues(record.oauth) : [])];
  for (const value of Object.values(record.headers)) {
    // "Bearer xyz": o token sozinho também.
    const token = /^\S+\s+(\S{6,})$/.exec(value)?.[1];
    if (token) values.push(token);
  }
  if (record.url) {
    try {
      const url = new URL(record.url);
      for (const value of url.searchParams.values()) if (value.length >= 6) values.push(value);
      for (const segment of url.pathname.split("/")) if (looksLikeKey(segment)) values.push(segment);
    } catch {
      // URL inválida: nada a acrescentar.
    }
  }
  return values.filter((value) => value.length >= 4).sort((a, b) => b.length - a.length);
}

/** Troca cada segredo do texto por "•••" (mensagens de erro do conector, stderr do processo). */
export function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) if (secret) out = out.split(secret).join(MASK);
  return out;
}

/** Estimativa de peso no contexto (caracteres / 4 de nome, descrição e esquema de cada ferramenta). */
export function estimateWeightTokens(tools: readonly StoredConnectorTool[]): number {
  let chars = 0;
  for (const tool of tools) chars += tool.name.length + (tool.description?.length ?? 0) + (tool.inputSchema ? JSON.stringify(tool.inputSchema).length : 0);
  return Math.ceil(chars / 4);
}

function publicStatus(status: StoredConnector["status"]): ConnectorStatus {
  return {
    state: status.state,
    ...(status.reason ? { reason: status.reason } : {}),
    ...(status.checkedAt ? { checkedAt: status.checkedAt } : {}),
    tools: status.tools.map((tool) => ({ name: tool.name, ...(tool.description ? { description: tool.description } : {}) })),
  };
}

/** Visão pública da Biblioteca: sem os valores dos segredos, URL mascarada e ferramentas sem o schema. */
export function publicLibraryConnector(record: StoredConnector, uses: LibraryUse[]): LibraryConnector {
  const { headers, env, status, url, oauth, ...rest } = record;
  return {
    ...structuredClone(rest),
    ...(url ? { url: maskUrl(url) } : {}),
    secretHeaders: Object.keys(headers).sort(),
    secretEnv: Object.keys(env).sort(),
    status: publicStatus(status),
    ...(oauth ? { oauth: publicOAuth(oauth) } : {}),
    uses,
  };
}

/**
 * Visão de um workspace (a forma de sempre, que o resto do código e a tela do workspace conhecem):
 * `agentIds` são os agentes DESTE workspace que receberam o conector.
 */
export function workspaceConnector(record: StoredConnector, workspaceId: string): Connector {
  const { headers, env, status, url, grants, oauth, description: _d, warnings: _w, appId: _a, weightTokens: _t, ...rest } = record;
  return {
    ...structuredClone(rest),
    kind: record.kind === "app" ? "stdio" : record.kind,
    origin: record.origin === "app" ? "manual" : record.origin,
    ...(url ? { url: maskUrl(url) } : {}),
    secretHeaders: Object.keys(headers).sort(),
    secretEnv: Object.keys(env).sort(),
    agentIds: [...(grants[workspaceId]?.agentIds ?? [])],
    status: publicStatus(status),
    ...(oauth ? { oauth: publicOAuth(oauth) } : {}),
  };
}
