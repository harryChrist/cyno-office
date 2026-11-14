import { useCallback, useEffect, useRef, useState } from "react";
import { describeError } from "../api/client";

export type AsyncAction = {
  pending: boolean;
  error: string | null;
  /** Roda a ação; devolve o resultado ou undefined se falhou (o erro fica em `error`). */
  run: <T>(action: () => Promise<T>) => Promise<T | undefined>;
  clearError: () => void;
};

/** Estado de uma chamada à API disparada pela UI: pendente e mensagem de erro amigável. */
export function useAsyncAction(): AsyncAction {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run = useCallback(async <T,>(action: () => Promise<T>): Promise<T | undefined> => {
    setPending(true);
    setError(null);
    try {
      return await action();
    } catch (caught) {
      if (mounted.current) setError(describeError(caught));
      return undefined;
    } finally {
      if (mounted.current) setPending(false);
    }
  }, []);

  const clearError = useCallback(() => setError(null), []);
  return { pending, error, run, clearError };
}
