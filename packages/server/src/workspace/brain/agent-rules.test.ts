import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { BRAIN_RULE_LIMITS } from "@cyno/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AGENT_RULES_FILE, AgentRules } from "./agent-rules";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "agent-rules-"));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const make = () => new AgentRules((id) => path.join(dir, "agents", id), () => new Date("2026-11-18T10:00:00Z"));

describe("AgentRules", () => {
  it("arquivo ausente = vazio", async () => {
    expect(await make().read("clara")).toEqual({ content: "", updatedAt: null });
  });

  it("write grava o texto aparado em agents/<id>/regras.md; vazio remove", async () => {
    const rules = make();
    const saved = await rules.write("clara", "  - Sempre em pt-BR.\n\n");
    expect(saved.content).toBe("- Sempre em pt-BR.");
    expect(saved.updatedAt).toBe("2026-11-18T10:00:00.000Z");
    expect(await readFile(path.join(dir, "agents", "clara", AGENT_RULES_FILE), "utf8")).toBe("- Sempre em pt-BR.\n");
    expect((await rules.read("clara")).content).toBe("- Sempre em pt-BR.");
    expect(await rules.write("clara", "   ")).toEqual({ content: "", updatedAt: null });
    expect((await rules.read("clara")).content).toBe("");
  });

  it("write acima do teto dá HttpError 400", async () => {
    await expect(make().write("clara", "x".repeat(BRAIN_RULE_LIMITS.rulesFile + 1))).rejects.toMatchObject({ statusCode: 400 });
  });

  it("append acrescenta uma linha, sem duplicar (caixa e acento não contam)", async () => {
    const rules = make();
    expect(await rules.append("clara", "Nunca use  emojis.")).toEqual({ added: true, content: "- Nunca use emojis." });
    expect((await rules.append("clara", "nunca USE emojis.")).added).toBe(false);
    expect((await rules.append("clara", "Sempre cite a fonte")).content).toBe("- Nunca use emojis.\n- Sempre cite a fonte");
    expect((await rules.append("clara", "SEMPRE cité a fonte")).added).toBe(false);
    expect((await rules.append("clara", "sempre cite a fonte")).added).toBe(false);
    expect((await rules.read("eco")).content).toBe("");
  });

  it("append em paralelo não perde linhas", async () => {
    const rules = make();
    await Promise.all(Array.from({ length: 8 }, (_, i) => rules.append("clara", `Regra ${i}`)));
    expect((await rules.read("clara")).content.split("\n")).toHaveLength(8);
  });

  it("append recusa linha longa demais e arquivo estourado", async () => {
    const rules = make();
    await expect(rules.append("clara", "x".repeat(BRAIN_RULE_LIMITS.agentRule + 1))).rejects.toThrow(/too long/);
    await rules.write("clara", Array.from({ length: 13 }, (_, i) => `- ${"y".repeat(290)} ${i}`).join("\n"));
    await expect(rules.append("clara", "z".repeat(250))).rejects.toThrow(/would pass/);
  });
});
