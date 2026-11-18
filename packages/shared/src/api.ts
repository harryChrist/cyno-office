import { z } from "zod";
import { workspaceAccessInputSchema, workspaceAccessSchema } from "./access";
import { agentFoldersSchema, workFolderSchema } from "./folders";
import { AVATAR_OPTIONS, SCENE_AVATAR_OPTIONS } from "./avatar";
import { isReservedRoomId, MAX_ID_LENGTH, SAFE_ID_PATTERN } from "./ids";
import { ROOM_THEME_IDS } from "./themes";
import type { BrainContext } from "./brain";
import { brainOrganizeDecisionSchema, brainOrganizePlanSchema } from "./brain-organize";
import { FOR_YOU_SOURCE_KINDS, FOR_YOU_SOURCE_LIMITS, FOR_YOU_ACTORS, FOR_YOU_DECISION_STATUSES, FOR_YOU_ID_PATTERN, FOR_YOU_KINDS, FOR_YOU_QUESTION_LIMITS, FOR_YOU_STATUSES, REJECTION_CATEGORIES, type ForYouItem, type ForYouSource } from "./for-you";
import { BLOCKED_SPANS_MAX, BLOCKED_TYPES, DISPATCH_LIMITS, HANDOFF_INTENTS, HELP_KINDS, PROJECT_BRIEF_MAX, PROJECT_KINDS, PROJECT_LIMITS, PROJECT_ORIGINS, PROJECT_PRIORITIES, PROJECT_STATUSES, PROJECT_STEP_STATUSES, PROJECT_TASK_STATUSES, type Project } from "./projects";
import { SPRINT_STATUSES, type Sprint } from "./sprints";
import { forYouTypeIdSchema, type ForYouTypeDef } from "./for-you-types";
import { gestaoPatchSchema } from "./reports";
import { routineApprovalOverridesSchema, routineProposalSchema } from "./routines";
import type { Agent, Avatar, OfficeState, Room, Task, Team, Workspace } from "./types";
import { AGENT_STATUSES, FAILURE_KINDS, MAESTRO_SESSION_NAME_MAX, ROOM_KINDS, TASK_STATUSES } from "./types";
import { AGENT_EFFORTS, AGENT_ENGINES } from "./terminal";
import { modelChoiceSchema, modelDefaultsSchema } from "./models";
import { LAYOUT_SEED_MAX, ROOM_PURPOSES, ROOM_SIZES } from "./room-spec";
import { PALETTE_COLOR_IDS, type PaletteColorId } from "./palette";
import { FURNITURE_ADD_KINDS, FURNITURE_FACINGS, FURNITURE_TILE_MAX, MAX_FURNITURE_EDITS, type FurnitureEdit } from "./furniture-edits";

// ---------- Campos ----------

export const idSchema = z
  .string()
  .max(MAX_ID_LENGTH)
  .regex(SAFE_ID_PATTERN, "id inválido: use letras minúsculas, números e hífens");

export const roomIdSchema = idSchema.refine(
  (id) => !isReservedRoomId(id),
  "id reservado para o lobby/Cérebro global",
);

const nameSchema = z.string().trim().min(1).max(40);
const focusSchema = z.string().trim().min(1).max(120);
const agentNameSchema = z.string().trim().min(1).max(24);
const roleSchema = z.string().trim().min(1).max(60);
const instructionsSchema = z.string().trim().max(2000);
/**
 * Teto de uma mensagem do usuário (conversa com o Maestro ou com um agente, pedido): alto de
 * propósito, para colar textos longos; só protege contra um colar acidental gigante.
 */
export const MESSAGE_MAX = 100_000;
const promptSchema = z.string().trim().min(1).max(MESSAGE_MAX);
const engineSchema = z.enum(AGENT_ENGINES);
const effortSchema = z.enum(AGENT_EFFORTS);
/** Nome/alias de modelo da CLI (vai como argumento de `--model`; nunca começa com "-"). */
const modelSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/[\]-]*$/, "modelo inválido");

const layoutSeedSchema = z.number().int().min(0).max(LAYOUT_SEED_MAX);
export const gridPositionSchema = z.object({ x: z.number().int(), y: z.number().int() });
export const roomThemeSchema = z.enum(ROOM_THEME_IDS);

/** Chave de um móvel: "seat:<agentId>" (posto de trabalho), "<tipo>@<i>,<j>" (gerado) ou "add-…" (adicionado). */
const furnitureKeySchema = z.string().max(80).regex(/^[a-z0-9][a-z0-9:@,._-]*$/, "chave de móvel inválida");
/** Id de um móvel adicionado no editor. */
const furnitureAddIdSchema = z.string().regex(/^add-[a-z0-9]{1,16}$/, "id de móvel adicionado inválido");
const furnitureTileSchema = z.number().int().min(0).max(FURNITURE_TILE_MAX);
const furnitureFacingSchema = z.enum(FURNITURE_FACINGS);

export const furnitureEditSchema = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("move"), key: furnitureKeySchema, i: furnitureTileSchema, j: furnitureTileSchema }),
  z.strictObject({ op: z.literal("rotate"), key: furnitureKeySchema, facing: furnitureFacingSchema }),
  z.strictObject({ op: z.literal("remove"), key: furnitureKeySchema }),
  z.strictObject({
    op: z.literal("add"),
    id: furnitureAddIdSchema,
    kind: z.enum(FURNITURE_ADD_KINDS),
    i: furnitureTileSchema,
    j: furnitureTileSchema,
    facing: furnitureFacingSchema,
    variant: z.number().int().min(0).max(3).optional(),
    color: z.enum(PALETTE_COLOR_IDS as [PaletteColorId, ...PaletteColorId[]]).optional(),
  }),
]) satisfies z.ZodType<FurnitureEdit>;

/** Lista de ajustes de uma sala: no máximo MAX_FURNITURE_EDITS, sem dois móveis adicionados com o mesmo id. */
export const furnitureEditsSchema = z
  .array(furnitureEditSchema)
  .max(MAX_FURNITURE_EDITS)
  .refine((edits) => {
    const ids = edits.flatMap((edit) => (edit.op === "add" ? [edit.id] : []));
    return new Set(ids).size === ids.length;
  }, "móvel adicionado repetido");

export const avatarSchema = z.object({
  skin: z.enum(AVATAR_OPTIONS.skin),
  hair: z.enum(AVATAR_OPTIONS.hair),
  hairColor: z.enum(AVATAR_OPTIONS.hairColor),
  shirt: z.enum(AVATAR_OPTIONS.shirt),
  pants: z.enum(AVATAR_OPTIONS.pants),
  accessory: z.enum(AVATAR_OPTIONS.accessory).optional(),
  cena: z
    .object({
      hairStyle: z.enum(SCENE_AVATAR_OPTIONS.hairStyle).optional(),
      topStyle: z.enum(SCENE_AVATAR_OPTIONS.topStyle).optional(),
      accessory: z.enum(SCENE_AVATAR_OPTIONS.accessory).optional(),
    })
    .optional(),
}) satisfies z.ZodType<Avatar>;

// ---------- Entidades ----------

export const workspaceNameSchema = z.string().trim().min(1).max(40);

/**
 * Nome da sessão do Remote Control do Maestro (vazio = o padrão "Maestro · <workspace>"). Sem
 * quebras de linha nem caracteres de controle: ele é digitado no terminal do Maestro (`/rename`).
 */
export const maestroSessionNameSchema = z
  .string()
  .trim()
  .max(MAESTRO_SESSION_NAME_MAX, `O nome da sessão pode ter até ${MAESTRO_SESSION_NAME_MAX} caracteres`)
  // eslint-disable-next-line no-control-regex
  .regex(/^[^\u0000-\u001f\u007f]*$/, "O nome da sessão não pode ter quebras de linha nem caracteres de controle");

export const workspaceSchema = z.object({
  id: idSchema,
  name: workspaceNameSchema,
  createdAt: z.iso.datetime(),
  models: modelDefaultsSchema.optional(),
  maestro: z.object({ keepAlive: z.boolean().optional(), sessionName: z.string().optional() }).optional(),
  dispatch: z.object({ maxRunning: z.number().int().optional(), perAgent: z.number().int().optional() }).optional(),
  gestao: z.object({ dailyAt: z.string().nullable().optional(), weekly: z.string().optional(), ai: z.object({ daily: z.boolean().optional(), weekly: z.boolean().optional() }).optional() }).optional(),
  access: workspaceAccessSchema.optional(),
  folders: z.array(workFolderSchema).optional(),
}) satisfies z.ZodType<Workspace>;

/** data/workspaces.json: a lista de workspaces. */
export const workspaceListSchema = z.array(workspaceSchema);

export const roomSchema = z.object({
  id: roomIdSchema,
  /** Ausente nos arquivos antigos = "team". */
  kind: z.enum(ROOM_KINDS).default("team"),
  name: nameSchema,
  theme: roomThemeSchema,
  gridPosition: gridPositionSchema,
  readsGlobalBrain: z.boolean(),
  readsBrainsOf: z.array(roomIdSchema),
  size: z.enum(ROOM_SIZES).optional(),
  purpose: z.enum(ROOM_PURPOSES).optional(),
  layoutSeed: layoutSeedSchema.optional(),
  furnitureEdits: furnitureEditsSchema.optional(),
}) satisfies z.ZodType<Room>;

export const teamSchema = z.object({
  id: idSchema,
  roomId: roomIdSchema,
  name: nameSchema,
  focus: focusSchema,
  leadAgentId: idSchema.optional(),
}) satisfies z.ZodType<Team>;

export const agentSchema = z.object({
  id: idSchema,
  teamId: idSchema,
  name: agentNameSchema,
  role: roleSchema,
  instructions: instructionsSchema,
  avatar: avatarSchema,
  status: z.enum(AGENT_STATUSES),
  /** Ausente nos arquivos antigos = "mock". */
  engine: engineSchema.optional(),
  model: modelSchema.optional(),
  effort: effortSchema.optional(),
  /** Acesso do agente (ausente = segue o workspace; false = desligado para ele). */
  internet: z.boolean().optional(),
  browser: z.boolean().optional(),
  terminal: z.boolean().optional(),
  /** Ajuste por pasta de trabalho (id -> "off" | "read"): ausente = como no workspace. */
  folders: agentFoldersSchema.optional(),
}) satisfies z.ZodType<Agent>;

export const taskSchema = z.object({
  id: idSchema,
  roomId: roomIdSchema,
  teamId: idSchema,
  agentId: idSchema.optional(),
  role: z.literal("request").optional(),
  projectId: idSchema.optional(),
  mergedInto: idSchema.optional(),
  routeReason: z.string().max(500).optional(),
  prompt: promptSchema,
  status: z.enum(TASK_STATUSES),
  outcome: z.literal("cancelled").optional(),
  failureKind: z.enum(FAILURE_KINDS).optional(),
  result: z.string().optional(),
  ranWith: modelChoiceSchema.optional(),
  work: z.object({ projectId: idSchema, ref: z.string().max(12), step: z.number().int().min(0) }).optional(),
  routineId: z.string().max(16).optional(),
  waiting: z.string().max(500).optional(),
  pendingDecision: z.record(z.string(), z.unknown()).optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
}) satisfies z.ZodType<Task>;

export const officeStateSchema = z.object({
  rooms: z.array(roomSchema),
  teams: z.array(teamSchema),
  agents: z.array(agentSchema),
  tasks: z.array(taskSchema),
}) satisfies z.ZodType<OfficeState>;

// ---------- Corpos de requisição (objetos estritos: campos extras = 400) ----------

export const createRoomBodySchema = z.strictObject({
  name: nameSchema,
  theme: roomThemeSchema,
  gridPosition: gridPositionSchema.optional(),
  readsGlobalBrain: z.boolean().optional(),
  size: z.enum(ROOM_SIZES).optional(),
  purpose: z.enum(ROOM_PURPOSES).optional(),
  layoutSeed: layoutSeedSchema.optional(),
});
export const updateRoomBodySchema = createRoomBodySchema.partial();

/** PATCH /rooms/:id/furniture: a lista COMPLETA de ajustes manuais dos móveis (vazia = volta ao gerado). */
export const updateFurnitureBodySchema = z.strictObject({ edits: furnitureEditsSchema });

/** Compartilhamento do Cérebro do quarto (lista completa de quartos lidos; não é simétrica). */
export const updateBrainSharingBodySchema = z.strictObject({
  readsGlobalBrain: z.boolean().optional(),
  readsBrainsOf: z.array(roomIdSchema).optional(),
});

export const createTeamBodySchema = z.strictObject({
  roomId: roomIdSchema,
  name: nameSchema,
  focus: focusSchema,
});
/** `leadAgentId: null` tira o líder. */
export const updateTeamBodySchema = createTeamBodySchema.partial().extend({ leadAgentId: idSchema.nullable().optional() });

/** Sem `status`: todo agente nasce idle e só o server muda o status. */
export const createAgentBodySchema = z.strictObject({
  teamId: idSchema,
  name: agentNameSchema,
  role: roleSchema,
  instructions: instructionsSchema,
  avatar: avatarSchema,
  engine: engineSchema.optional(),
  model: modelSchema.optional(),
  effort: effortSchema.optional(),
  /** Acesso do agente (internet, navegador, terminal): ausente = segue o workspace; false = desligado para ele. */
  internet: z.boolean().optional(),
  browser: z.boolean().optional(),
  terminal: z.boolean().optional(),
  /** Ajuste por pasta de trabalho (id -> "off" | "read"); no PATCH, `{}` volta a seguir o workspace em todas. */
  folders: agentFoldersSchema.optional(),
});
/** No PATCH, `model: null`/`effort: null` voltam ao padrão (tiram o campo). */
export const updateAgentBodySchema = createAgentBodySchema.partial().extend({
  model: modelSchema.nullable().optional(),
  effort: effortSchema.nullable().optional(),
});

export const listTasksQuerySchema = z.object({
  roomId: idSchema.optional(),
  agentId: idSchema.optional(),
});

/**
 * Só `prompt`: o pedido vai para o Maestro, que escolhe o time. `teamId` (com ou sem `roomId`)
 * é o atalho que pula a triagem e manda direto para o time.
 */
export const createTaskBodySchema = z
  .strictObject({
    prompt: promptSchema,
    roomId: roomIdSchema.optional(),
    teamId: idSchema.optional(),
  })
  .refine((body) => body.roomId === undefined || body.teamId !== undefined, {
    message: "Com a sala (roomId), informe também o time (teamId)",
    path: ["teamId"],
  });

export const taskApprovalBodySchema = z.strictObject({ approved: z.boolean() });

export const idParamsSchema = z.object({ id: idSchema });

// ---------- Para você ----------

/** Teto do motivo de uma alteração ou de um cancelamento. */
export const FOR_YOU_REASON_MAX = 500;

export const forYouIdSchema = z.string().regex(FOR_YOU_ID_PATTERN, "id inválido: use o formato A-0001");

const L = FOR_YOU_SOURCE_LIMITS;

/** Uma fonte do cartão (schema estrito, para dados salvos). */
export const forYouSourceSchema = z.object({
  kind: z.enum(FOR_YOU_SOURCE_KINDS),
  url: z.string().max(L.url).optional(),
  title: z.string().max(L.title).optional(),
  author: z.string().max(L.author).optional(),
  authorDetail: z.string().max(L.authorDetail).optional(),
  postedAt: z.string().max(L.postedAt).optional(),
  content: z.string().max(L.content).optional(),
  summary: z.string().max(L.summary).optional(),
  facts: z.array(z.object({ label: z.string().max(L.factLabel), value: z.string().max(L.factValue) })).max(L.facts).optional(),
  mediaIds: z.array(z.string().max(16)).max(L.mediaIds).optional(),
}) satisfies z.ZodType<ForYouSource>;

const forYouTextSchema = z.string().max(20000);

/** A regra de um cartão kind "regra" (a retrospectiva da Gestão). */
export const FOR_YOU_RULE_LIMITS = { text: 600, excerpt: 400, excerpts: 5, itemIds: 200 } as const;
export const forYouRuleScopeSchema = z.strictObject({ roomId: roomIdSchema.optional(), agentId: idSchema.optional(), global: z.literal(true).optional() });
export const forYouRuleSchema = z.object({
  text: z.string().max(FOR_YOU_RULE_LIMITS.text),
  scope: forYouRuleScopeSchema,
  evidence: z.object({
    itemIds: z.array(z.string().max(32)).max(FOR_YOU_RULE_LIMITS.itemIds),
    count: z.number().int().nonnegative(),
    days: z.number().int().nonnegative(),
    total: z.number().int().nonnegative().optional(),
    line: z.string().max(300).optional(),
    excerpts: z.array(z.object({ itemId: z.string().max(32), before: z.string().max(FOR_YOU_RULE_LIMITS.excerpt), after: z.string().max(FOR_YOU_RULE_LIMITS.excerpt).optional() })).max(FOR_YOU_RULE_LIMITS.excerpts).optional(),
  }),
  source: z.enum(["molde", "maestro"]),
  retro: z.string().max(12),
  groupId: z.string().max(40).optional(),
});

export const forYouItemSchema = z.object({
  id: forYouIdSchema,
  taskId: idSchema.optional(),
  agentId: idSchema,
  roomId: roomIdSchema,
  type: forYouTypeIdSchema,
  status: z.enum(FOR_YOU_STATUSES),
  title: z.string().max(500).optional(),
  where: z.string().max(500).optional(),
  to: z.string().max(500).optional(),
  why: z.string().max(2000).optional(),
  meta: z.record(z.string(), z.string()),
  text: forYouTextSchema,
  originalText: forYouTextSchema.optional(),
  editedByUser: z.boolean(),
  response: z.string().max(4000).optional(),
  kind: z.enum(FOR_YOU_KINDS).optional(),
  projectId: idSchema.optional(),
  taskRef: z.string().max(12).optional(),
  sprintId: z.string().max(12).optional(),
  rejection: z.object({ reason: z.string().max(4000), category: z.string().max(60).optional() }).optional(),
  decidedBy: z.enum(["usuario", "automatico"]).optional(),
  groupId: z.string().max(64).optional(),
  viaBatch: z.literal(true).optional(),
  routineId: z.string().max(16).optional(),
  routine: routineProposalSchema.optional(),
  rule: forYouRuleSchema.optional(),
  organize: brainOrganizePlanSchema.optional(),
  mediaIds: z.array(z.string().max(16)).max(50).optional(),
  sources: z.array(forYouSourceSchema).max(L.sources).optional(),
  questions: z
    .array(
      z.object({
        id: z.string().max(12),
        text: z.string().max(FOR_YOU_QUESTION_LIMITS.text),
        options: z.array(z.string().max(FOR_YOU_QUESTION_LIMITS.option)).max(FOR_YOU_QUESTION_LIMITS.options).optional(),
        default: z.string().max(FOR_YOU_QUESTION_LIMITS.option).optional(),
      }),
    )
    .max(FOR_YOU_QUESTION_LIMITS.questions)
    .optional(),
  answers: z.record(z.string(), forYouAnswerSchema()).optional(),
  createdAt: z.iso.datetime(),
  decidedAt: z.iso.datetime().optional(),
  history: z
    .array(z.object({ at: z.iso.datetime(), by: z.enum(FOR_YOU_ACTORS), action: z.enum(["alterado", "cancelado"]), reason: z.string().max(FOR_YOU_REASON_MAX).optional() }))
    .optional(),
  cancelledBy: z.enum(FOR_YOU_ACTORS).optional(),
  cancelReason: z.string().max(FOR_YOU_REASON_MAX).optional(),
}) satisfies z.ZodType<ForYouItem>;

function forYouAnswerSchema() {
  return z.strictObject({ text: z.string().max(FOR_YOU_QUESTION_LIMITS.answer).optional(), skipped: z.boolean().optional() });
}

/** POST /for-you/:id/cancel: "Descartar" (você retira o item pendente; o motivo é opcional). */
export const forYouCancelBodySchema = z.strictObject({ reason: z.string().trim().max(FOR_YOU_REASON_MAX).optional() });
export type ForYouCancelBody = z.input<typeof forYouCancelBodySchema>;

/** PATCH /for-you/:id/answers: rascunho das respostas de um questionário (só as que mudam; não acorda ninguém). */
export const forYouAnswersBodySchema = z.strictObject({ answers: z.record(z.string().max(12), forYouAnswerSchema()) });
export type ForYouAnswersBody = z.input<typeof forYouAnswersBodySchema>;

// ---------- Projetos (antes "Planos") ----------

const projectStepSchema = z.object({
  /** Vazio = a tarefa criada à mão ainda sem responsável (o dono escolhe depois): tem de sobreviver a um reinício. */
  agentId: z.union([idSchema, z.literal("")]),
  address: z.string().max(100).optional(),
  what: z.string(),
  status: z.enum(PROJECT_STEP_STATUSES),
  taskId: idSchema.optional(),
  result: z.string().optional(),
  startedAt: z.iso.datetime().optional(),
  finishedAt: z.iso.datetime().optional(),
});

const doneItemSchema = z.object({ id: z.string().max(32), text: z.string(), met: z.boolean().optional(), note: z.string().optional() });

const autoGrantSchema = z.object({
  actions: z.array(z.string()),
  sites: z.array(z.string()).optional(),
  connectors: z.array(z.string()).optional(),
  dailyCap: z.number().int().min(0).optional(),
  approvedAt: z.iso.datetime(),
});

const routineRefSchema = z.object({ routineId: z.string().max(16), scheduleId: z.string().max(64).optional(), slot: z.string().max(40).optional(), period: z.string().max(16).optional() });

const sprintSummarySchema = z.object({
  builtAt: z.iso.datetime(),
  done: z.array(z.object({ ref: z.string(), title: z.string(), assignees: z.array(z.string()), finishedAt: z.iso.datetime(), links: z.array(z.string()).optional(), taskIds: z.array(z.string()).optional() })),
  carried: z.array(z.object({ ref: z.string(), title: z.string(), to: z.string().nullable() })),
  failed: z.array(z.object({ ref: z.string(), title: z.string(), reason: z.string().optional() })),
  skipped: z.array(z.string()),
  byAgent: z.record(z.string(), z.object({ done: z.number(), total: z.number() })),
  workedMs: z.number(),
  cancelled: z.array(z.object({ ref: z.string(), title: z.string() })).optional(),
  reworked: z.array(z.object({ ref: z.string(), title: z.string(), count: z.number(), reason: z.string().optional() })).optional(),
  text: z.string().optional(),
  decidedBy: z.enum(["usuario", "automatico"]).optional(),
  decidedAt: z.iso.datetime().optional(),
  returned: z.object({ reason: z.string(), refs: z.array(z.string()) }).optional(),
});

const sprintSchema = z.object({
  id: z.string().max(12),
  name: z.string(),
  goal: z.string().optional(),
  startAt: z.iso.datetime(),
  endAt: z.iso.datetime(),
  order: z.number(),
  status: z.enum(SPRINT_STATUSES),
  openedAt: z.iso.datetime().optional(),
  closedAt: z.iso.datetime().optional(),
  summary: sprintSummarySchema.optional(),
  forYouId: z.string().optional(),
}) satisfies z.ZodType<Sprint>;

const labelSchema = z.object({ id: z.string().max(32), name: z.string(), color: z.string() });

export const projectTaskSchema = z.object({
  ref: z.string().max(12),
  title: z.string(),
  briefing: z.string(),
  ownerId: z.string(),
  steps: z.array(projectStepSchema),
  current: z.number().int().min(0),
  dependsOn: z.array(z.string()),
  priority: z.enum(PROJECT_PRIORITIES),
  startAt: z.iso.datetime().optional(),
  dueAt: z.iso.datetime().optional(),
  doneWhen: z.array(doneItemSchema).default([]),
  status: z.enum(PROJECT_TASK_STATUSES),
  skipped: z.boolean().optional(),
  approvalType: z.string().optional(),
  result: z.string().optional(),
  failure: z.string().optional(),
  note: z.string().optional(),
  blocked: z.object({ type: z.enum(BLOCKED_TYPES), by: z.string().optional(), note: z.string(), since: z.iso.datetime() }).optional(),
  blockedSpans: z.array(z.object({ type: z.enum(BLOCKED_TYPES), by: z.string().optional(), since: z.iso.datetime(), until: z.iso.datetime() })).max(BLOCKED_SPANS_MAX).optional(),
  queuedAt: z.iso.datetime().optional(),
  rework: z.object({ count: z.number().int().min(0), last: z.object({ reason: z.string(), at: z.iso.datetime(), itemId: z.string().optional() }).optional() }).default({ count: 0 }),
  origin: z.object({ fromAddress: z.string(), fromRef: z.string(), intent: z.enum(HANDOFF_INTENTS), hops: z.number().int().min(0), at: z.iso.datetime().optional(), reply: z.boolean().optional() }).optional(),
  waitingSince: z.iso.datetime().optional(),
  stallWarned: z.boolean().optional(),
  help: z.array(z.object({ agentId: z.string(), what: z.string(), suggestedAgentId: z.string().optional(), kind: z.enum(HELP_KINDS).optional(), at: z.iso.datetime() })).optional(),
  startedAt: z.iso.datetime().optional(),
  finishedAt: z.iso.datetime().optional(),
  updatedAt: z.iso.datetime(),
  parent: z.string().max(12).optional(),
  order: z.number().optional(),
  group: z.literal(true).optional(),
  archived: z.literal(true).optional(),
  sprintId: z.string().max(12).optional(),
  labels: z.array(z.string()).max(PROJECT_LIMITS.labelsPerTask).optional(),
  carriedFrom: z.string().max(12).optional(),
  carryCount: z.number().int().min(0).optional(),
  pinnedAt: z.iso.datetime().optional(),
  meta: z
    .object({
      requestId: idSchema,
      origin: z.enum(PROJECT_ORIGINS),
      routineRef: routineRefSchema.optional(),
      brief: z.string().optional(),
      joint: z.object({ id: z.string(), part: z.string(), dependsOn: z.array(z.string()) }).optional(),
      createdAt: z.iso.datetime().optional(),
    })
    .optional(),
});

/** Projeto como gravado em projects/<id>.json (campos novos com padrão: lê o formato antigo do plano). */
export const projectSchema = z.object({
  id: idSchema,
  kind: z.enum(PROJECT_KINDS).default("projeto"),
  title: z.string(),
  summary: z.string().optional(),
  origin: z.enum(PROJECT_ORIGINS).default("maestro"),
  routineRef: routineRefSchema.optional(),
  status: z.enum(PROJECT_STATUSES),
  version: z.number().int(),
  feedback: z.string().optional(),
  forYouId: z.string().optional(),
  priority: z.enum(PROJECT_PRIORITIES).default("normal"),
  startAt: z.iso.datetime().optional(),
  dueAt: z.iso.datetime().optional(),
  pace: z
    .object({
      hoursPerDay: z.number().positive().max(24).optional(),
      window: z.object({ from: z.string().regex(/^\d{2}:\d{2}$/), to: z.string().regex(/^\d{2}:\d{2}$/) }).optional(),
      maxParallel: z.number().int().min(1).optional(),
    })
    .optional(),
  mode: z.discriminatedUnion("kind", [z.object({ kind: z.literal("pede-ok") }), z.object({ kind: z.literal("automatico"), grant: autoGrantSchema })]).default({ kind: "pede-ok" }),
  modeProposal: z.object({ grant: autoGrantSchema, by: z.enum(["maestro", "cyno"]), at: z.iso.datetime() }).optional(),
  autoUsage: z.object({ day: z.string(), count: z.number().int().min(0) }).optional(),
  doneWhen: z.array(doneItemSchema).optional(),
  worked: z.record(z.string(), z.number()).default({}),
  tasks: z.array(projectTaskSchema),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  approvedAt: z.iso.datetime().optional(),
  finishedAt: z.iso.datetime().optional(),
  doneNotified: z.boolean().optional(),
  brief: z.string().max(PROJECT_BRIEF_MAX).optional(),
  joint: z.object({ id: z.string(), part: z.string(), dependsOn: z.array(z.string()) }).optional(),
  system: z.literal("avulsas").optional(),
  labels: z.array(labelSchema).max(PROJECT_LIMITS.labels).optional(),
  sprints: z.array(sprintSchema).max(PROJECT_LIMITS.sprints).optional(),
  pausedAt: z.iso.datetime().optional(),
  pinnedAt: z.iso.datetime().optional(),
  nextRef: z.number().int().min(1).optional(),
}) satisfies z.ZodType<Project, unknown>;

/** @deprecated use projectSchema. */
export const planSchema = projectSchema;

/** POST /plans/:id/adjust: o que o usuário quer mudar no plano (vai para o Maestro numa mensagem só). */
export const planAdjustBodySchema = z.strictObject({ feedback: z.string().trim().min(1).max(4000) });
export type PlanAdjustBody = z.input<typeof planAdjustBodySchema>;

/** Ritmo do projeto (horas por dia, janela de horário e etapas em paralelo). */
const paceSchema = z.strictObject({
  hoursPerDay: z.number().gt(0).max(24).optional(),
  window: z.strictObject({ from: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM"), to: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM") }).optional(),
  maxParallel: z.number().int().min(1).max(10).optional(),
});

/** PATCH /projects/:id: o que o usuário (ou o Maestro) muda no projeto; `null` limpa prazo, começo e ritmo. */
export const projectPatchBodySchema = z.strictObject({
  title: z.string().trim().min(1).max(PROJECT_LIMITS.title).optional(),
  priority: z.enum(PROJECT_PRIORITIES).optional(),
  startAt: z.union([z.iso.datetime({ offset: true }), z.null()]).optional(),
  dueAt: z.union([z.iso.datetime({ offset: true }), z.null()]).optional(),
  pace: z.union([paceSchema, z.null()]).optional(),
  status: z.enum(["ativo", "pausado"]).optional(),
  /** "Isso primeiro": true fixa o projeto no topo da fila; false solta. */
  pinned: z.boolean().optional(),
  /** O objetivo ("summary") e o "pronto quando…" do projeto, editados na tela do projeto. */
  summary: z.union([z.string().trim().max(2000), z.null()]).optional(),
  doneWhen: z.array(z.string().trim().min(1).max(500)).max(20).optional(),
});
export type ProjectPatchBody = z.infer<typeof projectPatchBodySchema>;

/**
 * POST /projects/:id/mode: só o usuário muda o modo (nenhuma ferramenta MCP chama esta rota).
 * `automatico` liga com a permissão (tipos de ação, teto por dia, sites e conectores opcionais);
 * `pede-ok` desliga; `proposta` aceita ou recusa a sugestão do Maestro/Cyno.
 */
export const projectModeBodySchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("pede-ok") }),
  z.strictObject({
    kind: z.literal("automatico"),
    actions: z.array(z.string().trim().min(1).max(64)).min(1).max(40),
    dailyCap: z.number().int().min(1).max(1000),
    sites: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
    connectors: z.array(z.string().trim().min(1).max(64)).max(20).optional(),
  }),
  z.strictObject({ kind: z.literal("proposta"), accept: z.boolean() }),
]);
export type ProjectModeBody = z.infer<typeof projectModeBodySchema>;
/** POST /routines/:id/mode: o mesmo corpo do modo do projeto (Pede OK, Automático com permissão, aceitar/recusar a sugestão). */
export const routineModeBodySchema = projectModeBodySchema;
export type RoutineModeBody = ProjectModeBody;

/** POST /tasks/:id/close: o usuário fecha um pedido parado (concluir como está, ou cancelar). */
export const closeRequestBodySchema = z.strictObject({ mode: z.enum(["concluir", "cancelar"]), note: z.string().trim().max(1000).optional() });
export type CloseRequestBody = z.input<typeof closeRequestBodySchema>;

export const forYouParamsSchema = z.object({ id: forYouIdSchema });

/**
 * Decisão sobre um item: aprovado/rejeitado/respondido (com o texto final e a resposta ou nota)
 * ou "pendente" (Reabrir). Responder exige a resposta; aprovar com texto exige texto não vazio.
 */
export const forYouDecisionBodySchema = z
  .strictObject({
    status: z.enum(FOR_YOU_DECISION_STATUSES),
    text: forYouTextSchema.optional(),
    response: z.string().max(4000).optional(),
    /** Recusa: por que o usuário recusou (volta ao agente para refazer; opcional). */
    reason: z.string().max(2000).optional(),
    /** Recusa: a categoria rápida do motivo (opcional; o dono pode pular). */
    category: z.enum(REJECTION_CATEGORIES).optional(),
    /** Cartão "rotina": ajustes feitos ao aprovar (precisa OK, meta, teto diário). */
    routine: routineApprovalOverridesSchema.optional(),
    /** Cartão "regra", ao aprovar: o texto e o escopo que o dono ajustou (sem isto vale o que o cartão propôs). */
    rule: z.strictObject({ text: z.string().trim().min(1).max(FOR_YOU_RULE_LIMITS.text).optional(), scope: forYouRuleScopeSchema.optional() }).optional(),
    /** Cartão "organizacao", ao aprovar: as ações da proposta que o dono desmarcou. */
    organize: brainOrganizeDecisionSchema.optional(),
    /** Cartão "sprint", ao devolver: as tarefas entregues (`ref`) que voltam como retrabalho na sprint ativa. */
    returnRefs: z.array(z.string().max(12)).max(200).optional(),
  })
  .refine((body) => body.status !== "respondido" || (body.response ?? "").trim().length > 0, {
    message: "Escreva a resposta antes de enviar",
    path: ["response"],
  })
  .refine((body) => body.status !== "aprovado" || body.text === undefined || body.text.trim().length > 0, {
    message: "O texto aprovado não pode ficar vazio",
    path: ["text"],
  });

/**
 * O Maestro de um workspace novo (tudo opcional): nome de exibição (o id do agente continua
 * "maestro"), aparência, motor/modelo/esforço (ausente = o padrão `maestro` dos modelos globais)
 * e instruções (ausente ou vazio = as instruções padrão do Maestro).
 */
export const newWorkspaceMaestroSchema = z.strictObject({
  name: agentNameSchema.optional(),
  avatar: avatarSchema.optional(),
  choice: modelChoiceSchema.optional(),
  instructions: instructionsSchema.optional(),
  /** Nome da sessão no Remote Control do Claude Code (vazio = "Maestro · <workspace>"). */
  sessionName: maestroSessionNameSchema.optional(),
});
/** `access`: o acesso dos agentes do workspace novo (ausente = os padrões; veja access.ts). */
export const createWorkspaceBodySchema = z.strictObject({ name: workspaceNameSchema, maestro: newWorkspaceMaestroSchema.optional(), access: workspaceAccessInputSchema.optional() });
export type NewWorkspaceMaestro = z.output<typeof newWorkspaceMaestroSchema>;
/**
 * PATCH /api/workspaces/:ws: renomear, trocar os modelos padrão (objeto inteiro; não mexe nos agentes
 * existentes) e/ou as configurações do Maestro (`maestro.keepAlive`: manter o terminal dele sempre rodando;
 * `maestro.sessionName`: nome da sessão no Remote Control, vazio = o padrão).
 */
/** Campos do workspace que herdam da plataforma e podem "voltar ao padrão" (o PATCH com `reset` apaga o valor próprio). */
export const WORKSPACE_RESETTABLE_FIELDS = [
  "dispatch.maxRunning",
  "dispatch.perAgent",
  "gestao.dailyAt",
  "gestao.weekly",
  "gestao.ai",
  "maestro.keepAlive",
  "maestro.sessionName",
  "access.internet",
  "access.browser",
  "access.terminal",
  "access.approveSensitiveActions",
  "access.allowLocalNetwork",
  "access.allowedDomains",
  "access.blockedDomains",
] as const;
export type WorkspaceResettableField = (typeof WORKSPACE_RESETTABLE_FIELDS)[number];

export const updateWorkspaceBodySchema = z
  .strictObject({
    name: workspaceNameSchema.optional(),
    /** "Voltar ao padrão da plataforma": apaga o valor próprio de cada campo listado (vale o padrão). */
    reset: z.array(z.enum(WORKSPACE_RESETTABLE_FIELDS)).min(1).max(WORKSPACE_RESETTABLE_FIELDS.length).optional(),
    models: modelDefaultsSchema.optional(),
    maestro: z
      .strictObject({ keepAlive: z.boolean().optional(), sessionName: maestroSessionNameSchema.optional() })
      .refine((maestro) => maestro.keepAlive !== undefined || maestro.sessionName !== undefined, { message: "Nada para mudar no Maestro" })
      .optional(),
    /** Paralelismo da distribuição dos planos (tarefas rodando no workspace e por agente). */
    dispatch: z
      .strictObject({
        maxRunning: z.number().int().min(DISPATCH_LIMITS.maxRunning.min).max(DISPATCH_LIMITS.maxRunning.max).optional(),
        perAgent: z.number().int().min(DISPATCH_LIMITS.perAgent.min).max(DISPATCH_LIMITS.perAgent.max).optional(),
      })
      .optional(),
    /** Cerimônias da Gestão (resumo do dia, revisão da semana, parágrafo de IA). */
    gestao: gestaoPatchSchema.optional(),
  })
  .refine((body) => body.name !== undefined || body.models !== undefined || body.maestro !== undefined || body.dispatch !== undefined || body.gestao !== undefined || body.reset !== undefined, { message: "Nada para mudar" });
/** Parâmetro `:ws` das rotas /api/w/:ws/... */
export const workspaceParamsSchema = z.object({ ws: idSchema });

// ---------- Tipos para o web ----------

export type CreateWorkspaceBody = z.input<typeof createWorkspaceBodySchema>;
export type UpdateWorkspaceBody = z.input<typeof updateWorkspaceBodySchema>;
export type CreateRoomBody = z.input<typeof createRoomBodySchema>;
export type UpdateRoomBody = z.input<typeof updateRoomBodySchema>;
export type UpdateBrainSharingBody = z.input<typeof updateBrainSharingBodySchema>;
export type UpdateFurnitureBody = z.input<typeof updateFurnitureBodySchema>;
export type CreateTeamBody = z.input<typeof createTeamBodySchema>;
export type UpdateTeamBody = z.input<typeof updateTeamBodySchema>;
export type CreateAgentBody = z.input<typeof createAgentBodySchema>;
export type UpdateAgentBody = z.input<typeof updateAgentBodySchema>;
export type ListTasksQuery = z.input<typeof listTasksQuerySchema>;
/**
 * Mensagem para o Maestro (a caixa "Fale com o Maestro"). Com o Maestro numa CLI é conversa: vai
 * para a sessão dele e só vira pedido (tarefa) quando ele decide (`open_request`). Com o Maestro
 * simulado, cada mensagem ainda vira um pedido.
 */
/** Conversa com o Maestro: sem limite de tamanho (só não pode ser vazia). */
export const maestroMessageBodySchema = z.strictObject({ text: z.string().trim().min(1) });

export type CreateTaskBody = z.input<typeof createTaskBodySchema>;
export type MaestroMessageBody = z.input<typeof maestroMessageBodySchema>;
/** POST /api/w/:ws/maestro/messages: conversa (sem tarefa) ou, no Maestro simulado, o pedido criado. */
export type MaestroMessageResponse = { mode: "conversa"; messageId: string } | { mode: "pedido"; task: Task };
export type TaskApprovalBody = z.input<typeof taskApprovalBodySchema>;
export type ForYouDecisionBody = z.input<typeof forYouDecisionBodySchema>;

/** POST /for-you/batch: aprovar vários itens de uma vez (só aprovação de texto, sem edição pendente e do mesmo tipo; veja for-you-batch.ts). */
export const forYouBatchBodySchema = z.strictObject({
  ids: z
    .array(forYouIdSchema)
    .min(1)
    .max(20)
    .refine((ids) => new Set(ids).size === ids.length, { message: "Há itens repetidos no lote" }),
  decision: z.literal("aprovado"),
});
export type ForYouBatchBody = z.infer<typeof forYouBatchBodySchema>;
/** O que o lote devolve: os itens aprovados, na ordem pedida. */
export type ForYouBatchResponse = { items: ForYouItem[] };

/** `sceneLive: true` só aparece com a cena ao vivo ligada no servidor (`CYNO_SCENE_LIVE`). */
export type HealthResponse = { ok: true; sceneLive?: true };

/**
 * Rotas da API (o server valida os corpos com os schemas acima):
 * - GET    /api/health                       -> HealthResponse
 * - GET    /api/engines[?refresh=1]          -> EnginesResponse (motores e modelos; CLIs detectadas na 1ª chamada)
 * - GET    /api/workspaces                   -> Workspace[]
 * - POST   /api/workspaces                   -> 201 Workspace (id = slug do nome; nasce com lobby e Cérebro global)
 * - PATCH  /api/workspaces/:ws               -> Workspace (renomear; o id não muda)
 * - DELETE /api/workspaces/:ws               -> 204 (409 se tiver tarefa ativa ou for o último)
 * Tudo abaixo é de um workspace (`:ws`); workspace inexistente -> 404.
 * - GET    /api/w/:ws/office                 -> OfficeState
 * - POST   /api/w/:ws/rooms                  -> 201 Room (readsGlobalBrain padrão: false; gridPosition livre automática)
 * - PATCH  /api/w/:ws/rooms/:id              -> Room
 * - DELETE /api/w/:ws/rooms/:id              -> 204 (cascata: times, agentes, tarefas, Cérebro, itens do
 *                                              "Para você", eventos do calendário, logs e pastas dos agentes)
 * - GET    /api/w/:ws/rooms/:id/deletion-preview -> RoomDeletionPreview (o que o DELETE apagaria)
 * - PATCH  /api/w/:ws/rooms/:id/brain-sharing -> Room (lê o Cérebro global? e a lista completa de quartos
 *                                              cujos Cérebros ele lê; as portas são automáticas, não se configuram)
 * - GET    /api/w/:ws/rooms/:id/context      -> BrainContext
 * - GET    /api/w/:ws/brains                 -> ListBrainsResponse (lobby, Sala do Maestro e quartos; notas mais recentes primeiro)
 * - GET    /api/w/:ws/brains/:brainId/notes/:file -> BrainNoteResponse (404 se o Cérebro ou a nota .md não existir)
 * - POST   /api/w/:ws/teams                  -> 201 Team;  PATCH /api/w/:ws/teams/:id -> Team;  DELETE -> 204
 * - POST   /api/w/:ws/agents                 -> 201 Agent; PATCH /api/w/:ws/agents/:id -> Agent; DELETE -> 204
 *                                              (engine "mock" | "claude" | ...; model e effort opcionais)
 * - POST   /api/w/:ws/agents/:id/terminal/start -> AgentTerminalInfo (liga o terminal de CLI; 409 se o motor é "mock")
 * - POST   /api/w/:ws/agents/:id/terminal/stop  -> AgentTerminalInfo (para o processo; a sessão continua salva)
 * - POST   /mcp (só 127.0.0.1, Authorization: Bearer <token do agente>) -> servidor MCP "office" das CLIs
 * - GET    /api/w/:ws/tasks?roomId=&agentId= -> Task[] (ordem de criação)
 * - POST   /api/w/:ws/tasks                  -> 201 Task ({ prompt }: tarefa do Maestro, "queued", que vai
 *                                              para a triagem; com teamId (e roomId): direto ao time, agentId já escolhido)
 * - POST   /api/w/:ws/maestro/messages       -> 202 MaestroMessageResponse ({ text }: conversa com o Maestro de CLI,
 *                                              sem tarefa; no Maestro simulado, vira pedido como o POST /tasks)
 * - POST   /api/w/:ws/tasks/:id/approval     -> Task (409 se a tarefa não estiver em waiting_approval;
 *                                              na tarefa do Maestro, decide a subtarefa ou refaz a triagem)
 * - GET    /api/w/:ws/calendar?from=&to=     -> CalendarEvent[] (datas AAAA-MM-DD inclusivas; ordem do calendário)
 * - POST   /api/w/:ws/calendar               -> 201 CalendarEvent; PATCH /api/w/:ws/calendar/:id -> CalendarEvent; DELETE -> 204
 *   (schemas em calendar.ts; quarto inexistente -> 400 com details em roomId)
 * - GET    /api/w/:ws/for-you                -> ForYouItem[] (ordem de criação)
 * - POST   /api/w/:ws/for-you/:id/decision   -> ForYouItem (409 se já decidido e o pedido não é "pendente";
 *                                              aprovar/rejeitar/responder decide a tarefa ligada, se ela espera)
 * - POST   /api/w/:ws/for-you/:id/cancel     -> ForYouItem ("Descartar": status "cancelado", cancelledBy "usuario";
 *                                              409 se não está pendente ou é um plano; a tarefa que ele segurava segue
 *                                              sem a resposta; o Maestro só fica sabendo quando acordar)
 * - GET    /api/w/:ws/for-you/types          -> ForYouTypeDef[] (tipos do workspace; schemas em for-you-types.ts)
 * - POST   /api/w/:ws/for-you/types          -> 201 ForYouTypeDef (409 se o id já existe)
 * - PATCH  /api/w/:ws/for-you/types/:typeId  -> ForYouTypeDef (embutidos não mudam de comportamento)
 * - DELETE /api/w/:ws/for-you/types/:typeId  -> 204 (os itens vão para "outro"; 409 nos embutidos)
 * - POST   /api/w/:ws/for-you/types/:typeId/merge { into } -> ForYouTypeDef (o destino; os itens vão para ele)
 * Erros: 400 { error, details? }, 404/409/422 { error }. DELETE bem-sucedido não tem corpo (204).
 */
export type ListTasksResponse = Task[];
export type TaskApprovalResponse = Task;
export type ListForYouResponse = ForYouItem[];
export type ForYouDecisionResponse = ForYouItem;
export type ListForYouTypesResponse = ForYouTypeDef[];
export type RoomContextResponse = BrainContext;

/** Quanto some junto com o quarto (GET rooms/:id/deletion-preview). */
export type RoomDeletionPreview = {
  teams: number;
  agents: number;
  /** Todas as tarefas do quarto (inclusive histórico). */
  tasks: number;
  /** Quantas dessas estão em andamento (são canceladas). */
  activeTasks: number;
  brainNotes: number;
  forYouItems: number;
  calendarEvents: number;
  /** Arquivos de log de trabalho das tarefas do quarto. */
  logs: number;
};

export type ValidationIssue = { path: string; message: string };

/** Corpo de erro da API: 400 traz `details`; 404/409/422 só `error`. */
export type ApiErrorBody = { error: string; details?: ValidationIssue[] };

export function toValidationIssues(error: z.ZodError): ValidationIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join("."),
    message: issue.message,
  }));
}


// ---------- Árvore de tarefas: criar e editar pela tela ----------

/** POST /projects: o dono cria um projeto à mão (origem "usuario", sem plano para aprovar). */
export const projectCreateBodySchema = z.strictObject({
  title: z.string().trim().min(1).max(PROJECT_LIMITS.title),
  summary: z.string().trim().max(2000).optional(),
  priority: z.enum(PROJECT_PRIORITIES).optional(),
  dueAt: z.iso.datetime({ offset: true }).optional(),
  doneWhen: z.array(z.string().trim().min(1).max(500)).max(20).optional(),
});
export type ProjectCreateBody = z.infer<typeof projectCreateBodySchema>;

/** POST /projects/:id/tasks: entregável (`group`), tarefa ou subtarefa (`parent`). Sem `assignee` a tarefa fica no backlog. */
export const taskCreateBodySchema = z.strictObject({
  title: z.string().trim().min(1).max(PROJECT_LIMITS.title),
  parent: z.string().max(12).optional(),
  group: z.boolean().optional(),
  briefing: z.string().trim().max(PROJECT_LIMITS.briefing).optional(),
  assignee: z.string().trim().min(1).max(64).optional(),
  priority: z.enum(PROJECT_PRIORITIES).optional(),
  startAt: z.iso.datetime({ offset: true }).optional(),
  dueAt: z.iso.datetime({ offset: true }).optional(),
  labels: z.array(z.string().max(32)).max(PROJECT_LIMITS.labelsPerTask).optional(),
  /** "Depois de": refs das tarefas (irmãs) que ela espera; a entrega delas chega ao agente. */
  dependsOn: z.array(z.string().max(12)).max(PROJECT_LIMITS.subtasksPerTask).optional(),
});
export type TaskCreateBody = z.infer<typeof taskCreateBodySchema>;

/** PATCH /projects/:id/tasks/:ref: edição na linha (`null` limpa). `status: "cancelada"` cancela; `"refazer"` volta uma tarefa que falhou ou foi cancelada para a fila. */
export const taskPatchBodySchema = z.strictObject({
  title: z.string().trim().min(1).max(PROJECT_LIMITS.title).optional(),
  briefing: z.string().trim().max(PROJECT_LIMITS.briefing).optional(),
  assignee: z.union([z.string().trim().min(1).max(64), z.null()]).optional(),
  priority: z.enum(PROJECT_PRIORITIES).optional(),
  startAt: z.union([z.iso.datetime({ offset: true }), z.null()]).optional(),
  dueAt: z.union([z.iso.datetime({ offset: true }), z.null()]).optional(),
  labels: z.array(z.string().max(32)).max(PROJECT_LIMITS.labelsPerTask).optional(),
  doneWhen: z.array(z.string().trim().min(1).max(500)).max(20).optional(),
  /** A lista inteira de "depois de" (mande sem uma ref para tirá-la). */
  dependsOn: z.array(z.string().max(12)).max(PROJECT_LIMITS.subtasksPerTask).optional(),
  status: z.enum(["cancelada", "refazer"]).optional(),
});
export type TaskPatchBody = z.infer<typeof taskPatchBodySchema>;

/**
 * POST /projects/:id/tasks/:ref/reassign: troca o agente de uma tarefa travada e a devolve à fila. `step` = índice (0) da etapa
 * (padrão: a atual). Só vale com a tarefa parada (backlog, a fazer, falhou, ou travada sem etapa rodando).
 */
export const taskReassignBodySchema = z.strictObject({
  agentId: z.string().trim().min(1).max(64),
  step: z.number().int().min(0).max(PROJECT_LIMITS.steps - 1).optional(),
});
export type TaskReassignBody = z.infer<typeof taskReassignBodySchema>;

/** POST /projects/:id/tasks/:ref/move: para outro pai (`parent: null` = direto no projeto) e/ou antes de uma irmã (`before`; null/ausente = no fim), ou um passo para cima/baixo. */
export const taskMoveBodySchema = z.strictObject({
  parent: z.union([z.string().max(12), z.null()]).optional(),
  before: z.union([z.string().max(12), z.null()]).optional(),
  step: z.enum(["up", "down"]).optional(),
  /** Sprint da folha (id); null = sem sprint. */
  sprintId: z.union([z.string().max(12), z.null()]).optional(),
});
export type TaskMoveBody = z.infer<typeof taskMoveBodySchema>;

/** POST /projects/:id/tasks/:ref/label: cria (se faltar) e liga uma etiqueta do projeto pelo nome. */
export const taskLabelBodySchema = z.strictObject({ name: z.string().trim().min(1).max(24) });
export type TaskLabelBody = z.infer<typeof taskLabelBodySchema>;

// ---------- Sprints ----------

/** POST /projects/:id/sprints: sem datas, a sprint começa onde a anterior acaba e dura uma semana; sem nome, "Sprint N". */
export const sprintCreateBodySchema = z.strictObject({
  name: z.string().trim().min(1).max(60).optional(),
  goal: z.string().trim().max(400).optional(),
  startAt: z.iso.datetime({ offset: true }).optional(),
  endAt: z.iso.datetime({ offset: true }).optional(),
  /** Põe nela as tarefas abertas que estão sem sprint (útil na primeira sprint de um projeto que já anda). */
  adoptOpen: z.boolean().optional(),
});
export type SprintCreateBody = z.infer<typeof sprintCreateBodySchema>;

/** PATCH /projects/:id/sprints/:sid: nome, objetivo (null limpa) e datas (só em sprint que ainda não fechou). */
export const sprintPatchBodySchema = z.strictObject({
  name: z.string().trim().min(1).max(60).optional(),
  goal: z.union([z.string().trim().max(400), z.null()]).optional(),
  startAt: z.iso.datetime({ offset: true }).optional(),
  endAt: z.iso.datetime({ offset: true }).optional(),
});
export type SprintPatchBody = z.infer<typeof sprintPatchBodySchema>;

/** POST /projects/:id/sprints/reorder: todos os ids, na ordem nova. */
export const sprintReorderBodySchema = z.strictObject({ ids: z.array(z.string().max(12)).min(1).max(PROJECT_LIMITS.sprints) });
export type SprintReorderBody = z.infer<typeof sprintReorderBodySchema>;
