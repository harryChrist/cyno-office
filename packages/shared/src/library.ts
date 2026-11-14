import { z } from "zod";
import {
  CONNECTOR_ORIGINS,
  connectorColorSchema,
  connectorEnvNameSchema,
  connectorHeaderNameSchema,
  connectorIconChoiceSchema,
  connectorIdSchema,
  type Connector,
  type ConnectorIcon,
  type ConnectorImportCandidate,
  type ConnectorStatus,
} from "./connectors";
import type { Avatar } from "./types";

/**
 * Biblioteca da plataforma (`data/platform/library/`): conectores (e, nas próximas fatias, skills e
 * apps) guardados UMA vez para o sistema inteiro. Um item é liberado em dois níveis:
 * item -> workspace -> agente (`grants`). O workspace só recebe o que foi liberado a ele; o agente só
 * recebe o que o dono (ou o Maestro, entre o que o workspace tem) entregou a ele. Nada vem liberado
 * por padrão. Segredos continuam só no servidor: a API mostra os nomes, nunca os valores.
 */

// ---------- Quem recebe ----------

/** Um workspace liberado e, dentro dele, os agentes (inclusive o Maestro) que recebem o item. */
export type LibraryGrant = { agentIds: string[]; grantedAt: string };
/** workspace -> liberação. */
export type LibraryGrants = Record<string, LibraryGrant>;
/** Corpo de entrada das liberações: o mapa inteiro (`{ [workspace]: { agentIds } }`). */
export const libraryGrantsInputSchema = z.record(connectorIdSchema, z.object({ agentIds: z.array(connectorIdSchema).max(200).default([]) }));
export type LibraryGrantsInput = z.input<typeof libraryGrantsInputSchema>;

/** Um agente na tela "quem usa" (o que a tela precisa para o avatar e o nome). */
export type LibraryUseAgent = { id: string; name: string; avatar: Avatar; maestro: boolean };
/** Um workspace que recebeu o item, com os agentes dele que o usam. */
export type LibraryUse = { workspaceId: string; workspaceName: string; agents: LibraryUseAgent[] };

// ---------- Conector da plataforma ----------

/** `app` (ferramenta que roda um comando de um app instalado) só chega com a aba Apps; já cabe no tipo. */
export const LIBRARY_CONNECTOR_KINDS = ["http", "stdio", "app"] as const;
export type LibraryConnectorKind = (typeof LIBRARY_CONNECTOR_KINDS)[number];
export const LIBRARY_CONNECTOR_ORIGINS = [...CONNECTOR_ORIGINS, "app"] as const;
export type LibraryConnectorOrigin = (typeof LIBRARY_CONNECTOR_ORIGINS)[number];

/** Conector da Biblioteca como a API mostra (sem segredos). */
export type LibraryConnector = Omit<Connector, "agentIds" | "kind" | "origin" | "status" | "icon"> & {
  kind: LibraryConnectorKind;
  origin: LibraryConnectorOrigin;
  icon: ConnectorIcon;
  status: ConnectorStatus;
  /** O que faz, em uma linha (escrito à mão ou vindo do catálogo). */
  description: string;
  /** Avisos que a janela de liberar mostra (ex.: "lê qualquer arquivo do servidor"). */
  warnings: string[];
  /** Dono: se vem de um app, some junto com ele. */
  appId?: string;
  /** Estimativa do peso no contexto de um agente (caracteres / 4 de nome, descrição e esquema das ferramentas). */
  weightTokens: number;
  /** Quem recebe: workspace -> agentes. */
  grants: LibraryGrants;
  /** `grants` com nomes e avatares (o server junta com o office.json de cada workspace). */
  uses: LibraryUse[];
};

/** Um workspace e os agentes dele (a janela de liberar lista todos, mesmo os que ainda não usam o item). */
export type LibraryWorkspaceInfo = { id: string; name: string; agents: LibraryUseAgent[] };

/** Quantos workspaces e agentes usam o item. */
export function libraryUsage(item: { uses: LibraryUse[] }): { workspaces: number; agents: number } {
  return { workspaces: item.uses.length, agents: item.uses.reduce((total, use) => total + use.agents.length, 0) };
}

// ---------- Rotas e corpos ----------

export const libraryConnectorParamsSchema = z.object({ connectorId: connectorIdSchema });

const nameSchema = z.string().trim().min(1).max(60);
const descriptionSchema = z.string().trim().max(300);

/** POST /api/library/connectors: igual ao do workspace, sem `agentIds`; as liberações vão em `grants` (opcional). */
export const createLibraryConnectorBodySchema = z
  .object({
    name: nameSchema,
    kind: z.enum(["http", "stdio"]),
    url: z.string().trim().max(2000).optional(),
    command: z.string().trim().min(1).max(300).optional(),
    args: z.array(z.string().max(1000)).max(40).optional(),
    headers: z.record(connectorHeaderNameSchema, z.string().min(1).max(8000)).optional(),
    env: z.record(connectorEnvNameSchema, z.string().min(1).max(8000)).optional(),
    icon: connectorIconChoiceSchema.optional(),
    color: connectorColorSchema.optional(),
    enabled: z.boolean().optional(),
    description: descriptionSchema.optional(),
    origin: z.enum(["manual", "claude-code"]).optional(),
    grants: libraryGrantsInputSchema.optional(),
  })
  .superRefine((body, ctx) => {
    if (body.kind === "http" && !body.url) ctx.addIssue({ code: "custom", path: ["url"], message: "conector HTTP precisa da URL" });
    if (body.kind === "stdio" && !body.command) ctx.addIssue({ code: "custom", path: ["command"], message: "conector stdio precisa do comando" });
  });
export type CreateLibraryConnectorBody = z.input<typeof createLibraryConnectorBodySchema>;

/** PATCH /api/library/connectors/:id (segredos: valor = define, null = apaga, ausente = fica). */
export const updateLibraryConnectorBodySchema = z.object({
  name: nameSchema.optional(),
  url: z.string().trim().max(2000).optional(),
  command: z.string().trim().min(1).max(300).optional(),
  args: z.array(z.string().max(1000)).max(40).optional(),
  headers: z.record(connectorHeaderNameSchema, z.string().min(1).max(8000).nullable()).optional(),
  env: z.record(connectorEnvNameSchema, z.string().min(1).max(8000).nullable()).optional(),
  icon: connectorIconChoiceSchema.optional(),
  color: connectorColorSchema.nullable().optional(),
  enabled: z.boolean().optional(),
  description: descriptionSchema.optional(),
});
export type UpdateLibraryConnectorBody = z.input<typeof updateLibraryConnectorBodySchema>;

/** PUT /api/library/connectors/:id/grants: o mapa inteiro (o que não estiver nele é retirado). */
export const setLibraryGrantsBodySchema = z.object({ grants: libraryGrantsInputSchema });
export type SetLibraryGrantsBody = z.input<typeof setLibraryGrantsBodySchema>;

/** GET /api/library/connectors/import/claude: candidatos do Claude Code do dono (só nomes e endereços). */
export type LibraryImportResponse = { available: boolean; reason?: string; candidates: ConnectorImportCandidate[] };

// ---------- Skills e Apps (as próximas fatias; declarados agora para não brigarem pelo `shared`) ----------

const slugSchema = z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9-]*$/);
const isoSchema = z.iso.datetime();

/** Skill: pasta própria da plataforma (nunca lê direto de ~/.claude). */
export const librarySkillSchema = z.object({
  id: slugSchema,
  name: z.string().max(80),
  description: z.string().max(1024),
  origin: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("app"), appId: slugSchema, path: z.string() }),
    z.object({ kind: z.literal("folder"), from: z.string(), copiedAt: isoSchema }),
    z.object({ kind: z.literal("url"), url: z.url(), sha256: z.string(), fetchedAt: isoSchema }),
    z.object({ kind: z.literal("manual") }),
  ]),
  requires: z.array(z.string()).default([]),
  files: z.number().int().default(1),
  bytes: z.number().int().default(0),
  weightTokens: z.number().int().default(0),
  readonly: z.boolean().default(false),
  usage: z.object({ reads: z.number().int().default(0), lastAt: isoSchema.optional() }).default({ reads: 0 }),
  grants: z.record(slugSchema, z.object({ agentIds: z.array(z.string()).default([]), grantedAt: isoSchema })).default({}),
});
export type LibrarySkill = z.output<typeof librarySkillSchema>;

/** App instalado (ou do catálogo): o instalador chega com a aba Apps. */
export const libraryAppSchema = z.object({
  id: slugSchema,
  catalogId: slugSchema,
  name: z.string().max(80),
  version: z.string().max(80),
  dir: z.string(),
  state: z.enum(["instalando", "instalado", "falhou", "precisa-do-dono", "atualizando", "desinstalando"]).default("instalando"),
  requires: z.array(z.object({ kind: z.string(), spec: z.string(), ok: z.boolean(), found: z.string().optional(), provision: z.string().optional(), sudoHint: z.string().optional() })).default([]),
  license: z.object({ spdx: z.string(), level: z.enum(["livre", "aviso", "restrita"]), acceptedAt: isoSchema.optional() }),
  provides: z.object({ connectorIds: z.array(slugSchema).default([]), skillIds: z.array(slugSchema).default([]) }).default({ connectorIds: [], skillIds: [] }),
  lastTest: z.object({ at: isoSchema, ok: z.boolean(), tool: z.string(), detail: z.string().max(400), ms: z.number() }).optional(),
  installedAt: isoSchema,
  jobId: z.string().optional(),
  sizeBytes: z.number().int().optional(),
  /** Versão da receita que foi instalada (o catálogo trouxe outra = "atualização disponível"). */
  recipeVersion: z.string().max(40).optional(),
  /** "Precisa de você": o comando exato para o dono rodar (o Cyno nunca roda sudo). */
  needs: z.object({ command: z.string().max(600), reason: z.string().max(300) }).optional(),
  /** Último erro (instalação que falhou). */
  error: z.string().max(800).optional(),
});
export type LibraryApp = z.output<typeof libraryAppSchema>;
