import { HANDOFF_INTENTS, HELP_KINDS } from "@cyno/shared";
import { z } from "zod";
import { toQuestions } from "../workspace/for-you/service";
import { asSources, attachmentError } from "./sources-field";
import { approvalLimitError, describeForYouTypes } from "./approval-type-tool";
import { forYouTools } from "./for-you-tools";
import { defineTool, type McpTool } from "./protocol";
import { workerRoutineTools } from "./routine-tools";
import { scriptToolsFor } from "./script-tools";
import type { OfficeToolsDeps } from "./office-tools";
import { approvalFields, approvalItemField, questionsField, requestApprovalDescription, text, withinLimit } from "./tool-fields";

/** Conferência do "Done when" da tarefa: o agente diz, item a item, se cumpriu (o servidor só grava e mostra; não bloqueia). */
const checklistField = z
  .array(
    z.object({
      index: z.number().int().min(1).max(10).describe('The number of the item in the briefing\'s "Done when" list (starts at 1)'),
      met: z.boolean().describe("Did the deliverable meet it?"),
      note: z.string().trim().max(300).optional().describe("One short sentence in Brazilian Portuguese (why not, or what was done)"),
    }),
  )
  .max(10)
  .optional()
  .describe('Only when the briefing has a "Done when" list: check each item against what you are delivering and report it here. It does not block anything; be honest.');

/** Grava o checklist na tarefa do projeto e devolve o aviso (itens que não existem), se houver. */
function checklistNote(plans: OfficeToolsDeps["plans"], task: Parameters<NonNullable<OfficeToolsDeps["plans"]>["recordChecklist"]>[0], checklist: { index: number; met: boolean; note?: string }[] | undefined): string {
  if (!plans || !checklist?.length) return "";
  const warning = plans.recordChecklist(task, checklist);
  return warning ? ` (${warning})` : "";
}

/** Quanto o `request_help` espera a resposta do Maestro antes de mandar o agente seguir sem ela. */
export const HELP_WAIT_MS = 10 * 60_000;

/** Ferramentas dos agentes de time (get_task, ask_user, request_help, submit_result, request_approval & cia). */

export function workerTools(agentId: string, { runner, forYouTypes, forYou, plans, state, routines, media, scripts }: OfficeToolsDeps): McpTool[] {
  const currentTask = () => {
    const taskId = runner.currentTaskId(agentId);
    const task = state.read().tasks.find((candidate) => candidate.id === taskId);
    if (!task) throw new Error("You have no task in progress right now");
    return task;
  };
  return [
    defineTool({
      name: "get_task",
      description: "Shows your current task: the briefing, your step, the full output of the previous steps and who receives your result.",
      input: z.object({}),
      call: () => {
        const task = currentTask();
        return text(plans ? plans.workerView(task) : `Tarefa ${task.id}\n\n${task.prompt}`);
      },
    }),
    defineTool({
      name: "ask_user",
      description:
        'Asks the user what only they know (becomes a questionnaire in "Para você"). Only YOUR task waits; the answers arrive together in one message. Check the briefing and the Brain (search_notes) first. End the turn afterwards.',
      input: z.object({ questions: questionsField, title: z.string().trim().max(120).optional().describe("Short title") }),
      call: ({ questions, title }) => text(runner.requestInformation(agentId, title || "Perguntas sobre a tarefa", toQuestions(questions))),
    }),
    ...(forYou ? forYouTools({ actor: "agente", agentId, currentTaskId: () => currentTask().id }, { state, forYou, types: forYouTypes, ...(media ? { media: media.media } : {}) }) : []),
    ...(routines ? workerRoutineTools(agentId, { state, runner, ...routines }) : []),
    // Scripts demorados rodados pelo servidor: só para quem tem o terminal ligado (workspace E agente).
    ...scriptToolsFor(agentId, state.read().agents.find((candidate) => candidate.id === agentId) ?? {}, scripts),
    defineTool({
      name: "request_help",
      description:
        "Asks the Maestro for something no colleague can give you: another specialty, or an ACCESS you lack (kind: \"access\"). It becomes a request the Maestro decides; it does not delegate anything by itself. Your task WAITS for the answer: end the turn right after calling; the reply arrives in a later message (if the Maestro takes too long you are told to go on without it). To talk to a colleague use send_to_colleague instead.",
      input: z.object({
        what: z.string().trim().min(1).max(1000).describe("What is missing and why"),
        kind: z.enum(HELP_KINDS).optional().describe('"skill" (default): another specialty or data from another team. "access": a site, tool or permission you do not have.'),
        suggested_agent: z.string().trim().max(64).optional().describe("Who could help (agentId or name), if you know"),
      }),
      call: ({ what, kind, suggested_agent }) => {
        if (!plans) throw new Error("There is no Maestro to ask for help in this workspace");
        const task = currentTask();
        const answer = plans.help(task, what, suggested_agent, kind ?? "skill");
        runner.holdForHelp(agentId, HELP_WAIT_MS, () => plans.helpReleased(task));
        return text(answer);
      },
    }),
    defineTool({
      name: "send_to_colleague",
      description: [
        "Talks directly to a colleague of this workspace, without going through the Maestro. The server creates a new task for them (in the same project, or next to yours if yours is a simple task) (queue, quota and pace rules apply).",
        'intent "pass_on": you finished your part and the next one is theirs (put everything they need in message; you still finish YOUR step with submit_result). "ask": you need information from them; their answer comes back to you as a NEW task. "fyi": just a heads-up, no reply.',
        "Do not hand off work that is yours, and do not bounce work back and forth: the server blocks loops (hop limit, back-and-forth, open handoffs, per-project and per-hour caps). Works inside a project and in a simple task (the new task is created next to yours); the Maestro is not a destination (use request_help). If the tool returns an error, NOTHING was handed off: never tell the user you passed the work on.",
      ].join(" "),
      input: z.object({
        to: z.string().trim().min(1).max(80).describe('The colleague: id, name or "workspace/agent" (same workspace)'),
        message: z.string().trim().min(1).max(4000).describe("What they need to know or do, complete (they do not see your conversation), in Brazilian Portuguese"),
        intent: z.enum(HANDOFF_INTENTS).describe("pass_on | ask | fyi"),
        done_when: z.array(z.string().trim().min(1).max(300)).max(10).optional().describe("Checkable criteria for the colleague's new task"),
      }),
      call: ({ to, message, intent, done_when }) => {
        if (!plans) throw new Error("There are no projects in this workspace. Nothing was handed off. Do the work yourself or call request_help. Do not report a handoff.");
        return text(plans.handoff(currentTask(), { to, message, intent, ...(done_when?.length ? { doneWhen: done_when } : {}) }));
      },
    }),
    defineTool({
      name: "submit_result",
      description: "Submits the final result of your current task (in markdown, in Brazilian Portuguese). This is how the task ends.",
      input: z.object({ result: z.string().trim().min(1).max(20000).describe("The final result"), checklist: checklistField }),
      call: ({ result, checklist }) => {
        const note = checklist?.length ? checklistNote(plans, currentTask(), checklist) : "";
        return text(`${runner.deliver(agentId, result)}${note}`);
      },
    }),
    defineTool({
      name: "report_progress",
      description: "Reports how the current task is going (percent from 0 to 100 and a short sentence in Brazilian Portuguese: the user sees it).",
      input: z.object({
        percent: z.number().min(0).max(100).describe("Percentage done"),
        message: z.string().trim().min(1).max(300).describe("What you are doing now"),
      }),
      call: ({ percent, message }) => text(runner.progress(agentId, percent, message)),
    }),
    defineTool({
      name: "request_approval",
      description: [
        requestApprovalDescription(`Asks the user for a decision or to approve a text before it goes out (becomes an item in "Para você").`),
        'Several drafts for the same task (e.g. 10 comments): send them ALL in ONE call with `items` (each one its own item in "Para você"); never one call per draft. A refusal comes back with the user\'s reason: redo the draft with it and call request_approval again (the user can refuse a task twice; after that the Maestro takes over).',
        "Types in this workspace (with limits):",
        describeForYouTypes(forYouTypes.list()),
      ].join("\n"),
      input: z.object({ ...approvalFields(forYouTypes), question: approvalFields(forYouTypes).question.optional(), items: approvalItemField(forYouTypes).optional(), checklist: checklistField }),
      call: ({ question, approval_type, text: draft, where, to, mediaIds, sources, items, checklist }) => {
        if (checklist?.length) checklistNote(plans, currentTask(), checklist);
        if (items) {
          const batch = items.map((entry) => ({
            question: entry.question,
            draft: { type: entry.approval_type, text: entry.text, where: entry.where, to: entry.to, ...(entry.mediaIds?.length ? { mediaIds: entry.mediaIds } : {}), ...(entry.sources?.length ? { sources: asSources(entry.sources)! } : {}) },
          }));
          for (const [index, entry] of items.entries()) {
            const error = approvalLimitError(forYouTypes.list(), { type: entry.approval_type, text: entry.text, where: entry.where }) ?? attachmentError(media?.media, entry.mediaIds, entry.sources);
            if (error) return { text: `items[${index}]: ${error}`, isError: true };
          }
          return text(runner.requestApproval(agentId, question ?? `${items.length} drafts to approve`, undefined, undefined, batch));
        }
        if (!question) return { text: 'Send "question" (or "items" for a batch).', isError: true };
        return withinLimit(
          forYouTypes,
          { type: approval_type, text: draft, where },
          () => runner.requestApproval(agentId, question, { type: approval_type, text: draft, where, to, ...(mediaIds?.length ? { mediaIds } : {}), ...(sources?.length ? { sources: asSources(sources)! } : {}) }),
          () => attachmentError(media?.media, mediaIds, sources),
        );
      },
    }),
  ];
}
