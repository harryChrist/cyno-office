import { useNavStore } from "../../store/navStore";
import { useWorkStore } from "../../store/workStore";
import { workSub, type ProjectTab } from "./workRoute";

/** Abre um projeto na página Trabalho (de qualquer tela): vai para a página e pede para abrir a linha dele. */
export function openProject(projectId: string): void {
  useWorkStore.getState().open(projectId);
  useNavStore.getState().go("trabalho");
}

/** Abre uma aba do projeto (e, se vier `ref`, o painel da tarefa) na página Trabalho. */
export function openProjectAt(projectId: string, tab: ProjectTab, ref?: string): void {
  useNavStore.getState().go("trabalho", workSub({ view: "project", projectId, tab, ...(ref ? { ref } : {}) }));
}
