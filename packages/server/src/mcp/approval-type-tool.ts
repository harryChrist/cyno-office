import {
  FOR_YOU_TYPE_COLORS,
  FOR_YOU_TYPE_ICONS,
  FOR_YOU_TYPE_NAME_MAX,
  formatCharCount,
  forYouLimitsText,
  forYouOverLimit,
  forYouTypeForRequest,
  forYouTypeLimitsSchema,
  type ForYouTypeBehavior,
  type ForYouTypeDef,
} from "@cyno/shared";
import { z } from "zod";
import type { ForYouTypesService } from "../workspace/for-you/types-service";
import { defineTool, type McpTool } from "./protocol";

export type ApprovalTypeDeps = Pick<ForYouTypesService, "define" | "list">;

/** Comportamento como o Maestro manda pelo MCP (em inglês) -> o gravado no tipo. */
const APPROVAL_BEHAVIORS = ["text", "question"] as const;
const BEHAVIOR_FROM_INPUT: Record<(typeof APPROVAL_BEHAVIORS)[number], ForYouTypeBehavior> = { text: "texto", question: "pergunta" };

/** "- convite (Convite): Convite de conexão… [limit 200 characters; use "to"]" — uma linha por tipo, para o `approval_type` (em inglês: vai na descrição da ferramenta). */
export function describeForYouTypes(types: readonly ForYouTypeDef[]): string {
  return types
    .map((type) => {
      const extras = [
        type.behavior === "pergunta" ? "the user answers" : "",
        type.limits?.default ? `limit ${formatCharCount(type.limits.default)} characters` : "",
        type.limits?.byWhere?.length
          ? `limits by "where": ${type.limits.byWhere.map((rule) => `${rule.match}=${formatCharCount(rule.max)}`).join(", ")} characters`
          : "",
        type.fields?.to ? 'use "to"' : "",
        type.fields?.where ? 'use "where"' : "",
      ].filter(Boolean);
      return `- ${type.id} (${type.name}): ${type.description || "no description"}${extras.length ? ` [${extras.join("; ")}]` : ""}`;
    })
    .join("\n");
}

/**
 * Erro (em inglês, o modelo vê) quando o rascunho do request_approval passa do limite do tipo (pelo
 * "where"); null = cabe. O limite é o do campo de verdade na plataforma onde o texto vai sair.
 */
export function approvalLimitError(types: readonly ForYouTypeDef[], draft: { type?: string; text?: string; where?: string }): string | null {
  if (!draft.text) return null;
  const type = forYouTypeForRequest(types, draft.type);
  const over = forYouOverLimit(type, draft.text, draft.where);
  if (!type || !over) return null;
  const where = draft.where?.trim() ? ` (where: ${draft.where.trim()})` : "";
  return `The text is over the limit of "${type.name}"${where}: ${formatCharCount(over.length)} of ${formatCharCount(over.limit.max)} characters. Shorten it and call request_approval again.`;
}

/** `approval_type: "reels"` / `tipo: "reels"` / `tipo reels` no texto do pedido (só vale o id de um tipo que existe). */
export function mentionedForYouType(types: readonly ForYouTypeDef[], text: string): string | undefined {
  for (const match of text.matchAll(/\b(?:approval_type|tipo)\s*[:=]?\s*["“'`]?([a-z0-9][a-z0-9-]*)/gi)) {
    const id = match[1]!.toLowerCase();
    if (types.some((type) => type.id === id)) return id;
  }
  return undefined;
}

/**
 * Bloco que vai no fim do pedido delegado quando o resultado vai para aprovação: nome, descrição
 * e limites do tipo, para o agente escrever já dentro do limite.
 */
export function delegationTypeNote(types: readonly ForYouTypeDef[], tipo: string): string {
  const type = forYouTypeForRequest(types, tipo);
  if (!type) {
    return `## Aprovação\nO resultado vai para aprovação com approval_type: "${tipo.trim()}" (tipo novo, ainda sem limite de caracteres). Use esse tipo no request_approval.`;
  }
  const limits = forYouLimitsText(type.limits);
  return [
    "## Aprovação",
    `O resultado vai para aprovação como "${type.name}" (approval_type: "${type.id}"): ${type.description || "sem descrição"}`,
    limits ? `${limits} É o limite real do campo na plataforma: o texto precisa caber (acima dele, o request_approval volta com erro).` : "Sem limite de caracteres.",
    `Use request_approval com approval_type: "${type.id}".`,
  ].join("\n");
}

const RESULT_LINES: Record<"created" | "updated" | "kept", (type: ForYouTypeDef) => string> = {
  created: (type) => `Type "${type.name}" created (id "${type.id}"). Use approval_type: "${type.id}" in request_approval.`,
  updated: (type) => `Type "${type.name}" (id "${type.id}") already existed: updated the description and what you sent.`,
  kept: (type) => `Type "${type.name}" (id "${type.id}") already exists and was created by the user: left as is. Use approval_type: "${type.id}".`,
};

/**
 * `set_approval_type` (só o Maestro): cria um tipo de aprovação do "Para você" quando o
 * projeto precisa (ex.: "Reels"). O usuário é avisado e pode editar depois.
 */
export function approvalTypeTool(types: ApprovalTypeDeps): McpTool {
  return defineTool({
    name: "set_approval_type",
    description: [
      'Creates (or refines) a "Para você" approval type for this workspace, when the project needs one that does not exist yet (e.g. "Reels", "Newsletter"). Agents pass its id as `approval_type` in request_approval.',
      "Current types:",
      describeForYouTypes(types.list()),
    ].join("\n"),
    input: z.object({
      name: z.string().trim().min(1).max(FOR_YOU_TYPE_NAME_MAX).describe("Short type name, shown to the user (e.g. Reels)"),
      description: z.string().trim().min(1).max(500).describe("When to use this type (it is what the agents read to choose)"),
      behavior: z.enum(APPROVAL_BEHAVIORS).optional().describe('"text" (the user edits and approves a text; default) or "question" (the user answers)'),
      limit: z.number().int().min(1).max(100_000).optional().describe("Character limit of the text"),
      limits_by_where: forYouTypeLimitsSchema.shape.byWhere.describe('Limits by the item\'s "where": { match (start of "where"), max, name }'),
      uses_to: z.boolean().optional().describe('The item says who it is for ("to")'),
      uses_where: z.boolean().optional().describe('The item says where the text goes ("where")'),
      icon: z.string().max(40).optional().describe(`Icon hint: ${FOR_YOU_TYPE_ICONS.join(", ")}`),
      color: z.string().max(20).optional().describe(`Color hint: ${FOR_YOU_TYPE_COLORS.join(", ")}`),
    }),
    call: ({ name, description, behavior, limit, limits_by_where, uses_to, uses_where, icon, color }) => {
      const limits = limit !== undefined || limits_by_where ? { ...(limit !== undefined ? { default: limit } : {}), ...(limits_by_where ? { byWhere: limits_by_where } : {}) } : undefined;
      const fields = uses_to !== undefined || uses_where !== undefined ? { ...(uses_to !== undefined ? { to: uses_to } : {}), ...(uses_where !== undefined ? { where: uses_where } : {}) } : undefined;
      const result = types.define({ name, description, behavior: behavior ? BEHAVIOR_FROM_INPUT[behavior] : undefined, limits, fields, icon, color });
      return { text: RESULT_LINES[result.outcome](result.type) };
    },
  });
}
