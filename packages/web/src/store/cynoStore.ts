import type { AgentLogEntry, Card, Confirmation, CynoServerEvent, JointView, CynoState, ModelChoice, SentRequestView, WaitingItem, WorkspaceProposal } from "@cyno/shared";
import { create } from "zustand";
import { api, describeError } from "../api/client";
import { connectCynoSocket, type CynoSocketStatus } from "../ws/cynoSocket";
import { useAgendaStore } from "./agendaStore";
import { useMuralStore } from "./muralStore";
import { AGENT_LOG_CAP, mergeEntry, mergeHistory } from "./agentLog";

type CynoStore = {
  /** Estado do Cyno (dormindo, acordando, trabalhando, acordado); null enquanto não chegou. */
  state: CynoState | null;
  /** Entradas do log da conversa (falas, ferramentas, respostas), as mais novas por último. */
  entries: AgentLogEntry[];
  socket: CynoSocketStatus;
  /** Já recebeu o primeiro snapshot? */
  loaded: boolean;
  /** Enviando a mensagem (entre o clique e a resposta do POST). */
  sending: boolean;
  /** Último erro de uma ação (enviar, trocar de modelo, nova conversa). */
  error: string | null;
  /** As fichas dos workspaces (calculadas pelo servidor, sem IA) e o "Esperando você" de todos. */
  cards: Card[];
  waiting: WaitingItem[];
  /** Os pedidos que o Cyno enviou aos Maestros, com o estado de cada um (o servidor avisa por `cyno:requests`). */
  requests: SentRequestView[];
  /** Os projetos conjuntos (uma parte em cada workspace), com o estado de cada parte (o servidor avisa por `cyno:joints`). */
  joints: JointView[];
  loadJoints: () => Promise<void>;
  /** O dono pausa, retoma ou cancela o conjunto, ou refaz uma parte que falhou. */
  jointAction: (id: string, action: "pause" | "resume" | "cancel" | "retry", ref?: string) => Promise<void>;
  /** Confirmações de ações perigosas e propostas de workspace (o servidor avisa por `cyno:confirmations`/`cyno:proposals`). */
  confirmations: Confirmation[];
  proposals: WorkspaceProposal[];
  /** Ids com um clique em andamento (o botão fica desligado até a resposta). */
  deciding: string[];
  loadDecisions: () => Promise<void>;
  /** O dono confirma/recusa uma ação perigosa ou aprova/recusa uma proposta de workspace. */
  decide: (kind: "confirmation" | "proposal", id: string, decision: "approve" | "reject") => Promise<void>;
  /** Já buscou as fichas ao menos uma vez? */
  cardsLoaded: boolean;
  loadRequests: () => Promise<void>;
  /** Busca as fichas e o "Esperando você" (a página abre; o servidor avisa por `cyno:cards` quando mudam). */
  loadCards: () => Promise<void>;
  /** Escreve a frase "o que este workspace faz" (o dono). */
  saveSummary: (workspace: string, summary: string) => Promise<boolean>;
  /** O dono ignora a sugestão de frase de uma IA. */
  dismissProposal: (workspace: string) => Promise<void>;
  applyEvent: (event: CynoServerEvent) => void;
  setSocketStatus: (status: CynoSocketStatus) => void;
  send: (text: string) => Promise<boolean>;
  newConversation: () => Promise<void>;
  setChoice: (choice: ModelChoice) => Promise<boolean>;
  clearError: () => void;
  /** Liga o websocket (a página abre); devolve a função que desliga. */
  connect: () => () => void;
};

/** Agrupa uma rajada de `cyno:cards` numa busca só. */
const RELOAD_DEBOUNCE_MS = 250;
let reloadTimer: ReturnType<typeof setTimeout> | undefined;

export const useCynoStore = create<CynoStore>()((set, get) => ({
  state: null,
  cards: [],
  waiting: [],
  requests: [],
  joints: [],
  confirmations: [],
  proposals: [],
  deciding: [],
  cardsLoaded: false,
  entries: [],
  socket: "connecting",
  loaded: false,
  sending: false,
  error: null,

  applyEvent(event) {
    if (event.type === "cyno:snapshot") {
      // Reconexão: o snapshot é a verdade, mas o que chegou ao vivo e ainda não está nele continua.
      set((current) => ({ state: event.state, entries: mergeHistory(current.entries, event.entries, AGENT_LOG_CAP), loaded: true }));
      // Conexão nova (ou reconexão): as fichas podem ter mudado enquanto estava fora.
      void get().loadCards();
      void get().loadRequests();
      void get().loadDecisions();
      void useMuralStore.getState().load();
      void get().loadJoints();
    } else if (event.type === "cyno:joints") {
      set({ joints: event.joints });
      // Um conjunto que travou (ou terminou) muda o "Esperando você".
      clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => void get().loadCards(), RELOAD_DEBOUNCE_MS);
    } else if (event.type === "cyno:confirmations") {
      set({ confirmations: event.confirmations });
    } else if (event.type === "cyno:proposals") {
      set({ proposals: event.proposals });
      // Workspace criado (ou desfeito): as fichas mudam.
      clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => void get().loadCards(), RELOAD_DEBOUNCE_MS);
    } else if (event.type === "cyno:requests") {
      set({ requests: event.requests });
      // Um pedido que passou a esperar você (ou fechou) muda o "Esperando você" e as fichas.
      clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => void get().loadCards(), RELOAD_DEBOUNCE_MS);
    } else if (event.type === "cyno:log") {
      set((current) => ({ entries: mergeEntry(current.entries, event.entry, AGENT_LOG_CAP) }));
    } else if (event.type === "agenda:upserted" || event.type === "agenda:availability") {
      // A Sua agenda (bloco da página inicial e a própria página) vive no agendaStore.
      useAgendaStore.getState().applyEvent(event);
    } else if (event.type === "mural:changed") {
      void useMuralStore.getState().load();
    } else if (event.type === "attention:raised" || event.type === "attention:updated" || event.type === "attention:cleared") {
      // Os alertas de atenção vivem no attentionStore (o `AttentionRoot` tem o próprio socket, sempre aberto).
    } else if (event.type === "cyno:cards") {
      clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => void get().loadCards(), RELOAD_DEBOUNCE_MS);
    } else {
      set({ state: event.state });
    }
  },

  async loadRequests() {
    try {
      set({ requests: (await api.cynoRequests()).requests });
    } catch {
      // Sem rede: fica com o que tinha; o próximo evento ou a reconexão busca de novo.
    }
  },

  async loadJoints() {
    try {
      set({ joints: (await api.cynoJoints()).joints });
    } catch {
      // Sem rede: fica com o que tinha; o próximo evento ou a reconexão busca de novo.
    }
  },

  async jointAction(id, action, ref) {
    set({ error: null });
    try {
      const updated = action === "retry" ? await api.retryJointPart(id, ref ?? "") : await api.jointAction(id, action);
      set((current) => ({ joints: current.joints.map((item) => (item.id === id ? updated : item)) }));
    } catch (error) {
      set({ error: describeError(error) });
      void get().loadJoints();
    }
  },

  async loadDecisions() {
    try {
      const [{ confirmations }, { proposals }] = await Promise.all([api.cynoConfirmations(), api.cynoProposals()]);
      set({ confirmations, proposals });
    } catch {
      // Sem rede: fica com o que tinha; o próximo evento ou a reconexão busca de novo.
    }
  },

  async decide(kind, id, decision) {
    if (get().deciding.includes(id)) return;
    set((current) => ({ deciding: [...current.deciding, id], error: null }));
    try {
      if (kind === "confirmation") {
        const updated = decision === "approve" ? await api.approveConfirmation(id) : await api.rejectConfirmation(id);
        set((current) => ({ confirmations: current.confirmations.map((item) => (item.id === id ? updated : item)) }));
      } else {
        const updated = decision === "approve" ? await api.approveProposal(id) : await api.rejectProposal(id);
        set((current) => ({ proposals: current.proposals.map((item) => (item.id === id ? updated : item)) }));
      }
    } catch (error) {
      set({ error: describeError(error) });
      // Outra aba pode ter decidido, ou venceu: confere o estado de verdade.
      void get().loadDecisions();
    } finally {
      set((current) => ({ deciding: current.deciding.filter((item) => item !== id) }));
    }
  },

  async loadCards() {
    try {
      const [{ cards }, { items }] = await Promise.all([api.cynoCards(), api.cynoWaiting()]);
      set({ cards, waiting: items, cardsLoaded: true });
    } catch {
      // Sem rede: fica com o que tinha; o próximo evento ou a reconexão busca de novo.
      set({ cardsLoaded: true });
    }
  },

  async saveSummary(workspace, summary) {
    set({ error: null });
    try {
      const card = await api.setCardSummary(workspace, summary);
      set((current) => ({ cards: current.cards.map((item) => (item.workspace === workspace ? card : item)) }));
      return true;
    } catch (error) {
      set({ error: describeError(error) });
      return false;
    }
  },

  async dismissProposal(workspace) {
    try {
      const card = await api.dismissCardProposal(workspace);
      set((current) => ({ cards: current.cards.map((item) => (item.workspace === workspace ? card : item)) }));
    } catch (error) {
      set({ error: describeError(error) });
    }
  },

  setSocketStatus: (socket) => set({ socket }),

  async send(text) {
    set({ sending: true, error: null });
    try {
      await api.sendToCyno(text);
      set({ sending: false });
      return true;
    } catch (error) {
      set({ sending: false, error: describeError(error) });
      return false;
    }
  },

  async newConversation() {
    set({ error: null });
    try {
      set({ state: await api.cynoNewConversation() });
    } catch (error) {
      set({ error: describeError(error) });
    }
  },

  async setChoice(choice) {
    set({ error: null });
    try {
      set({ state: await api.setCynoModel(choice) });
      return true;
    } catch (error) {
      set({ error: describeError(error) });
      return false;
    }
  },

  clearError: () => set({ error: null }),

  connect() {
    return connectCynoSocket({ onEvent: (event) => get().applyEvent(event), onStatus: (status) => get().setSocketStatus(status) });
  },
}));
