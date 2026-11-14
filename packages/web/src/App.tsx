import type { ServerEvent } from "@cyno/shared";
import { lazy, Suspense, useEffect } from "react";
import { AttentionRoot } from "./attention/AttentionRoot";
import { Hud } from "./hud/Hud";
import { SystemWarnings } from "./hud/SystemWarnings";
import { CenaControles } from "./cena/CenaControles";
import { ReplayPlayer } from "./cena/replay/ReplayPlayer";
import { pedeCenaDemo } from "./cena/chave";
import { Pages } from "./pages/Pages";
import { syncNavWithHistory, useNavStore } from "./store/navStore";
import { useActivityLogStore } from "./store/activityLogStore";
import { useLibraryAppsStore } from "./store/libraryAppsStore";
import { useLibraryStore } from "./store/libraryStore";
import { routineNoticeOf, useNoticesStore } from "./store/notices";
import { useSystemWarningStore } from "./store/systemWarningStore";
import { useOfficeStore } from "./store/officeStore";
import { useWorkspaceStore, useWorkspaceView } from "./store/workspaceStore";
import { watchWorkspaceSwitch } from "./store/workspaceSwitch";
import { startActivityTracking } from "./ui/activity";
import { exposeStoresForDev } from "./ui/devHooks";
import { NoWorkspace } from "./ui/NoWorkspace";
import { SidePanel } from "./ui/SidePanel";
import { TaskBox } from "./ui/TaskBox";
import "./ui/ui.css";
import { connectOfficeSocket } from "./ws/officeSocket";

if (import.meta.env.DEV) exposeStoresForDev();

// A cena nova (motor do Habblaud, pacote @cyno/cena): só carrega com ?cena=demo (dados de mentira, F1 da Junção V2).
const CenaCanvas = lazy(() => import("./cena/CenaCanvas").then((module) => ({ default: module.CenaCanvas })));
// O escritório real do workspace aberto na cena (motor do pacote @cyno/cena).
const CenaDoEscritorio = lazy(() => import("./cena/CenaCanvas").then((module) => ({ default: module.CenaDoEscritorio })));

export function App() {
  const load = useOfficeStore((state) => state.load);
  const applyEvent = useOfficeStore((state) => state.applyEvent);
  const setSocketStatus = useOfficeStore((state) => state.setSocketStatus);
  const onOffice = useNavStore((state) => state.page === "office");
  // Páginas do app inteiro (abrem mesmo sem workspace): Configurações, a Atividade e o Cyno.
  const onSettings = useNavStore((state) => state.page === "configuracoes" || (state.page === "gestao" && state.sub === "atividade") || state.page === "cyno" || state.page === "agenda" || state.page === "biblioteca");
  const workspaceId = useNavStore((state) => state.workspaceId);
  const view = useWorkspaceView();
  const workspaceName = useWorkspaceStore((state) => state.workspaces?.find((ws) => ws.id === workspaceId)?.name ?? "");

  useEffect(() => syncNavWithHistory(), []);
  useEffect(() => watchWorkspaceSwitch(), []);
  useEffect(() => startActivityTracking(), []);

  // O escritório por REST só depois que a lista confirmou o workspace (um endereço de workspace
  // excluído daria 404); o snapshot do WebSocket costuma chegar junto.
  const listed = view === "ready";
  useEffect(() => {
    if (listed) void load();
  }, [listed, workspaceId, load]);

  // Um WebSocket por workspace: trocar de workspace fecha o antigo e conecta no novo. Sem workspace
  // nenhum, o socket só traz a lista (e avisa quando um workspace nascer).
  useEffect(() => {
    const onEvent = (event: ServerEvent) => {
      if (event.type === "workspaces:list") {
        useWorkspaceStore.getState().setList(event.workspaces);
        return;
      }
      // Entrada nova da Atividade (do workspace aberto ou do servidor): só alimenta a página Atividade.
      if (event.type === "activity:appended") {
        useActivityLogStore.getState().push(event.entry);
        // Rotina de acompanhamento com mudança (item novo, status, fim da vida): um aviso no sino.
        const notice = routineNoticeOf(event.entry);
        if (notice && (event.entry.workspaceId === undefined || event.entry.workspaceId === useNavStore.getState().workspaceId)) useNoticesStore.getState().push(notice);
        return;
      }
      // A Biblioteca é da plataforma: o evento vale em qualquer workspace aberto.
      if (event.type === "library:upserted" || event.type === "library:deleted" || event.type === "library:skill-upserted" || event.type === "library:skill-deleted") {
        useLibraryStore.getState().apply(event);
        return;
      }
      if (event.type === "library:app" || event.type === "library:app-removed" || event.type === "library:app-run" || event.type === "library:job" || event.type === "library:job-log") {
        useLibraryAppsStore.getState().apply(event);
        return;
      }
      if (event.type === "system:warning") {
        useSystemWarningStore.getState().push(event.message, event.at);
        return;
      }
      // Evento atrasado do workspace anterior (o socket ainda não fechou): ignora.
      if (workspaceId !== null && useNavStore.getState().workspaceId !== workspaceId) return;
      applyEvent(event);
    };
    return connectOfficeSocket({ workspaceId, onEvent, onStatus: setSocketStatus });
  }, [workspaceId, applyEvent, setSocketStatus]);

  if (pedeCenaDemo(window.location.search)) {
    return (
      <Suspense fallback={null}>
        <CenaCanvas search={window.location.search} />
      </Suspense>
    );
  }

  // Sem workspace: o estado vazio (criar o primeiro); as Configurações gerais continuam abrindo.
  // Enquanto a lista não confirma o workspace do endereço, só a barra.
  return (
    <>
      {view === "ready" && workspaceId && (
        <Suspense fallback={null}>
          <CenaDoEscritorio key={workspaceId} workspaceId={workspaceId} workspaceName={workspaceName} suspensa={!onOffice} />
        </Suspense>
      )}
      <Hud />
      <AttentionRoot />
      <SystemWarnings />
      {view === "ready" && onOffice && (
        <>
          <SidePanel />
          <TaskBox />
          <CenaControles />
          <ReplayPlayer />
        </>
      )}
      {((view === "ready" && !onOffice) || (view !== "ready" && onSettings)) && <Pages />}
      {view === "empty" && !onSettings && <NoWorkspace />}
    </>
  );
}
