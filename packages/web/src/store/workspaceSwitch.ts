import { useActivityStore } from "../ui/activity";
import { useWorkPanelStore } from "../agentWork/workPanelStore";
import { useAgentLogStore } from "./agentLogStore";
import { useCalendarStore } from "./calendarStore";
import { useForYouTypesSheet } from "./forYouTypesSheet";
import { useNavStore } from "./navStore";
import { useOfficeStore } from "./officeStore";
import { useViewStore } from "./viewStore";

/**
 * Troca de workspace: esquece o escritório anterior (o canvas reconstrói tudo com o snapshot do
 * novo), o calendário, a seleção, o foco, o feed de atividade, o log dos agentes e a tela de trabalho aberta. Quem reconecta o WebSocket e recarrega o
 * escritório é o App (o efeito depende do workspace atual).
 */
export function clearWorkspaceState(): void {
  useOfficeStore.getState().reset();
  useCalendarStore.getState().reset();
  useViewStore.setState({ selection: null, focus: { kind: "map" }, showAgentRequest: null });
  useActivityStore.setState({ entries: [] });
  useAgentLogStore.getState().reset();
  useWorkPanelStore.getState().close();
  useWorkPanelStore.getState().collapseMaestro();
  useForYouTypesSheet.getState().setOpen(false);
}

/** Limpa o estado sempre que o workspace muda (a primeira escolha, de null para um id, não limpa). */
export function watchWorkspaceSwitch(): () => void {
  return useNavStore.subscribe((state, prev) => {
    if (prev.workspaceId !== null && state.workspaceId !== prev.workspaceId) clearWorkspaceState();
  });
}
