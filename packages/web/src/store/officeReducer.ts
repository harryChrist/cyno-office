import type { OfficeState, ServerEvent } from "@cyno/shared";
import { applyServerEvent } from "./applyServerEvent";
import { applyForYouEvent, type ForYouItems } from "./forYouItems";
import { applyForYouTypesEvent, isForYouTypesEvent, type ForYouTypes } from "./forYouTypes";
import { applyTaskProgress, EMPTY_PROGRESS, type TaskProgressMap } from "./taskProgress";

/**
 * Tudo que o web sabe do server: o escritório, o progresso das tarefas ativas e os itens do
 * "Para você" com os tipos do workspace (vêm no office:snapshot; null = ainda não carregados).
 */
export type OfficeSync = { office: OfficeState | null; progress: TaskProgressMap; forYou: ForYouItems; forYouTypes: ForYouTypes };

export const INITIAL_SYNC: OfficeSync = { office: null, progress: EMPTY_PROGRESS, forYou: null, forYouTypes: null };

/**
 * Reducer puro que aplica QUALQUER ServerEvent. Antes do primeiro snapshot (office null)
 * os eventos do escritório são ignorados; os foryou:* só valem depois do GET. Devolve o mesmo
 * objeto se nada mudou.
 */
export function officeReducer(state: OfficeSync, event: ServerEvent): OfficeSync {
  if (event.type === "foryou:upserted" || event.type === "foryou:deleted" || event.type === "foryou:archived") {
    const forYou = applyForYouEvent(state.forYou, event);
    return forYou === state.forYou ? state : { ...state, forYou };
  }
  if (isForYouTypesEvent(event)) {
    const forYouTypes = applyForYouTypesEvent(state.forYouTypes, event);
    return forYouTypes === state.forYouTypes ? state : { ...state, forYouTypes };
  }
  if (event.type === "office:snapshot") {
    // O snapshot traz o "Para você" (server novo): é o retrato completo, troca tudo de uma vez.
    return {
      ...state,
      office: event.office,
      progress: applyTaskProgress(state.progress, event, event.office),
      ...(event.forYou ? { forYou: event.forYou } : {}),
      ...(event.forYouTypes ? { forYouTypes: event.forYouTypes } : {}),
    };
  }
  if (!state.office) return state;
  const office = applyServerEvent(state.office, event);
  const progress = applyTaskProgress(state.progress, event, state.office);
  if (office === state.office && progress === state.progress) return state;
  return { ...state, office, progress };
}
