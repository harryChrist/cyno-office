import { useRef, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { NAV_RAIL_WIDTH, NAV_WIDTH_MAX, NAV_WIDTH_MIN, navWidthKey, useNavLayoutStore } from "../../store/navLayoutStore";

/**
 * Puxador na borda direita da barra: arrastar muda a largura (200–360 px; abaixo de 140 px
 * recolhe, e da barra recolhida arrastar para fora abre), duplo clique alterna recolhida/aberta
 * e, com foco, as setas, Home, End e Enter fazem o mesmo pelo teclado.
 */
export function ResizeHandle() {
  const collapsed = useNavLayoutStore((state) => state.collapsed);
  const width = useNavLayoutStore((state) => state.width);
  const drag = useRef<{ startX: number; startWidth: number; moved: boolean; frame: number; raw: number } | null>(null);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const state = useNavLayoutStore.getState();
    drag.current = { startX: event.clientX, startWidth: state.collapsed ? NAV_RAIL_WIDTH : state.width, moved: false, frame: 0, raw: 0 };
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current) return;
    const dx = event.clientX - current.startX;
    if (!current.moved) {
      // Um clique parado (ou o duplo clique) não é arraste.
      if (Math.abs(dx) < 3) return;
      current.moved = true;
      useNavLayoutStore.getState().startDrag();
    }
    current.raw = current.startWidth + dx;
    // Um ajuste por quadro, no máximo.
    if (current.frame) return;
    current.frame = requestAnimationFrame(() => {
      current.frame = 0;
      useNavLayoutStore.getState().dragTo(current.raw);
    });
  };
  const finish = () => {
    const current = drag.current;
    drag.current = null;
    if (!current?.moved) return;
    if (current.frame) cancelAnimationFrame(current.frame);
    const store = useNavLayoutStore.getState();
    store.dragTo(current.raw);
    store.endDrag();
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const next = navWidthKey(event.key, event.shiftKey, useNavLayoutStore.getState());
    if (!next) return;
    event.preventDefault();
    useNavLayoutStore.getState().setLayout(next);
  };

  return (
    <div
      className="sidenav__resize"
      role="separator"
      aria-orientation="vertical"
      aria-label="Largura da barra lateral"
      aria-valuemin={NAV_WIDTH_MIN}
      aria-valuemax={NAV_WIDTH_MAX}
      aria-valuenow={collapsed ? NAV_WIDTH_MIN : width}
      aria-valuetext={collapsed ? "Recolhida" : `${width} pixels`}
      tabIndex={0}
      title="Arraste para mudar a largura · duplo clique recolhe ou abre · Ctrl+B"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finish}
      onPointerCancel={finish}
      onDoubleClick={() => useNavLayoutStore.getState().toggleCollapsed()}
      onKeyDown={onKeyDown}
      data-testid="nav-resize"
    />
  );
}
