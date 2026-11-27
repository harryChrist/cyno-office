import {
  ACCOUNT_ENGINES,
  DEFAULT_ACCOUNT_ID,
  ENGINE_LABELS,
  type AccountEngine,
  type EngineAccountView,
} from "@cyno/shared";

/**
 * Regras puras da tela de primeiro uso na página inicial do Cyno:
 * decisão de exibição (carregando, primeiro uso ou conversa normal),
 * os 3 passos ("Comece em 3 passos"), a detecção das contas padrão conectadas
 * e os 4 atalhos iniciais. Sem React.
 */

export type OnboardingStepId = "conta" | "workspace" | "pedido";
export type OnboardingStepStatus = "concluido" | "ativo" | "bloqueado";

export type EngineConnectionMap = Record<AccountEngine, boolean>;

export type OnboardingEngineChip = {
  engine: AccountEngine;
  label: string;
  connected: boolean;
};

export type OnboardingInput = {
  /** Se a conta padrão de cada motor (Claude Code e Antigravity) está conectada. */
  connected: EngineConnectionMap;
  /** Quantidade atual de workspaces. */
  workspaces: number;
  /** Quantidade de pedidos/projetos existentes. */
  requests: number;
};

export type OnboardingState = {
  steps: Record<OnboardingStepId, OnboardingStepStatus>;
  engines: OnboardingEngineChip[];
  completedCount: number;
  totalSteps: 3;
  progressPercent: number;
  allDone: boolean;
};

export type OnboardingSuggestion = {
  label: string;
  prompt: string;
};

export type FirstUseInput = {
  /** A lista de workspaces já chegou do servidor? */
  workspacesLoaded: boolean;
  /** Quantidade atual de workspaces. */
  workspaceCount: number;
  /** O histórico da conversa com o Cyno já chegou? (padrão: true). */
  conversationLoaded?: boolean;
  /** A conversa atual com o Cyno está vazia (sem mensagens, ou marcada para começar do zero em "Nova conversa")? */
  conversationEmpty: boolean;
  /**
   * O usuário acabou de mandar uma mensagem pela tela de primeiro uso nesta sessão? Só em memória: faz o Início
   * mostrar o chat na hora (antes de a mensagem aparecer na conversa), para a animação e para ver o Cyno trabalhando.
   */
  chatOpen: boolean;
  /** Modo de revisão ligado em Configurações > Sistema? */
  reviewMode: boolean;
};

export type CynoScreenMode = "loading" | "first-use" | "chat";

/**
 * As 4 sugestões da visão A da tela de primeiro uso. São genéricas e NÃO enviam nada: clicar põe o começo da frase
 * (`prompt`, que termina com um espaço) na caixa de texto, para a pessoa completar com o que ela quer.
 */
export const FIRST_USE_SUGGESTIONS: readonly OnboardingSuggestion[] = [
  { label: "Cuidar das redes sociais", prompt: "Quero um workspace para cuidar das redes sociais de " },
  { label: "Atender clientes", prompt: "Quero um workspace para atender clientes de " },
  { label: "Pesquisar e resumir", prompt: "Quero um workspace para pesquisar e resumir " },
  { label: "Programar um projeto", prompt: "Quero um workspace para programar " },
] as const;

function isDefaultEngineAccount(account: Pick<EngineAccountView, "id" | "isDefault">): boolean {
  return account.isDefault === true || account.id === DEFAULT_ACCOUNT_ID;
}

/** Verifica, para cada motor com contas (Claude Code e Antigravity), se a conta padrão está logada. */
export function defaultAccountsConnected(accounts: readonly EngineAccountView[] | null): EngineConnectionMap {
  const list = accounts ?? [];
  const connected = {} as EngineConnectionMap;
  for (const engine of ACCOUNT_ENGINES) {
    const account = list.find((item) => item.engine === engine && isDefaultEngineAccount(item));
    connected[engine] = Boolean(account?.loggedIn);
  }
  return connected;
}

/**
 * Decide o que a página inicial do Cyno deve exibir:
 * - `"first-use"`: modo de revisão ligado, ou sem workspace e com a conversa vazia (nada ainda, ou "Nova conversa"
 *   clicada). Uma conversa em andamento NÃO é trocada pela boas-vindas: ela não vira a página de foco para sempre.
 * - `"loading"`: fora do modo de revisão, enquanto a lista de workspaces (ou, sem workspace, a conversa) não carregou.
 * - `"chat"`: já existe workspace, a conversa tem mensagens, ou o usuário acabou de enviar uma (`chatOpen`).
 */
export function cynoScreenMode(input: FirstUseInput): CynoScreenMode {
  if (input.reviewMode) return "first-use";
  if (!input.workspacesLoaded) return "loading";
  if (input.workspaceCount > 0) return "chat";
  if (input.chatOpen) return "chat";
  if (input.conversationLoaded === false) return "loading";
  return input.conversationEmpty ? "first-use" : "chat";
}

/** A tela de primeiro uso deve substituir toda a área principal da página do Cyno? */
export function showFirstUse(input: FirstUseInput): boolean {
  return cynoScreenMode(input) === "first-use";
}

/**
 * Calcula o estado de cada um dos 3 passos iniciais:
 * - Passo 1 (conta): concluído quando ao menos um motor tem a conta padrão logada; senão ativo.
 * - Passo 2 (workspace): concluído quando há ao menos um workspace; senão ativo.
 * - Passo 3 (pedido): bloqueado até existir um workspace; depois, concluído com ao menos um pedido ou ativo.
 */
export function onboardingState(input: OnboardingInput): OnboardingState {
  const hasAccount = ACCOUNT_ENGINES.some((engine) => input.connected[engine]);
  const hasWorkspace = input.workspaces > 0;
  const hasRequest = input.requests > 0;

  const conta: OnboardingStepStatus = hasAccount ? "concluido" : "ativo";
  const workspace: OnboardingStepStatus = hasWorkspace ? "concluido" : "ativo";
  const pedido: OnboardingStepStatus = !hasWorkspace ? "bloqueado" : hasRequest ? "concluido" : "ativo";

  const steps: Record<OnboardingStepId, OnboardingStepStatus> = { conta, workspace, pedido };
  const completedCount = (conta === "concluido" ? 1 : 0) + (workspace === "concluido" ? 1 : 0) + (pedido === "concluido" ? 1 : 0);

  const engines: OnboardingEngineChip[] = ACCOUNT_ENGINES.map((engine) => ({
    engine,
    label: ENGINE_LABELS[engine],
    connected: Boolean(input.connected[engine]),
  }));

  return {
    steps,
    engines,
    completedCount,
    totalSteps: 3,
    progressPercent: Math.round((completedCount / 3) * 100),
    allDone: completedCount === 3,
  };
}
