import { describe, expect, it } from "vitest";
import { advanceChatStatus, CHAT_MESSAGE_STATUSES } from "./terminal";
import { parseServerEvent } from "./events";

describe("advanceChatStatus", () => {
  it("começa em qualquer estado e só avança", () => {
    expect(advanceChatStatus(undefined, "queued")).toBe("queued");
    expect(advanceChatStatus("queued", "delivered")).toBe("delivered");
    expect(advanceChatStatus("delivered", "answered")).toBe("answered");
    expect(advanceChatStatus("queued", "answered")).toBe("answered");
  });

  it("nada volta atrás", () => {
    expect(advanceChatStatus("delivered", "queued")).toBe("delivered");
    expect(advanceChatStatus("answered", "delivered")).toBe("answered");
    expect(advanceChatStatus("answered", "queued")).toBe("answered");
  });

  it("falhou só vale sobre a fila; uma confirmação atrasada corrige falhou para entregue ou respondeu, nunca o contrário", () => {
    expect(advanceChatStatus("queued", "failed")).toBe("failed");
    expect(advanceChatStatus("failed", "delivered")).toBe("delivered");
    expect(advanceChatStatus("failed", "answered")).toBe("answered");
    expect(advanceChatStatus("failed", "queued")).toBe("queued");
    expect(advanceChatStatus("delivered", "failed")).toBe("delivered");
    expect(advanceChatStatus("answered", "failed")).toBe("answered");
  });

  it("em qualquer ordem de chegada, entregue ou respondeu vencem o falhou", () => {
    for (const order of [
      ["failed", "delivered"],
      ["delivered", "failed"],
      ["failed", "answered"],
      ["answered", "failed"],
    ] as const) {
      const end = order.reduce<(typeof CHAT_MESSAGE_STATUSES)[number] | undefined>((state, next) => advanceChatStatus(state, next), "queued");
      expect(end).not.toBe("failed");
    }
  });
});

describe("evento agent:chat-status", () => {
  it("é um evento do servidor conhecido", () => {
    const raw = JSON.stringify({ type: "agent:chat-status", chat: { messageId: "m1", agentId: "a1", status: "queued", mode: "conversa", at: "2026-11-12T12:00:00.000Z" } });
    expect(parseServerEvent(raw)).toMatchObject({ type: "agent:chat-status", chat: { messageId: "m1", status: "queued" } });
  });
});
