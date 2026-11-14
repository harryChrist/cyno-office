import { describe, expect, it } from "vitest";
import { agentChatBodySchema, friendlyTerminalError, terminalStateView, type AgentTerminalInfo } from "./terminal";
import { maestroSessionNameSchema } from "./api";
import { defaultMaestroSessionName, maestroSessionName } from "./types";

const info = (change: Partial<AgentTerminalInfo>): AgentTerminalInfo => ({ agentId: "a", engine: "claude", status: "stopped", updatedAt: "2026-11-08T12:00:00.000Z", ...change });

describe("terminalStateView", () => {
  it("criado (nunca iniciado) → iniciando → ligado → desligado", () => {
    expect(terminalStateView("claude", undefined)).toMatchObject({ key: "novo", emoji: "🆕", label: "Criado, nunca iniciado", canStart: true, canStop: false });
    expect(terminalStateView("claude", info({}))).toMatchObject({ key: "novo" });
    expect(terminalStateView("claude", info({ status: "starting", everStarted: true }))).toMatchObject({ key: "iniciando", emoji: "⏳", canStart: false, canStop: false });
    expect(terminalStateView("claude", info({ status: "idle", everStarted: true }))).toMatchObject({ key: "ligado", emoji: "🟢", canStop: true, midTurn: false });
    expect(terminalStateView("claude", info({ status: "busy", everStarted: true }))).toMatchObject({ key: "ligado", midTurn: true });
    expect(terminalStateView("claude", info({ status: "stopped", everStarted: true, stoppedReason: "Parado por ociosidade" }))).toMatchObject({
      key: "desligado",
      emoji: "💤",
      label: "Desligado",
      detail: "Parado por ociosidade: sobe sozinho na próxima tarefa",
      canStart: true,
    });
  });

  it("conversando com você aparece no detalhe do ligado", () => {
    expect(terminalStateView("claude", info({ status: "busy", everStarted: true, chatting: true })).detail).toBe("Conversando com você");
  });

  it("com erro: motivo legível e Tentar de novo", () => {
    const view = terminalStateView("gemini", info({ engine: "gemini", status: "error", error: "Não foi possível iniciar a CLI: spawn agy ENOENT" }));
    expect(view).toMatchObject({ key: "erro", emoji: "🔴", label: "Com erro", detail: "comando agy não encontrado", canStart: true });
  });

  it("sem cota: vale enquanto o processo não está no ar (reusa o rótulo da disponibilidade)", () => {
    const block = { label: "sem cota · volta às 14:30", reason: "quota" };
    expect(terminalStateView("claude", info({ everStarted: true }), block)).toMatchObject({ key: "sem_cota", emoji: "🚫", label: "Sem cota · volta às 14:30" });
    expect(terminalStateView("claude", info({ status: "busy", everStarted: true }), block)).toMatchObject({ key: "ligado" });
  });

  it("simulado: sem processo", () => {
    expect(terminalStateView("mock", undefined)).toMatchObject({ key: "simulado", canStart: false, canStop: false });
  });
});

describe("friendlyTerminalError", () => {
  it.each([
    ["Não foi possível iniciar a CLI: spawn claude ENOENT", "comando claude não encontrado"],
    ["A CLI saiu (código 1): Error: Not logged in · Please run /login", "login expirado (entre de novo na CLI)"],
    ["A CLI saiu (código 1): OAuth token has expired", "login expirado (entre de novo na CLI)"],
    ["A CLI saiu (código 2): algo quebrou aqui", "algo quebrou aqui"],
    ["", "erro desconhecido"],
  ])("%s → %s", (raw, expected) => {
    expect(friendlyTerminalError(raw)).toBe(expected);
  });
});

describe("agentChatBodySchema", () => {
  it("corta espaços e recusa vazio", () => {
    expect(agentChatBodySchema.parse({ text: "  oi  " })).toEqual({ text: "oi" });
    expect(agentChatBodySchema.safeParse({ text: "   " }).success).toBe(false);
  });
});

describe("maestroSessionName", () => {
  it("o nome escolhido (sem espaços nas pontas) ou o padrão \"Maestro · <workspace>\"", () => {
    expect(maestroSessionName(undefined, "Loja")).toBe("Maestro · Loja");
    expect(maestroSessionName({ sessionName: "   " }, "Loja")).toBe("Maestro · Loja");
    expect(maestroSessionName({ sessionName: "  Meu Maestro " }, "Loja")).toBe("Meu Maestro");
    expect(maestroSessionName({ sessionName: "x".repeat(100) }, "Loja")).toHaveLength(80);
    expect(defaultMaestroSessionName("Loja")).toBe("Maestro · Loja");
  });

  it("o schema recusa quebras de linha e caracteres de controle (o nome é digitado no terminal)", () => {
    expect(maestroSessionNameSchema.safeParse("Maestro do Harry").success).toBe(true);
    expect(maestroSessionNameSchema.safeParse("").success).toBe(true);
    expect(maestroSessionNameSchema.safeParse("a\n/exit").success).toBe(false);
    expect(maestroSessionNameSchema.safeParse("a\u001b[2J").success).toBe(false);
    expect(maestroSessionNameSchema.safeParse("x".repeat(81)).success).toBe(false);
  });
});
