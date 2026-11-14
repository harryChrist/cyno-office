import { describe, expect, it } from "vitest";
import { freebuffBlock, freebuffCostText, freebuffHoldsHour, freebuffMinutesLeft, type FreebuffUsageDetail } from "./freebuff";
import { engineBlock, engineBlockLabel, INITIAL_MODEL_DEFAULTS, modelDefaultsSchema, type AvailabilityContext } from "./models";
import { canonicalToolName } from "./work-phrase";
import { engineRoleNote, terminalStateView } from "./terminal";

const NOW = Date.parse("2026-11-12T15:00:00.000Z");
const iso = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString();

function detail(overrides: Partial<FreebuffUsageDetail> = {}): FreebuffUsageDetail {
  return {
    settings: { model: "DeepSeek V4.1 Flash", effort: "high", maxOpenHours: 1, multiplier: 2 },
    hours: { total: 21, remaining: 15, wallet: 0, resetsAt: iso(9 * 60), openedSince: 0 },
    sessions: [],
    ...overrides,
  };
}

const session = (agentId: string, minutes: number, workspaceId = "ws") => ({ agentId, agentName: agentId.toUpperCase(), workspaceId, openedAt: iso(minutes - 60), endsAt: iso(minutes), endsAtSource: "measured" as const, multiplier: 2, model: "DeepSeek V4.1 Flash", hasProcess: true });

describe("freebuffBlock: quem espera pela hora do Freebuff", () => {
  it("sem hora aberta e com saldo, ninguém espera", () => {
    expect(freebuffBlock(detail(), { agentId: "ana" }, NOW)).toBeUndefined();
    expect(freebuffBlock(undefined, { agentId: "ana" }, NOW)).toBeUndefined();
  });

  it("com o teto cheio, o outro agente espera pelo dono da hora, com o nome e a hora em que ela acaba; o dono nunca espera", () => {
    const state = detail({ sessions: [session("ana", 37)] });
    expect(freebuffBlock(state, { agentId: "beto", workspaceId: "ws" }, NOW)).toEqual({ reason: "hour", holder: "ANA", resetsAt: iso(37) });
    expect(freebuffBlock(state, { agentId: "ana", workspaceId: "ws" }, NOW)).toBeUndefined();
    // O mesmo id em outro workspace é outro agente.
    expect(freebuffBlock(state, { agentId: "ana", workspaceId: "outro" }, NOW)).toMatchObject({ reason: "hour" });
    // Hora que já acabou não conta.
    expect(freebuffBlock(detail({ sessions: [session("ana", -1)] }), { agentId: "beto" }, NOW)).toBeUndefined();
  });

  it("o teto sobe: com 2 horas abertas ao mesmo tempo o segundo anda", () => {
    const state = detail({ settings: { model: "m", effort: "high", maxOpenHours: 2, multiplier: 2 }, sessions: [session("ana", 37)] });
    expect(freebuffBlock(state, { agentId: "beto" }, NOW)).toBeUndefined();
  });

  it("o pedido que ainda está abrindo a hora já reserva a vaga", () => {
    const state = detail({ pending: [{ agentId: "ana", agentName: "Ana", workspaceId: "ws" }] });
    expect(freebuffBlock(state, { agentId: "beto", workspaceId: "ws" }, NOW)).toEqual({ reason: "hour", holder: "Ana" });
    expect(freebuffBlock(state, { agentId: "ana", workspaceId: "ws" }, NOW)).toBeUndefined();
  });

  it("sem horas no dia: sem cota, com a hora em que o dia vira; a carteira paga depois do saldo", () => {
    const empty = detail({ hours: { total: 21, remaining: 1, wallet: 0, resetsAt: iso(9 * 60), openedSince: 0 } });
    expect(freebuffBlock(empty, { agentId: "ana" }, NOW)).toEqual({ reason: "quota", resetsAt: iso(9 * 60) });
    expect(freebuffBlock({ ...empty, hours: { ...empty.hours, wallet: 25 } }, { agentId: "ana" }, NOW)).toBeUndefined();
    // O modelo de 1x cabe em 1 hora.
    expect(freebuffBlock({ ...empty, settings: { ...empty.settings, multiplier: 1 } }, { agentId: "ana" }, NOW)).toBeUndefined();
  });

  it("minutos que faltam e quem segura hora", () => {
    const state = detail({ sessions: [session("ana", 37)] });
    expect(freebuffMinutesLeft(state, { agentId: "ana" }, NOW)).toBe(37);
    expect(freebuffMinutesLeft(state, { agentId: "beto" }, NOW)).toBeUndefined();
    expect(freebuffHoldsHour(state, { agentId: "ana" }, NOW)).toBe(true);
    expect(freebuffHoldsHour(state, { agentId: "beto" }, NOW)).toBe(false);
    expect(freebuffCostText(2)).toBe("2 horas por hora aberta");
    expect(freebuffCostText(1)).toBe("1 hora por hora aberta");
  });
});

describe("o Freebuff nas regras de disponibilidade dos motores", () => {
  const context = (state: FreebuffUsageDetail): AvailabilityContext => ({ usage: [{ provider: "freebuff", windows: [], updatedAt: iso(0), freebuff: state }], now: NOW });

  it("engineBlock usa o estado do Freebuff e o texto diz o agente e a hora", () => {
    const block = engineBlock("freebuff", context(detail({ sessions: [session("ana", 37)] })), undefined, { agentId: "beto", workspaceId: "ws" });
    expect(block).toMatchObject({ reason: "hour", holder: "ANA" });
    expect(engineBlockLabel(block!, NOW, "UTC")).toBe("esperando a hora do Freebuff de ANA acabar (às 15:37)");
    expect(engineBlock("claude", context(detail({ sessions: [session("ana", 37)] })), undefined, { agentId: "beto" })).toBeUndefined();
  });

  it("o estado do terminal diz o motivo da espera", () => {
    const view = terminalStateView("freebuff", undefined, { label: "esperando a hora do Freebuff de ANA acabar", reason: "hour" });
    expect(view.key).toBe("sem_cota");
    expect(view.label).toBe("Esperando a hora do Freebuff de ANA acabar");
    expect(view.detail).toMatch(/hora aberta/);
  });
});

describe("o Freebuff em qualquer papel", () => {
  it("o Maestro e o Cyno aceitam o Freebuff, o OpenClaw e o Hermes nos modelos padrão (com aviso, sem bloqueio)", () => {
    const base = JSON.parse(JSON.stringify(INITIAL_MODEL_DEFAULTS)) as typeof INITIAL_MODEL_DEFAULTS;
    for (const engine of ["freebuff", "openclaw", "hermes", "claude", "gemini"] as const) {
      expect(modelDefaultsSchema.safeParse({ ...base, agentes: { engine } }).success).toBe(true);
      expect(modelDefaultsSchema.safeParse({ ...base, maestro: { engine } }).success).toBe(true);
      expect(modelDefaultsSchema.safeParse({ ...base, cyno: { engine } }).success).toBe(true);
    }
  });

  it("cada motor diz em uma linha o que muda no papel (Claude Code e Antigravity não têm aviso)", () => {
    expect(engineRoleNote("claude", "maestro")).toBeUndefined();
    expect(engineRoleNote("gemini", "cyno")).toBeUndefined();
    expect(engineRoleNote("freebuff", "maestro")).toMatch(/segura uma hora aberta/);
    expect(engineRoleNote("freebuff", "cyno")).toMatch(/Cyno acordado segura uma hora aberta/);
    expect(engineRoleNote("openclaw", "maestro")).toMatch(/lembra por resumo/);
    expect(engineRoleNote("openclaw", "agent")).toMatch(/sem atividade ao vivo/);
    expect(engineRoleNote("hermes", "cyno")).toMatch(/retoma a sessão salva/);
    expect(engineRoleNote("hermes", "agent")).toMatch(/testado com o programa de verdade/i);
  });

  it("as ferramentas do Freebuff têm o nome do vocabulário comum (frase de atividade)", () => {
    expect(canonicalToolName("run_terminal_command")).toBe("Bash");
    expect(canonicalToolName("read_files")).toBe("Read");
    expect(canonicalToolName("write_file")).toBe("Write");
    expect(canonicalToolName("str_replace")).toBe("Edit");
    expect(canonicalToolName("code_search")).toBe("Grep");
  });
});
