import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { DEFAULT_PREFS, defaultAsideWidth, asideBounds, asideWidthForKey, clampAside, parseSplitPrefs, serializeSplitPrefs, splitStorageKey, type SplitPrefs } from "./splitPane";

type Props = {
  /** Chave para lembrar largura e recolhido neste navegador (ex.: "maestro"); sem ela, só na sessão. */
  splitKey?: string;
  main: ReactNode;
  /** Nome acessível e título da coluna lateral. */
  asideLabel: string;
  aside: ReactNode;
};

function readPrefs(splitKey: string | undefined): SplitPrefs {
  if (!splitKey) return DEFAULT_PREFS;
  try {
    return parseSplitPrefs(window.localStorage.getItem(splitStorageKey(splitKey)));
  } catch {
    return DEFAULT_PREFS;
  }
}

function writePrefs(splitKey: string | undefined, prefs: SplitPrefs) {
  if (!splitKey) return;
  try {
    window.localStorage.setItem(splitStorageKey(splitKey), serializeSplitPrefs(prefs));
  } catch {
    // Sem storage (aba privada, bloqueado): só não lembra.
  }
}

type Drag = { pointerId: number; startX: number; startWidth: number };

/**
 * Corpo da tela de trabalho com lateral: a conversa à esquerda, a lateral à direita e, entre as
 * duas, uma divisória que se arrasta (mouse, toque ou caneta) ou se move pelo teclado. A lateral
 * recolhe num trilho fino pelo botão do título. Largura e recolhido ficam lembrados por `splitKey`.
 * Em telas estreitas (≤ 880px) a lateral some e a divisória também (só CSS).
 *
 * `main` e `aside` chegam prontos do pai: arrastar re-renderiza só este componente, não as listas.
 */
export function WorkSplit({ splitKey, main, asideLabel, aside }: Props) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const drag = useRef<Drag | null>(null);
  const [prefs, setPrefs] = useState<SplitPrefs>(() => readPrefs(splitKey));
  const [containerWidth, setContainerWidth] = useState(0);
  const [dragging, setDragging] = useState(false);
  const asideId = useId();
  const contentId = useId();

  // Mede antes de pintar (sem pulo ao abrir) e acompanha o dialog mudando de tamanho.
  // clientWidth/contentRect ignoram o transform da animação de abertura.
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    setContainerWidth(body.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setContainerWidth(Math.round(entry.contentRect.width));
    });
    observer.observe(body);
    return () => observer.disconnect();
  }, []);

  // Salva quando a escolha assenta (não a cada movimento do arrasto).
  useEffect(() => {
    if (!dragging) writePrefs(splitKey, prefs);
  }, [splitKey, prefs, dragging]);

  const bounds = asideBounds(containerWidth);
  const width = clampAside(prefs.width ?? defaultAsideWidth(containerWidth), bounds);
  const max = Number.isFinite(bounds.max) ? bounds.max : width;
  const collapsed = prefs.collapsed;

  const setWidth = (next: number | null) => setPrefs((current) => (current.width === next ? current : { ...current, width: next }));

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.focus({ preventScroll: true });
    drag.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: width };
    setDragging(true);
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    // Arrastar para a esquerda alarga a lateral.
    setWidth(clampAside(current.startWidth + (current.startX - event.clientX), bounds));
  };

  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag.current || drag.current.pointerId !== event.pointerId) return;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    setDragging(false);
  };

  const toggle = () => setPrefs((current) => ({ ...current, collapsed: !current.collapsed }));

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      setPrefs((current) => ({ ...current, collapsed: true }));
      toggleRef.current?.focus();
      return;
    }
    const next = asideWidthForKey(event.key, event.shiftKey, width, bounds);
    if (next === null) return;
    event.preventDefault();
    setWidth(next);
  };

  const style = { "--work-aside-w": `${width}px` } as CSSProperties;
  const className = `work-view__body work-split${collapsed ? " work-split--collapsed" : ""}${dragging ? " work-split--dragging" : ""}`;

  return (
    <div ref={bodyRef} className={className} style={style} data-testid="work-split">
      <div className="work-view__main">{main}</div>
      {!collapsed && (
        <div
          className="work-split__handle"
          role="separator"
          tabIndex={0}
          aria-orientation="vertical"
          aria-controls={asideId}
          aria-label={`Redimensionar ${asideLabel}`}
          aria-valuenow={width}
          aria-valuemin={bounds.min}
          aria-valuemax={max}
          aria-valuetext={`${asideLabel}: ${width} px`}
          title="Arraste para redimensionar · duplo clique volta para metade/metade"
          data-testid="work-split-handle"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onLostPointerCapture={endDrag}
          onDoubleClick={() => setWidth(null)}
          onKeyDown={onKeyDown}
        />
      )}
      <aside id={asideId} className="work-view__aside" aria-label={asideLabel}>
        <div className="work-view__aside-head">
          <h3 className="work-view__aside-title">
            <span className="work-live-dot" aria-hidden="true" />
            <span className="work-view__aside-label">{asideLabel}</span>
          </h3>
          <button
            ref={toggleRef}
            type="button"
            className="ui-icon-button work-split__toggle"
            aria-expanded={!collapsed}
            aria-controls={contentId}
            aria-label={collapsed ? `Mostrar ${asideLabel}` : `Recolher ${asideLabel}`}
            title={collapsed ? "Mostrar" : "Recolher"}
            onClick={toggle}
            data-testid="work-split-toggle"
          >
            <span aria-hidden="true">{collapsed ? "‹" : "›"}</span>
          </button>
        </div>
        <div id={contentId} className="work-view__aside-content" hidden={collapsed}>
          {aside}
        </div>
      </aside>
    </div>
  );
}
