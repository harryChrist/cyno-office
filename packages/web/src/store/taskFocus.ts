import { create } from "zustand";
import { useNavStore } from "./navStore";

type TaskFocusState = {
  /** Tarefa (ou pedido) que a página Trabalho deve abrir (null = nenhuma). */
  taskId: string | null;
  /** "Abrir em Projetos e tarefas": vai para a página e pede a linha (e a etapa) da tarefa. */
  open: (taskId: string) => void;
  clear: () => void;
};

export const useTaskFocus = create<TaskFocusState>()((set) => ({
  taskId: null,
  open: (taskId) => {
    set({ taskId });
    useNavStore.getState().go("trabalho");
  },
  clear: () => set({ taskId: null }),
}));
