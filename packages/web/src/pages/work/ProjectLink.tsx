import { projectProgress } from "@cyno/shared";
import { useWorkStore } from "../../store/workStore";
import "./work.css";
import { openProject } from "./openProject";

/** Botão "Projeto 3/8" de um pedido (nada se o pedido não virou projeto): abre o projeto na página Trabalho. */
export function ProjectLink({ requestId }: { requestId: string }) {
  const project = useWorkStore((state) => state.projects.find((candidate) => candidate.id === requestId));
  if (!project || project.kind !== "projeto") return null;
  const { done, total } = projectProgress(project);
  return (
    <button type="button" className="plan-link" onClick={() => openProject(project.id)} title="Ver o projeto em Projetos e tarefas" data-testid="plan-link">
      Projeto {done}/{total}
    </button>
  );
}
