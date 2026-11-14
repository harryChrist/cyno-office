import { PROJECT_BRIEF_MAX, PROJECT_INPUT_PRIORITIES } from "@cyno/shared";
import { z } from "zod";
import { defineTool, type McpTool, type McpToolResult } from "../protocol";

/** O que as ferramentas de pedidos do Cyno pedem ao `CynoService` (cada uma lança `Error` com o motivo, em inglês). */
export type RequestToolsDeps = {
  sendRequest: (input: SendRequestInput) => { projectId: string; workspace: string; workspaceName: string; address: string; duplicate: boolean; note?: string };
  requestStatus: (ref: { requestId?: string; workspace?: string }) => string;
  listSent: (filter: { workspace?: string; open?: boolean }) => string;
  messageAgent: (input: { workspace: string; agent: string; message: string }) => Promise<string>;
  cancelRequest: (requestId: string, reason: string) => Promise<string>;
  updateRequest: (requestId: string, patch: UpdateRequestInput) => Promise<string>;
  answerMaestro: (askId: string, message: string) => string;
};

export type SendRequestInput = {
  workspace: string;
  title: string;
  brief: string;
  kind?: "project" | "task";
  priority?: (typeof PROJECT_INPUT_PRIORITIES)[number];
  dueAt?: string;
  startAt?: string;
  doneWhen?: string[];
  suggestedAgents?: string[];
  /** Este pedido é uma parte de um projeto conjunto (só o coordenador passa; o Cyno não). */
  joint?: { id: string; part: string; dependsOn: string[] };
};

export type UpdateRequestInput = { priority?: (typeof PROJECT_INPUT_PRIORITIES)[number]; dueAt?: string | null; startAt?: string | null; paused?: boolean };

const TOOL_MAX_CHARS = 4000;
const ok = (text: string): McpToolResult => ({ text: text.length > TOOL_MAX_CHARS ? `${text.slice(0, TOOL_MAX_CHARS - 1)}…` : text });
const fail = (text: string): McpToolResult => ({ text, isError: true });

/** Roda a chamada e devolve o erro dela como resultado (o modelo vê o motivo). */
async function guarded(run: () => string | Promise<string>): Promise<McpToolResult> {
  try {
    return ok(await run());
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

const workspaceField = z.string().trim().min(1).max(120).describe("Workspace id or name (see list_workspaces)");
const requestField = z.string().trim().min(1).max(80).describe("The request id (the project id that send_request returned)");

/**
 * Ferramentas do Cyno para MANDAR e ACOMPANHAR trabalho nos workspaces (escopo "platform"), em inglês.
 * `send_request` é o caminho normal (o Maestro do workspace distribui); `message_agent` é a exceção.
 * Acompanhar (`get_request_status`, `list_sent_requests`) é leitura por código: não acorda ninguém.
 */
export function requestTools(deps: RequestToolsDeps): McpTool[] {
  return [
    defineTool({
      name: "send_request",
      description:
        "Sends a piece of work to the Maestro of ONE workspace, in the owner's name. This is the NORMAL way to get anything done in a workspace. Pick the workspace from the cards (list_workspaces / get_workspace_card). Write a COMPLETE briefing in Brazilian Portuguese: the goal, the context the owner gave, the deliverables and format, how to do it, which agents of that team should do each part (suggested_agents; see get_workspace_card), the done criteria, deadline/priority and what needs the owner's OK. The Maestro will NOT re-ask the owner what is already in the briefing: it only distributes the work to its team, so everything it needs must be in `brief`. It creates the request and its project in the workspace (origin: Cyno) and wakes that Maestro once (this costs the workspace's subscription). Returns the request id to follow with get_request_status. Never call it twice for the same thing (a repeated title is ignored). If it is unclear WHICH workspace is the right one, ask the owner first; if the workspace is clear, send directly.",
      input: z.object({
        workspace: workspaceField,
        title: z.string().trim().min(3).max(120).describe("Short title of the deliverable, in Brazilian Portuguese"),
        brief: z.string().trim().min(40).max(PROJECT_BRIEF_MAX).describe("The complete briefing: goal, context, deliverables, how, which agents do what, done criteria, deadline, what needs the owner's OK"),
        kind: z.enum(["project", "task"]).optional().describe('"project" (several parts, more than one agent, steps in sequence, days) or "task" (one agent, one deliverable). Omit when truly unsure and the Maestro decides when distributing'),
        priority: z.enum(PROJECT_INPUT_PRIORITIES).optional().describe("high, normal (default) or low"),
        due_at: z.string().trim().max(40).optional().describe('Deadline (ISO 8601, e.g. "2026-11-20T18:00:00-03:00" or "2026-11-20")'),
        start_at: z.string().trim().max(40).optional().describe("Do not start before this date (ISO 8601)"),
        done_when: z.array(z.string().trim().min(1).max(300)).max(10).optional().describe("Short, checkable done criteria"),
        suggested_agents: z.array(z.string().trim().min(1).max(80)).max(8).optional().describe("Names of agents of that workspace's team that fit each part (the Maestro may adjust)"),
      }),
      call: ({ workspace, title, brief, kind, priority, due_at, start_at, done_when, suggested_agents }) =>
        guarded(() => {
          const sent = deps.sendRequest({
            workspace,
            title,
            brief,
            ...(kind ? { kind } : {}),
            ...(priority ? { priority } : {}),
            ...(due_at ? { dueAt: due_at } : {}),
            ...(start_at ? { startAt: start_at } : {}),
            ...(done_when?.length ? { doneWhen: done_when } : {}),
            ...(suggested_agents?.length ? { suggestedAgents: suggested_agents } : {}),
          });
          return sent.duplicate
            ? `An open request with this title already exists in ${sent.workspace}: ${sent.projectId}. Nothing new was sent. Follow it with get_request_status(request_id: "${sent.projectId}").`
            : `Sent to the Maestro of ${sent.workspaceName} (${sent.address}). Request id: ${sent.projectId}. The Maestro distributes the work to its team; you are NOT woken when it finishes: the owner sees it on the page and you can read the state any time with get_request_status(request_id: "${sent.projectId}"). Tell the owner in one or two sentences what you sent and to whom (in Brazilian Portuguese).${sent.note ? ` Note: ${sent.note}` : ""}`;
        }),
    }),
    defineTool({
      name: "get_request_status",
      description:
        "The state of a request you sent (or of all open ones in a workspace), read by code from the project: tasks and steps with who is doing what, blockers, what is waiting for the owner, and deliveries with links. It does NOT wake the Maestro or any agent: use it to answer 'how is that going?'. With no arguments it lists every open request you sent.",
      input: z.object({ request_id: requestField.optional(), workspace: workspaceField.optional() }),
      call: ({ request_id, workspace }) => guarded(() => deps.requestStatus({ ...(request_id ? { requestId: request_id } : {}), ...(workspace ? { workspace } : {}) })),
    }),
    defineTool({
      name: "list_sent_requests",
      description: "Lists the requests you sent to the workspaces (newest first) with the current state of each, by code (nobody is woken). Use open_only to hide the finished ones.",
      input: z.object({ workspace: workspaceField.optional(), open_only: z.boolean().optional() }),
      call: ({ workspace, open_only }) => guarded(() => deps.listSent({ ...(workspace ? { workspace } : {}), ...(open_only ? { open: true } : {}) })),
    }),
    defineTool({
      name: "message_agent",
      description:
        "Talks directly to ONE agent of a workspace (or to its Maestro with agent: \"maestro\"), outside any request. This is the EXCEPTION: the normal way to get work done is send_request, which gives the Maestro the full briefing. Use message_agent only for a quick question or a nudge to someone you already know is working. The message goes to the agent's chat marked as coming from you in the owner's name; no task is created and the reply is NOT returned to you (the owner sees it in the workspace). Limited to a few messages per hour.",
      input: z.object({ workspace: workspaceField, agent: z.string().trim().min(1).max(80).describe('Agent id or name, or "maestro"'), message: z.string().trim().min(1).max(2000).describe("The message, in Brazilian Portuguese") }),
      call: ({ workspace, agent, message }) => guarded(() => deps.messageAgent({ workspace, agent, message })),
    }),
    defineTool({
      name: "update_request",
      description: "Changes a request you sent: priority, deadline, start date, or pause/resume it (paused work does not start new steps; a step already running finishes). Only for requests you sent. Use null to clear a date.",
      input: z.object({
        request_id: requestField,
        priority: z.enum(PROJECT_INPUT_PRIORITIES).optional(),
        due_at: z.string().trim().max(40).nullable().optional(),
        start_at: z.string().trim().max(40).nullable().optional(),
        paused: z.boolean().optional().describe("true to pause, false to resume"),
      }),
      call: ({ request_id, priority, due_at, start_at, paused }) =>
        guarded(() => deps.updateRequest(request_id, { ...(priority ? { priority } : {}), ...(due_at !== undefined ? { dueAt: due_at } : {}), ...(start_at !== undefined ? { startAt: start_at } : {}), ...(paused !== undefined ? { paused } : {}) })),
    }),
    defineTool({
      name: "cancel_request",
      description: "Cancels a request you sent: running steps stop and its items waiting for the owner are withdrawn. Only for requests you sent; for work the owner or the Maestro started, tell the owner. Do it only when the owner asked or confirmed.",
      input: z.object({ request_id: requestField, reason: z.string().trim().min(1).max(400).describe("Why, in Brazilian Portuguese (shown in the workspace)") }),
      call: ({ request_id, reason }) => guarded(() => deps.cancelRequest(request_id, reason)),
    }),
    defineTool({
      name: "answer_maestro",
      description:
        "Answers a question a Maestro asked you with ask_cyno (the message tells the ask id, like A-0001). You answer ONCE per question: the answer goes to that Maestro as a message and the question closes; if it needs more it opens another one. If the answer needs action in another workspace, do it first (send_request / message_agent), then answer saying what you did. Be concrete and short.",
      input: z.object({ ask_id: z.string().trim().regex(/^A-\d{4,}$/).describe("The ask id, e.g. A-0001"), message: z.string().trim().min(1).max(3500).describe("The answer, in Brazilian Portuguese") }),
      call: ({ ask_id, message }) => guarded(() => deps.answerMaestro(ask_id, message)),
    }),
  ];
}
