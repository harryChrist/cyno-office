import type { AgentChatStatus } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { applyChatStatus, latestChatStatus } from "../store/chatStatusStore";
import {
  ANSWERED_SHOW_MS,
  canRetry,
  canSend,
  counterText,
  DELIVERED_SHOW_MS,
  enterSends,
  getDraft,
  MESSAGE_MAX,
  messageText,
  nextCheckIn,
  QUEUED_STALE_MS,
  sendStatusText,
  setDraft,
  viewSend,
  type SendState,
} from "./composerModel";

const key = (key: string, extra: Partial<Parameters<typeof enterSends>[0]> = {}) => ({ key, shiftKey: false, altKey: false, isComposing: false, ...extra });
const T0 = 1_000_000;
const state = (patch: Partial<SendState> = {}): SendState => ({ phase: "queued", messageId: "m1", mode: "conversa", text: "oi", at: T0, ...patch });
const server = (status: AgentChatStatus["status"], extra: Partial<AgentChatStatus> = {}): AgentChatStatus => ({ messageId: "m1", agentId: "a", status, mode: "conversa", at: new Date(T0 + 500).toISOString(), ...extra });

describe("a caixa", () => {
  it("Enter envia; Shift+Enter e Alt+Enter quebram a linha; compondo acento não envia", () => {
    expect(enterSends(key("Enter"))).toBe(true);
    expect(enterSends(key("Enter", { shiftKey: true }))).toBe(false);
    expect(enterSends(key("Enter", { altKey: true }))).toBe(false);
    expect(enterSends(key("Enter", { isComposing: true }))).toBe(false);
    expect(enterSends(key("a"))).toBe(false);
  });

  it("canSend: vazio, só espaço, muito longo ou ocupado não envia", () => {
    expect(canSend("oi")).toBe(true);
    expect(canSend("  \n ")).toBe(false);
    expect(canSend("x".repeat(MESSAGE_MAX))).toBe(true);
    expect(canSend("x".repeat(MESSAGE_MAX + 1))).toBe(false);
    expect(canSend("oi", true)).toBe(false);
    expect(messageText("oi  \n\n")).toBe("oi");
  });

  it("o contador só aparece perto do limite", () => {
    expect(counterText(100)).toBe("");
    expect(counterText(MESSAGE_MAX * 0.8 - 1)).toBe("");
    expect(counterText(16_000)).toBe("16.000 / 20.000");
    expect(counterText(MESSAGE_MAX)).toBe("20.000 / 20.000");
  });

  it("rascunho por agente: cada um guarda o seu e vazio apaga", () => {
    setDraft("rafa", "meio texto");
    setDraft("lia", "outro");
    expect(getDraft("rafa")).toBe("meio texto");
    expect(getDraft("lia")).toBe("outro");
    setDraft("rafa", "");
    expect(getDraft("rafa")).toBe("");
    expect(getDraft("ninguem")).toBe("");
  });
});

describe("o estado que a tela mostra", () => {
  it("o servidor leva a mensagem da fila para entregue e respondeu", () => {
    expect(viewSend(state(), { m1: server("delivered") }, T0 + 1000)?.phase).toBe("delivered");
    expect(viewSend(state(), { m1: server("answered") }, T0 + 1000)?.phase).toBe("answered");
    expect(viewSend(state(), {}, T0 + 1000)?.phase).toBe("queued");
    expect(viewSend(undefined, {}, T0)).toBeUndefined();
  });

  it("enviando e recusada não são mexidas pelo servidor", () => {
    expect(viewSend(state({ phase: "sending", messageId: undefined }), { m1: server("delivered") }, T0)?.phase).toBe("sending");
    expect(viewSend(state({ phase: "rejected" }), { m1: server("delivered") }, T0)?.phase).toBe("rejected");
  });

  it("falhou e depois a confirmação atrasada chega: corrige para entregue; o contrário nunca", () => {
    let byMessage = applyChatStatus({}, server("failed", { error: "terminal parado" }));
    expect(viewSend(state(), byMessage, T0 + 2000)).toMatchObject({ phase: "failed", error: "terminal parado" });
    byMessage = applyChatStatus(byMessage, server("delivered"));
    expect(viewSend(state(), byMessage, T0 + 3000)).toMatchObject({ phase: "delivered" });
    // falha tardia depois da entrega: continua entregue
    byMessage = applyChatStatus(byMessage, server("failed", { error: "x" }));
    expect(byMessage.m1!.status).toBe("delivered");
    expect(viewSend(state({ phase: "delivered" }), { m1: server("failed") }, T0)?.phase).toBe("delivered");
  });

  it("o evento que chega primeiro, fora de ordem (entregue antes de na fila), não volta atrás", () => {
    let byMessage = applyChatStatus({}, server("delivered"));
    byMessage = applyChatStatus(byMessage, server("queued"));
    expect(byMessage.m1!.status).toBe("delivered");
  });
});

describe("a linha de situação", () => {
  it("cada estado tem o seu texto, com o tom da nota ou da conversa", () => {
    expect(sendStatusText(state({ phase: "sending" }), T0)).toBe("Enviando…");
    expect(sendStatusText(state(), T0)).toMatch(/^Na fila/);
    expect(sendStatusText(state({ mode: "nota" }), T0)).toMatch(/nota/);
    expect(sendStatusText(state({ phase: "delivered" }), T0 + 1)).toBe("Entregue ✓");
    expect(sendStatusText(state({ phase: "answered" }), T0 + 1)).toBe("Respondeu ✓");
    expect(sendStatusText(state({ phase: "failed", error: "terminal caiu" }), T0)).toBe("Não foi entregue: terminal caiu");
    expect(sendStatusText(state({ phase: "rejected", error: "mensagem vazia" }), T0)).toBe("Não foi possível mandar: mensagem vazia");
    expect(sendStatusText(undefined, T0)).toBe("");
  });

  it("entregue some depois de 12 s e respondeu depois de 4 s; erro não some", () => {
    expect(sendStatusText(state({ phase: "delivered" }), T0 + DELIVERED_SHOW_MS)).toBe("");
    expect(sendStatusText(state({ phase: "answered" }), T0 + ANSWERED_SHOW_MS)).toBe("");
    expect(sendStatusText(state({ phase: "failed", error: "x" }), T0 + 10 * 60_000)).toMatch(/^Não foi entregue/);
    expect(sendStatusText(state({ phase: "delivered", error: "cota" }), T0 + 10 * 60_000)).toBe("Entregue, mas o turno falhou: cota");
  });

  it("na fila há mais de 1 min com o terminal parado: avisa", () => {
    expect(sendStatusText(state(), T0 + QUEUED_STALE_MS, { status: "stopped" })).toMatch(/terminal está parado/);
    expect(sendStatusText(state(), T0 + QUEUED_STALE_MS, { status: "busy" })).toMatch(/^Na fila:/);
    expect(sendStatusText(state(), T0 + 5_000, { status: "stopped" })).toMatch(/^Na fila:/);
  });

  it("quando reavaliar a linha", () => {
    expect(nextCheckIn(state({ phase: "delivered" }), T0 + 2_000)).toBe(DELIVERED_SHOW_MS - 2_000);
    expect(nextCheckIn(state({ phase: "answered" }), T0)).toBe(ANSWERED_SHOW_MS);
    expect(nextCheckIn(state(), T0 + 10_000)).toBe(QUEUED_STALE_MS - 10_000);
    expect(nextCheckIn(state({ phase: "failed" }), T0)).toBeNull();
    expect(nextCheckIn(undefined, T0)).toBeNull();
  });

  it("tentar de novo só para o que falhou", () => {
    expect(canRetry(state({ phase: "failed" }))).toBe(true);
    expect(canRetry(state({ phase: "delivered" }))).toBe(false);
    expect(canRetry(undefined)).toBe(false);
  });
});

describe("a mensagem mais recente do agente", () => {
  it("a de horário maior vence; de outro agente não conta", () => {
    const a = server("delivered", { messageId: "a", at: "2026-11-12T12:00:00.000Z" });
    const b = server("failed", { messageId: "b", at: "2026-11-12T12:05:00.000Z" });
    const c = server("answered", { messageId: "c", agentId: "outro", at: "2026-11-12T12:10:00.000Z" });
    expect(latestChatStatus({ a, b, c }, "a")?.messageId).toBe("b");
    expect(latestChatStatus({ a, b, c }, "ninguem")).toBeUndefined();
  });
});
