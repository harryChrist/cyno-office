import { useCallback, useRef } from "react";
import { useNavLayoutStore } from "../../store/navLayoutStore";
import { pageLabel, useNavStore } from "../../store/navStore";
import { currentWorkspaceName, useWorkspaceStore, useWorkspaceView } from "../../store/workspaceStore";
import { AttentionCounter } from "../AttentionCounter";
import { NavIcon } from "../navIcons";
import { useNotificationsSummary } from "../NotificationsBell";
import { SocketIndicator } from "../SocketIndicator";
import { useOverlayInsets } from "../useOverlayInsets";
import { MobileDrawer } from "./MobileDrawer";
import { openPanel } from "./NavItems";
import { useVersionTone } from "./NavVersion";
import { menuButtonLabel } from "../../version/versionView";

/** Barra curta do celular: menu, a página atual (e o workspace) e o sino. */
export function MobileBar() {
  const page = useNavStore((state) => state.page);
  const workspaceId = useNavStore((state) => state.workspaceId);
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const empty = useWorkspaceView() === "empty";
  const drawerOpen = useNavLayoutStore((state) => state.drawerOpen);
  const setDrawerOpen = useNavLayoutStore((state) => state.setDrawerOpen);
  const panel = useNavLayoutStore((state) => state.panel);
  const { unread, label } = useNotificationsSummary();
  const versionTone = useVersionTone();
  const ref = useRef<HTMLElement>(null);
  useOverlayInsets("topbar", ref, "top", true);
  const closeDrawer = useCallback(() => setDrawerOpen(false), [setDrawerOpen]);
  const workspace = currentWorkspaceName(workspaces, workspaceId);
  return (
    <>
      <header ref={ref} className="mbar" data-testid="hud">
        <button
          type="button"
          className="mbar__button"
          aria-label={menuButtonLabel(versionTone)}
          aria-expanded={drawerOpen}
          onClick={() => {
            useNavLayoutStore.getState().closePanel();
            setDrawerOpen(true);
          }}
          data-testid="nav-menu"
        >
          <NavIcon name="menu" />
          {versionTone !== "normal" && <span className="navitem__dot navitem__dot--update" aria-hidden="true" data-testid="menu-update-dot" />}
        </button>
        <div className="mbar__titles">
          <h1 className="sr-only">Cyno</h1>
          <p className="mbar__title">{pageLabel(page)}</p>
          {workspace && <p className="mbar__ws">{workspace}</p>}
        </div>
        <SocketIndicator />
        {!empty && <AttentionCounter />}
        {!empty && (
          <button
            type="button"
            className="mbar__button"
            aria-label={label}
            aria-expanded={panel === "notificacoes"}
            aria-haspopup="dialog"
            onClick={() => openPanel("notificacoes")}
            data-panel-trigger="notificacoes"
            data-testid="bell"
          >
            <NavIcon name="bell" />
            {unread > 0 && <span className="navitem__dot" aria-hidden="true" data-testid="bell-dot" />}
          </button>
        )}
      </header>
      {drawerOpen && <MobileDrawer onClose={closeDrawer} />}
    </>
  );
}
