import { BRAIN_ORGANIZE_ACTION_TYPES, BRAIN_ORGANIZE_LIMITS, BRAIN_RULE_LIMITS, type BrainOrganizeAction } from "@cyno/shared";
import { z } from "zod";
import { defineTool, type McpTool } from "./protocol";

const DESCRIPTION =
  "Proposes ONE cleanup of a Brain (a room's Brain or \"global\") to the owner. Only works while the owner's \"Organizar\" request for that Brain is open (it arrives as a request with the inventory of the Brain). Call it exactly ONCE with ALL the actions and a short summary: it opens ONE proposal card in Aprovações. Nothing is applied without the owner's approval (they can untick actions), nothing is ever deleted (archived notes go to the Brain's history, still found by search_notes), and you cannot approve it yourself. Actions: make_rule (note becomes an always-loaded rule; pass `content` with one to three short lines when the note is long), archive (finished-step reports and stale state go to the history), merge (`paths` of two or more notes become one new note with `title` and `content`), rewrite (shorten a bloated note with `content`), set_rules (new text for the Brain's `_regras`), agent_rule (`agent` + `text`: a rule that concerns only one agent). A note can appear in only one action. Texts in Brazilian Portuguese.";

const actionSchema = z.object({
  action: z.enum(BRAIN_ORGANIZE_ACTION_TYPES).describe("What to do with the note(s)"),
  path: z.string().trim().max(BRAIN_ORGANIZE_LIMITS.file).optional().describe("make_rule, archive, rewrite: the note, as \"<brain>/<file>.md\" from the inventory"),
  paths: z.array(z.string().trim().max(BRAIN_ORGANIZE_LIMITS.file)).max(BRAIN_ORGANIZE_LIMITS.mergeFiles).optional().describe("merge: two or more notes to join into one"),
  title: z.string().trim().max(BRAIN_ORGANIZE_LIMITS.title).optional().describe("merge: the title of the new note"),
  content: z.string().max(BRAIN_RULE_LIMITS.note).optional().describe(`make_rule: the short rule (up to ${BRAIN_RULE_LIMITS.ruleNote} chars); merge/rewrite: the new text (up to ${BRAIN_RULE_LIMITS.note}); set_rules: the whole new rules text (up to ${BRAIN_RULE_LIMITS.rulesFile})`),
  agent: z.string().trim().max(120).optional().describe("agent_rule: id or exact name of the agent"),
  text: z.string().max(500).optional().describe(`agent_rule: the rule, one short imperative sentence (up to ${BRAIN_RULE_LIMITS.agentRule} chars)`),
  reason: z.string().max(400).optional().describe(`Why, in one short sentence (shown to the owner; up to ${BRAIN_ORGANIZE_LIMITS.reason} chars)`),
});
export type BrainCleanupActionInput = z.infer<typeof actionSchema>;

export type BrainOrganizeToolsDeps = { propose: (input: { brain: string; summary: string; actions: BrainOrganizeAction[] }) => Promise<string> };

/** Mapeia as ações da ferramenta para a união compartilhada, dizendo (em inglês, com o número da ação) o campo que falta. */
export function mapCleanupActions(inputs: readonly BrainCleanupActionInput[]): BrainOrganizeAction[] {
  return inputs.map((input, index): BrainOrganizeAction => {
    const label = `Action ${index + 1} (${input.action})`;
    const need = (field: string, value: unknown): void => {
      if (value === undefined || value === "" || (Array.isArray(value) && value.length === 0)) throw new Error(`${label}: \`${field}\` is required.`);
    };
    const reason = input.reason?.trim() ? { reason: input.reason.trim().slice(0, BRAIN_ORGANIZE_LIMITS.reason) } : {};
    switch (input.action) {
      case "make_rule":
        need("path", input.path);
        return { type: "make_rule", file: input.path!, ...(input.content?.trim() ? { content: input.content.trim() } : {}), ...reason };
      case "archive":
        need("path", input.path);
        return { type: "archive", file: input.path!, ...reason };
      case "rewrite":
        need("path", input.path);
        need("content", input.content?.trim());
        return { type: "rewrite", file: input.path!, content: input.content!.trim(), ...reason };
      case "merge":
        need("paths", input.paths);
        need("title", input.title);
        need("content", input.content?.trim());
        if (input.paths!.length < 2) throw new Error(`${label}: \`paths\` needs at least two notes (to change one note use rewrite).`);
        return { type: "merge", files: input.paths!, title: input.title!, content: input.content!.trim(), ...reason };
      case "set_rules":
        need("content", input.content?.trim());
        return { type: "set_rules", content: input.content!.trim(), ...reason };
      case "agent_rule":
        need("agent", input.agent);
        need("text", input.text?.trim());
        return { type: "agent_rule", agentId: input.agent!, text: input.text!.trim(), ...reason };
    }
  });
}

/** `propose_brain_cleanup` (só o Maestro, só durante o pedido "Organizar" do dono): abre o cartão `kind: "organizacao"`. */
export function maestroBrainOrganizeTools(deps: BrainOrganizeToolsDeps): McpTool[] {
  return [
    defineTool({
      name: "propose_brain_cleanup",
      description: DESCRIPTION,
      input: z.object({
        brain: z.string().trim().min(1).max(64).describe("The Brain id from the request: a room id or \"global\""),
        summary: z.string().trim().min(1).max(BRAIN_ORGANIZE_LIMITS.summary).describe("One or two sentences in Brazilian Portuguese: what you saw and what you propose"),
        actions: z.array(actionSchema).min(1).max(BRAIN_ORGANIZE_LIMITS.actions).describe("All the actions of the proposal"),
      }),
      call: async ({ brain, summary, actions }) => {
        try {
          return { text: await deps.propose({ brain, summary, actions: mapCleanupActions(actions) }) };
        } catch (error) {
          return { text: error instanceof Error ? error.message : String(error), isError: true };
        }
      },
    }),
  ];
}
