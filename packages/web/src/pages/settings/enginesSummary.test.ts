import { INITIAL_MODEL_DEFAULTS, type EngineStatus } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { engineAccountLine, engineModelLine, engineSummary, engineToOpenFirst } from "./enginesSummary";
import { stepView, verifyGroups } from "./oneShotView";

const NOW = Date.parse("2026-11-12T15:00:00Z");
const base = { blurb: "x", supported: true } as const;
const claude: EngineStatus = { ...base, id: "claude", label: "Claude Code", state: "working" };
const gemini: EngineStatus = { ...base, id: "gemini", label: "Antigravity", state: "no_login" };
const openclaw: EngineStatus = { ...base, id: "openclaw", label: "OpenClaw", state: "installed", account: { mode: "openrouter", location: "cyno" }, openrouterKey: { configured: true, last4: "a1b2" }, choices: { model: "google/gemma:free" } };
const hermes: EngineStatus = { ...base, id: "hermes", label: "Hermes", state: "not_installed" };
const freebuff: EngineStatus = {
  ...base,
  id: "freebuff",
  label: "Freebuff",
  state: "installed",
  freebuff: { settings: { model: "GLM 5", effort: "high", maxOpenHours: 1 }, models: [], hours: { total: 21, remaining: 17, openedSince: 0 }, sessions: [] },
};

describe("resumo dos motores", () => {
  it("motor funcionando: selo verde, ✓ e para quem é o padrão", () => {
    const summary = engineSummary(claude, INITIAL_MODEL_DEFAULTS, NOW);
    expect(summary).toMatchObject({ tone: "success", stateLabel: "Funcionando", icon: "✓", account: "Assinatura, conta da CLI" });
    expect(summary.usedFor).toContain("maestro");
  });

  it("falta conta, não instalado e com erro têm selo, símbolo e conta próprios", () => {
    expect(engineSummary(gemini, INITIAL_MODEL_DEFAULTS, NOW)).toMatchObject({ tone: "attention", icon: "!", account: "Falta entrar na conta" });
    expect(engineSummary(hermes, INITIAL_MODEL_DEFAULTS, NOW)).toMatchObject({ tone: "neutral", icon: "○", stateLabel: "Não instalado", account: "Sem conta (instale primeiro)" });
    const broken = engineSummary({ ...openclaw, verify: { at: "2026-11-12T14:00:00Z", ok: false, checks: [] } }, INITIAL_MODEL_DEFAULTS, NOW);
    expect(broken).toMatchObject({ tone: "danger", icon: "✕", stateLabel: "Com erro" });
    expect(engineSummary({ ...claude, lastTest: { ok: false, ms: 1, at: "2026-11-12T14:00:00Z", error: "x" } }, INITIAL_MODEL_DEFAULTS, NOW).stateLabel).toBe("Com erro");
  });

  it("conta e modelo do OpenClaw vêm da chave e da escolha; gasto e horas aparecem quando há", () => {
    expect(engineAccountLine(openclaw)).toBe("Chave do OpenRouter …a1b2");
    expect(engineAccountLine({ ...openclaw, openrouterKey: { configured: false } })).toBe("Falta a chave do OpenRouter");
    expect(engineAccountLine({ ...openclaw, account: { mode: "program", location: "personal" } })).toBe("Configuração do programa (pasta pessoal)");
    expect(engineModelLine(openclaw, null)).toBe("google/gemma:free");
    expect(engineModelLine({ ...openclaw, choices: undefined }, null)).toBe("Falta escolher o modelo");
    expect(engineSummary({ ...openclaw, spent: { usd: 0.37, at: "2026-11-12T14:00:00Z" } }, null, NOW).extra).toBe("Gasto US$ 0,37");
    expect(engineSummary(freebuff, null, NOW)).toMatchObject({ extra: "Restam 17/21 h hoje", model: "GLM 5 · high" });
  });

  it("em tela larga abre primeiro o motor que pede atenção, senão o primeiro", () => {
    expect(engineToOpenFirst([claude, gemini, openclaw], INITIAL_MODEL_DEFAULTS, NOW)).toBe("gemini");
    expect(engineToOpenFirst([claude, hermes], INITIAL_MODEL_DEFAULTS, NOW)).toBe("claude");
    expect(engineToOpenFirst([], null, NOW)).toBeNull();
  });
});

describe("etapas do passo a passo", () => {
  it("a da vez e a com erro abrem; a feita recolhe; a próxima esmaece; clicar reabre", () => {
    expect(stepView({ id: "key", state: "current" }, "key", false)).toBe("open");
    expect(stepView({ id: "verify", state: "error" }, "verify", false)).toBe("open");
    expect(stepView({ id: "install", state: "done" }, "key", false)).toBe("folded");
    expect(stepView({ id: "model", state: "todo" }, "key", false)).toBe("dim");
    expect(stepView({ id: "install", state: "done" }, "key", true)).toBe("open");
  });

  it("o Verificar separa o que falhou, o que não deu para checar e o que passou", () => {
    const groups = verifyGroups([
      { id: "a", label: "A", ok: true },
      { id: "b", label: "B", ok: false, fix: "faça" },
      { id: "c", label: "C", ok: null },
    ]);
    expect(groups.failed.map((check) => check.id)).toEqual(["b"]);
    expect(groups.skipped.map((check) => check.id)).toEqual(["c"]);
    expect(groups.passed.map((check) => check.id)).toEqual(["a"]);
  });
});
