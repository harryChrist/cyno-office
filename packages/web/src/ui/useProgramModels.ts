import type { OneShotEngineId, ProgramModelsResponse } from "@cyno/shared";
import { useCallback, useEffect, useState } from "react";
import { api, describeError } from "../api/client";

/**
 * Os modelos que o PRÓPRIO programa lista (OpenClaw: `models list`; Hermes: não há lista, só digitação livre). Só lê quando
 * `active` (a conta é a configuração do programa). `refresh` lê de novo; falha de leitura vira `error` e a digitação livre segue valendo.
 */
export function useProgramModels(engine: OneShotEngineId, active: boolean, version = "") {
  const [data, setData] = useState<ProgramModelsResponse | null>(null);
  const [loading, setLoading] = useState(active);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!active) return;
    let alive = true;
    api
      .getEngineProgramModels(engine)
      .then((response) => alive && (setData(response), setError(null)))
      .catch((failure: unknown) => alive && setError(describeError(failure)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [engine, active, version]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await api.getEngineProgramModels(engine));
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setLoading(false);
    }
  }, [engine]);

  return { models: data?.models ?? [], readAt: data?.readAt, note: data?.note, source: data?.source, loading, error, refresh };
}
