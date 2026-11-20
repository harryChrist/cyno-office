import { useId, useRef, type TouchEvent as ReactTouchEvent } from "react";
import { useWorkspaceView } from "../../store/workspaceStore";
import { useModalDialog } from "../../ui/widgets";
import { NavIcon } from "../navIcons";
import { WorkspacePicker } from "../WorkspacePicker";
import { FoldersItem } from "./FoldersNav";
import { NavFooter } from "./NavFooter";
import { NavVersion } from "./NavVersion";
import { CynoItem, NavSections } from "./NavItems";

/**
 * Gaveta do celular: abre da esquerda por cima de tudo (dialog modal: foco preso dentro, Esc e
 * toque fora fecham), com as mesmas seções da barra lateral. Escolher uma página fecha; arrastar
 * para a esquerda também.
 */
export function MobileDrawer({ onClose }: { onClose: () => void }) {
  const ref = useModalDialog(onClose);
  const titleId = useId();
  const empty = useWorkspaceView() === "empty";
  const start = useRef<{ x: number; y: number } | null>(null);
  const onTouchStart = (event: ReactTouchEvent) => {
    const touch = event.touches[0];
    start.current = touch ? { x: touch.clientX, y: touch.clientY } : null;
  };
  const onTouchEnd = (event: ReactTouchEvent) => {
    const touch = event.changedTouches[0];
    const from = start.current;
    start.current = null;
    if (!touch || !from) return;
    const dx = touch.clientX - from.x;
    if (dx < -60 && Math.abs(dx) > Math.abs(touch.clientY - from.y)) onClose();
  };
  return (
    <dialog ref={ref} className="mdrawer" aria-labelledby={titleId} onTouchStart={onTouchStart} onTouchEnd={onTouchEnd} data-testid="nav-drawer">
      <div className="sidenav__head mdrawer__head">
        <p className="sr-only" id={titleId}>
          Cyno
        </p>
        <div className="mdrawer__top">
          <div className="sidenav__brandrow">
            <ul className="navsection__list navsection--cyno">
              <li>
                <CynoItem onNavigate={onClose} />
              </li>
            </ul>
            <NavVersion onNavigate={onClose} />
          </div>
          <button type="button" className="mdrawer__close" aria-label="Fechar o menu" onClick={onClose} data-testid="nav-drawer-close">
            <NavIcon name="close" />
          </button>
        </div>
        <div className="sidenav__ws">
          <WorkspacePicker />
        </div>
        {!empty && <FoldersItem onBeforeOpen={onClose} />}
      </div>
      <div className="sidenav__scroll">
        <NavSections onNavigate={onClose} drawer />
      </div>
      <NavFooter onNavigate={onClose} onBeforeOpen={onClose} showCollapse={false} />
    </dialog>
  );
}
