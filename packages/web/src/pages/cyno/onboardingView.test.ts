import type { EngineAccountView } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import {
  cynoScreenMode,
  defaultAccountsConnected,
  FIRST_USE_SUGGESTIONS,
  onboardingState,
  showFirstUse,
} from "./onboardingView";

const CLAUDE_DEFAULT_ON: EngineAccountView = {
  id: "padrao",
  engine: "claude",
  label: "Padrão",
  isDefault: true,
  loggedIn: true,
};

const CLAUDE_DEFAULT_OFF: EngineAccountView = {
  id: "padrao",
  engine: "claude",
  label: "Padrão",
  isDefault: true,
  loggedIn: false,
};

const CLAUDE_EXTRA_ON: EngineAccountView = {
  id: "trabalho",
  engine: "claude",
  label: "Trabalho",
  loggedIn: true,
  createdAt: "2026-11-23T01:00:00.000Z",
};

const AGY_DEFAULT_ON: EngineAccountView = {
  id: "padrao",
  engine: "gemini",
  label: "Padrão",
  isDefault: true,
  loggedIn: true,
};

const AGY_DEFAULT_OFF: EngineAccountView = {
  id: "padrao",
  engine: "gemini",
  label: "Padrão",
  isDefault: true,
  loggedIn: false,
};

describe("onboardingView: estado dos 3 passos iniciais", () => {
  it("nada feito: passos 1 e 2 ativos, passo 3 bloqueado e 0 de 3 concluídos", () => {
    const view = onboardingState({
      connected: { claude: false, gemini: false },
      workspaces: 0,
      requests: 0,
    });
    expect(view.steps).toEqual({
      conta: "ativo",
      workspace: "ativo",
      pedido: "bloqueado",
    });
    expect(view.completedCount).toBe(0);
    expect(view.totalSteps).toBe(3);
    expect(view.progressPercent).toBe(0);
    expect(view.allDone).toBe(false);
    expect(view.engines).toEqual([
      { engine: "claude", label: "Claude Code", connected: false },
      { engine: "gemini", label: "Antigravity", connected: false },
    ]);
  });

  it("só conta conectada (Claude Code ou Antigravity): passo 1 concluído, passo 2 ativo e passo 3 bloqueado", () => {
    const onlyClaude = onboardingState({
      connected: { claude: true, gemini: false },
      workspaces: 0,
      requests: 0,
    });
    expect(onlyClaude.steps).toEqual({
      conta: "concluido",
      workspace: "ativo",
      pedido: "bloqueado",
    });
    expect(onlyClaude.completedCount).toBe(1);
    expect(onlyClaude.progressPercent).toBe(33);
    expect(onlyClaude.allDone).toBe(false);

    const onlyGemini = onboardingState({
      connected: { claude: false, gemini: true },
      workspaces: 0,
      requests: 0,
    });
    expect(onlyGemini.steps).toEqual({
      conta: "concluido",
      workspace: "ativo",
      pedido: "bloqueado",
    });
    expect(onlyGemini.completedCount).toBe(1);
    expect(onlyGemini.progressPercent).toBe(33);
    expect(onlyGemini.allDone).toBe(false);
  });

  it("conta + workspace: passos 1 e 2 concluídos, passo 3 ativo e 2 de 3 concluídos", () => {
    const view = onboardingState({
      connected: { claude: true, gemini: false },
      workspaces: 1,
      requests: 0,
    });
    expect(view.steps).toEqual({
      conta: "concluido",
      workspace: "concluido",
      pedido: "ativo",
    });
    expect(view.completedCount).toBe(2);
    expect(view.progressPercent).toBe(67);
    expect(view.allDone).toBe(false);
  });

  it("tudo feito: os 3 passos concluídos e allDone verdadeiro", () => {
    const view = onboardingState({
      connected: { claude: true, gemini: true },
      workspaces: 2,
      requests: 1,
    });
    expect(view.steps).toEqual({
      conta: "concluido",
      workspace: "concluido",
      pedido: "concluido",
    });
    expect(view.completedCount).toBe(3);
    expect(view.progressPercent).toBe(100);
    expect(view.allDone).toBe(true);
  });

  it("sem conta mas com workspace: passo 1 segue ativo, passo 2 concluído e passo 3 liberado", () => {
    const withoutRequest = onboardingState({
      connected: { claude: false, gemini: false },
      workspaces: 1,
      requests: 0,
    });
    expect(withoutRequest.steps).toEqual({
      conta: "ativo",
      workspace: "concluido",
      pedido: "ativo",
    });
    expect(withoutRequest.completedCount).toBe(1);
    expect(withoutRequest.progressPercent).toBe(33);
    expect(withoutRequest.allDone).toBe(false);

    const withRequest = onboardingState({
      connected: { claude: false, gemini: false },
      workspaces: 1,
      requests: 2,
    });
    expect(withRequest.steps).toEqual({
      conta: "ativo",
      workspace: "concluido",
      pedido: "concluido",
    });
    expect(withRequest.completedCount).toBe(2);
    expect(withRequest.progressPercent).toBe(67);
    expect(withRequest.allDone).toBe(false);
  });

  it("passo 3 permanece bloqueado antes do passo 2, mesmo se houver pedidos antigos", () => {
    const view = onboardingState({
      connected: { claude: true, gemini: false },
      workspaces: 0,
      requests: 3,
    });
    expect(view.steps.workspace).toBe("ativo");
    expect(view.steps.pedido).toBe("bloqueado");
    expect(view.completedCount).toBe(1);
    expect(view.progressPercent).toBe(33);
    expect(view.allDone).toBe(false);
  });
});

describe("onboardingView: showFirstUse e cynoScreenMode", () => {
  const base = { workspacesLoaded: true, workspaceCount: 0, conversationLoaded: true, conversationEmpty: true, chatOpen: false, reviewMode: false };

  it("enquanto a lista de workspaces carrega, não mostra primeiro uso nem a página normal (fica em loading)", () => {
    const input = { ...base, workspacesLoaded: false };
    expect(cynoScreenMode(input)).toBe("loading");
    expect(showFirstUse(input)).toBe(false);
  });

  it("sem workspace e com a conversa ainda carregando, espera antes de decidir", () => {
    const input = { ...base, conversationLoaded: false };
    expect(cynoScreenMode(input)).toBe("loading");
    expect(showFirstUse(input)).toBe(false);
  });

  it("sem workspace e com a conversa vazia (nada ainda, ou Nova conversa clicada): mostra a tela de primeiro uso", () => {
    expect(cynoScreenMode(base)).toBe("first-use");
    expect(showFirstUse(base)).toBe(true);
  });

  it("sem workspace, mas com uma conversa em andamento: fica no chat (a boas-vindas não vira a página de foco para sempre)", () => {
    const input = { ...base, conversationEmpty: false };
    expect(cynoScreenMode(input)).toBe("chat");
    expect(showFirstUse(input)).toBe(false);
  });

  it("acabou de enviar pela tela de primeiro uso (chatOpen): mostra o chat na hora, antes de a mensagem aparecer na conversa", () => {
    const input = { ...base, chatOpen: true };
    expect(cynoScreenMode(input)).toBe("chat");
    expect(showFirstUse(input)).toBe(false);
  });

  it("quando já existe workspace (fora do modo de revisão), mantém sempre a conversa normal", () => {
    for (const conversationEmpty of [false, true]) {
      const input = { ...base, workspaceCount: 2, conversationEmpty };
      expect(cynoScreenMode(input)).toBe("chat");
      expect(showFirstUse(input)).toBe(false);
    }
  });

  it("modo de revisão ligado força a tela de primeiro uso mesmo com workspaces, conversa e lista carregando", () => {
    for (const input of [
      { ...base, workspaceCount: 3, conversationEmpty: false, reviewMode: true },
      { ...base, workspaceCount: 3, chatOpen: true, reviewMode: true },
      { ...base, workspacesLoaded: false, reviewMode: true },
    ]) {
      expect(cynoScreenMode(input)).toBe("first-use");
      expect(showFirstUse(input)).toBe(true);
    }
  });
});

describe("onboardingView: auxiliares de contas e atalhos", () => {
  it("defaultAccountsConnected considera apenas a conta padrão de cada motor", () => {
    expect(defaultAccountsConnected(null)).toEqual({ claude: false, gemini: false });
    expect(defaultAccountsConnected([CLAUDE_DEFAULT_OFF, CLAUDE_EXTRA_ON, AGY_DEFAULT_OFF])).toEqual({
      claude: false,
      gemini: false,
    });
    expect(defaultAccountsConnected([CLAUDE_DEFAULT_ON, AGY_DEFAULT_OFF])).toEqual({
      claude: true,
      gemini: false,
    });
    expect(defaultAccountsConnected([CLAUDE_DEFAULT_ON, AGY_DEFAULT_ON])).toEqual({
      claude: true,
      gemini: true,
    });
  });

  it("FIRST_USE_SUGGESTIONS traz 4 sugestões genéricas que terminam com espaço, para a pessoa completar", () => {
    expect(FIRST_USE_SUGGESTIONS.map((item) => item.label)).toEqual(["Cuidar das redes sociais", "Atender clientes", "Pesquisar e resumir", "Programar um projeto"]);
    for (const item of FIRST_USE_SUGGESTIONS) {
      expect(item.prompt.startsWith("Quero um workspace para ")).toBe(true);
      expect(item.prompt.endsWith(" ")).toBe(true);
    }
  });
});
