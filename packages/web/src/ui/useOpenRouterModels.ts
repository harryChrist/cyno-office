import type { OpenRouterModel } from "@cyno/shared";
import { useCallback, useEffect, useState } from "react";
import { api, describeError } from "../api/client";

/**
 * A lista inteira de modelos do OpenRouter, como o servidor a guarda (OpenClaw e Hermes). Lê a guardada ao montar;
 * `refresh` pede ao servidor para ler de novo na rota pública. Falha de leitura vira `error` (a digitação livre segue valendo).
 */
export function useOpenRouterModels(active = true): { models: OpenRouterModel[]; readAt: string | undefined; loading: boolean; refreshing: boolean; error: string | null; refresh: () => Promise<void> } {
  const [data, setData] = useState<{ models: OpenRouterModel[]; readAt: string } | null>(null);
  const [loading, setLoading] = useState(active);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!active) return;
    let alive = true;
    api
      .getOpenRouterModels()
      .then((response) => alive && setData(response))
      .catch((failure: unknown) => alive && setError(describeError(failure)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [active]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    setError(null);
    try {
      setData(await api.refreshOpenRouterModels());
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setRefreshing(false);
    }
  }, []);

  return { models: data?.models ?? [], readAt: data?.readAt || undefined, loading, refreshing, error, refresh };
}
