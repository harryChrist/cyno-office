import { INITIAL_MODEL_DEFAULTS, type EngineStatus } from "@cyno/shared";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EngineCard } from "./EnginesPanel";
import { defaultTargetsFor, defaultsWithEngine, engineDefaultFor } from "./enginesView";
import { FreebuffSection, freebuffChoiceLine, freebuffTestWarning } from "./FreebuffSection";

const NOW = Date.parse("2026-11-12T15:00:00Z");
const iso = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString();

const info: NonNullable<EngineStatus["freebuff"]> = {
  settings: { model: "DeepSeek V4.1 Flash", effort: "high", maxOpenHours: 1 },
  modelFound: true,
  multiplier: 2,
  models: [
    { name: "DeepSeek V4.1 Flash Slow", multiplier: 1, efforts: ["low"], defaultEffort: "low", section: "STANDARD" },
    { name: "DeepSeek V4.1 Flash", multiplier: 2, efforts: ["low", "high"], defaultEffort: "high", section: "PREMIUM" },
  ],
  modelsReadAt: iso(-12),
  hours: { total: 21, remaining: 17, wallet: 25, resetsAt: iso(510), measuredAt: iso(-3), openedSince: 0 },
  sessions: [{ agentId: "beto", agentName: "Beto", workspaceId: "ws", openedAt: iso(-23), endsAt: iso(37), endsAtSource: "measured", multiplier: 2, model: "DeepSeek V4.1 Flash", hasProcess: true }],
};
const freebuff: EngineStatus = { id: "freebuff", label: "Freebuff", blurb: "Terminal gratuito.", supported: true, state: "installed", version: "0.2.36", path: "/home/x/.local/bin/freebuff", pathSource: "path", loginCommand: "freebuff login", freebuff: info };

const section = (extra: Partial<Parameters<typeof FreebuffSection>[0]> = {}) =>
  renderToStaticMarkup(createElement(FreebuffSection, { engine: freebuff, now: NOW, onStatus: () => undefined, confirming: false, testing: false, onConfirmTest: () => undefined, onCancelTest: () => undefined, ...extra }));

describe("Freebuff na tela Motores", () => {
  it("o modelo da plataforma com o custo em horas, a lista lida e o teto de horas abertas", () => {
    expect(freebuffChoiceLine(info)).toBe("DeepSeek V4.1 Flash · high · gasta 2 horas por hora aberta");
    const html = section();
    expect(html).toContain("DeepSeek V4.1 Flash · high · gasta 2 horas por hora aberta");
    expect(html).toContain("DeepSeek V4.1 Flash Slow · 1x");
    expect(html).toContain("DeepSeek V4.1 Flash · 2x");
    expect(html).toContain('data-testid="freebuff-max-open"');
    expect(html).toContain("Atualizar modelos");
    expect(html).toContain("2 modelos, lista lida há 12 min.");
  });

  it("as horas do dia (medido) e a hora em uso por agente", () => {
    const html = section();
    expect(html).toContain("4/21 h");
    expect(html).toContain("restam 17 h");
    expect(html).toContain("25 h na carteira");
    expect(html).toContain("Medido: lido na tela do Freebuff há 3 min.");
    expect(html).toContain("Beto");
    expect(html).toContain("hora em uso: restam 37 min");
  });

  it("antes de ler a lista: o aviso de que a sondagem não manda mensagem nem gasta hora", () => {
    const html = section({ engine: { ...freebuff, freebuff: { ...info, models: [], modelsReadAt: undefined as never } } });
    expect(html).toContain("Lista ainda não lida");
    expect(html).toContain("não gasta hora");
  });

  it("o Testar avisa quanto gasta e pede a confirmação antes de rodar", () => {
    expect(freebuffTestWarning(info)).toBe("Este teste abre uma hora do Freebuff: gasta 2 horas das suas horas de hoje.");
    expect(freebuffTestWarning({ ...info, multiplier: 1 })).toBe("Este teste abre uma hora do Freebuff: gasta 1 hora das suas horas de hoje.");
    expect(section()).not.toContain("freebuff-test-confirm");
    const html = section({ confirming: true });
    expect(html).toContain('data-testid="freebuff-test-confirm"');
    expect(html).toContain("gasta 2 horas das suas horas de hoje");
    expect(html).toContain("Gastar e testar");
  });

  it("o cartão do Freebuff: 'Usar como padrão' para o Maestro e os agentes (os subagentes não)", () => {
    expect(defaultTargetsFor(freebuff)).toEqual(["maestro", "agentes"]);
    expect(defaultTargetsFor({ id: "claude" })).toEqual(["maestro", "agentes", "subagentes"]);
    const html = renderToStaticMarkup(
      createElement(EngineCard, { engine: freebuff, defaults: INITIAL_MODEL_DEFAULTS, now: NOW, testing: false, anyTesting: false, configOpen: false, onTest: () => undefined, onToggleConfig: () => undefined, onUseAsDefault: () => undefined, extra: createElement(FreebuffSection, { engine: freebuff, now: NOW, onStatus: () => undefined, confirming: false, testing: false, onConfirmTest: () => undefined, onCancelTest: () => undefined }) }),
    );
    expect(html).toContain('data-testid="engine-default-agentes"');
    expect(html).toContain('data-testid="engine-default-maestro"');
    expect(html).not.toContain('data-testid="engine-default-subagentes"');
    expect(html).toContain("Usar como padrão (sem subagentes) para");
    const next = defaultsWithEngine(INITIAL_MODEL_DEFAULTS, "freebuff", "agentes");
    expect(next.agentes).toEqual({ engine: "freebuff" });
    expect(next.maestro).toEqual(INITIAL_MODEL_DEFAULTS.maestro);
    expect(defaultsWithEngine(INITIAL_MODEL_DEFAULTS, "freebuff", "maestro").maestro).toEqual({ engine: "freebuff" });
    expect(engineDefaultFor(next, "freebuff")).toEqual(["agentes"]);
    expect(engineDefaultFor(INITIAL_MODEL_DEFAULTS, "freebuff")).toEqual([]);
  });
});
