import { INITIAL_MODEL_DEFAULTS, type EngineStatus } from "@cyno/shared";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EngineCard, type EngineCardProps } from "./EnginesPanel";
import { canUseAsDefault, defaultsWithEngine, engineDefaultFor, enginePathLine, engineStateBadge, engineTestLine, engineVersionLine, loginInstruction } from "./enginesView";

const NOW = Date.parse("2026-11-12T15:00:00Z");

const claude: EngineStatus = {
  id: "claude",
  label: "Claude Code",
  blurb: "A CLI do Claude Code.",
  supported: true,
  state: "working",
  version: "2.1.322 (Claude Code)",
  path: "/home/x/.local/bin/claude",
  pathSource: "path",
  loginCommand: "claude",
  lastTest: { ok: true, ms: 1800, at: "2026-11-12T12:00:00.000Z", text: "ok", tokens: 320, model: "haiku" },
};
const freebuff: EngineStatus = { id: "freebuff", label: "Freebuff", blurb: "Terminal gratuito.", supported: false, state: "installed", version: "0.2.36", path: "/home/x/.local/bin/freebuff", pathSource: "path", loginCommand: "freebuff login", notice: "O suporte chega numa próxima entrega." };
const hermes: EngineStatus = { id: "hermes", label: "Hermes", blurb: "Agente da Nous.", supported: false, state: "not_installed", notice: "O suporte chega numa próxima entrega." };

const card = (engine: EngineStatus, extra: Partial<EngineCardProps> = {}) =>
  renderToStaticMarkup(
    createElement(EngineCard, { engine, defaults: INITIAL_MODEL_DEFAULTS, now: NOW, testing: false, anyTesting: false, configOpen: false, onTest: () => undefined, onToggleConfig: () => undefined, onUseAsDefault: () => undefined, ...extra }),
  );

describe("estados da tela Motores", () => {
  it("o selo de cada estado", () => {
    expect(engineStateBadge(claude, NOW)).toEqual({ tone: "success", label: "Funcionando" });
    expect(engineStateBadge({ ...claude, state: "installed" }, NOW).label).toBe("Instalado");
    expect(engineStateBadge({ ...claude, state: "no_login" }, NOW)).toEqual({ tone: "attention", label: "Sem login" });
    expect(engineStateBadge({ ...claude, state: "not_installed" }, NOW).label).toBe("Não instalado");
    expect(engineStateBadge(freebuff, NOW).label).toBe("Instalado · em breve");
    expect(engineStateBadge(hermes, NOW).label).toBe("Não instalado · em breve");
    const quota = engineStateBadge({ ...claude, state: "no_quota", resetsAt: "2026-11-12T16:30:00.000Z" }, NOW);
    expect(quota.tone).toBe("danger");
    expect(quota.label).toMatch(/^Sem cota · volta às \d\d:\d\d$/);
    expect(engineStateBadge({ ...claude, state: "no_quota" }, NOW).label).toBe("Sem cota");
  });

  it("versão, caminho com a origem e o último teste (tempo, tokens, erro)", () => {
    expect(engineVersionLine(claude)).toBe("Versão 2.1.322 (Claude Code)");
    expect(engineVersionLine(hermes)).toBe("Executável não encontrado.");
    expect(engineVersionLine({ ...freebuff, version: undefined as unknown as string })).toMatch(/versão não lida/);
    expect(enginePathLine(claude)).toBe("/home/x/.local/bin/claude · achado no PATH");
    expect(enginePathLine({ ...claude, pathSource: "env" })).toContain("variável de ambiente");
    expect(enginePathLine({ ...claude, pathSource: "config" })).toContain("escolhido aqui");
    expect(enginePathLine(hermes)).toBe("");
    expect(engineTestLine(claude.lastTest!, NOW)).toEqual({ ok: true, text: "Testado há 3 h · 1,8 s · 320 tokens · haiku" });
    expect(engineTestLine({ ok: false, ms: 90_000, at: "2026-11-12T14:58:00.000Z", error: "Sem login ou login expirado." }, NOW)).toEqual({ ok: false, text: "Testado há 2 min · falhou: Sem login ou login expirado." });
  });

  it("'usar como padrão': libera com o motor instalado e com login; bloqueia o resto com o motivo", () => {
    expect(canUseAsDefault(claude)).toEqual({ ok: true });
    expect(canUseAsDefault({ ...claude, state: "not_installed" })).toMatchObject({ ok: false, reason: expect.stringContaining("Instale") });
    expect(canUseAsDefault({ ...claude, state: "no_login" })).toMatchObject({ ok: false, reason: expect.stringContaining("Entre") });
    expect(canUseAsDefault(freebuff).ok).toBe(false);
    expect(loginInstruction(claude)).toBe("claude");
    expect(loginInstruction(freebuff)).toBeNull();
    expect(loginInstruction({ ...claude, state: "not_installed" })).toBeNull();
  });

  it("os padrões depois de 'usar como padrão' reaproveitam o modelo inicial do motor (sem copiar a tabela)", () => {
    const base = INITIAL_MODEL_DEFAULTS;
    const toGemini = defaultsWithEngine(base, "gemini", "agentes");
    expect(toGemini.agentes).toEqual({ engine: "gemini", model: "gemini-3.8-flash-medium" });
    expect(toGemini.maestro).toEqual(base.maestro);
    // Já era o mesmo motor: mantém o modelo escolhido.
    const custom = { ...base, agentes: { engine: "claude" as const, model: "opus", effort: "high" as const } };
    expect(defaultsWithEngine(custom, "claude", "agentes").agentes).toEqual({ engine: "claude", model: "opus", effort: "high" });
    // Subagentes: o motor ganha o modelo leve, sem mexer no que já estava.
    expect(defaultsWithEngine({ ...base, subagentes: {} }, "gemini", "subagentes").subagentes).toEqual({ gemini: { model: "gemini-3.8-flash-medium" } });
    expect(base.agentes).toEqual(INITIAL_MODEL_DEFAULTS.agentes);
    expect(engineDefaultFor(toGemini, "gemini")).toContain("agentes");
    expect(engineDefaultFor(null, "claude")).toEqual([]);
  });
});

describe("cartão de motor", () => {
  it("motor funcionando: estado, versão, caminho, último teste, botões e padrão atual", () => {
    const html = card(claude);
    expect(html).toContain('data-testid="settings-engine-claude"');
    expect(html).toContain("Funcionando");
    expect(html).toContain("Versão 2.1.322 (Claude Code)");
    expect(html).toContain("achado no PATH");
    expect(html).toContain("Testado há 3 h");
    expect(html).toContain('data-testid="engine-test"');
    expect(html).toContain('data-testid="engine-configure"');
    expect(html).toContain("Usar como padrão para");
    expect(html).toContain("Padrão para:");
  });

  it("em breve: só o estado detectado e o texto do que falta, sem Testar nem instalar", () => {
    const html = card(freebuff);
    expect(html).toContain("Instalado · em breve");
    expect(html).toContain("Versão 0.2.36");
    expect(html).toContain("O suporte chega numa próxima entrega.");
    expect(html).not.toContain('data-testid="engine-test"');
    expect(html).not.toContain("Instalar");
    expect(html).not.toContain("Usar como padrão para");
    expect(card(hermes)).toContain("Executável não encontrado.");
  });

  it("sem login mostra o comando de entrada; testando desliga os botões; erro do teste aparece", () => {
    expect(card({ ...claude, state: "no_login", lastTest: undefined })).toContain("<code>claude</code>");
    const busy = card(claude, { testing: true, anyTesting: true });
    expect(busy).toContain("Testando…");
    expect(busy).toMatch(/data-testid="engine-test"[^>]*disabled|disabled[^>]*data-testid="engine-test"/);
    expect(card(claude, { testError: "Testou há pouco. Espere 12 s para testar de novo." })).toContain("Espere 12 s");
  });

  it("Configurar aberto: caminho em uso, padrão de modelos reaproveitado e como entrar", () => {
    const html = card(claude, { configOpen: true, config: createElement("span", null, "FORM"), onOpenModels: () => undefined });
    expect(html).toContain('data-testid="engine-config"');
    expect(html).toContain("FORM");
    expect(html).toContain("Editar em Modelos padrão");
    expect(html).toContain("Como entrar");
    expect(html).toContain("O Cyno nunca toca na sua senha");
  });
});
