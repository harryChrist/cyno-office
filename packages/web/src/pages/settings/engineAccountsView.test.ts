import type { EngineAccountView, EngineStatus } from "@cyno/shared";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EngineAccountsCard, type EngineAccountsCardProps } from "./EngineAccountsPanel";
import {
  ACCOUNT_DELETE_WARNING,
  ACCOUNTS_HELP_LINE,
  INITIAL_ACCOUNTS_STATE,
  accountDisplayLabel,
  accountKey,
  accountLoginActionLabel,
  accountLoginBadge,
  accountsReducer,
  engineAccountsSummaryBadge,
  engineInstallState,
  groupAccountsByEngine,
  isDefaultAccount,
  validateAccountLabel,
} from "./engineAccountsView";

const CLAUDE_DEFAULT: EngineAccountView = {
  id: "padrao",
  engine: "claude",
  label: "Padrão",
  isDefault: true,
  loggedIn: true,
};

const CLAUDE_EXTRA: EngineAccountView = {
  id: "trabalho",
  engine: "claude",
  label: "Trabalho",
  loggedIn: false,
  createdAt: "2026-11-23T01:00:00.000Z",
};

const AGY_DEFAULT: EngineAccountView = {
  id: "padrao",
  engine: "gemini",
  label: "Padrão",
  isDefault: true,
  loggedIn: false,
};

const CLAUDE_INSTALLED: EngineStatus = {
  id: "claude",
  label: "Claude Code",
  blurb: "CLI do Claude Code.",
  supported: true,
  state: "installed",
};

const AGY_NOT_INSTALLED: EngineStatus = {
  id: "gemini",
  label: "Antigravity",
  blurb: "CLI do Antigravity.",
  supported: true,
  state: "not_installed",
  installable: true,
};

function renderCard(props: Partial<EngineAccountsCardProps> & Pick<EngineAccountsCardProps, "group">) {
  return renderToStaticMarkup(
    createElement(EngineAccountsCard, {
      onLogin: () => undefined,
      onCreate: async () => undefined,
      onRename: async () => undefined,
      onAskDelete: () => undefined,
      onInstalled: () => undefined,
      ...props,
    }),
  );
}

describe("engineAccountsView: agrupamento, selos e validação", () => {
  it("agrupa apenas Claude Code e Antigravity (nunca Freebuff), separando conta padrão das extras", () => {
    const fakeFreebuff = {
      id: "fb-1",
      engine: "freebuff",
      label: "Freebuff",
      loggedIn: true,
    } as unknown as EngineAccountView;
    const groups = groupAccountsByEngine([CLAUDE_EXTRA, CLAUDE_DEFAULT, AGY_DEFAULT, fakeFreebuff]);
    expect(groups.map((g) => g.engine)).toEqual(["claude", "gemini"]);
    expect(groups[0]!.label).toBe("Claude Code");
    expect(groups[0]!.defaultAccount).toEqual(CLAUDE_DEFAULT);
    expect(groups[0]!.extraAccounts).toEqual([CLAUDE_EXTRA]);
    expect(groups[1]!.label).toBe("Antigravity");
    expect(groups[1]!.defaultAccount).toEqual(AGY_DEFAULT);
    expect(groups[1]!.extraAccounts).toEqual([]);
  });

  it("identifica conta padrão, monta chave estável e rótulos de estado/ação", () => {
    expect(isDefaultAccount(CLAUDE_DEFAULT)).toBe(true);
    expect(isDefaultAccount({ id: "padrao" })).toBe(true);
    expect(isDefaultAccount(CLAUDE_EXTRA)).toBe(false);
    expect(accountKey(CLAUDE_DEFAULT)).toBe("claude:padrao");
    expect(accountKey(AGY_DEFAULT)).toBe("gemini:padrao");
    expect(accountDisplayLabel(CLAUDE_DEFAULT)).toBe("Conta padrão");
    expect(accountDisplayLabel(CLAUDE_EXTRA)).toBe("Trabalho");
    expect(accountLoginBadge(true)).toEqual({ label: "Conectada", tone: "success" });
    expect(accountLoginBadge(false)).toEqual({ label: "Precisa entrar", tone: "attention" });
    expect(accountLoginActionLabel(true)).toBe("Reconectar");
    expect(accountLoginActionLabel(false)).toBe("Entrar");
  });

  it("calcula estado de instalação e resumo do cabeçalho", () => {
    const groups = groupAccountsByEngine([CLAUDE_DEFAULT, CLAUDE_EXTRA, AGY_DEFAULT]);
    expect(engineInstallState(undefined)).toBe("unknown");
    expect(engineInstallState(CLAUDE_INSTALLED)).toBe("installed");
    expect(engineInstallState(AGY_NOT_INSTALLED)).toBe("not_installed");
    expect(engineAccountsSummaryBadge(groups[0]!, "installed")).toEqual({ label: "1 conectada", tone: "success" });
    expect(engineAccountsSummaryBadge(groups[1]!, "installed")).toEqual({ label: "Nenhuma conectada", tone: "attention" });
    expect(engineAccountsSummaryBadge(groups[1]!, "not_installed")).toEqual({ label: "Não instalado", tone: "neutral" });
  });

  it("valida apelido (vazio e tamanho máximo de 40 caracteres)", () => {
    expect(validateAccountLabel("   ")).toEqual({ ok: false, error: "Digite um apelido para a conta." });
    expect(validateAccountLabel("  Trabalho  ")).toEqual({ ok: true, value: "Trabalho" });
    expect(validateAccountLabel("a".repeat(41)).ok).toBe(false);
    expect(validateAccountLabel("a".repeat(40))).toEqual({ ok: true, value: "a".repeat(40) });
  });

  it("reducer atualiza loading, loaded, created, renamed, deleted e error preservando a conta padrão", () => {
    let state = accountsReducer(INITIAL_ACCOUNTS_STATE, { type: "loaded", accounts: [CLAUDE_DEFAULT, AGY_DEFAULT] });
    expect(state.loading).toBe(false);
    expect(state.accounts).toHaveLength(2);

    state = accountsReducer(state, { type: "created", account: CLAUDE_EXTRA });
    expect(state.accounts).toHaveLength(3);

    state = accountsReducer(state, { type: "renamed", account: { ...CLAUDE_EXTRA, label: "Empresa" } });
    expect(state.accounts?.find((item) => item.id === "trabalho")?.label).toBe("Empresa");

    // Não apaga conta padrão mesmo se vier id "padrao".
    state = accountsReducer(state, { type: "deleted", id: "padrao" });
    expect(state.accounts?.filter((item) => item.id === "padrao")).toHaveLength(2);

    state = accountsReducer(state, { type: "deleted", id: "trabalho" });
    expect(state.accounts).toHaveLength(2);

    state = accountsReducer(state, { type: "error", error: "Falha de rede" });
    expect(state.error).toBe("Falha de rede");
  });
});

describe("EngineAccountsCard: renderização do cartão de contas", () => {
  it("mostra Conta padrão sem Renomear/Apagar e contas extras com Entrar/Reconectar, Renomear e Apagar", () => {
    const [claudeGroup] = groupAccountsByEngine([CLAUDE_DEFAULT, CLAUDE_EXTRA]);
    const html = renderCard({ group: claudeGroup!, status: CLAUDE_INSTALLED });

    expect(html).toContain("Claude Code");
    expect(html).toContain("Conta padrão");
    expect(html).toContain("Conectada");
    expect(html).toContain("Reconectar");
    expect(html).toContain("Trabalho");
    expect(html).toContain("Precisa entrar");
    expect(html).toContain("Entrar");
    expect(html).toContain('data-testid="account-rename-trabalho"');
    expect(html).toContain('data-testid="account-delete-trabalho"');
    expect(html).not.toContain('data-testid="account-rename-padrao"');
    expect(html).not.toContain('data-testid="account-delete-padrao"');
    expect(html).toContain("Adicionar conta");
    expect(html).not.toContain("100");
    expect(html).not.toContain("Freebuff");
    expect(ACCOUNTS_HELP_LINE).toMatch(/pasta isolada/i);
    expect(ACCOUNTS_HELP_LINE).toMatch(/fixo na conta escolhida/i);
    expect(ACCOUNT_DELETE_WARNING).toMatch(/apaga o login e o histórico dessa conta neste servidor/i);
  });

  it("motor não instalado mostra Instalar e desabilita o botão Entrar", () => {
    const [, agyGroup] = groupAccountsByEngine([CLAUDE_DEFAULT, AGY_DEFAULT]);
    const html = renderCard({ group: agyGroup!, status: AGY_NOT_INSTALLED });

    expect(html).toContain('data-testid="accounts-install-gemini"');
    expect(html).toContain('data-testid="accounts-install-plan-gemini"');
    expect(html).toContain("Instalar");
    expect(html).toMatch(/data-testid="account-login-gemini-padrao"[^>]*disabled|disabled[^>]*data-testid="account-login-gemini-padrao"/);
  });
});
