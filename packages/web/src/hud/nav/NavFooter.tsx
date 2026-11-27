import { useNavLayoutStore } from "../../store/navLayoutStore";
import { useWorkspaceView } from "../../store/workspaceStore";
import { NavIcon } from "../navIcons";
import { SocketIndicator } from "../SocketIndicator";
import { AgentsItem, PageItem } from "./NavItems";
import { NavUsage } from "./NavUsage";
import { SETTINGS_ITEM } from "./navItemsView";

/** Rodapé: conexão (só aparece fora do ar), uso do plano, agentes, Configurações e o botão de recolher. */
export function NavFooter({ onNavigate, onBeforeOpen, showCollapse }: { onNavigate?: () => void; onBeforeOpen?: () => void; showCollapse: boolean }) {
  const empty = useWorkspaceView() === "empty";
  const collapsed = useNavLayoutStore((state) => state.collapsed);
  const toggleCollapsed = useNavLayoutStore((state) => state.toggleCollapsed);
  return (
    <div className="navfoot">
      <SocketIndicator />
      <NavUsage onBeforeOpen={onBeforeOpen} />
      {!empty && <AgentsItem onBeforeOpen={onBeforeOpen} />}
      <div className="navfoot__row">
        <ul className="navsection__list navfoot__settings">
          <PageItem item={SETTINGS_ITEM} onNavigate={onNavigate} />
        </ul>
        {showCollapse && (
          <button
            type="button"
            className="navfoot__collapse"
            aria-label={collapsed ? "Expandir a barra lateral" : "Recolher a barra lateral"}
            aria-pressed={collapsed}
            onClick={toggleCollapsed}
            data-tip={collapsed ? "Expandir" : "Recolher"}
            data-testid="nav-collapse"
          >
            <NavIcon name={collapsed ? "rail-open" : "rail-close"} />
          </button>
        )}
      </div>
    </div>
  );
}
