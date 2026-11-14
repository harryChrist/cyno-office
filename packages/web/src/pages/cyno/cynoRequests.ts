import { isSentRequestClosed, SENT_REQUEST_STATE_LABELS, type SentRequestState, type SentRequestView } from "@cyno/shared";
import { useNavStore } from "../../store/navStore";
import { useWorkStore } from "../../store/workStore";

/** Funções puras dos cartões de pedidos enviados (o chat e a seção "Pedidos enviados"). */

export type RequestTone = "info" | "wait" | "ok" | "bad" | "idle";

const TONES: Record<SentRequestState, RequestTone> = { enviado: "info", andando: "info", esperando_voce: "wait", pausado: "idle", concluido: "ok", falhou: "bad", cancelado: "idle" };

export const requestTone = (state: SentRequestState): RequestTone => TONES[state];

/** "andando", "esperando você", "concluído"… (o selo do cartão). */
export function stateLabel(view: Pick<SentRequestView, "state">): string {
  return view.state === "enviado" ? "enviado" : SENT_REQUEST_STATE_LABELS[view.state];
}

/** "2/4 tarefas" quando já há tarefas; vazio senão. */
export function tasksLabel(view: Pick<SentRequestView, "tasksDone" | "tasksTotal">): string {
  return view.tasksTotal > 0 ? `${view.tasksDone}/${view.tasksTotal} ${view.tasksTotal === 1 ? "tarefa" : "tarefas"}` : "";
}

/** A linha compacta do cartão: "Enviado ao LinkedIn · Post da semana · 2/4 tarefas · esperando você (1)". */
export function requestLine(view: SentRequestView): string {
  const parts = [`Enviado ao ${view.workspaceName}`, view.title, tasksLabel(view)];
  if (view.state === "esperando_voce") parts.push(view.waitingForYou > 0 ? `esperando você (${view.waitingForYou})` : "esperando você");
  else parts.push(stateLabel(view));
  return parts.filter(Boolean).join(" · ");
}

export const isOpenRequest = (view: Pick<SentRequestView, "state">): boolean => !isSentRequestClosed(view.state);

/** Os pedidos abertos de um workspace (o selo da ficha). */
export const openRequestsOf = (requests: readonly SentRequestView[], workspace: string): SentRequestView[] => requests.filter((view) => view.workspace === workspace && isOpenRequest(view));

/** "1 novo no mural" / "3 novos no mural" (o que o Maestro do workspace ainda não viu); vazio sem novidade. */
export function muralBadge(count: number): string {
  return count <= 0 ? "" : count === 1 ? "1 novo no mural" : `${count} novos no mural`;
}

/** "1 pedido do Cyno" / "3 pedidos do Cyno" (o selo da ficha); vazio sem pedidos abertos. */
export function requestsBadge(count: number): string {
  return count === 0 ? "" : `${count} ${count === 1 ? "pedido" : "pedidos"} do Cyno`;
}

/** Abre o projeto na tela Trabalho do workspace dele (de qualquer tela, inclusive a página do Cyno). */
export function openRequestProject(workspace: string, projectId: string): void {
  const nav = useNavStore.getState();
  nav.setWorkspace(workspace);
  nav.go("trabalho");
  const loaded = (projects: readonly { id: string }[]) => projects.some((project) => project.id === projectId);
  if (loaded(useWorkStore.getState().projects)) {
    useWorkStore.getState().open(projectId);
    return;
  }
  // Trocar de workspace limpa o que a tela Trabalho carregou: o pedido de foco entra quando os projetos do novo chegam.
  const timer = window.setTimeout(() => off(), 10_000);
  const off = useWorkStore.subscribe((state) => {
    if (!loaded(state.projects)) return;
    window.clearTimeout(timer);
    off();
    state.open(projectId);
  });
}
