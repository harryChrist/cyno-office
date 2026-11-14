import type { SubscriptionUsage } from "@cyno/shared";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NavUsageView } from "./nav/NavUsage";
import { usageViews } from "./usage";
import { UsagePanelView } from "./UsagePanel";

const minutes = (count: number) => new Date(Date.now() + count * 60_000).toISOString();

function claudeUsage(overrides: Partial<SubscriptionUsage> = {}): SubscriptionUsage {
  return {
    provider: "claude",
    status: "allowed",
    windows: [
      { id: "five_hour", utilization: 0.27, resetsAt: minutes(135) },
      { id: "seven_day", utilization: 0.91, resetsAt: minutes(3 * 24 * 60) },
    ],
    updatedAt: minutes(-2),
    source: "account",
    fetchedAt: minutes(-2),
    ...overrides,
  };
}

function antigravityUsage(overrides: Partial<SubscriptionUsage> = {}): SubscriptionUsage {
  return {
    provider: "gemini",
    windows: [
      { id: "five_hour", utilization: 0.12, resetsAt: minutes(200), label: "Sessão 5h", group: "Modelos Gemini" },
      { id: "seven_day", utilization: 0.05, resetsAt: minutes(5000), label: "Semana", group: "Modelos Gemini" },
      { id: "five_hour_claude_gpt", utilization: 0, label: "Sessão 5h", group: "Claude e GPT" },
      { id: "seven_day_claude_gpt", utilization: 0, label: "Semana", group: "Claude e GPT" },
      { id: "seven_day_gemini_4_argon", utilization: 0, label: "Semana", group: "Gemini 4 Argon" },
    ],
    updatedAt: minutes(-1),
    source: "account",
    fetchedAt: minutes(-1),
    ...overrides,
  };
}

const views = (...usages: SubscriptionUsage[]) => usageViews(Object.fromEntries(usages.map((usage) => [usage.provider, usage])), Date.now());
const menu = (...usages: SubscriptionUsage[]) => renderToStaticMarkup(createElement(NavUsageView, { views: views(...usages), open: false }));
const panel = (usages: SubscriptionUsage[], extra: { workspaceOpen?: boolean } = {}) =>
  renderToStaticMarkup(createElement(UsagePanelView, { views: views(...usages), now: Date.now(), workspaceOpen: extra.workspaceOpen ?? false, missingAntigravity: false, onClose: () => undefined, titleId: "t" }));

describe("bloco 'Uso do plano' do menu (NavUsage)", () => {
  it("sem nenhuma leitura de uso, não aparece", () => {
    expect(menu()).toBe("");
  });

  it("uma linha por motor com a barra da janela mais apertada e a porcentagem", () => {
    const html = menu(claudeUsage(), antigravityUsage());
    expect(html).toContain('data-testid="nav-usage"');
    expect(html.match(/data-testid="nav-usage-row"/g)).toHaveLength(2);
    // Claude: a semana (91%) é a mais apertada; Antigravity: a sessão de 5 h (12%).
    expect(html).toMatch(/data-provider="claude"[^>]*>[\s\S]*?Claude[\s\S]*?width:91%[\s\S]*?91%/);
    expect(html).toMatch(/data-provider="gemini"[^>]*>[\s\S]*?Antigravity[\s\S]*?width:12%[\s\S]*?12%/);
    expect(html).toContain("navusage__row--danger");
    // O ponto de alerta existe (aparece só com o menu recolhido, pelo CSS) e o rótulo resume.
    expect(html).toContain('data-testid="nav-usage-dot"');
    expect(html).toContain("Uso do plano: Claude 91%, Antigravity 12%");
    expect(html).toContain('aria-expanded="false"');
  });

  it("dado antigo: sinal ⏱ e linha esmaecida, sem cor de alerta; sem janela, '–'", () => {
    const html = menu(claudeUsage({ updatedAt: minutes(-42), fetchedAt: minutes(-42) }));
    expect(html).toContain("navusage__row--old");
    expect(html).toContain("⏱");
    expect(html).not.toContain("navusage__row--danger");
    expect(html).toContain("(dado antigo)");
    // O ponto avisa de dado antigo (âmbar) mesmo sem perigo.
    expect(html).toContain("navusage__dot--warn");
  });

  it("a janela renovada mostra ↻, nunca o número antigo", () => {
    const html = menu(claudeUsage({ windows: [{ id: "five_hour", utilization: 0.9, resetsAt: minutes(-5) }], updatedAt: minutes(-20), fetchedAt: minutes(-20) }));
    expect(html).toContain("↻");
    expect(html).not.toContain("90%");
  });
});

describe("painel de detalhe (UsagePanel)", () => {
  it("destaca a janela mais perto do limite e agrupa por motor, com a renovação curta", () => {
    const html = panel([claudeUsage(), antigravityUsage()]);
    expect(html).toContain("Uso do plano");
    expect(html).toContain('data-testid="usage-closest"');
    expect(html).toMatch(/usagep__closest-name">Claude · Semana<\/span><span class="usagep__closest-pct ui-tabular">91%/);
    expect(html.match(/data-testid="usage-provider"/g)).toHaveLength(2);
    // Renovação em forma curta ("renova 2 h 15 min", "renova 3 d"), a hora exata só na dica.
    expect(html).toMatch(/renova 2 h 1[45] min/);
    expect(html).toContain("renova 3 d");
    expect(html).not.toContain(">renova às");
    expect(html).toContain("renova 3 d</p>");
    expect(html).toContain('title="renova');
    // Um botão de atualizar por motor (a conta é consultada pelo servidor).
    expect(html).toContain('data-testid="usage-refresh" data-provider="claude"');
    expect(html).toContain('data-testid="usage-refresh" data-provider="gemini"');
  });

  it("sem janela a partir de 50%, não há destaque", () => {
    expect(panel([claudeUsage({ windows: [{ id: "five_hour", utilization: 0.2 }, { id: "seven_day", utilization: 0.3 }] })])).not.toContain('data-testid="usage-closest"');
  });

  it("grupos do Antigravity sem uso ficam recolhidos numa linha ('2 grupos sem uso')", () => {
    const html = panel([antigravityUsage()]);
    expect(html).toContain('data-testid="usage-idle-groups"');
    expect(html).toContain("2 grupos sem uso");
    expect(html).toContain("Gemini 4 Argon");
    expect(html).toContain("Claude e GPT");
    // O grupo com uso aparece aberto; os sem uso (todas as janelas em 0%) ficam só na linha recolhida.
    expect(html).toMatch(/data-group="Modelos Gemini"/);
    expect(html).not.toMatch(/data-group="Gemini 4 Argon"/);
    expect(html).not.toMatch(/data-group="Claude e GPT"/);
  });

  it("leitura antiga: esmaecida, com a idade ao lado; janela renovada: '↻ renovada', trilho vazio", () => {
    const html = panel([
      claudeUsage({
        windows: [
          { id: "five_hour", utilization: 0.9, resetsAt: minutes(-5) },
          { id: "seven_day", utilization: 0.6, resetsAt: minutes(4000) },
        ],
        updatedAt: minutes(-42),
        fetchedAt: minutes(-42),
      })
    ]);
    expect(html).toContain("usagep__window--renewed");
    expect(html).toContain("↻ renovada");
    expect(html).toContain("usagep__bar--empty");
    expect(html).toContain("usagep__window--old");
    expect(html).toContain('data-testid="usage-window-age"');
    expect(html).toContain("há 42 min");
    // Dado antigo nunca vira alarme: sem destaque de "mais perto do limite".
    expect(html).not.toContain('data-testid="usage-closest"');
  });

  it("sem dado nenhum, explica; com a consulta falhando, mostra o aviso e o último valor", () => {
    expect(panel([])).toContain('data-testid="usage-empty"');
    const html = panel([claudeUsage({ stale: { reason: "Login do Claude Code expirado", since: minutes(-10) } })]);
    expect(html).toContain("Login do Claude Code expirado");
    expect(html).toContain("mostrando o último valor");
  });

  it("o 'Por agente' e o link de gastos só aparecem com um workspace aberto", () => {
    expect(panel([claudeUsage()])).not.toContain('data-testid="usage-agents"');
    const html = panel([claudeUsage()], { workspaceOpen: true });
    expect(html).toContain('data-testid="usage-agents"');
    expect(html).toContain('data-testid="usage-agents-spend"');
  });
});
