import { z } from "zod";
import { defineTool, type McpTool } from "./protocol";

const DESCRIPTION =
  "Proposes ONE rule to the owner from a pattern the server found in the owner's recent decisions (refusals, edits, failures). Only works while the owner's retrospective request is open (the owner asks for it with the button \"Escrever as regras com o Maestro\"); the request lists the groups, each with a `group_id`. Call it exactly once per group, with `text` = one short imperative sentence in Brazilian Portuguese, general enough to guide that agent's future work (never quote the samples, never invent facts) and `scope` = 'agent' when the pattern comes from one agent or 'global' when it comes from two or more. It opens a rule card for the owner to approve, edit or refuse: nothing enters the Brain without that click, and you cannot approve it yourself.";

export type RetroToolsDeps = { propose: (input: { groupId: string; text: string; scope: "agent" | "global" }) => Promise<string> };

/** `propose_rule` (só o Maestro, só durante o pedido da retrospectiva): cria o cartão `kind: "regra"` para o dono aprovar. */
export function maestroRetroTools(deps: RetroToolsDeps): McpTool[] {
  return [
    defineTool({
      name: "propose_rule",
      description: DESCRIPTION,
      input: z.object({
        group_id: z.string().trim().min(1).max(40).describe("The group id from the retrospective request (e.g. \"g-1a2b3c4d5e\")"),
        text: z.string().trim().min(8).max(500).describe("The rule: one short imperative sentence in Brazilian Portuguese"),
        scope: z.enum(["agent", "global"]).describe("'agent' when the pattern comes from one agent (the rule goes to that agent's room Brain), 'global' when from two or more (the workspace's global Brain)"),
      }),
      call: async ({ group_id, text, scope }) => {
        try {
          return { text: await deps.propose({ groupId: group_id, text, scope }) };
        } catch (error) {
          return { text: error instanceof Error ? error.message : String(error), isError: true };
        }
      },
    }),
  ];
}
