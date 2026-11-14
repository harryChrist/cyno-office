import type { AttentionAlert } from "@cyno/shared";
import { useWorkPanelStore } from "../agentWork/workPanelStore";
import { openProject } from "../pages/work/openProject";
import { useForYouFocus } from "../store/forYouFocus";
import { useNavStore } from "../store/navStore";
import { useOfficeStore } from "../store/officeStore";
import { useTaskFocus } from "../store/taskFocus";
import { useViewStore } from "../store/viewStore";

/** Abre o agente quando o escritório do workspace (que acabou de ser trocado) já o conhece. */
function openAgentWhenLoaded(agentId: string): void {
  const knows = () => useOfficeStore.getState().office?.agents.some((agent) => agent.id === agentId) ?? false;
  if (knows()) {
    useWorkPanelStore.getState().openAgent(agentId);
    return;
  }
  const stop = useOfficeStore.subscribe(() => {
    if (!knows()) return;
    stop();
    window.clearTimeout(timer);
    useWorkPanelStore.getState().openAgent(agentId);
  });
  const timer = window.setTimeout(stop, 8_000);
}

/**
 * Com o Escritório aberto, enquadra o personagem do agente no mapa (seleciona e leva a câmera até ele). Fora do
 * Escritório não mexe em nada. A cena ignora quem não está presente (a seleção some sozinha).
 */
export function frameAgentOnMap(agentId: string): void {
  if (useNavStore.getState().page !== "office") return;
  const office = useOfficeStore.getState().office;
  const agent = office?.agents.find((candidate) => candidate.id === agentId);
  if (!office || !agent) return;
  const roomId = office.teams.find((team) => team.id === agent.teamId)?.roomId;
  if (!roomId) return;
  const view = useViewStore.getState();
  view.select({ kind: "agent", id: agentId });
  view.showAgent(agentId, roomId);
}

/**
 * Leva ao lugar do alerta, trocando de workspace se for preciso: o item em Aprovações, a tarefa em
 * Projetos e tarefas, o agente (a tela de trabalho dele), os Gastos. Só leva até lá: **nunca decide
 * nada** (aprovar é sempre um clique do dono no cartão).
 */
export function openAlert(alert: Pick<AttentionAlert, "kind" | "target" | "taskId" | "projectId" | "agentId">): void {
  const { target } = alert;
  const nav = useNavStore.getState();
  const noEscritorio = nav.page === "office" && !(target.workspaceId && target.workspaceId !== nav.workspaceId);
  if (noEscritorio && alert.agentId && target.page === "agente") frameAgentOnMap(alert.agentId);
  const switching = Boolean(target.workspaceId && target.workspaceId !== nav.workspaceId);
  if (target.workspaceId && switching) nav.setWorkspace(target.workspaceId);
  switch (target.page) {
    case "para-voce":
      if (target.ref) useForYouFocus.getState().open(target.ref);
      else useNavStore.getState().go("para-voce");
      return;
    case "trabalho":
      if ((alert.kind === "help" || alert.kind === "delivery") && alert.projectId) openProject(alert.projectId);
      else if (target.ref) useTaskFocus.getState().open(target.ref);
      else useNavStore.getState().go("trabalho");
      return;
    case "agente":
      if (target.ref) {
        // A tela de trabalho abre por cima de qualquer página.
        if (switching) openAgentWhenLoaded(target.ref);
        else useWorkPanelStore.getState().openAgent(target.ref);
      } else useNavStore.getState().go("office");
      return;
    case "gestao":
      useNavStore.getState().go("gestao", target.ref ?? "");
      return;
    case "cyno":
      useNavStore.getState().go("cyno");
      return;
  }
}
