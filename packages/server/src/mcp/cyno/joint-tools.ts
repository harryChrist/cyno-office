import { JOINT_LIMITS } from "@cyno/shared";
import { z } from "zod";
import { defineTool, type McpTool, type McpToolResult } from "../protocol";
import type { JointInput } from "../../platform/cyno/joint-coordinator";

/** O que as ferramentas de projeto conjunto pedem ao `CynoService` (cada uma lança `Error` com o motivo, em inglês). */
export type JointToolsDeps = {
  create: (input: JointInput) => { id: string; title: string; duplicate: boolean; parts: { ref: string; workspace: string; title: string; started: boolean; dependsOn: string[] }[] };
  status: (id?: string) => string;
  cancel: (id: string, reason: string) => Promise<string>;
};

const TOOL_MAX_CHARS = 4000;
const ok = (text: string): McpToolResult => ({ text: text.length > TOOL_MAX_CHARS ? `${text.slice(0, TOOL_MAX_CHARS - 1)}…` : text });
const fail = (text: string): McpToolResult => ({ text, isError: true });

async function guarded(run: () => string | Promise<string>): Promise<McpToolResult> {
  try {
    return ok(await run());
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

const jointField = z.string().trim().regex(/^J-\d{4,}$/i, 'Use the joint project id, e.g. "J-0001"').describe("The joint project id that send_joint_request returned");

/**
 * Ferramentas do Cyno para projetos que envolvem MAIS DE UM workspace (escopo "platform"), em inglês.
 * `send_joint_request` cria uma parte em cada workspace; as que dependem de outra nascem pausadas e o servidor
 * as libera sozinho quando a anterior conclui (você NÃO é acordado a cada passo). `get_joint_status` lê por código.
 */
export function jointTools(deps: JointToolsDeps): McpTool[] {
  return [
    defineTool({
      name: "send_joint_request",
      description:
        "Creates a PROJECT THAT NEEDS MORE THAN ONE WORKSPACE, with one part in each workspace, in the owner's name (e.g. 'Design makes the art, then LinkedIn posts it': part P1 in Design, part P2 in LinkedIn with depends_on [\"P1\"]). Use it when the request cannot be done by a single workspace, whether in sequence or in parallel; for ONE workspace use send_request. Parts are named P1, P2... in the order you list them. A part with no depends_on starts now (that workspace's Maestro is woken once, with the brief). A part with depends_on is created PAUSED and wakes nobody: the server releases it by itself when the parts it depends on finish, copying their media into that workspace's library and passing their summary into its briefing (the Maestro there is woken once, then). You are NOT woken at each step: the owner sees a live card in this chat, and you can read the state any time with get_joint_status. If a part fails or is cancelled, the parts that depend on it stay blocked and the owner is warned. Write a COMPLETE brief for each part in Brazilian Portuguese (goal, context the owner gave, deliverables and format, which agents of that workspace should do it, done criteria), like send_request, and say in the brief of the first part which media to save in the media library so the next part receives it. Check list_workspaces / get_workspace_card first to pick the right workspaces; if it is unclear which workspaces fit, ask the owner BEFORE creating it. Never create the same joint project twice (a repeated title is ignored).",
      input: z.object({
        title: z.string().trim().min(3).max(120).describe("Short title of the whole project, in Brazilian Portuguese"),
        brief: z.string().trim().max(JOINT_LIMITS.briefChars).optional().describe("Optional shared context for every part (the owner's goal and tone), in Brazilian Portuguese"),
        due_at: z.string().trim().max(40).optional().describe("Overall deadline (ISO 8601); each part uses it unless it has its own"),
        parts: z
          .array(
            z.object({
              workspace: z.string().trim().min(1).max(120).describe("Workspace id or name (see list_workspaces)"),
              title: z.string().trim().min(3).max(120).describe("Title of this part's deliverable, in Brazilian Portuguese"),
              brief: z.string().trim().min(40).max(JOINT_LIMITS.briefChars).describe("The complete briefing of this part: goal, context, deliverables and format, how, which agents do what, done criteria, what needs the owner's OK"),
              depends_on: z.array(z.string().trim().regex(/^P\d{1,2}$/i)).max(5).optional().describe('Parts that must finish first, by their name in this list (P1 is the first part you list), e.g. ["P1"]'),
              expects: z.string().trim().max(500).optional().describe("What this part is expected to deliver to the next ones, in Brazilian Portuguese"),
              done_when: z.array(z.string().trim().min(1).max(300)).max(10).optional().describe("Short, checkable done criteria"),
              due_at: z.string().trim().max(40).optional().describe("Deadline of this part (ISO 8601)"),
            }),
          )
          .min(2)
          .max(JOINT_LIMITS.parts)
          .describe("The parts, in order. At least 2, in at least 2 different workspaces; at least one without depends_on"),
      }),
      call: ({ title, brief, due_at, parts }) =>
        guarded(() => {
          const created = deps.create({
            title,
            ...(brief ? { brief } : {}),
            ...(due_at ? { dueAt: due_at } : {}),
            parts: parts.map((part) => ({ workspace: part.workspace, title: part.title, brief: part.brief, ...(part.depends_on?.length ? { dependsOn: part.depends_on } : {}), ...(part.expects ? { expects: part.expects } : {}), ...(part.done_when?.length ? { doneWhen: part.done_when } : {}), ...(part.due_at ? { dueAt: part.due_at } : {}) })),
          });
          if (created.duplicate) return `A joint project with this title is already open: ${created.id}. Nothing new was created. Follow it with get_joint_status(joint_id: "${created.id}").`;
          const lines = created.parts.map((part) => `- ${part.ref} → ${part.workspace}: "${part.title}" ${part.started ? "(started: its Maestro was woken once)" : `(PAUSED until ${part.dependsOn.join(" and ")} finish${part.dependsOn.length === 1 ? "es" : ""}; nobody was woken)`}`);
          return `Joint project ${created.id} "${created.title}" created.\n${lines.join("\n")}\nYou are NOT woken as it progresses: a live card in this chat shows each part, and get_joint_status(joint_id: "${created.id}") reads the state by code. Tell the owner in one or two sentences (Brazilian Portuguese, no ids) what each workspace will do and in which order, then stop.`;
        }),
    }),
    defineTool({
      name: "get_joint_status",
      description: "The state of a joint project (or, with no argument, the list of all of them), read by code: each part, its workspace, whether it is waiting for another part, its current stage, what it delivered and what it received from the previous part. It does NOT wake any Maestro or agent: use it to answer 'how is the joint project going?'.",
      input: z.object({ joint_id: jointField.optional() }),
      call: ({ joint_id }) => guarded(() => deps.status(joint_id)),
    }),
    defineTool({
      name: "cancel_joint_request",
      description: "Cancels a whole joint project: parts in progress are cancelled and the ones waiting are closed. Do it only when the owner asked or confirmed.",
      input: z.object({ joint_id: jointField, reason: z.string().trim().min(1).max(400).describe("Why, in Brazilian Portuguese (shown in the workspaces)") }),
      call: ({ joint_id, reason }) => guarded(() => deps.cancel(joint_id, reason)),
    }),
  ];
}
