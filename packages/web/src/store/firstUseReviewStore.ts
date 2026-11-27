import { create } from "zustand";
import { useNavStore } from "./navStore";

type FirstUseReviewState = {
  /** Modo de revisão da tela de primeiro uso (só em memória; nunca apaga nada). */
  active: boolean;
  /** Liga o modo de revisão e abre a página inicial do Cyno. */
  start: () => void;
  /** Desliga o modo de revisão (ao enviar mensagem, criar workspace ou sair da página do Cyno). */
  stop: () => void;
  /**
   * O usuário abriu o chat com o Cyno nesta sessão (mandou uma mensagem ou clicou em "Continuar a conversa anterior")?
   * Sem workspace, o Início mostra a tela de boas-vindas, a menos que isto seja verdadeiro. Só em memória.
   */
  chatOpen: boolean;
  openChat: () => void;
  closeChat: () => void;
};

export const useFirstUseReviewStore = create<FirstUseReviewState>()((set) => ({
  active: false,
  start: () => {
    useNavStore.getState().go("cyno");
    set({ active: true });
  },
  stop: () => set({ active: false }),
  chatOpen: false,
  openChat: () => set({ chatOpen: true, active: false }),
  closeChat: () => set((state) => (state.chatOpen ? { chatOpen: false } : state)),
}));

// Ao sair da página do Cyno (por clique na navegação ou Voltar do navegador), o modo de revisão desliga.
useNavStore.subscribe((state) => {
  if (state.page !== "cyno" && useFirstUseReviewStore.getState().active) {
    useFirstUseReviewStore.getState().stop();
  }
});
