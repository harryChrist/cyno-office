import type { EngineStatus } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { canUseAsDefault, defaultsWithEngine, defaultTargetsFor, engineDefaultFor, engineStateBadge } from "./enginesView";
import { checkGlyph, currentStep, FREE_LIMIT_NOTE, keyLine, paidModelWarning, priceLine, spentLine, verifyHeadline } from "./oneShotView";

const NOW = Date.parse("2026-11-12T12:00:00Z");

const engine = (patch: Partial<EngineStatus>): EngineStatus => ({ id: "openclaw", label: "OpenClaw", blurb: "", supported: true, state: "installed", ...patch });

describe("modelos do OpenRouter no seletor", () => {
  it("o preço sai por milhão de tokens e o modelo pago avisa que cobra do saldo (gratuito não avisa)", () => {
    expect(priceLine({ free: true })).toBe("gratuito");
    expect(priceLine({ free: false, promptPerM: 0.09, completionPerM: 0.18 })).toBe("US$ 0,09/M de entrada · US$ 0,18/M de saída");
    expect(priceLine(undefined)).toContain("não lido");
    expect(paidModelWarning({ choices: { model: "x" }, modelPrice: { free: false, promptPerM: 1, completionPerM: 2 } })).toContain("cobra do seu saldo do OpenRouter");
    expect(paidModelWarning({ choices: { model: "x:free" }, modelPrice: { free: true } })).toBeNull();
    expect(paidModelWarning({})).toBeNull();
  });

  it("a nota dos gratuitos só traz o que a documentação do OpenRouter diz", () => {
    expect(FREE_LIMIT_NOTE).toContain("20 por minuto e 50 por dia");
    expect(FREE_LIMIT_NOTE).toContain("documentação do OpenRouter");
  });
});

describe("chave, custo e Verificar", () => {
  it("a chave nunca aparece inteira: só 'termina em …abcd'", () => {
    expect(keyLine(undefined, NOW)).toBe("Nenhuma chave configurada.");
    expect(keyLine({ configured: false }, NOW)).toBe("Nenhuma chave configurada.");
    expect(keyLine({ configured: true, last4: "abcd", savedAt: new Date(NOW - 5 * 60_000).toISOString() }, NOW)).toBe("Configurada · termina em …abcd · guardada há 5 min");
  });

  it("o custo é informação (não alerta) e some quando é zero", () => {
    expect(spentLine({ usd: 0.0123, at: new Date(NOW - 60_000).toISOString() }, NOW)).toContain("US$ 0,0123");
    expect(spentLine({ usd: 0, at: new Date(NOW).toISOString() }, NOW)).toBeNull();
    expect(spentLine(undefined, NOW)).toBeNull();
  });

  it("o resumo do Verificar diz tudo certo, falta o turno ou quantos itens falharam", () => {
    const at = new Date(NOW - 3 * 60_000).toISOString();
    expect(verifyHeadline({ at, ok: true, checks: [] }, NOW)).toBe("Verificado há 3 min · tudo certo");
    expect(verifyHeadline({ at, ok: false, checks: [{ id: "a", label: "a", ok: true }], pendingTurn: { model: "m", notice: "n" } }, NOW)).toContain("falta só o turno de teste");
    expect(verifyHeadline({ at, ok: false, checks: [{ id: "a", label: "a", ok: false }, { id: "b", label: "b", ok: false }] }, NOW)).toContain("2 itens falharam");
    expect(checkGlyph({ id: "a", label: "a", ok: true })).toBe("✓");
    expect(checkGlyph({ id: "a", label: "a", ok: false })).toBe("✗");
    expect(checkGlyph({ id: "a", label: "a", ok: null })).toBe("–");
  });

  it("a etapa da vez é a com erro, senão a primeira que falta", () => {
    expect(currentStep([{ id: "install", label: "i", state: "done" }, { id: "key", label: "k", state: "current" }, { id: "model", label: "m", state: "todo" }])?.id).toBe("key");
    expect(currentStep([{ id: "install", label: "i", state: "done" }, { id: "key", label: "k", state: "done" }, { id: "model", label: "m", state: "error" }, { id: "verify", label: "v", state: "current" }])?.id).toBe("model");
  });
});

describe("a tela Motores com OpenClaw e Hermes", () => {
  it("o selo diz que falta a chave do OpenRouter (e não 'sem login')", () => {
    expect(engineStateBadge(engine({ state: "no_login" }), NOW).label).toBe("Falta a chave do OpenRouter");
    expect(engineStateBadge(engine({ state: "installed" }), NOW).label).toBe("Instalado · falta verificar");
    expect(engineStateBadge(engine({ state: "working" }), NOW).label).toBe("Funcionando");
    expect(engineStateBadge(engine({ id: "hermes", state: "not_installed" }), NOW).label).toBe("Não instalado");
  });

  it("'Usar como padrão' para o Maestro e os agentes, liberado com a conta e o modelo escolhido (nada bloqueia por custo)", () => {
    expect(defaultTargetsFor(engine({}))).toEqual(["maestro", "agentes"]);
    expect(canUseAsDefault(engine({ state: "not_installed" })).ok).toBe(false);
    expect(canUseAsDefault(engine({ state: "no_login" })).reason).toContain("chave do OpenRouter");
    expect(canUseAsDefault(engine({ state: "installed" })).reason).toContain("modelo");
    expect(canUseAsDefault(engine({ state: "installed", choices: { model: "deepseek/deepseek-v4-flash" } })).ok).toBe(true);
    expect(canUseAsDefault(engine({ state: "working", choices: { model: "x:free" } })).ok).toBe(true);
    // Configuração do próprio programa: sem conta ligada pede o provedor; o modelo padrão do programa basta.
    expect(canUseAsDefault(engine({ state: "no_login", account: { mode: "program", location: "personal" } })).reason).toContain("provedor");
    expect(canUseAsDefault(engine({ state: "installed", account: { mode: "program", location: "personal" }, program: { at: "", location: "personal", ok: true, providers: [], defaultModel: "openai/gpt-5", verified: true, command: "x" } })).ok).toBe(true);
  });

  it("usar como padrão guarda o motor e o modelo escolhido só nos agentes; o Maestro e os subagentes ficam como estavam", () => {
    const defaults = { maestro: { engine: "claude" as const, model: "sonnet" }, agentes: { engine: "claude" as const, model: "sonnet" }, subagentes: {} };
    const next = defaultsWithEngine(defaults, "openclaw", "agentes", { model: "deepseek/deepseek-v4-flash", effort: "low" });
    expect(next.agentes).toEqual({ engine: "openclaw", model: "deepseek/deepseek-v4-flash", effort: "low" });
    expect(next.maestro).toEqual(defaults.maestro);
    expect(defaultsWithEngine(defaults, "hermes", "agentes", { model: "m", effort: "high" }).agentes).toEqual({ engine: "hermes", model: "m" });
    // O Maestro também pode usar o motor (sem bloqueio por papel).
    expect(defaultsWithEngine(defaults, "openclaw", "maestro", { model: "m" }).maestro).toEqual({ engine: "openclaw", model: "m" });
    expect(engineDefaultFor(next, "openclaw")).toEqual(["agentes"]);
    expect(engineDefaultFor(next, "hermes")).toEqual([]);
  });
});
