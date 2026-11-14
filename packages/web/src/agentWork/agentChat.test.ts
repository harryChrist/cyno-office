import { conversationLogId, type AgentLogEntry, type AgentTerminalInfo } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { agentChatItems, agentReplying, awaitingAgentReply, AWAIT_REPLY_MS, chattingAgentIds } from "./agentChat";

const AT = "2026-11-08T12:00:00.000Z";
const NOW = Date.parse(AT) + 5_000;
const TASK = "11111111-2222-3333-4444-555555555555";
const CONVERSA = conversationLogId("rafa", AT);
let seq = 0;
const entry = (body: Record<string, unknown>, extra: Partial<AgentLogEntry> = {}): AgentLogEntry =>
  ({ id: `e${String(++seq).padStart(3, "0")}`, taskId: CONVERSA, agentId: "rafa", at: AT, ...body, ...extra }) as AgentLogEntry;

describe("agentChatItems", () => {
  it("falas da conversa, notas para a tarefa e avisos; nada de passos de trabalho", () => {
    const items = agentChatItems(
      [
        entry({ kind: "chat", from: "user", text: "oi" }),
        entry({ kind: "text", text: "pensando" }),
        entry({ kind: "chat", from: "agent", text: "olá" }),
        entry({ kind: "chat", from: "user", text: "foca no jovem" }, { taskId: TASK }),
        entry({ kind: "status", status: "waiting", message: "Nota na fila: chega ao agente no fim do turno em curso" }, { taskId: TASK }),
        entry({ kind: "status", status: "started", message: "Começou" }, { taskId: TASK }),
        entry({ kind: "status", status: "failed", message: "A mensagem não chegou" }),
        entry({ kind: "chat", from: "user", text: "de outro" }, { agentId: "bia" }),
      ],
      "rafa",
    );
    expect(items.map((item) => (item.kind === "message" ? `${item.from}${item.note ? "+nota" : ""}:${item.text}` : `aviso:${item.text}`))).toEqual([
      "user:oi",
      "agent:olá",
      "user+nota:foca no jovem",
      "aviso:Nota na fila: chega ao agente no fim do turno em curso",
      "aviso:A mensagem não chegou",
    ]);
  });

  it("respondendo…: só quando a última fala de conversa é do usuário (e recente); nota não espera resposta", () => {
    const asked = agentChatItems([entry({ kind: "chat", from: "user", text: "oi" })], "rafa");
    expect(awaitingAgentReply(asked, NOW)).toBe(true);
    expect(awaitingAgentReply(asked, Date.parse(AT) + AWAIT_REPLY_MS + 1)).toBe(false);
    const answered = agentChatItems([entry({ kind: "chat", from: "user", text: "oi" }), entry({ kind: "chat", from: "agent", text: "olá" })], "rafa");
    expect(awaitingAgentReply(answered, NOW)).toBe(false);
    const note = agentChatItems([entry({ kind: "chat", from: "user", text: "foca" }, { taskId: TASK })], "rafa");
    expect(awaitingAgentReply(note, NOW)).toBe(false);
  });
});

describe("agentReplying (o estado inicial vem do servidor)", () => {
  const asked = agentChatItems([entry({ kind: "chat", from: "user", text: "oi" })], "rafa");
  it("recarregou a página: o terminal parado (chatting ausente) não está respondendo, mesmo dentro da janela de 3 min", () => {
    expect(agentReplying({ items: asked, now: NOW, terminal: {}, lastStatus: undefined })).toBe(false);
  });
  it("o servidor diz que está conversando: está respondendo, com ou sem o que a aba viu", () => {
    expect(agentReplying({ items: asked, now: NOW, terminal: { chatting: true }, lastStatus: undefined })).toBe(true);
    expect(agentReplying({ items: [], now: NOW, terminal: { chatting: true }, lastStatus: "delivered" })).toBe(true);
  });
  it("mensagem vista ao vivo (na fila, entregue): vale a janela; respondeu ou falhou: não", () => {
    expect(agentReplying({ items: asked, now: NOW, terminal: {}, lastStatus: "queued" })).toBe(true);
    expect(agentReplying({ items: asked, now: Date.parse(AT) + AWAIT_REPLY_MS + 1, terminal: {}, lastStatus: "queued" })).toBe(false);
    expect(agentReplying({ items: asked, now: NOW, terminal: { chatting: true }, lastStatus: "answered" })).toBe(false);
    expect(agentReplying({ items: asked, now: NOW, terminal: {}, lastStatus: "failed" })).toBe(false);
  });
  it("sem terminal conhecido (agente simulado): só a janela da última fala", () => {
    expect(agentReplying({ items: asked, now: NOW, terminal: undefined, lastStatus: undefined })).toBe(true);
  });
});

describe("chattingAgentIds (balão no escritório)", () => {
  it("terminal num turno de conversa ou fala do usuário ainda sem resposta", () => {
    const terminals: Record<string, AgentTerminalInfo> = { caio: { agentId: "caio", engine: "claude", status: "busy", chatting: true, updatedAt: AT } };
    const logs = {
      rafa: [entry({ kind: "chat", from: "user", text: "oi" })],
      bia: [entry({ kind: "chat", from: "user", text: "oi" }, { agentId: "bia" }), entry({ kind: "chat", from: "agent", text: "olá" }, { agentId: "bia" })],
      dani: [entry({ kind: "chat", from: "user", text: "nota" }, { agentId: "dani", taskId: TASK })],
    };
    // Bia acabou de responder (5 s): o balão ainda está lá; depois some.
    expect([...chattingAgentIds(logs, terminals, NOW)].sort()).toEqual(["bia", "caio", "rafa"]);
    expect([...chattingAgentIds(logs, terminals, Date.parse(AT) + 9_000)].sort()).toEqual(["caio", "rafa"]);
    expect([...chattingAgentIds(logs, {}, Date.parse(AT) + AWAIT_REPLY_MS + 1)]).toEqual([]);
  });
});
