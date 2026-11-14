import { FOR_YOU_QUESTION_LIMITS } from "@cyno/shared";
import { z } from "zod";
import { APPROVAL_BATCH_MAX } from "../engines/runner/types";
import { approvalLimitError, describeForYouTypes, type ApprovalTypeDeps } from "./approval-type-tool";
import { SOURCES_RULE, sourcesField } from "./sources-field";

/** Campos e helpers que as ferramentas do Maestro (office-tools, plan-tools) e dos agentes (worker-tools) compartilham. */

export const requestId = z
  .string()
  .max(64)
  .optional()
  .describe('Request id (the one open_request returned, or the one in a "Pedido <id>" message). May be omitted only in the turn where you opened the request or in a message about it.');
/** Campos do request_approval; o `approval_type` lista os tipos do workspace (um id novo cria o tipo na hora). */
export const approvalFields = (types: ApprovalTypeDeps) => ({
  question: z.string().trim().min(1).max(300).describe("The short question for the user"),
  approval_type: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .optional()
    .describe(
      `Id of the draft's approval type. ALWAYS pick the type that matches the ACTION the user will approve (comment, post, invite, message, email...): the user's Automatic mode releases actions by type. Types in this workspace (id (name)):\n${describeForYouTypes(types.list())}\nIf one fits, use its id even if the name is not identical. Create a new type (a new id) only when none fits; "outro" is the last resort. A type that does not exist is created on the spot.`,
    ),
  text: z
    .string()
    .max(8000)
    .optional()
    .describe('Draft the user can edit before approving. It must fit the type\'s character limit (by "where"): above it, an error comes back and nothing is created.'),
  where: z.string().trim().max(200).optional().describe('Where the text will be published (e.g. "Sobre", "Legenda")'),
  to: z.string().trim().max(200).optional().describe("Who the text is for (e.g. the name on the invite)"),
  mediaIds: z
    .array(z.string().trim().regex(/^M-\d{4,}$/, 'Use media ids like "M-0001"'))
    .max(10)
    .optional()
    .describe('Media library ids to attach to the request (images/videos you made with media_render_html / media_save_file); the user sees and approves them together with the text. Ids that do not exist return an error.'),
  sources: sourcesField.optional().describe(`What the draft is based on (the user sees it on the card). ${SOURCES_RULE}`),
});

/** Um rascunho de um lote (`items` do request_approval dos agentes de time): os mesmos campos, sem aninhar `items`. */
export const approvalItemField = (types: ApprovalTypeDeps) =>
  z
    .array(z.object(approvalFields(types)))
    .min(1)
    .max(APPROVAL_BATCH_MAX)
    .describe(
      `A batch: up to ${APPROVAL_BATCH_MAX} drafts to approve in ONE call (e.g. 10 comments to publish). Each entry becomes its own item in "Para você" with its own approve/edit/refuse; they are grouped under this task and the task waits until ALL are decided (or cancelled). You get ONE message back with the result per item: approved items with their final text (use it), refused items with the user's reason (rework ONLY those that came with a reason, then call request_approval again with just the reworked ones). Every entry must carry its own text, "where" and "sources" (what THAT draft is based on: the original post, author, link). Do not use several calls in a row for several drafts, and do not put drafts of different kinds in one batch. When "items" is given, the top-level "question" (a short label for the batch) is optional and the other top-level draft fields are ignored.`,
    );

/** Descrição do request_approval (as duas versões: o que ele faz e a regra das fontes). */
export const requestApprovalDescription = (lead: string) => `${lead} Returns right away; the decision arrives in a message. ${SOURCES_RULE} ${APPROVAL_LIMIT_RULE}`;

export const text = (value: string) => ({ text: value });

/** Perguntas de um questionário (ask_user, do Maestro e dos agentes). */
export const questionsField = z
  .array(
    z.object({
      question: z.string().trim().min(1).max(FOR_YOU_QUESTION_LIMITS.text).describe("The question, short and objective"),
      options: z.array(z.string().trim().min(1).max(FOR_YOU_QUESTION_LIMITS.option)).max(FOR_YOU_QUESTION_LIMITS.options).optional().describe("Suggested options (the user may write something else)"),
      default: z.string().trim().max(FOR_YOU_QUESTION_LIMITS.option).optional().describe('What you will do if the user does not answer ("you decide")'),
    }),
  )
  .min(1)
  .max(FOR_YOU_QUESTION_LIMITS.questions);

/** Limite de caracteres que um pedido de aprovação deixa passar (é o limite do campo na plataforma). */
export const APPROVAL_LIMIT_RULE = "The text must fit the type's character limit (the real limit of the field where it will be published); above it, the request returns an error and nothing is created.";

/** Confere o limite antes de abrir o item: acima dele, erro para o modelo (o item não nasce). */
export function withinLimit(types: ApprovalTypeDeps, draft: { type?: string; text?: string; where?: string }, open: () => string, attachments?: () => string | undefined) {
  const error = approvalLimitError(types.list(), draft) ?? attachments?.();
  return error ? { text: error, isError: true } : text(open());
}

