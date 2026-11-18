import { describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import { mapCleanupActions, maestroBrainOrganizeTools, type BrainCleanupActionInput } from "./brain-organize-tools";

const schemaOf = (tool: unknown) => (tool as { input: z.ZodObject }).input;

describe("propose_brain_cleanup (só o Maestro, só durante o pedido Organizar)", () => {
  it("descreve o limite da ferramenta e passa brain, summary e as ações mapeadas ao serviço", async () => {
    const propose = vi.fn(async () => "Proposal card A-0003 opened for the owner (2 actions).");
    const [tool] = maestroBrainOrganizeTools({ propose });
    expect(tool!.name).toBe("propose_brain_cleanup");
    expect(tool!.description).toMatch(/works while the owner's "Organizar" request/);
    expect(tool!.description).toMatch(/Nothing is applied without the owner's approval/);
    expect(tool!.description).toMatch(/nothing is ever deleted/);
    expect(tool!.description).toMatch(/cannot approve it yourself/);
    const result = await tool!.call({
      brain: "sala-a",
      summary: "Resumo.",
      actions: [
        { action: "archive", path: "sala-a/a.md", reason: " etapa antiga " },
        { action: "agent_rule", agent: "Clara", text: " Sempre abrir curto. " },
      ],
    });
    expect(propose).toHaveBeenCalledWith({
      brain: "sala-a",
      summary: "Resumo.",
      actions: [
        { type: "archive", file: "sala-a/a.md", reason: "etapa antiga" },
        { type: "agent_rule", agentId: "Clara", text: "Sempre abrir curto." },
      ],
    });
    expect(result).toEqual({ text: "Proposal card A-0003 opened for the owner (2 actions)." });
  });

  it("mapeia cada ação para a união compartilhada", () => {
    const actions: BrainCleanupActionInput[] = [
      { action: "make_rule", path: "g/a.md" },
      { action: "make_rule", path: "g/b.md", content: " Curta. " },
      { action: "rewrite", path: "g/c.md", content: "Novo." },
      { action: "merge", paths: ["g/d.md", "g/e.md"], title: "Junto", content: "Texto." },
      { action: "set_rules", content: "- Regra." },
    ];
    expect(mapCleanupActions(actions)).toEqual([
      { type: "make_rule", file: "g/a.md" },
      { type: "make_rule", file: "g/b.md", content: "Curta." },
      { type: "rewrite", file: "g/c.md", content: "Novo." },
      { type: "merge", files: ["g/d.md", "g/e.md"], title: "Junto", content: "Texto." },
      { type: "set_rules", content: "- Regra." },
    ]);
  });

  it("diz qual campo falta em qual ação (pelo número) e devolve como erro de ferramenta", async () => {
    expect(() => mapCleanupActions([{ action: "archive", path: "g/a.md" }, { action: "rewrite", path: "g/b.md" }])).toThrow("Action 2 (rewrite): `content` is required.");
    expect(() => mapCleanupActions([{ action: "merge", paths: ["g/a.md"], title: "T", content: "C" }])).toThrow(/Action 1 \(merge\): `paths` needs at least two notes/);
    expect(() => mapCleanupActions([{ action: "merge", paths: ["g/a.md", "g/b.md"], content: "C" }])).toThrow("Action 1 (merge): `title` is required.");
    expect(() => mapCleanupActions([{ action: "agent_rule", text: "Uma regra." }])).toThrow("Action 1 (agent_rule): `agent` is required.");
    expect(() => mapCleanupActions([{ action: "archive" }])).toThrow("Action 1 (archive): `path` is required.");
    const [tool] = maestroBrainOrganizeTools({ propose: async () => "" });
    const result = await tool!.call({ brain: "g", summary: "s", actions: [{ action: "set_rules" }] });
    expect(result).toMatchObject({ isError: true, text: "Action 1 (set_rules): `content` is required." });
  });

  it("o erro do serviço volta como erro de ferramenta; a entrada exige ao menos uma ação e só aceita os tipos conhecidos", async () => {
    const [tool] = maestroBrainOrganizeTools({ propose: async () => Promise.reject(new Error("propose_brain_cleanup only works while the owner's request is open")) });
    expect(await tool!.call({ brain: "g", summary: "s", actions: [{ action: "archive", path: "g/a.md" }] })).toMatchObject({ isError: true, text: expect.stringContaining("only works while") });
    const schema = schemaOf(tool);
    expect(schema.safeParse({ brain: "g", summary: "s", actions: [] }).success).toBe(false);
    expect(schema.safeParse({ brain: "g", summary: "s", actions: [{ action: "delete", path: "g/a.md" }] }).success).toBe(false);
    expect(schema.safeParse({ brain: "g", summary: "s", actions: [{ action: "archive", path: "g/a.md" }] }).success).toBe(true);
  });
});
