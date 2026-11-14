import type { OfficeState } from "@cyno/shared";
import { z } from "zod";
import { brainViewer, NOTE_INPUT_KINDS, type BrainAccess } from "../workspace/brain/access";
import { BRAIN_LIMITS } from "../workspace/brain/limits";
import { defineTool, type McpTool } from "./protocol";

export type BrainToolsDeps = {
  state: { read(): OfficeState };
  access: BrainAccess;
};

const notePath = z.string().trim().min(3).max(300);

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
  const kinds = z.enum(NOTE_INPUT_KINDS).describe("decision (what was decided and why), doc (how-to / reference), learning, preference (the user's) or other");
  const saveFields = {
    title: z.string().trim().min(1).max(120).describe("Short title (becomes the file name)"),
    content: z
      .string()
      .trim()
      .min(1)
      .max(BRAIN_LIMITS.saveFixed)
      .describe(`The text in markdown, short and direct, in Brazilian Portuguese (up to ${BRAIN_LIMITS.saveNote} characters for a note; ${BRAIN_LIMITS.saveFixed} for a pinned one). Use [[links]] to other notes.`),
    kind: kinds,
    tags: z.array(z.string().trim().min(1).max(40)).max(8).optional().describe("Tags (without #)"),
    replace: notePath.optional().describe('Path of an existing note whose content you want to replace (e.g. "projetox/_briefing.md") instead of creating another'),
  };
  return [
    defineTool({
      name: "search_notes",
      description: "Searches the Brain you can see (rules, briefing, index, notes and the task history), ignoring accents and case. Returns titles, paths and excerpts; read a note with read_note.",
      input: z.object({
        query: z.string().trim().min(1).max(300).describe("Words from the subject"),
        limit: z.number().int().min(1).max(BRAIN_LIMITS.searchMax).optional().describe(`How many results (default ${BRAIN_LIMITS.searchDefault})`),
      }),
      call: async ({ query, limit }) => ({ text: await deps.access.search(viewer(), query, limit) }),
    }),
    defineTool({
      name: "read_note",
      description: `Reads a whole Brain note by path ("<brain>/<file>.md", as shown in the context and in the search), up to ${BRAIN_LIMITS.readNote} characters.`,
      input: z.object({ path: notePath.describe('E.g. "projetox/decisoes-tecnicas.md" or "projetox/historico/2026-11-07-090503-tela.md"') }),
      call: async ({ path }) => ({ text: await deps.access.read(viewer(), path) }),
    }),
    maestro
      ? defineTool({
          name: "save_note",
          description:
            "Saves a short note to the Brain (decision, doc, learning, preference) or updates an existing one (`replace`), including the `_briefing`, the `_indice` and the `_regras` of a room or of the global Brain. A new note is added to `_indice` automatically.",
          input: z.object({ ...saveFields, brain: z.string().trim().min(1).max(64).optional().describe('Room id or "global" (default: the Maestro\'s room)') }),
          call: async (input) => ({ text: await deps.access.save(viewer(), input) }),
        })
      : defineTool({
          name: "save_note",
          description:
            "Saves a short note to YOUR room's Brain (decision, doc, learning, preference) or updates an existing one (`replace`), including the room's `_briefing` and `_indice`. Durable facts, not the deliverable. A new note is added to `_indice` automatically.",
          input: z.object(saveFields),
          call: async (input) => ({ text: await deps.access.save(viewer(), input) }),
        }),
  ];
}
