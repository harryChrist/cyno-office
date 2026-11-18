import { FOR_YOU_QUESTION_LIMITS, FOR_YOU_REASON_MAX, forYouKind, lastUpdate, type ForYouItem, type ForYouKind, type ForYouStatus, type OfficeState } from "@cyno/shared";
import { z } from "zod";
import { toQuestions, type ForYouService } from "../workspace/for-you/service";
import { approvalLimitError, type ApprovalTypeDeps } from "./approval-type-tool";
import { defineTool, type McpTool } from "./protocol";
import { asSources, attachmentError, sourcesField } from "./sources-field";

/*
 * Ferramentas do "Para você" para quem pediu: listar, alterar e cancelar itens pendentes. O Maestro
 * mexe em qualquer item do workspace; um agente de time só nos que ele mesmo criou na tarefa atual.
 * Contrato em inglês (o modelo vê); o que o usuário vê continua em pt-BR.
 */

export type ForYouToolsDeps = {
  state: { read(): OfficeState };
  forYou: Pick<ForYouService, "list" | "update" | "cancel">;
  types: ApprovalTypeDeps;
  /** Biblioteca de mídia (confere os ids de `sources[].mediaIds`). */
  media?: { missing(ids: readonly string[]): string[] };
};

/** Quem chama: o Maestro (tudo) ou um agente (só os itens dele na tarefa em curso). */
export type ForYouToolsScope = { actor: "maestro" } | { actor: "agente"; agentId: string; currentTaskId: () => string };

const STATUS_IN: Record<string, ForYouStatus | "all"> = {
  pending: "pendente",
  approved: "aprovado",
  rejected: "rejeitado",
  answered: "respondido",
  cancelled: "cancelado",
  all: "all",
};
const STATUS_OUT: Record<ForYouStatus, string> = { pendente: "pending", aprovado: "approved", rejeitado: "rejected", respondido: "answered", cancelado: "cancelled" };
const KIND_IN: Record<string, ForYouKind> = { approval: "aprovacao", plan: "plano", questionnaire: "questionario", routine: "rotina", sprint: "sprint", rule: "regra", brain_cleanup: "organizacao" };
const KIND_OUT: Record<ForYouKind, string> = { aprovacao: "approval", plano: "plan", questionario: "questionnaire", rotina: "routine", sprint: "sprint", regra: "rule", organizacao: "brain_cleanup" };
const ACTOR_OUT = { maestro: "the Maestro", agente: "the agent", usuario: "the user", servidor: "the server" } as const;

const idField = z.string().trim().regex(/^A-\d{4,}$/, 'Use the short id, e.g. "A-0001"').describe('Item id, e.g. "A-0001" (see list_pending_items)');

const text = (value: string) => ({ text: value });
const fail = (value: string) => ({ text: value, isError: true });

/** Uma linha (mais as perguntas, no questionário) por item, para o modelo. */
function describeItem(item: ForYouItem, state: OfficeState): string {
  const who = state.agents.find((agent) => agent.id === item.agentId)?.name ?? item.agentId;
  const title = item.title ?? item.where ?? (item.to ? `Para ${item.to}` : item.why ?? "");
  const parts = [
    `${item.id} — ${KIND_OUT[forYouKind(item)]} — “${title}”`,
    `asked by ${who}`,
    STATUS_OUT[item.status],
    `created ${item.createdAt}`,
    item.projectId ? `request ${item.projectId}` : "",
    lastUpdate(item) ? `updated ${item.history!.filter((entry) => entry.action === "alterado").length}x` : "",
    item.rejection?.reason ? `refused: ${item.rejection.reason}` : "",
    item.groupId ? `batch ${item.groupId}` : "",
    item.status === "cancelado" ? `cancelled by ${ACTOR_OUT[item.cancelledBy ?? "maestro"]}${item.cancelReason ? `: ${item.cancelReason}` : ""}` : "",
  ].filter(Boolean);
  const lines = [`- ${parts.join(" · ")}`];
  if (forYouKind(item) === "questionario") {
    for (const [index, question] of (item.questions ?? []).entries()) {
      const answer = item.answers?.[question.id];
      const draft = answer?.skipped ? " (draft: you decide)" : answer?.text?.trim() ? ` (draft answer: ${answer.text.trim().slice(0, 120)})` : "";
      lines.push(`    ${index + 1}. ${question.text}${draft}`);
    }
  } else if (forYouKind(item) === "aprovacao") {
    if (item.why && item.why !== title) lines.push(`    question: ${item.why}`);
    if (item.text) lines.push(`    text: ${item.text.length > 200 ? `${item.text.slice(0, 200)}…` : item.text}`);
  }
  return lines.join("\n");
}

const questionsField = z
  .array(
    z.object({
      question: z.string().trim().min(1).max(FOR_YOU_QUESTION_LIMITS.text).describe("The question, short and objective"),
      options: z.array(z.string().trim().min(1).max(FOR_YOU_QUESTION_LIMITS.option)).max(FOR_YOU_QUESTION_LIMITS.options).optional().describe("Suggested options"),
      default: z.string().trim().max(FOR_YOU_QUESTION_LIMITS.option).optional().describe('What you will do if the user does not answer ("you decide")'),
    }),
  )
  .min(1)
  .max(FOR_YOU_QUESTION_LIMITS.questions);

/** list_pending_items, update_pending_item e cancel_pending_item para o Maestro ou um agente. */
export function forYouTools(scope: ForYouToolsScope, deps: ForYouToolsDeps): McpTool[] {
  const maestro = scope.actor === "maestro";
  /** Os itens que quem chama pode ver e mexer. */
  const visible = (): ForYouItem[] => {
    const items = deps.forYou.list();
    if (scope.actor === "maestro") return items;
    const taskId = scope.currentTaskId();
    return items.filter((item) => item.agentId === scope.agentId && item.taskId === taskId);
  };
  /** O item pendente que quem chama pode mexer, ou o erro (em inglês) para o modelo. */
  const editable = (id: string): ForYouItem | string => {
    const item = visible().find((candidate) => candidate.id === id);
    if (!item) {
      const exists = deps.forYou.list().some((candidate) => candidate.id === id);
      if (exists && !maestro) return `Item ${id} is not yours: you can only change items you created in your current task.`;
      return `Item ${id} does not exist (see list_pending_items).`;
    }
    if (item.status !== "pendente") return `Item ${id} is already ${STATUS_OUT[item.status]}: only pending items can be changed or cancelled.`;
    if (forYouKind(item) === "sprint") return `Item ${id} is a sprint delivery summary: only the user approves or sends it back.`;
    if (forYouKind(item) === "regra") return `Item ${id} is a rule proposed by the retrospective: only the user approves or refuses it.`;
    if (forYouKind(item) === "organizacao") return `Item ${id} is a Brain cleanup proposal: only the user approves or refuses it.`;
    if (forYouKind(item) === "plano") return `Item ${id} is a plan approval: send a new version with create_project, or stop it with resolve_task (cancel_project) / cancel_request.`;
    return item;
  };
  const scopeNote = maestro ? "Works on any item of the workspace." : "Only items you created in your current task.";

  return [
    defineTool({
      name: "list_pending_items",
      description: `Lists the items in "Para você" (what is waiting for the user): short id (A-0001), kind, title, who asked, status, creation time and, for questionnaires, the questions with the user's draft answers. ${scopeNote}`,
      input: z.object({
        status: z.enum(["pending", "approved", "rejected", "answered", "cancelled", "all"]).optional().describe("Filter by status (default: pending)"),
        kind: z.enum(["approval", "plan", "questionnaire"]).optional().describe("Filter by kind"),
      }),
      call: ({ status, kind }) => {
        const wanted = STATUS_IN[status ?? "pending"]!;
        const items = visible().filter((item) => (wanted === "all" || item.status === wanted) && (!kind || forYouKind(item) === KIND_IN[kind]));
        if (items.length === 0) return text(`No ${status && status !== "all" ? status : ""} items${kind ? ` of kind ${kind}` : ""} in Para você.`.replace(/\s+/g, " "));
        const state = deps.state.read();
        return text(items.map((item) => describeItem(item, state)).join("\n"));
      },
    }),
    defineTool({
      name: "update_pending_item",
      description: [
        'Changes an item that is STILL PENDING in "Para você" instead of sending a new one: a questionnaire (replace the questions; the user\'s draft answers to questions that stay the same are kept) or an approval (the draft text and/or the question). The user sees it marked "Atualizado" with your reason. Does not wake anyone.',
        `Use it whenever you want to change what you asked; never send a duplicate and never ask the user to "ignore" an item. ${scopeNote}`,
      ].join(" "),
      input: z.object({
        id: idField,
        title: z.string().trim().min(1).max(120).optional().describe("New short title"),
        questions: questionsField.optional().describe("Questionnaire only: the FULL new list of questions (replaces the old one)"),
        text: z.string().max(8000).optional().describe("Approval only: the new draft text (must fit the type's character limit)"),
        question: z.string().trim().min(1).max(300).optional().describe("Approval only: the new short question for the user"),
        sources: sourcesField.optional().describe("Approval only: the FULL new list of sources (what the draft is based on: original post text, author, link, summary, profile…); replaces the old list. Send [] to clear."),
        reason: z.string().trim().max(FOR_YOU_REASON_MAX).optional().describe("Why it changed, in Brazilian Portuguese (the user sees it)"),
      }),
      call: async ({ id, title, questions, text: draft, question, sources, reason }) => {
        const item = editable(id);
        if (typeof item === "string") return fail(item);
        const kind = forYouKind(item);
        if (!title && !questions && draft === undefined && !question && sources === undefined) return fail("Nothing to change: pass title, questions, text, question or sources.");
        if (questions && kind !== "questionario") return fail(`Item ${id} is not a questionnaire: "questions" only applies to questionnaires (use text/question for approvals).`);
        if (sources !== undefined && kind !== "aprovacao") return fail(`Item ${id} is not an approval: "sources" only applies to approvals.`);
        const badMedia = attachmentError(deps.media, undefined, sources);
        if (badMedia) return fail(badMedia);
        if ((draft !== undefined || question) && kind !== "aprovacao") return fail(`Item ${id} is a questionnaire: change it with "questions" (and "title").`);
        if (draft !== undefined && !draft.trim()) return fail("The text cannot be empty.");
        if (draft !== undefined) {
          const over = approvalLimitError(deps.types.list(), { type: item.type, text: draft, where: item.where });
          if (over) return fail(over.replace("call request_approval again", "call update_pending_item again"));
        }
        const parsed = questions ? toQuestions(questions) : undefined;
        if (parsed && parsed.length === 0) return fail("Send at least one question.");
        const before = Object.keys(item.answers ?? {}).length;
        const updated = await deps.forYou.update(id, { ...(title ? { title } : {}), ...(parsed ? { questions: parsed } : {}), ...(draft !== undefined ? { text: draft } : {}), ...(question ? { question } : {}), ...(sources !== undefined ? { sources: asSources(sources)! } : {}), ...(reason ? { reason } : {}) }, maestro ? "maestro" : "agente");
        const kept = parsed ? ` ${Object.keys(updated.answers ?? {}).length} of ${before} draft answer(s) kept.` : "";
        return text(`Item ${id} updated.${kept} The user sees it marked as updated in Para você; it is still the same item (do not send another one). Say so in one sentence.`);
      },
    }),
    defineTool({
      name: "cancel_pending_item",
      description: [
        'Withdraws a PENDING item from "Para você" (e.g. a duplicate, or something no longer needed): it moves to "Cancelados" with your reason. If it was holding an agent\'s task, that task continues without the answer. Does not wake anyone.',
        scopeNote,
      ].join(" "),
      input: z.object({ id: idField, reason: z.string().trim().min(1).max(FOR_YOU_REASON_MAX).describe("Why, in Brazilian Portuguese (the user sees it)") }),
      call: async ({ id, reason }) => {
        const item = editable(id);
        if (typeof item === "string") return fail(item);
        const cancelled = await deps.forYou.cancel(id, { by: maestro ? "maestro" : "agente", reason });
        const state = deps.state.read();
        const task = cancelled.taskId ? state.tasks.find((candidate) => candidate.id === cancelled.taskId) : undefined;
        const ownRequest = task !== undefined && task.agentId === cancelled.agentId && task.projectId === undefined;
        const follow = !maestro
          ? " Your task is no longer waiting for it: continue in this turn and finish with submit_result."
          : ownRequest && task.status === "waiting_approval" && task.waiting
            ? ` Request ${task.id} now waits for the user (nothing else pending): send a corrected item, continue it, or close it (complete_request / cancel_request).`
            : !ownRequest && task?.status === "in_progress"
              ? " The agent's task that was waiting for it continues without the answer."
              : "";
        return text(`Item ${id} cancelled (moved to Cancelados).${follow}`);
      },
    }),
  ];
}
