import { conversationLogId, type AgentLogEntry } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { entriesToTerminalLines, entryToTerminalLine, toolLabel } from "./agentTerminal";

const AT = "2026-11-08T12:00:00.000Z";
const TASK = "11111111-2222-3333-4444-555555555555";
const CONVERSA = conversationLogId("rafa", AT);
let seq = 0;
const entry = (body: Record<string, unknown>, extra: Partial<AgentLogEntry> = {}): AgentLogEntry =>
  ({ id: `e${String(++seq).padStart(3, "0")}`, taskId: TASK, agentId: "rafa", at: AT, ...body, ...extra }) as AgentLogEntry;

describe("entryToTerminalLine", () => {
  it("cada tipo vira uma linha com prefixo e cor", () => {
    expect(entryToTerminalLine(entry({ kind: "text", text: "Lendo o briefing" }), "Rafa")).toMatchObject({ tone: "text", prefix: "●", text: "Lendo o briefing" });
    expect(entryToTerminalLine(entry({ kind: "chat", from: "user", text: "foca no público jovem" }), "Rafa")).toMatchObject({ tone: "user", prefix: "❯", meta: "você · nota para a tarefa" });
    expect(entryToTerminalLine(entry({ kind: "chat", from: "user", text: "oi" }, { taskId: CONVERSA }), "Rafa")).toMatchObject({ meta: "você" });
    expect(entryToTerminalLine(entry({ kind: "chat", from: "agent", text: "olá" }, { taskId: CONVERSA }), "Rafa")).toMatchObject({ tone: "agent", prefix: "◀", meta: "Rafa" });
    expect(entryToTerminalLine(entry({ kind: "progress", progress: 0.4, message: "Escrevendo" }), "Rafa")).toMatchObject({ tone: "info", prefix: "▸", text: "40% Escrevendo" });
    expect(entryToTerminalLine(entry({ kind: "approval", phase: "asked", question: "Posso publicar?" }), "Rafa")).toMatchObject({ tone: "warn", prefix: "?" });
    expect(entryToTerminalLine(entry({ kind: "approval", phase: "decided", approved: false }), "Rafa")).toMatchObject({ tone: "error", prefix: "✗", text: "você recusou" });
    expect(entryToTerminalLine(entry({ kind: "status", status: "failed", message: "Caiu" }), "Rafa")).toMatchObject({ tone: "error", prefix: "·" });
    expect(entryToTerminalLine(entry({ kind: "result", text: "## Pronto" }), "Rafa")).toMatchObject({ tone: "result", prefix: "✔", meta: "resultado" });
    expect(entryToTerminalLine(entry({ kind: "raw", stream: "stderr", text: "warn: x" }), "Rafa")).toMatchObject({ tone: "error", prefix: "!" });
    expect(entryToTerminalLine(entry({ kind: "raw", stream: "stdout", text: "[init] sessão" }), "Rafa")).toMatchObject({ tone: "dim", prefix: "$" });
  });

  it("ferramenta: nome sem o prefixo do MCP do escritório, estado e duração, prévia da saída; nome cru para achar o conector", () => {
    const running = entryToTerminalLine(entry({ kind: "tool", toolUseId: "t1", name: "mcp__office__submit_result", summary: "Post pronto", status: "running" }), "Rafa");
    expect(running).toMatchObject({ tone: "tool", prefix: "⏺", text: "entregar(Post pronto)", meta: "rodando…", tool: "mcp__office__submit_result" });
    const done = entryToTerminalLine(entry({ kind: "tool", toolUseId: "t2", name: "mcp__notion__search", summary: "briefing", status: "ok", durationMs: 1200, output: "a\nb" }), "Rafa");
    expect(done).toMatchObject({ text: "mcp__notion__search(briefing)", meta: "✓ 1,2 s", detail: "a\nb", tool: "mcp__notion__search" });
    expect(entryToTerminalLine(entry({ kind: "tool", toolUseId: "t3", name: "Read", summary: "x", status: "error" }), "Rafa")).toMatchObject({ tone: "error", meta: "✗ erro" });
  });

  it("subagente: início com o modelo e o objetivo; fim ok/erro", () => {
    expect(entryToTerminalLine(entry({ kind: "subagent", phase: "started", subagentId: "s1", label: "Pesquisa", goal: "Ache 3 fontes", model: "haiku" }), "Rafa")).toMatchObject({
      prefix: "⤷",
      text: "subagente Pesquisa",
      meta: "haiku",
      detail: "Ache 3 fontes",
    });
    expect(entryToTerminalLine(entry({ kind: "subagent", phase: "finished", subagentId: "s1", label: "Pesquisa", status: "error" }), "Rafa")).toMatchObject({ tone: "error", text: "subagente Pesquisa falhou" });
  });
});

describe("entriesToTerminalLines", () => {
  it("abre uma seção por tarefa/conversa e recua as entradas do subagente com o rótulo dele", () => {
    const entries = [
      entry({ kind: "chat", from: "user", text: "oi" }, { taskId: CONVERSA }),
      entry({ kind: "chat", from: "agent", text: "olá" }, { taskId: CONVERSA }),
      entry({ kind: "status", status: "started", message: "Começou" }),
      entry({ kind: "subagent", phase: "started", subagentId: "s1", label: "Pesquisa", goal: "x" }),
      entry({ kind: "text", text: "dentro do subagente" }, { thread: "s1" }),
    ];
    const lines = entriesToTerminalLines(entries, { agentName: "Rafa", taskTitle: (id) => (id === TASK ? "Post de lançamento" : undefined) });
    expect(lines.filter((line) => line.tone === "section").map((line) => line.text)).toEqual(["conversa direta", "tarefa · Post de lançamento"]);
    expect(lines.at(-1)).toMatchObject({ thread: "Pesquisa", text: "dentro do subagente" });
    expect(lines).toHaveLength(7);
  });

  it("na conversa, o texto do turno igual à resposta não repete", () => {
    const lines = entriesToTerminalLines(
      [entry({ kind: "text", text: "Olá!" }, { taskId: CONVERSA }), entry({ kind: "chat", from: "agent", text: "Olá!" }, { taskId: CONVERSA }), entry({ kind: "text", text: "Olá!" })],
      { agentName: "Rafa" },
    );
    expect(lines.map((line) => line.tone)).toEqual(["section", "agent", "section", "text"]);
  });
});

describe("ajudantes", () => {
  it("toolLabel", () => {
    expect(toolLabel("mcp__office__report_progress")).toBe("progresso");
    expect(toolLabel("mcp__office__ler_nota")).toBe("ler nota");
    expect(toolLabel("mcp__office__notion__create_page")).toBe("notion__create_page");
    expect(toolLabel("Read")).toBe("Read");
  });
});
