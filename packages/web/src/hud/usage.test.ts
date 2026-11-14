import type { SubscriptionUsage } from "@cyno/shared";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProviderUsagePlaceholder, UsageMeter } from "./UsageMeter";
import {
  agentUsageRows,
  formatTokens,
  resetLabel,
  sessionWindowStart,
  updatedLabel,
  usageAlert,
  closestToLimit,
  planRows,
  planSummary,
  shortReset,
  splitIdleGroups,
  tightestWindow,
  usageTooltip,
  usageView,
  usageViews,
} from "./usage";

const NOW = Date.parse("2026-11-08T12:00:00Z");
/** O Intl separa "12,3 mil" com espaço que não quebra; nos testes, espaço comum. */
const plain = (text: string) => text.replace(/\u00a0/g, " ");
const clock = (iso: string) => {
  const at = new Date(iso);
  return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
};

const claude: SubscriptionUsage = {
  provider: "claude",
  status: "allowed",
  windows: [
    { id: "seven_day", utilization: 0.44, resetsAt: "2026-11-11T12:00:00.000Z" },
    { id: "five_hour", utilization: 0.27, resetsAt: "2026-11-08T14:15:00.000Z", status: "allowed" },
  ],
  updatedAt: "2026-11-08T11:57:00.000Z",
};

describe("uso da assinatura (interface)", () => {
  it("resume em uma linha, com as janelas em ordem (Sessão 5h, Semana)", () => {
    const view = usageView(claude, NOW);
    expect(view.summary).toBe("Claude · Sessão 5h 27% · Semana 44%");
    expect(view.warn).toBe(false);
    expect(view.updatedLabel).toBe("atualizado há 3 min");
    expect(view.account).toBe(false);
    expect(view.windows.map((window) => [window.label, window.percent, window.tone])).toEqual([
      ["Sessão 5h", 27, "ok"],
      ["Semana", 44, "ok"],
    ]);
  });

  it("cor por faixa: normal abaixo de 50%, atenção de 50 a 79%, perigo de 80% em diante, crítica ou barrada", () => {
    const tone = (window: SubscriptionUsage["windows"][number]) => usageView({ ...claude, windows: [window] }, NOW).windows[0]!.tone;
    expect(tone({ id: "five_hour", utilization: 0.49 })).toBe("ok");
    expect(tone({ id: "five_hour", utilization: 0.5 })).toBe("warn");
    expect(tone({ id: "five_hour", utilization: 0.79 })).toBe("warn");
    expect(tone({ id: "five_hour", utilization: 0.8 })).toBe("danger");
    expect(tone({ id: "five_hour", utilization: 0.3, severity: "warning" })).toBe("warn");
    expect(tone({ id: "five_hour", utilization: 0.3, severity: "critical" })).toBe("danger");
    expect(tone({ id: "five_hour", utilization: 0.3, status: "rejected" })).toBe("danger");
    expect(tone({ id: "five_hour", utilization: 0.3, severity: "normal" })).toBe("ok");
    expect(usageView({ ...claude, status: "rejected", windows: [{ id: "five_hour", utilization: 0.1 }] }, NOW)).toMatchObject({ warn: true, tone: "danger" });
  });

  it("diz quando a janela renova, na hora local", () => {
    expect(resetLabel("2026-11-08T14:15:00.000Z", NOW)).toBe(`renova às ${clock("2026-11-08T14:15:00.000Z")} (em 2 h 15 min)`);
    expect(resetLabel("2026-11-08T12:40:00.000Z", NOW)).toBe(`renova em 40 min (às ${clock("2026-11-08T12:40:00.000Z")})`);
    expect(resetLabel("2026-11-11T12:00:00.000Z", NOW)).toMatch(/^renova \S+ às \d\d:\d\d \(em 3 d\)$/);
    // Nunca um reinício no passado (a janela renovada é tratada por usageWindowState).
    expect(resetLabel("2026-11-08T11:00:00.000Z", NOW)).toBe("");
    expect(resetLabel("2026-11-08T12:00:20.000Z", NOW)).toBe("renovando agora");
    expect(resetLabel(undefined, NOW)).toBe("");
    expect(resetLabel("lixo", NOW)).toBe("");
  });

  it("há quanto tempo atualizou", () => {
    expect(updatedLabel("2026-11-08T11:59:40.000Z", NOW)).toBe("atualizado agora");
    expect(updatedLabel("2026-11-08T11:48:00.000Z", NOW)).toBe("atualizado há 12 min");
    expect(updatedLabel("2026-11-08T09:30:00.000Z", NOW)).toBe("atualizado há 2 h 30 min");
    expect(updatedLabel(undefined, NOW)).toBe("");
  });

  it("uso da conta: escopo semanal, aviso de dado velho e botão de atualizar", () => {
    const account: SubscriptionUsage = {
      ...claude,
      windows: [...claude.windows, { id: "seven_day_opus", utilization: 0.86, severity: "warning" }],
      source: "account",
      fetchedAt: "2026-11-08T11:57:00.000Z",
      stale: { reason: "Sem conexão com a Anthropic", since: "2026-11-08T11:59:00.000Z" },
    };
    const view = usageView(account, NOW);
    expect(view.windows.map((window) => window.label)).toEqual(["Sessão 5h", "Semana", "Semana · Opus"]);
    expect(view).toMatchObject({ account: true, stale: "Sem conexão com a Anthropic", tone: "danger" });
    expect(usageAlert([view])?.window).toMatchObject({ label: "Semana · Opus", percent: 86 });
    expect(usageAlert([usageView(claude, NOW)])).toBeNull();
    // Falha antes de qualquer dado: aparece só com o aviso.
    const onlyStale = usageViews({ claude: { provider: "claude", windows: [], updatedAt: claude.updatedAt, stale: account.stale } }, NOW);
    expect(onlyStale).toHaveLength(1);
    expect(onlyStale[0]).toMatchObject({ windows: [], updatedLabel: "", stale: "Sem conexão com a Anthropic", account: true });
  });

  it("ignora o mock e provedores sem janelas; o tooltip tem uma linha por janela e a atualização", () => {
    const views = usageViews({ claude, mock: { ...claude, provider: "mock" }, codex: { ...claude, provider: "codex", windows: [] } }, NOW);
    expect(views.map((view) => view.provider)).toEqual(["claude"]);
    expect(usageTooltip(views).split("\n")).toEqual([
      `Claude · Sessão 5h: 27% — renova às ${clock("2026-11-08T14:15:00.000Z")} (em 2 h 15 min)`,
      expect.stringMatching(/^Claude · Semana: 44% — renova \S+ às/),
      "Claude: atualizado há 3 min",
    ]);
  });

  it("bloco do menu: uma linha por motor com a janela mais apertada; sem dados, nada", () => {
    const rows = planRows(usageViews({ claude }, NOW));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ provider: "claude", providerLabel: "Claude", percent: 44, text: "44%", tone: "ok", old: false });
    expect(rows[0]!.window).toMatchObject({ id: "seven_day" });
    expect(rows[0]!.title).toContain("Claude · Semana: 44%");
    expect(planRows([])).toEqual([]);
    expect(planSummary(usageViews({ claude }, NOW))).toMatchObject({ tone: "ok", old: false, label: "Uso do plano: Claude 44%" });
  });

  it("alerta: a pior cor entre os motores; dado velho (consulta falhando) vira o sinal de antigo, nunca alarme", () => {
    const hot: SubscriptionUsage = { ...claude, windows: [...claude.windows, { id: "seven_day_opus", utilization: 0.96 }] };
    const views = usageViews({ claude: hot }, NOW);
    expect(planRows(views)[0]).toMatchObject({ percent: 96, tone: "danger" });
    expect(planSummary(views)).toMatchObject({ tone: "danger", old: false });
    expect(closestToLimit(views)).toMatchObject({ view: { provider: "claude" }, window: { id: "seven_day_opus", percent: 96 } });
    const stale = usageViews({ claude: { ...claude, stale: { reason: "Login expirado", since: claude.updatedAt } } }, NOW);
    expect(planRows(stale)[0]).toMatchObject({ old: true });
    expect(planSummary(stale)).toMatchObject({ old: true });
    expect(planSummary(stale).label).toContain("dado antigo");
    // Só o aviso, sem janela nenhuma: "sem dados".
    const empty = usageViews({ claude: { provider: "claude", windows: [], updatedAt: claude.updatedAt, stale: { reason: "Login expirado", since: claude.updatedAt } } }, NOW);
    expect(planRows(empty)[0]).toMatchObject({ text: "sem dados", percent: null, old: true });
    expect(planRows(empty)[0]!.window).toBeUndefined();
  });

  it("mais perto do limite: só de 50% em diante e leitura recente; abaixo disso, nenhum destaque", () => {
    expect(closestToLimit(usageViews({ claude }, NOW))).toBeNull();
    const warm: SubscriptionUsage = { ...claude, windows: [{ id: "five_hour", utilization: 0.55 }, { id: "seven_day", utilization: 0.91 }] };
    expect(closestToLimit(usageViews({ claude: warm }, NOW))).toMatchObject({ window: { id: "seven_day", percent: 91 } });
    const old: SubscriptionUsage = { ...warm, updatedAt: "2026-11-08T11:00:00.000Z" };
    expect(closestToLimit(usageViews({ claude: old }, NOW))).toBeNull();
  });

  it("renovação curta para a barra: '2 h 15 min', '3 d', '40 min'; passada ou inválida, vazio", () => {
    expect(shortReset("2026-11-08T14:15:00.000Z", NOW)).toBe("2 h 15 min");
    expect(shortReset("2026-11-11T12:00:00.000Z", NOW)).toBe("3 d");
    expect(shortReset("2026-11-08T12:40:00.000Z", NOW)).toBe("40 min");
    expect(shortReset("2026-11-08T11:00:00.000Z", NOW)).toBe("");
    expect(shortReset(undefined, NOW)).toBe("");
    expect(shortReset("lixo", NOW)).toBe("");
    const view = usageViews({ claude }, NOW)[0]!;
    expect(tightestWindow(view)).toMatchObject({ id: "seven_day" });
  });

  it("começo da sessão de 5 h: quando renova menos 5 h; sem janela (ou data estranha), as últimas 5 h", () => {
    expect(sessionWindowStart(claude, NOW)).toBe("2026-11-08T09:15:00.000Z");
    expect(sessionWindowStart(undefined, NOW)).toBe("2026-11-08T07:00:00.000Z");
    const at = (resetsAt: string) => sessionWindowStart({ ...claude, windows: [{ id: "five_hour", utilization: 0.1, resetsAt }] }, NOW);
    expect(at("2026-11-08T11:00:00.000Z")).toBe("2026-11-08T07:00:00.000Z");
    expect(at("2026-11-09T12:00:00.000Z")).toBe("2026-11-08T07:00:00.000Z");
  });

  it("tokens em pt-BR compacto", () => {
    expect(formatTokens(950)).toBe("950");
    expect(plain(formatTokens(12_345))).toBe("12,3 mil");
    expect(plain(formatTokens(1_250_000))).toBe("1,3 mi");
    expect(formatTokens(-3)).toBe("0");
  });

  it("uso por agente: nome atual, maior primeiro, barra relativa a quem mais gastou; sem tokens = só turnos", () => {
    const tally = (agentId: string, provider: "claude" | "gemini", turns: number, input: number, output: number, measured = turns) => ({
      agentId,
      provider,
      turns,
      measuredTurns: measured,
      inputTokens: input,
      outputTokens: output,
      cacheReadTokens: 9000,
      cacheCreationTokens: 0,
      lastAt: "2026-11-08T11:00:00.000Z",
    });
    const rows = agentUsageRows(
      [tally("a1", "claude", 2, 100, 900), tally("a2", "claude", 1, 500, 4500), tally("a3", "gemini", 3, 0, 0, 0), tally("x", "claude", 1, 10, 240)],
      [
        { id: "a1", name: "Clara" },
        { id: "a2", name: "Rafa" },
        { id: "a3", name: "Gê" },
      ],
    );
    expect(rows.map((row) => [row.name, plain(row.tokensLabel), row.turnsLabel, row.share])).toEqual([
      ["Rafa", "5 mil", "1 turno", 100],
      ["Clara", "1 mil", "2 turnos", 20],
      ["Agente removido", "250", "1 turno", 5],
      ["Gê", "–", "3 turnos", 0],
    ]);
    expect(plain(rows[0]!.detail)).toBe("entrada 500 · saída 4,5 mil · cache: 0 gravados, 9 mil lidos · 1 turno");
    expect(rows[3]!.detail).toBe("3 turnos · Antigravity não informa tokens");
    // Selo do motor em cada linha.
    expect(rows.map((row) => row.providerLabel)).toEqual(["Claude", "Claude", "Claude", "Antigravity"]);
  });
});

/** Cota do Antigravity como o server normaliza (`agy -p /usage`): grupos de modelos com rótulo pronto. */
const antigravity: SubscriptionUsage = {
  provider: "gemini",
  windows: [
    { id: "seven_day", utilization: 0.12, resetsAt: "2026-11-15T04:28:24.000Z", label: "Semana", group: "Modelos Gemini", appliesTo: ["gemini"] },
    { id: "five_hour", utilization: 0.4, resetsAt: "2026-11-08T14:43:56.000Z", label: "Sessão 5h", group: "Modelos Gemini", appliesTo: ["gemini"] },
    { id: "seven_day_claude_gpt", utilization: 0, label: "Semana", group: "Claude e GPT", appliesTo: ["claude", "gpt"] },
    { id: "five_hour_claude_gpt", utilization: 0.97, label: "Sessão 5h", group: "Claude e GPT", appliesTo: ["claude", "gpt"] },
    { id: "seven_day_gemini_4_argon", utilization: 0, label: "Semana", group: "Gemini 4 Argon", appliesTo: ["gemini 4 argon"] },
  ],
  source: "account",
  fetchedAt: "2026-11-08T11:58:00.000Z",
  updatedAt: "2026-11-08T11:58:00.000Z",
};

describe("uso da assinatura: Claude e Antigravity", () => {
  it("uma seção por motor (Claude primeiro), com as janelas do Antigravity por grupo de modelos", () => {
    const views = usageViews({ gemini: antigravity, claude }, NOW);
    expect(views.map((view) => [view.provider, view.providerLabel, view.account])).toEqual([
      ["claude", "Claude", false],
      ["gemini", "Antigravity", true],
    ]);
    const gemini = views[1]!;
    expect(gemini.groups.map((group) => [group.group, group.windows.map((window) => `${window.label} ${window.percent}%`)])).toEqual([
      ["Modelos Gemini", ["Sessão 5h 40%", "Semana 12%"]],
      ["Claude e GPT", ["Sessão 5h 97%", "Semana 0%"]],
      ["Gemini 4 Argon", ["Semana 0%"]],
    ]);
    expect(gemini.summary).toBe("Antigravity · Modelos Gemini · Sessão 5h 40% · Modelos Gemini · Semana 12% · Claude e GPT · Sessão 5h 97% · Claude e GPT · Semana 0% · Gemini 4 Argon · Semana 0%");
    expect(gemini.tone).toBe("danger");
    expect(gemini.updatedLabel).toBe("atualizado há 2 min");
    // O Claude não separa por grupo: um grupo só, sem nome.
    expect(views[0]!.groups).toEqual([{ group: "", windows: views[0]!.windows }]);
  });

  it("bloco do menu com os dois motores; os grupos do Antigravity sem uso ficam recolhidos", () => {
    const views = usageViews({ claude, gemini: antigravity }, NOW);
    const rows = planRows(views);
    expect(rows.map((row) => [row.providerLabel, row.text, row.tone])).toEqual([
      ["Claude", "44%", "ok"],
      ["Antigravity", "97%", "danger"],
    ]);
    expect(closestToLimit(views)).toMatchObject({ view: { provider: "gemini" }, window: { group: "Claude e GPT", percent: 97 } });
    expect(usageTooltip(usageViews({ gemini: antigravity }, NOW))).toContain("Antigravity · Claude e GPT · Sessão 5h: 97%");
    const { shown, idle } = splitIdleGroups(views[1]!.groups);
    expect(shown.map((group) => group.group)).toEqual(["Modelos Gemini", "Claude e GPT"]);
    expect(idle.map((group) => group.group)).toEqual(["Gemini 4 Argon"]);
    // A conta toda (grupo sem nome) nunca some, nem em 0%.
    const zero = usageViews({ claude: { ...claude, windows: [{ id: "five_hour", utilization: 0 }] } }, NOW)[0]!;
    expect(splitIdleGroups(zero.groups)).toEqual({ shown: zero.groups, idle: [] });
    // Leitura antiga em 0% não conta como "sem uso" (o número é de outra hora).
    const old = usageViews({ gemini: { ...antigravity, updatedAt: "2026-11-08T10:00:00.000Z", fetchedAt: "2026-11-08T10:00:00.000Z" } }, NOW)[0]!;
    expect(splitIdleGroups(old.groups).idle).toEqual([]);
  });

  it("o detalhe desenha as duas seções, com selo do motor, nomes dos grupos e recarregar em cada uma", () => {
    const html = renderToStaticMarkup(createElement(UsageMeter, { views: usageViews({ claude: { ...claude, source: "account" }, gemini: antigravity }, NOW) }));
    expect(html.match(/data-testid="usage-provider"/g)).toHaveLength(2);
    expect(html).toContain('class="usage__block usage__block--ok usage__block--claude"');
    expect(html).toContain("usage__block--gemini");
    expect(html.match(/class="usage__group-name"/g)).toHaveLength(3);
    expect(html).toContain(">Claude e GPT</h4>");
    expect(html).toContain('data-testid="usage-refresh" data-provider="claude"');
    expect(html).toContain('data-testid="usage-refresh" data-provider="gemini"');
    expect(html).toContain('aria-label="Antigravity · Claude e GPT · Sessão 5h"');
    // Sem cota do Antigravity: a seção aparece com o aviso.
    const placeholder = renderToStaticMarkup(createElement(ProviderUsagePlaceholder, { provider: "gemini", label: "Antigravity", note: "Sem a cota da conta Google ainda." }));
    expect(placeholder).toContain("usage__block--gemini");
    expect(placeholder).toContain("Sem a cota da conta Google ainda.");
  });
});

describe("uso honesto na interface (leitura antiga e janela renovada)", () => {
  it("leitura de 42 min: número esmaecido com a idade, sem cor de alerta, anel marcado como velho", () => {
    const old: SubscriptionUsage = { ...claude, windows: [{ id: "five_hour", utilization: 0.9, resetsAt: "2026-11-08T14:15:00.000Z" }], updatedAt: "2026-11-08T11:18:00.000Z" };
    const view = usageView(old, NOW);
    expect(view.windows[0]).toMatchObject({ percent: 90, tone: "ok", warn: false, old: true, ageLabel: "há 42 min" });
    expect(view.old).toBe(true);
    expect(view.updatedLabel).toBe("atualizado há 42 min");
    expect(view.summary).toBe("Claude · Sessão 5h 90% (de há 42 min)");
    expect(planRows([view])[0]).toMatchObject({ percent: 90, old: true, tone: "ok" });
    expect(planSummary([view])).toMatchObject({ tone: "ok", old: true });
    expect(closestToLimit([view])).toBeNull();
    expect(usageTooltip([view])).toContain("90% (de há 42 min)");
  });

  it("janela que já renovou: sem o percentual antigo, 'renovada' e traço; o anel mostra ↻", () => {
    const renewed: SubscriptionUsage = {
      ...claude,
      windows: [
        { id: "five_hour", utilization: 0.9, resetsAt: "2026-11-08T11:50:00.000Z" },
        { id: "seven_day", utilization: 0.44, resetsAt: "2026-11-11T12:00:00.000Z" },
      ],
      updatedAt: "2026-11-08T11:40:00.000Z",
    };
    const view = usageView(renewed, NOW);
    expect(view.windows[0]).toMatchObject({ id: "five_hour", percent: null, text: "renovada", renewed: true, tone: "ok", resetLabel: "" });
    expect(view.windows[1]).toMatchObject({ id: "seven_day", percent: 44 });
    expect(view.summary).toBe("Claude · Sessão 5h renovada · Semana 44%");
    expect(planRows([view])[0]).toMatchObject({ percent: 44, text: "44%" });
    expect(usageAlert([view])).toBeNull();
  });

  it("os dois motores usam a mesma regra (Antigravity com grupos)", () => {
    const gemini: SubscriptionUsage = {
      provider: "gemini",
      updatedAt: "2026-11-08T11:00:00.000Z",
      windows: [
        { id: "five_hour", utilization: 0.6, group: "Modelos Gemini", label: "Sessão 5h", resetsAt: "2026-11-08T11:30:00.000Z" },
        { id: "seven_day", utilization: 0.6, group: "Modelos Gemini", label: "Semana", resetsAt: "2026-11-12T12:00:00.000Z" },
      ],
    };
    const view = usageView(gemini, NOW);
    expect(view.windows.map((window) => [window.id, window.renewed, window.old, window.tone])).toEqual([
      ["five_hour", true, true, "ok"],
      ["seven_day", false, true, "ok"],
    ]);
  });

  it("o detalhe mostra '↻ renovada' no lugar do número e a idade da leitura antiga", () => {
    const usage: SubscriptionUsage = {
      ...claude,
      windows: [
        { id: "five_hour", utilization: 0.9, resetsAt: "2026-11-08T11:50:00.000Z" },
        { id: "seven_day", utilization: 0.6, resetsAt: "2026-11-11T12:00:00.000Z" },
      ],
      updatedAt: "2026-11-08T11:18:00.000Z",
    };
    const html = renderToStaticMarkup(createElement(UsageMeter, { views: [usageView(usage, NOW)] }));
    expect(html).toContain("↻ renovada");
    expect(html).not.toContain("90%");
    expect(html).toContain("atualizado há 42 min");
    expect(html).toContain("Leitura antiga (há 42 min)");
    expect(html).toContain("usage__window--renewed");
    expect(html).toContain("usage__window--old");
  });
});
