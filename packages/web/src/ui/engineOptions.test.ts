import type { EngineInfo } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { engineOptions, EngineFields, shownVersion } from "./EngineFields";

const ENGINES: EngineInfo[] = [
  { engine: "mock", label: "Simulado", available: true, models: [], freeModel: false },
  { engine: "claude", label: "Claude Code", available: true, version: "2.1.319 (Claude Code)", models: [{ id: "sonnet" }], freeModel: true },
  { engine: "gemini", label: "Antigravity", available: false, reason: "comando agy não encontrado", models: [], freeModel: false },
];

describe("seletor de motor", () => {
  it("mostra o simulado e só as CLIs instaladas (com a versão)", () => {
    expect(engineOptions(ENGINES, "mock")).toEqual([
      { engine: "mock", label: "Simulado", disabled: false },
      { engine: "claude", label: "Claude Code · 2.1.319", disabled: false },
    ]);
  });

  it("sem o modo simulado: nada de motor simulado; agente antigo em mock aparece como 'Sem motor'", () => {
    const real = ENGINES.filter((info) => info.engine !== "mock");
    expect(engineOptions(real, "claude", false).map((option) => option.engine)).toEqual(["claude"]);
    expect(engineOptions(real, "mock", false)).toEqual([
      { engine: "claude", label: "Claude Code · 2.1.319", disabled: false },
      { engine: "mock", label: "Sem motor (escolha um)", disabled: false },
    ]);
    expect(engineOptions(undefined, "claude", false)).toEqual([{ engine: "claude", label: "Claude Code", disabled: false }]);
  });

  it("o motor atual aparece mesmo sem a CLI instalada", () => {
    expect(engineOptions(ENGINES, "gemini").map((option) => option.label)).toEqual(["Simulado", "Claude Code · 2.1.319", "Antigravity (não instalado)"]);
    expect(engineOptions(undefined, "codex")).toEqual([
      { engine: "mock", label: "Simulado", disabled: false },
      { engine: "codex", label: "Codex", disabled: false },
    ]);
  });

  it("os cinco motores ficam liberados para qualquer papel (nada desligado por papel) e cada um avisa o que muda", () => {
    const five: EngineInfo[] = (["claude", "gemini", "freebuff", "openclaw", "hermes"] as const).map((engine) => ({ engine, label: engine, available: true, models: [], freeModel: true }));
    expect(engineOptions(five, "claude", false).every((option) => !option.disabled)).toBe(true);
    const html = (engine: "freebuff" | "openclaw" | "hermes" | "claude", role: "maestro" | "cyno" | "agent") => renderToStaticMarkup(createElement(EngineFields, { values: { engine, model: "", effort: "" }, onChange: () => undefined, locked: false, role }));
    expect(html("freebuff", "maestro")).toContain("segura uma hora aberta");
    expect(html("openclaw", "cyno")).toContain("lembra por resumo");
    expect(html("hermes", "maestro")).toContain("retoma a sessão salva");
    expect(html("claude", "maestro")).not.toContain("engine-note");
    expect(html("openclaw", "agent")).toContain("sem atividade ao vivo");
  });
});

describe("shownVersion", () => {
  it("esconde a versão 0.0.0 (não lida) e corta o resto do texto", () => {
    expect(shownVersion("0.0.0")).toBe("");
    expect(shownVersion(undefined)).toBe("");
    expect(shownVersion("2.1.319 (Claude Code)")).toBe("2.1.319");
  });
});
