import {
  ACCOUNT_ENGINES,
  DEFAULT_ACCOUNT_ID,
  ENGINE_LABELS,
  type AccountEngine,
  type EngineAccountView,
  type EngineStatus,
} from "@cyno/shared";

/**
 * Regras puras do painel "Contas" em Configurações (Claude Code e Antigravity;
 * Freebuff, OpenClaw e Hermes não entram aqui).
 */

export const MAX_ACCOUNT_LABEL_LENGTH = 40;

export const ACCOUNTS_HELP_LINE =
  "Cada conta tem uma pasta isolada neste servidor e o agente ficará fixo na conta escolhida (a escolha por agente chega na próxima etapa; por enquanto você já pode cadastrar e entrar nas contas).";

export const ACCOUNT_DELETE_WARNING =
  "Isso apaga o login e o histórico dessa conta neste servidor.";

export type EngineAccountsGroup = {
  engine: AccountEngine;
  label: string;
  defaultAccount: EngineAccountView | null;
  extraAccounts: EngineAccountView[];
};

export type EngineInstallState = "unknown" | "installed" | "not_installed";

export type AccountsState = {
  accounts: EngineAccountView[] | null;
  loading: boolean;
  error: string | null;
};

export type AccountsAction =
  | { type: "loading" }
  | { type: "loaded"; accounts: EngineAccountView[] }
  | { type: "error"; error: string }
  | { type: "created"; account: EngineAccountView }
  | { type: "renamed"; account: EngineAccountView }
  | { type: "deleted"; id: string };

export const INITIAL_ACCOUNTS_STATE: AccountsState = {
  accounts: null,
  loading: true,
  error: null,
};

/** Reducer puro do estado da lista de contas dos motores. */
export function accountsReducer(state: AccountsState, action: AccountsAction): AccountsState {
  switch (action.type) {
    case "loading":
      return { ...state, loading: true, error: null };
    case "loaded":
      return { accounts: action.accounts, loading: false, error: null };
    case "error":
      return { ...state, loading: false, error: action.error };
    case "created":
      return {
        ...state,
        error: null,
        accounts: state.accounts ? [...state.accounts, action.account] : [action.account],
      };
    case "renamed":
      return {
        ...state,
        error: null,
        accounts: state.accounts
          ? state.accounts.map((item) =>
              !isDefaultAccount(item) && item.id === action.account.id ? action.account : item,
            )
          : [action.account],
      };
    case "deleted":
      return {
        ...state,
        error: null,
        accounts: state.accounts
          ? state.accounts.filter((item) => isDefaultAccount(item) || item.id !== action.id)
          : null,
      };
  }
}

/** A conta é a conta padrão sintética (a do HOME real do servidor)? */
export function isDefaultAccount(account: Pick<EngineAccountView, "id" | "isDefault">): boolean {
  return account.isDefault === true || account.id === DEFAULT_ACCOUNT_ID;
}

/** Chave estável de renderização (a conta `padrao` existe em cada motor). */
export function accountKey(account: Pick<EngineAccountView, "engine" | "id">): string {
  return `${account.engine}:${account.id}`;
}

/** Rótulo mostrado na tela ("Conta padrão" para a padrão; o apelido para as extras). */
export function accountDisplayLabel(account: Pick<EngineAccountView, "id" | "label" | "isDefault">): string {
  return isDefaultAccount(account) ? "Conta padrão" : account.label;
}

/** Selo de estado de login da conta. */
export function accountLoginBadge(loggedIn: boolean): { label: string; tone: "success" | "attention" } {
  return loggedIn
    ? { label: "Conectada", tone: "success" }
    : { label: "Precisa entrar", tone: "attention" };
}

/** Rótulo do botão de abrir o mini terminal de login. */
export function accountLoginActionLabel(loggedIn: boolean): string {
  return loggedIn ? "Reconectar" : "Entrar";
}

/** Agrupa as contas apenas nos motores com suporte a contas (Claude Code e Antigravity). */
export function groupAccountsByEngine(accounts: readonly EngineAccountView[] | null): EngineAccountsGroup[] {
  const list = accounts ?? [];
  return ACCOUNT_ENGINES.map((engine) => {
    const forEngine = list.filter((item) => item.engine === engine);
    const defaultAccount = forEngine.find((item) => isDefaultAccount(item)) ?? null;
    const extraAccounts = forEngine.filter((item) => !isDefaultAccount(item));
    return {
      engine,
      label: ENGINE_LABELS[engine],
      defaultAccount,
      extraAccounts,
    };
  });
}

/** Estado de instalação do motor no servidor para liberar ou bloquear o botão Entrar. */
export function engineInstallState(status: EngineStatus | undefined): EngineInstallState {
  if (!status) return "unknown";
  return status.state === "not_installed" ? "not_installed" : "installed";
}

/** Resumo curto no cabeçalho do cartão de contas de um motor. */
export function engineAccountsSummaryBadge(
  group: EngineAccountsGroup,
  installState: EngineInstallState,
): { label: string; tone: "success" | "attention" | "neutral" } {
  if (installState === "not_installed") {
    return { label: "Não instalado", tone: "neutral" };
  }
  const all = [...(group.defaultAccount ? [group.defaultAccount] : []), ...group.extraAccounts];
  if (all.length === 0) {
    return { label: "Carregando…", tone: "neutral" };
  }
  const connected = all.filter((item) => item.loggedIn).length;
  if (connected === 0) {
    return { label: "Nenhuma conectada", tone: "attention" };
  }
  return {
    label: connected === 1 ? "1 conectada" : `${connected} conectadas`,
    tone: "success",
  };
}

/** Valida o apelido informado ao criar ou renomear uma conta extra. */
export function validateAccountLabel(
  raw: string,
): { ok: true; value: string } | { ok: false; error: string } {
  const value = raw.trim();
  if (!value) {
    return { ok: false, error: "Digite um apelido para a conta." };
  }
  if (value.length > MAX_ACCOUNT_LABEL_LENGTH) {
    return { ok: false, error: `O apelido pode ter no máximo ${MAX_ACCOUNT_LABEL_LENGTH} caracteres.` };
  }
  return { ok: true, value };
}
