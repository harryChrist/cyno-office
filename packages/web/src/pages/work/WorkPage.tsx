import { isMaestroAgent } from "@cyno/shared";
import { useEffect, useMemo, useRef } from "react";
import { useNavStore } from "../../store/navStore";
import { useOfficeStore } from "../../store/officeStore";
import { useTaskFocus } from "../../store/taskFocus";
import { useWorkStore } from "../../store/workStore";
import { useNow } from "../../ui/ActivityFeed";
import { ProjectScreen } from "./ProjectScreen";
import { AllTasks } from "./AllTasks";
import { ProjectsHome } from "./ProjectsHome";
import { parseWorkRoute, routeForProjectId, routeForTaskId, workSub } from "./workRoute";
import { assemblingRequests } from "./workView";
import "./work.css";
import "./tree.css";
import "./flow.css";

/**
 * Página "Projetos e tarefas": a entrada só com os projetos (`#/<ws>/trabalho`) e a tela de um projeto
 * (`#/<ws>/trabalho/p/<id>[/<aba>[/<tarefa>]]`). Os pedidos de foco (Para você, Cyno, Hoje, Gestão) viram endereço.
 */
export function WorkPage() {
  // Trocar de workspace recomeça a página (a tarefa aberta e os filtros eram do anterior).
  const workspaceId = useNavStore((state) => state.workspaceId);
  const sub = useNavStore((state) => state.sub);
  const section = useRef<HTMLElement>(null);
  // Trocar de tela (entrada, projeto, aba) começa do topo; abrir ou fechar o painel de uma tarefa não mexe na rolagem.
  const screen = parseWorkRoute(sub);
  const screenKey = screen.view === "home" ? "home" : screen.view === "tasks" ? "tasks" : `${screen.projectId}/${screen.tab}`;
  useEffect(() => {
    let node: HTMLElement | null = section.current;
    while (node) {
      node.scrollTop = 0;
      node = node.parentElement;
    }
    window.scrollTo(0, 0);
  }, [screenKey]);
  return (
    <section ref={section} className="page page--fill page--work" aria-labelledby="page-title-trabalho" data-testid="page-trabalho">
      <WorkView key={workspaceId ?? ""} workspaceId={workspaceId} />
    </section>
  );
}

function WorkView({ workspaceId }: { workspaceId: string | null }) {
  const sub = useNavStore((state) => state.sub);
  const office = useOfficeStore((state) => state.office);
  const forYou = useOfficeStore((state) => state.forYou);
  const projects = useWorkStore((state) => state.rawProjects);
  const nowDate = useNow();
  const now = nowDate.getTime();
  const route = useMemo(() => parseWorkRoute(sub), [sub]);

  const agents = useMemo(() => new Map((office?.agents ?? []).map((agent) => [agent.id, agent])), [office]);
  const workers = useMemo(() => (office?.agents ?? []).filter((agent) => !(office && isMaestroAgent(office, agent))).sort((a, b) => a.name.localeCompare(b.name, "pt-BR")), [office]);
  const assembling = useMemo(() => (route.view === "home" ? assemblingRequests(office?.tasks ?? [], projects).length : 0), [route.view, office, projects]);

  // Pedidos de foco: o Para você, o Cyno e a Hoje mandam o id de um projeto; o painel de status e o Maestro mandam uma tarefa.
  const requestedProject = useWorkStore((state) => state.openProjectId);
  const requestedTask = useTaskFocus((state) => state.taskId);
  useEffect(() => {
    const target = requestedProject ? routeForProjectId(requestedProject, projects) : requestedTask ? routeForTaskId(requestedTask, projects) : null;
    // Projeto que ainda não chegou: o pedido fica (o efeito roda de novo quando os projetos chegam).
    if (!target) {
      if ((requestedProject || requestedTask) && office) {
        // Já carregou e não existe: mostra a entrada e limpa.
        useWorkStore.getState().open(null);
        useTaskFocus.getState().clear();
      }
      return;
    }
    useNavStore.getState().go("trabalho", workSub(target), true);
    useWorkStore.getState().open(null);
    useTaskFocus.getState().clear();
  }, [requestedProject, requestedTask, projects, office]);

  // O resumo da Gestão abre a entrada só com os prazos em risco (o filtro vive na store até o dono tirar ou sair da página).
  const atRisk = useWorkStore((state) => state.openAtRisk);
  useEffect(() => {
    if (atRisk && sub !== "") useNavStore.getState().go("trabalho", "", true);
  }, [atRisk, sub]);
  useEffect(() => () => useWorkStore.getState().openFiltered(false), []);

  if (route.view === "tasks") {
    return <AllTasks projects={projects} forYou={forYou} agents={agents} workers={workers} now={now} query={route.query} panel={route.projectId && route.ref ? { projectId: route.projectId, ref: route.ref } : null} />;
  }
  if (route.view === "project") {
    return (
      <ProjectScreen
        project={projects.find((project) => project.id === route.projectId)}
        projectId={route.projectId}
        tab={route.tab}
        taskRef={route.ref}
        agents={agents}
        workers={workers}
        forYou={forYou}
        workspaceId={workspaceId}
        now={now}
      />
    );
  }
  return <ProjectsHome projects={projects} forYou={forYou} agents={agents} now={now} atRiskOnly={atRisk} onClearAtRisk={() => useWorkStore.getState().openFiltered(false)} assembling={assembling} />;
}
