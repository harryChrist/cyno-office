import { describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import { maestroRetroTools } from "./retro-tools";

describe("propose_rule (só o Maestro, só durante o pedido da retrospectiva)", () => {
  it("passa group_id, text e scope ao serviço e devolve a resposta dele em inglês", async () => {
    const propose = vi.fn(async () => "Rule card A-0007 opened for the owner (0 group(s) left).");
    const [tool] = maestroRetroTools({ propose });
    expect(tool!.name).toBe("propose_rule");
    expect(tool!.description).toMatch(/nothing enters the Brain without that click/i);
    const result = await tool!.call({ group_id: "g-1a2b3c", text: "Evitar tom formal demais em comentários.", scope: "agent" });
    expect(propose).toHaveBeenCalledWith({ groupId: "g-1a2b3c", text: "Evitar tom formal demais em comentários.", scope: "agent" });
    expect(result).toEqual({ text: "Rule card A-0007 opened for the owner (0 group(s) left)." });
  });

  it("um erro do serviço volta como erro de ferramenta (o modelo lê o motivo), sem derrubar nada", async () => {
    const [tool] = maestroRetroTools({ propose: async () => Promise.reject(new Error("propose_rule only works while the owner's retrospective request is open")) });
    const result = await tool!.call({ group_id: "g-x", text: "Uma regra qualquer aqui.", scope: "global" });
    expect(result).toMatchObject({ isError: true, text: expect.stringContaining("only works while") });
  });

  it("o escopo só aceita 'agent' ou 'global' e o texto precisa de uma frase", () => {
    const [tool] = maestroRetroTools({ propose: async () => "" });
    const schema = (tool as unknown as { input: z.ZodObject }).input;
    expect(schema.safeParse({ group_id: "g", text: "Uma regra qualquer aqui.", scope: "room" }).success).toBe(false);
    expect(schema.safeParse({ group_id: "g", text: "curta", scope: "agent" }).success).toBe(false);
    expect(schema.safeParse({ group_id: "g", text: "Uma regra qualquer aqui.", scope: "agent" }).success).toBe(true);
  });
});
