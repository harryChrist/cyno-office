import { BRAIN_RULE_LIMITS, type OfficeState } from "@cyno/shared";
import { z } from "zod";
import { brainViewer, NOTE_INPUT_KINDS, type BrainAccess } from "../workspace/brain/access";
import { BRAIN_LIMITS } from "../workspace/brain/limits";
import { defineTool, type McpTool } from "./protocol";

export type BrainToolsDeps = {
  state: { read(): OfficeState };
  access: BrainAccess;
};

const notePath = z.string().trim().min(3).max(300);
const ruleText = z.string().trim().min(4).max(BRAIN_RULE_LIMITS.agentRule).describe("One short imperative sentence in Brazilian Portuguese");
const AGENT_RULE_DESCRIPTION =
  "Records a standing rule that applies to ONE agent only (it is loaded in every task of that agent and of nobody else). Use it when the user tells a specific agent how to always work. One short imperative sentence in Brazilian Portuguese.";

/**
 * Ferramentas do Cérebro (Maestro e agentes de time): buscar, ler e salvar notas, com as regras de
 * visibilidade do quarto do agente (veja BrainAccess). O Maestro ganha `brain` no save_note.
 */
export function brainTools(agentId: string, deps: BrainToolsDeps): McpTool[] {
  const viewer = () => {
    const found = brainViewer(deps.state.read(), agentId);
    if (!found) throw new Error("You are not in a room (no team): the Brain is not available");
    return found;
  };
  const maestro = brainViewer(deps.state.read(), agentId)?.maestro === true;
  const kinds = z.enum(NOTE_INPUT_KINDS).describe(
    "decision (what was decided and why), doc (how-to / reference), learning, preference (the user's), rule (a standing instruction the user gave the team: always loaded in every task of this room; keep it to one or two lines) or other",
  );
  const saveFields = {
    title: z.string().trim().min(1).max(120).describe("Short title (becomes the file name)"),
    content: z
      .string()
      .trim()
      .min(1)
      .max(BRAIN_LIMITS.saveFixed)
      .describe(
        `The text in markdown, short and direct, in Brazilian Portuguese (up to ${BRAIN_LIMITS.saveNote} characters for a note; ${BRAIN_RULE_LIMITS.ruleNote} for a rule; ${BRAIN_LIMITS.saveFixed} for a pinned one). Use [[links]] to other notes.`,
      ),
    kind: kinds,
    tags: z.array(z.string().trim().min(1).max(40)).max(8).optional().describe("Tags (without #)"),
    replace: notePath.optional().describe('Path of an existing note whose content you want to replace (e.g. "projetox/_briefing.md") instead of creating another'),
  };
  return [
    defineTool({
      name: "search_notes",
      description:
        "Searches the Brain you can see (rules, briefing, index, notes and the task history of past tasks), ignoring accents and case. The task context only brings the rules and the briefing plus the titles of the other notes; use this to find anything else. Returns titles, paths and excerpts; read a note with read_note.",
      input: z.object({
        query: z.string().trim().min(1).max(300).describe("Words from the subject"),
        limit: z.number().int().min(1).max(BRAIN_LIMITS.searchMax).optional().describe(`How many results (default ${BRAIN_LIMITS.searchDefault})`),
      }),
      call: async ({ query, limit }) => ({ text: await deps.access.search(viewer(), query, limit) }),
    }),
    defineTool({
      name: "read_note",
      description: `Reads a whole Brain note by path ("<brain>/<file>.md", as listed by title in the context or returned by search_notes), up to ${BRAIN_LIMITS.readNote} characters. Read the notes that are useful for the task instead of guessing from the title.`,
      input: z.object({ path: notePath.describe('E.g. "projetox/decisoes-tecnicas.md" or "projetox/historico/2026-11-07-090503-tela.md"') }),
      call: async ({ path }) => ({ text: await deps.access.read(viewer(), path) }),
    }),
    maestro
      ? defineTool({
          name: "save_note",
          description:
            "Saves a short note to the Brain (decision, doc, learning, preference, rule) or updates an existing one (`replace`), including the `_briefing`, the `_indice` and the `_regras` of a room or of the global Brain. Only what will help FUTURE tasks: not a report of what was done (the task result already goes to the history). Search first and update an existing note with `replace`. Only rules and the briefing are loaded in every task; other notes are read with read_note. A new note is added to `_indice` automatically.",
          input: z.object({ ...saveFields, brain: z.string().trim().min(1).max(64).optional().describe('Room id or "global" (default: the Maestro\'s room)') }),
          call: async (input) => ({ text: await deps.access.save(viewer(), input) }),
        })
      : defineTool({
          name: "save_note",
          description:
            "Saves a short note to YOUR room's Brain (decision, doc, learning, preference, rule) or updates an existing one (`replace`), including the room's `_briefing` and `_indice`. Only what will help FUTURE tasks (how something works, a decision and why, a user preference), not the deliverable and not a report of what you did (the task result already goes to the history). Search first and update an existing note with `replace`. Only rules and the briefing are loaded in every task; other notes are read with read_note. A new note is added to `_indice` automatically.",
          input: z.object(saveFields),
          call: async (input) => ({ text: await deps.access.save(viewer(), input) }),
        }),
    maestro
      ? defineTool({
          name: "save_agent_rule",
          description: `${AGENT_RULE_DESCRIPTION} Pass \`agent\`: the id or exact name of any agent in the workspace (your own id if the rule is for you).`,
          input: z.object({ text: ruleText, agent: z.string().trim().min(1).max(120).describe("Agent id or exact name") }),
          call: async ({ text, agent }) => ({ text: await deps.access.saveAgentRule(viewer(), text, agent) }),
        })
      : defineTool({
          name: "save_agent_rule",
          description: `${AGENT_RULE_DESCRIPTION} It is always saved for YOU.`,
          input: z.object({ text: ruleText }),
          call: async ({ text }) => ({ text: await deps.access.saveAgentRule(viewer(), text) }),
        }),
  ];
}
