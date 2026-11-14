import { useEffect } from "react";
import { WorkPanelHost } from "../../agentWork/WorkPanelHost";
import { ConnectorDetailHost } from "../../connectors/ConnectorDetail";
import { MOBILE_NAV_QUERY, useNavLayoutStore } from "../../store/navLayoutStore";
import { useWorkspaceView } from "../../store/workspaceStore";
import { CommandShortcut } from "../CommandBar";
import { useMediaQuery, useNavToggleShortcut } from "./navHooks";
import { MobileBar } from "./MobileBar";
import { NavPanelHost } from "./NavPanelHost";
import { Sidebar } from "./Sidebar";
import "./appNav.css";

/**
 * Navegação do app: barra lateral à esquerda no computador (recolhível) e, no celular, uma barra
 * curta com menu (gaveta), a página atual e o sino. Os painéis de notificações e agentes abrem ao
 * lado. Também hospeda a tela de trabalho e o detalhe de conector (antes dentro da barra de cima).
 */
export function AppNav() {
  const mobile = useMediaQuery(MOBILE_NAV_QUERY);
  const empty = useWorkspaceView() === "empty";
  useNavToggleShortcut(!mobile);
  // Saiu do celular com a gaveta aberta: fecha (no computador ela não existe).
  useEffect(() => {
    if (!mobile) useNavLayoutStore.getState().setDrawerOpen(false);
  }, [mobile]);
  return (
    <>
      {!empty && <CommandShortcut />}
      {mobile ? <MobileBar /> : <Sidebar />}
      <NavPanelHost />
      {/* A tela de trabalho aberta (Maestro ou um agente): dialog por cima de tudo. */}
      <WorkPanelHost />
      {/* Detalhe de um conector (status, ferramentas, quem usa). */}
      <ConnectorDetailHost />
    </>
  );
}
