/**
 * "Organizar" o Cérebro de uma sala: o dono pede, o Maestro lê as notas e devolve uma PROPOSTA
 * (cartão `kind: "organizacao"` no Para você). Nada muda sem o dono aprovar, e nada é apagado: o
 * que sai da frente vai para `historico/` (achado por busca).
 */

import { z } from "zod";

/** Tetos do Cérebro que a web e o server precisam concordar (os demais ficam em brain/limits.ts no server). */
export const BRAIN_RULE_LIMITS = {
  /** `_regras.md` de uma sala ou do lobby, e o arquivo de regras de um agente (texto inteiro). */
  rulesFile: 4000,
  /** Uma nota de regra (curta: entra inteira em toda tarefa). */
  ruleNote: 800,
  /** Uma regra de agente acrescentada por ferramenta ou pela proposta (uma linha). */
  agentRule: 300,
  /** Uma nota de referência (igual ao teto de `save_note`). */
  note: 6000,
} as const;

/**
 * O que a proposta pode fazer com as notas da raiz de UM Cérebro (`file` é o nome do arquivo, sem o
 * id do Cérebro):
 * - make_rule: a nota passa a ser regra (sempre carregada). Com `content`, o texto vira essa versão
 *   curta e a anterior vai para o histórico.
 * - archive: registro de etapa, estado do momento ou nota vencida: vai para o histórico.
 * - merge: várias notas viram uma só (`title` + `content`); as originais vão para o histórico.
 * - rewrite: a nota fica mais curta (`content`); a versão anterior vai para o histórico.
 * - set_rules: novo texto do `_regras.md` (a versão anterior vai para o histórico).
 * - agent_rule: uma regra que só vale para um agente (entra nas regras dele).
 */
export const BRAIN_ORGANIZE_ACTION_TYPES = ["make_rule", "archive", "merge", "rewrite", "set_rules", "agent_rule"] as const;
export type BrainOrganizeActionType = (typeof BRAIN_ORGANIZE_ACTION_TYPES)[number];

export const BRAIN_ORGANIZE_LIMITS = { actions: 80, mergeFiles: 12, reason: 200, summary: 600, title: 120, file: 200 } as const;

const fileSchema = z.string().trim().min(4).max(BRAIN_ORGANIZE_LIMITS.file);
const reasonSchema = z.string().trim().max(BRAIN_ORGANIZE_LIMITS.reason).optional();

export const brainOrganizeActionSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("make_rule"), file: fileSchema, title: z.string().max(200).optional(), content: z.string().trim().min(1).max(BRAIN_RULE_LIMITS.ruleNote).optional(), reason: reasonSchema }),
  z.strictObject({ type: z.literal("archive"), file: fileSchema, title: z.string().max(200).optional(), reason: reasonSchema }),
  z.strictObject({
    type: z.literal("merge"),
    files: z.array(fileSchema).min(2).max(BRAIN_ORGANIZE_LIMITS.mergeFiles),
    /** Títulos das notas juntadas, na mesma ordem de `files` (só para o cartão). */
    titles: z.array(z.string().max(200)).max(BRAIN_ORGANIZE_LIMITS.mergeFiles).optional(),
    title: z.string().trim().min(1).max(BRAIN_ORGANIZE_LIMITS.title),
    content: z.string().trim().min(1).max(BRAIN_RULE_LIMITS.note),
    reason: reasonSchema,
  }),
  z.strictObject({ type: z.literal("rewrite"), file: fileSchema, title: z.string().max(200).optional(), content: z.string().trim().min(1).max(BRAIN_RULE_LIMITS.note), reason: reasonSchema }),
  z.strictObject({ type: z.literal("set_rules"), content: z.string().trim().min(1).max(BRAIN_RULE_LIMITS.rulesFile), reason: reasonSchema }),
  z.strictObject({ type: z.literal("agent_rule"), agentId: z.string().min(1).max(64), agentName: z.string().max(120).optional(), text: z.string().trim().min(4).max(BRAIN_RULE_LIMITS.agentRule), reason: reasonSchema }),
]);
export type BrainOrganizeAction = z.infer<typeof brainOrganizeActionSchema>;

/** Quanto o Cérebro pesa: notas de referência na raiz e os caracteres delas (regras e histórico à parte). */
export type BrainOrganizeWeight = { notes: number; chars: number; rules: number };

export const brainOrganizeWeightSchema = z.object({ notes: z.number().int().min(0), chars: z.number().int().min(0), rules: z.number().int().min(0) });

/** A proposta guardada no cartão (`ForYouItem.organize`). */
export const brainOrganizePlanSchema = z.object({
  /** "global" ou o id da sala. */
  brainId: z.string().min(1).max(64),
  brainName: z.string().max(200),
  /** Uma ou duas frases do Maestro: o que ele viu e o que propõe. */
  summary: z.string().max(BRAIN_ORGANIZE_LIMITS.summary),
  actions: z.array(brainOrganizeActionSchema).max(BRAIN_ORGANIZE_LIMITS.actions),
  /** Como está hoje e como fica se tudo for aprovado. */
  before: brainOrganizeWeightSchema,
  after: brainOrganizeWeightSchema,
  /** Depois de aprovado: os índices de `actions` que o dono desmarcou e os que não deram para aplicar (a nota sumiu, por exemplo). */
  skipped: z.array(z.number().int().min(0)).max(BRAIN_ORGANIZE_LIMITS.actions).optional(),
  failed: z.array(z.object({ index: z.number().int().min(0), error: z.string().max(300) })).max(BRAIN_ORGANIZE_LIMITS.actions).optional(),
});
export type BrainOrganizePlan = z.infer<typeof brainOrganizePlanSchema>;

/** Decisão do cartão "organizacao", ao aprovar: os índices de `actions` que o dono NÃO quer aplicar. */
export const brainOrganizeDecisionSchema = z.strictObject({ skip: z.array(z.number().int().min(0)).max(BRAIN_ORGANIZE_LIMITS.actions).optional() });

/** POST /api/w/:ws/brains/:brainId/organize: pede a proposta ao Maestro (devolve o pedido aberto). */
export type BrainOrganizeResponse = { taskId: string };
export const brainOrganizePath = (brainId: string) => `/brains/${encodeURIComponent(brainId)}/organize`;

export const BRAIN_ORGANIZE_ACTION_LABELS: Record<BrainOrganizeActionType, string> = {
  make_rule: "Vira regra",
  archive: "Vai para o histórico",
  merge: "Juntar num resumo",
  rewrite: "Encurtar",
  set_rules: "Regras da sala",
  agent_rule: "Regra de um agente",
};

/** Notas da raiz que cada ação tira da frente ou altera (para conferir repetição e contar o depois). */
export function brainOrganizeFiles(action: BrainOrganizeAction): string[] {
  if (action.type === "merge") return action.files;
  if (action.type === "make_rule" || action.type === "archive" || action.type === "rewrite") return [action.file];
  return [];
}
