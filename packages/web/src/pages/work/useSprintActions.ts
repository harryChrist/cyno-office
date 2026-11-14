import type { SprintCreateBody, SprintPatchBody } from "@cyno/shared";
import { useCallback, useMemo, useState } from "react";
import { api, describeError } from "../../api/client";

/**
 * As ações do dono sobre as sprints do projeto (criar, editar, apagar, começar e fechar agora), com o erro da
 * última chamada guardado para a tela mostrar. O resultado chega pelos eventos do servidor (project:upserted).
 */
export type SprintActions = {
  error: string | null;
  busy: boolean;
  clearError: () => void;
  create: (body: SprintCreateBody) => Promise<boolean>;
  update: (sprintId: string, body: SprintPatchBody) => Promise<boolean>;
  remove: (sprintId: string) => Promise<boolean>;
  start: (sprintId: string) => Promise<boolean>;
  close: (sprintId: string) => Promise<boolean>;
};

export function useSprintActions(projectId: string): SprintActions {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const clearError = useCallback(() => setError(null), []);

  const run = useCallback(async <T,>(action: () => Promise<T>): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      await action();
      return true;
    } catch (caught) {
      setError(describeError(caught));
      return false;
    } finally {
      setBusy(false);
    }
  }, []);

  return useMemo<SprintActions>(
    () => ({
      error,
      busy,
      clearError,
      create: (body) => run(() => api.createSprint(projectId, body)),
      update: (sprintId, body) => run(() => api.updateSprint(projectId, sprintId, body)),
      remove: (sprintId) => run(() => api.deleteSprint(projectId, sprintId)),
      start: (sprintId) => run(() => api.startSprint(projectId, sprintId)),
      close: (sprintId) => run(() => api.closeSprint(projectId, sprintId)),
    }),
    [error, busy, clearError, run, projectId],
  );
}
