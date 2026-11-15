import { useEffect, useLayoutEffect } from "react";
import { NAV_RAIL_WIDTH, useNavLayoutStore } from "../../store/navLayoutStore";
import { NO_INSETS, useViewStore } from "../../store/viewStore";
import { useWorkspaceView } from "../../store/workspaceStore";
import { WorkspacePicker } from "../WorkspacePicker";
import { useRailTip } from "./navHooks";
import { FoldersItem } from "./FoldersNav";
import { NavFooter } from "./NavFooter";
import { AttentionCounter } from "../AttentionCounter";
import { CynoItem, MovedHint, NavSections, NotificationsItem, TodayItem } from "./NavItems";
import { ResizeHandle } from "./ResizeHandle";

/**
 * Barra lateral do computador: logo e workspace em cima, notificações, as páginas por seção e,
 * no rodapé, os agentes e as Configurações. Recolhe para uma coluna de ícones (lembra a escolha).
 */
export function Sidebar() {
  const collapsed = useNavLayoutStore((state) => state.collapsed);
  const width = useNavLayoutStore((state) => state.width);
  const dragging = useNavLayoutStore((state) => state.dragging);
  const empty = useWorkspaceView() === "empty";
  const setOverlay = useViewStore((state) => state.setOverlay);
  const tip = useRailTip(collapsed && !dragging);
  const shown = collapsed ? NAV_RAIL_WIDTH : width;

  // A largura vai para o CSS na hora (--sidenav-w): feed, caixa do Maestro e páginas acompanham o arraste.
  useLayoutEffect(() => {
    document.documentElement.style.setProperty("--sidenav-w", `${width}px`);
  }, [width]);
  useEffect(
    () => () => {
      document.documentElement.style.removeProperty("--sidenav-w");
    },
    [],
  );

  // A câmera só reenquadra quando o arraste termina (reenquadrar a cada quadro faria o zoom pular).
  // A faixa coberta é a margem + a largura da barra (o mesmo que medir o retângulo dela).
  useLayoutEffect(() => {
    if (dragging) return;
    const gap = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--gap")) || 8;
    setOverlay("sidebar", { ...NO_INSETS, left: Math.round(gap + shown) });
  }, [dragging, shown, setOverlay]);
  useEffect(() => () => setOverlay("sidebar", null), [setOverlay]);

  return (
    <aside className={`sidenav${collapsed ? " sidenav--rail" : ""}${dragging ? " sidenav--dragging" : ""}`} aria-label="Navegação" data-testid="hud" {...tip.handlers}>
      <div className="sidenav__head">
        <h1 className="sr-only">Cyno</h1>
        <ul className="navsection__list navsection--cyno">
          <li>
            <CynoItem />
          </li>
        </ul>
        <div className="sidenav__ws" data-tip="Trocar de workspace">
          <WorkspacePicker />
        </div>
        {!empty && <FoldersItem />}
      </div>
      <div className="sidenav__scroll">
        <MovedHint />
        {!empty && (
          <ul className="navsection__list navsection--top">
            <li>
              <AttentionCounter />
            </li>
            <li>
              <NotificationsItem />
            </li>
            <li>
              <TodayItem />
            </li>
          </ul>
        )}
        <NavSections />
      </div>
      <NavFooter showCollapse />
      <ResizeHandle />
      {tip.node}
    </aside>
  );
}
