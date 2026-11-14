import { describe, expect, it } from "vitest";
import { AGENT_LOG_LIMITS, agentLogEntrySchema, boundAgentLogBody, summarizeToolInput, taskLogQuerySchema } from "./agent-log";

const base = { id: "00000000a-0000", taskId: "t1", agentId: "ana", at: "2026-11-08T10:00:00.000Z" };

describe("agentLogEntrySchema", () => {
  it("aceita cada tipo (inclusive thread, provider, aprovação e subagente pelas fases)", () => {
    const entries = [
      { ...base, kind: "text", text: "oi", provider: "claude" },
      { ...base, kind: "tool", toolUseId: "toolu_1", name: "Read", summary: "a.md", status: "running", thread: "toolu_0" },
      { ...base, kind: "approval", phase: "asked", question: "Pode?", forYouId: "A-0001" },
      { ...base, kind: "approval", phase: "decided", approved: false, note: "não" },
      { ...base, kind: "subagent", phase: "started", subagentId: "sa-1", label: "Ana · pesquisa", goal: "pesquisar" },
      { ...base, kind: "subagent", phase: "finished", subagentId: "sa-1", label: "Ana · pesquisa", status: "ok" },
      { ...base, kind: "raw", stream: "stderr", text: "warning: x" },
      { ...base, kind: "status", status: "canceled", message: "Cancelada" },
    ];
    for (const entry of entries) expect(agentLogEntrySchema.safeParse(entry).data).toEqual(entry);
  });

  it("rejeita tipo/fase/provedor desconhecidos e thread insegura", () => {
    expect(agentLogEntrySchema.safeParse({ ...base, kind: "nada" }).success).toBe(false);
    expect(agentLogEntrySchema.safeParse({ ...base, kind: "approval", phase: "asked" }).success).toBe(false);
    expect(agentLogEntrySchema.safeParse({ ...base, kind: "text", text: "x", provider: "outro" }).success).toBe(false);
    expect(agentLogEntrySchema.safeParse({ ...base, kind: "text", text: "x", thread: "../x" }).success).toBe(false);
    expect(taskLogQuerySchema.safeParse({ thread: "a b" }).success).toBe(false);
  });
});

describe("boundAgentLogBody", () => {
  it("corta textos com … e tira o input grande demais (summary do primeiro texto)", () => {
    const text = boundAgentLogBody({ kind: "text", text: "a".repeat(AGENT_LOG_LIMITS.text + 1) });
    expect(text.kind === "text" && text.text.length).toBe(AGENT_LOG_LIMITS.text);
    expect(text.kind === "text" && text.text.endsWith("…")).toBe(true);
    const tool = boundAgentLogBody({
      kind: "tool",
      toolUseId: "t",
      name: "Write",
      summary: "",
      status: "ok",
      input: { file: "a.md", content: "b".repeat(AGENT_LOG_LIMITS.inputJson) },
      output: "c".repeat(AGENT_LOG_LIMITS.output + 10),
    });
    expect(tool).toMatchObject({ summary: "a.md" });
    expect(tool).not.toHaveProperty("input");
    expect(tool.kind === "tool" && tool.output!.length).toBe(AGENT_LOG_LIMITS.output);
  });

  it("progresso fica entre 0 e 1", () => {
    expect(boundAgentLogBody({ kind: "progress", progress: 3, message: "x" })).toMatchObject({ progress: 1 });
    expect(boundAgentLogBody({ kind: "progress", progress: Number.NaN, message: "x" })).toMatchObject({ progress: 0 });
  });

  it("summarizeToolInput: primeiro valor de texto, senão o JSON curto", () => {
    expect(summarizeToolInput({ limit: 3, query: "agentes  de\nIA" })).toBe("agentes de IA");
    expect(summarizeToolInput({ limit: 3 })).toBe('{"limit":3}');
    expect(summarizeToolInput(undefined)).toBe("");
  });
});
