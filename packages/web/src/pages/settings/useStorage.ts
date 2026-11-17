import type { StorageResponse } from "@cyno/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../api/client";
import { anyComputing, STORAGE_POLL_MS } from "./storageView";

export type StorageHook = { data: StorageResponse | null; failed: boolean; refresh: () => void };

/**
 * Espaço em disco do workspace e das pastas de trabalho. A primeira consulta já dispara as medições (feitas em
 * segundo plano no servidor, com cache); a tela só volta a consultar enquanto houver algo "computing".
 */
export function useStorage(workspaceId: string, folderKey = ""): StorageHook {
  const [data, setData] = useState<StorageResponse | null>(null);
  const [failed, setFailed] = useState(false);
  const alive = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const loadRef = useRef<(refresh: boolean) => Promise<void>>(async () => undefined);

  const load = useCallback(
    async (refresh: boolean) => {
      clearTimeout(timer.current);
      try {
        const next = await (refresh ? api.refreshStorageOf(workspaceId) : api.storageOf(workspaceId));
        if (!alive.current) return;
        setData(next);
        setFailed(false);
        if (anyComputing(next)) timer.current = setTimeout(() => void loadRef.current(false), STORAGE_POLL_MS);
      } catch {
        if (!alive.current) return;
        setFailed(true);
      }
    },
    [workspaceId],
  );

  useEffect(() => {
    loadRef.current = load;
  }, [load]);

  // `folderKey` muda quando uma pasta é cadastrada ou tirada: consulta de novo para medir a nova.
  useEffect(() => {
    alive.current = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- consulta o servidor ao abrir a tela
    void load(false);
    return () => {
      alive.current = false;
      clearTimeout(timer.current);
    };
  }, [load, folderKey]);

  return { data, failed, refresh: useCallback(() => void load(true), [load]) };
}
