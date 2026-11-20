import { describe, expect, it } from "vitest";
import { AgentUsageLedger } from "../usage/agent-usage";
import { interpretStepUsage } from "./chat-log";

// Formas reais do log.jsonl do Freebuff (valores de exemplo): o passo começa com o tamanho do contexto e termina com os créditos.
const start = { level: "DEBUG", msg: "Start agent base3-free-catalog step 1 (abc - Prompt: oi)", data: { iteration: 1, contextTokenCount: 54096, systemTokens: 10021, messageCount: 1 } };
const end = (response: string, credits = 0) => ({
  level: "DEBUG",
  msg: "End agent base3-free-catalog step 1 (abc - Prompt: oi)",
  data: { iteration: 1, agentId: "main-agent", shouldEndTurn: false, fullResponse: response, toolCalls: [{ toolName: "read_files", input: { paths: ["a.ts"] }, toolCallId: "t1" }], toolResults: [], stepCreditsUsed: credits },
});

describe("gasto de um passo do Freebuff (log.jsonl)", () => {
  it("o começo do passo traz a entrada medida (contexto lido)", () => {
    expect(interpretStepUsage(start)).toEqual({ inputTokens: 54096, outputTokens: 0, credits: 0 });
  });

  it("o fim do passo traz a saída estimada pelo tamanho (4 caracteres por token) e os créditos do passo", () => {
    const response = "x".repeat(400);
    const calls = JSON.stringify(end(response).data.toolCalls).length;
    expect(interpretStepUsage(end(response, 3))).toEqual({ inputTokens: 0, outputTokens: Math.ceil((400 + calls) / 4), credits: 3 });
  });

  it("linhas que não são de passo (ou sem número) não viram gasto", () => {
    expect(interpretStepUsage({ level: "INFO", msg: "[send-message] Sending message" })).toBeUndefined();
    expect(interpretStepUsage({ msg: "Start agent x step 1", data: { contextTokenCount: "muitos" } })).toBeUndefined();
    expect(interpretStepUsage({ msg: "Start agent x step 1", data: { contextTokenCount: -5 } })).toBeUndefined();
    expect(interpretStepUsage("lixo")).toBeUndefined();
  });
});

describe("livro de uso por agente com tokens estimados", () => {
  it("o turno estimado conta como medido e marca o agente como estimado; os de outras CLIs não", () => {
    const ledger = new AgentUsageLedger(() => new Date("2026-11-19T12:00:00Z"));
    ledger.record("fb", "freebuff", { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheCreationTokens: 0, estimated: true });
    ledger.record("fb", "freebuff", { inputTokens: 500, outputTokens: 100, cacheReadTokens: 0, cacheCreationTokens: 0, estimated: true });
    ledger.record("cl", "claude", { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 });
    const { agents } = ledger.summary();
    const fb = agents.find((tally) => tally.agentId === "fb")!;
    expect(fb).toMatchObject({ turns: 2, measuredTurns: 2, estimatedTurns: 2, inputTokens: 1500, outputTokens: 300 });
    expect(agents.find((tally) => tally.agentId === "cl")!.estimatedTurns).toBeUndefined();
  });
});
