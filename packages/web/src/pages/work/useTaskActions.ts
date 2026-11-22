import type { Project, TaskCreateBody, TaskMoveBody, TaskPatchBody } from "@cyno/shared";
import { useCallback, useMemo, useState } from "react";
import { api, describeError, type ReleaseBody } from "../../api/client";
import { useWorkStore } from "../../store/workStore";

/** Extrai o projeto da resposta (`{ project }` ou `Project`) e aplica no store local na hora. */
export function syncProjectResponse(response: { project: Project } | Project | undefined): Project | undefined {
  if (!response) return undefined;
  const project = "project" in response ? response.project : response;
  if (project && typeof project.id === "string" && Array.isArray(project.tasks)) {
    useWorkStore.getState().apply({ type: "project:upserted", project });
    return project;
  }
  return undefined;
}

/**
 * As ações do dono sobre a árvore (criar, editar, mover, duplicar, arquivar, etiquetar, cancelar), com o erro
 * da última chamada guardado para a tela mostrar. O resultado chega pelos eventos do servidor (project:upserted);
 * aqui só se espera a resposta para saber se deu certo.
 */
export type TaskActions = {
  error: string | null;
  busy: boolean;
  clearError: () => void;
  create: (body: TaskCreateBody) => Promise<string | undefined>;
  update: (ref: string, body: TaskPatchBody) => Promise<boolean>;
  move: (ref: string, body: TaskMoveBody) => Promise<boolean>;
  duplicate: (ref: string) => Promise<string | undefined>;
  archive: (ref: string) => Promise<boolean>;
  cancel: (ref: string) => Promise<boolean>;
  label: (ref: string, name: string) => Promise<boolean>;
  /** Libera o que está Planejado (módulo = tudo dentro; `withPrerequisites` leva o que esperam). */
  release: (body: ReleaseBody) => Promise<boolean>;
  /** Segura de volta (Planejada) o que ainda não começou. */
  hold: (refs: string[]) => Promise<boolean>;
  /** Tarefa do Avulsas -> projeto próprio; devolve o projeto novo. */
  toProject: (ref: string) => Promise<Project | undefined>;
  /** Projeto de uma tarefa só -> tarefa do Avulsas. */
  toTask: () => Promise<boolean>;
};

export function useTaskActions(projectId: string): TaskActions {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const clearError = useCallback(() => setError(null), []);

  const run = useCallback(async <T,>(action: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    setError(null);
    try {
      return await action();
    } catch (caught) {
      setError(describeError(caught));
      return undefined;
    } finally {
      setBusy(false);
    }
  }, []);

  return useMemo<TaskActions>(
    () => ({
      error,
      busy,
      clearError,
      create: async (body) => {
        const created = await run(() => api.createProjectTask(projectId, body));
        if (created) syncProjectResponse(created);
        return created?.ref;
      },
      update: async (ref, body) => (await run(() => api.updateProjectTask(projectId, ref, body))) !== undefined,
      move: async (ref, body) => (await run(() => api.moveProjectTask(projectId, ref, body))) !== undefined,
      duplicate: async (ref) => (await run(() => api.duplicateProjectTask(projectId, ref)))?.ref,
      archive: async (ref) => (await run(() => api.archiveProjectTask(projectId, ref))) !== undefined,
      cancel: async (ref) => (await run(() => api.updateProjectTask(projectId, ref, { status: "cancelada" }))) !== undefined,
      label: async (ref, name) => (await run(() => api.labelProjectTask(projectId, ref, name))) !== undefined,
      release: async (body) => syncProjectResponse(await run(() => api.releaseWork(projectId, body))) !== undefined,
      hold: async (refs) => syncProjectResponse(await run(() => api.holdWork(projectId, refs))) !== undefined,
      toProject: async (ref) => (await run(() => api.convertTaskToProject(ref)))?.project,
      toTask: async () => (await run(() => api.convertProjectToTask(projectId))) !== undefined,
    }),
    [error, busy, clearError, run, projectId],
  );
}
