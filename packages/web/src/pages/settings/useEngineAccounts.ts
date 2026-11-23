import type { AccountEngine, EngineAccountView } from "@cyno/shared";
import { useCallback, useEffect, useReducer, useRef } from "react";
import { api, describeError } from "../../api/client";
import { accountsReducer, INITIAL_ACCOUNTS_STATE } from "./engineAccountsView";

export type EngineAccountsHook = {
  accounts: EngineAccountView[] | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  createAccount: (engine: AccountEngine, label: string) => Promise<EngineAccountView>;
  renameAccount: (id: string, label: string) => Promise<EngineAccountView>;
  deleteAccount: (id: string) => Promise<void>;
};

/**
 * Estado das contas dos motores (Claude Code e Antigravity) em Configurações.
 * Carrega uma vez ao montar e recarrega a lista após cada ação para manter `loggedIn` em dia.
 */
export function useEngineAccounts(): EngineAccountsHook {
  const [state, dispatch] = useReducer(accountsReducer, INITIAL_ACCOUNTS_STATE);
  const alive = useRef(true);

  const load = useCallback(async (showLoading: boolean) => {
    if (showLoading) dispatch({ type: "loading" });
    try {
      const response = await api.listEngineAccounts();
      if (!alive.current) return;
      dispatch({ type: "loaded", accounts: response.accounts });
    } catch (failure) {
      if (!alive.current) return;
      dispatch({ type: "error", error: describeError(failure) });
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void api.listEngineAccounts().then(
      (response) => {
        if (!alive.current) return;
        dispatch({ type: "loaded", accounts: response.accounts });
      },
      (failure: unknown) => {
        if (!alive.current) return;
        dispatch({ type: "error", error: describeError(failure) });
      },
    );
    return () => {
      alive.current = false;
    };
  }, []);

  const refresh = useCallback(() => load(true), [load]);

  const createAccount = useCallback(
    async (engine: AccountEngine, label: string): Promise<EngineAccountView> => {
      const { account } = await api.createEngineAccount({ engine, label });
      if (alive.current) dispatch({ type: "created", account });
      await load(false);
      return account;
    },
    [load],
  );

  const renameAccount = useCallback(
    async (id: string, label: string): Promise<EngineAccountView> => {
      const { account } = await api.renameEngineAccount(id, { label });
      if (alive.current) dispatch({ type: "renamed", account });
      await load(false);
      return account;
    },
    [load],
  );

  const deleteAccount = useCallback(
    async (id: string): Promise<void> => {
      await api.deleteEngineAccount(id);
      if (alive.current) dispatch({ type: "deleted", id });
      await load(false);
    },
    [load],
  );

  return {
    accounts: state.accounts,
    loading: state.loading,
    error: state.error,
    refresh,
    createAccount,
    renameAccount,
    deleteAccount,
  };
}
