import type { Project } from "@cyno/shared";
import { useMemo } from "react";
import { useOfficeStore } from "../../store/officeStore";
import { useWorkStore } from "../../store/workStore";
import { awaitingUser, looseTaskProjects, type Awaiting } from "./workView";

/** Os projetos do workspace e, junto, as tarefas avulsas que o servidor ainda não espelhou num Projeto (só na tela). */
export function useWorkProjects(): Project[] {
  const projects = useWorkStore((state) => state.projects);
  const tasks = useOfficeStore((state) => state.office?.tasks);
  return useMemo(() => [...projects, ...looseTaskProjects(tasks ?? [], projects)], [projects, tasks]);
}

/** "Esperando você": a única conta (menu, página e painel de status). */
export function useAwaiting(): Awaiting {
  const projects = useWorkProjects();
  const forYou = useOfficeStore((state) => state.forYou);
  return useMemo(() => awaitingUser(projects, forYou), [projects, forYou]);
}
