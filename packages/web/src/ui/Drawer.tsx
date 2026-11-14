import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { useModalDialog } from "./widgets";
import "./drawer.css";

const EXIT_MS = 180;
const KEY_STEP = 32;

const prefersReducedMotion = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

type DrawerProps = {
  /** Nome da gaveta para quem usa leitor de tela. */
  label: string;
  /** Chamada quando a gaveta termina de sair (o chamador desmonta). */
  onClose: () => void;
  /** Largura em pixels; `null` = a tela inteira (celular e janelas estreitas). */
  width: number | null;
  /** Limites do arrasto da borda (só com `width` em pixels). */
  min?: number;
  max?: number;
  /** O arrasto ou a seta do teclado terminou numa largura nova (guarde-a). */
  onWidthChange?: (width: number) => void;
  testId?: string;
  className?: string;
  /** O conteúdo; a função recebe `close`, que fecha com a animação de saída. */
  children: ReactNode | ((api: { close: () => void }) => ReactNode);
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/**
 * Gaveta à direita, por cima da página: um <dialog> modal (foco preso, a página de trás parada, Esc fecha) com um
 * fundo preto translúcido que fecha ao clique, entrada e saída curtas e a borda esquerda arrastável para alargar.
 */
export function Drawer({ label, onClose, width, min = 0, max = Infinity, onWidthChange, testId, className, children }: DrawerProps) {
  const ref = useModalDialog(onClose, { closeOnBackdrop: false });
  const [closing, setClosing] = useState(false);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  // Fechar passa pela saída: some o fundo, o painel desliza para a direita e só então o chamador desmonta.
  const close = useCallback(() => setClosing(true), []);
  useEffect(() => {
    if (!closing) return;
    if (prefersReducedMotion()) {
      onCloseRef.current();
      return;
    }
    const timer = window.setTimeout(() => onCloseRef.current(), EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [closing]);

  // Esc: o <dialog> fecharia sem animação; aqui passa pela saída.
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const onCancel = (event: Event) => {
      event.preventDefault();
      close();
    };
    dialog.addEventListener("cancel", onCancel);
    return () => dialog.removeEventListener("cancel", onCancel);
  }, [ref, close]);

  // Clicar no fundo (o próprio <dialog>, fora do painel) fecha; soltar o arrasto de um texto aqui não.
  const pressedBackdrop = useRef(false);

  // Largura ao vivo durante o arrasto; fora dele, a do chamador.
  const [live, setLive] = useState<{ from: number | null; value: number | null }>({ from: width, value: width });
  if (live.from !== width) setLive({ from: width, value: width });
  const current = live.value;
  const panel = useRef<HTMLDivElement>(null);
  // Ao abrir, o foco vai para o painel: as setas ←/→ e o Tab já funcionam dentro dele, e o leitor de tela lê o nome da gaveta.
  useEffect(() => {
    panel.current?.focus({ preventScroll: true });
  }, []);
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  const setWidth = (next: number) => setLive({ from: width, value: next });
  const onGripDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (current === null) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { startX: event.clientX, startWidth: current };
    setDragging(true);
  };
  const onGripMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    setWidth(clamp(drag.current.startWidth + (drag.current.startX - event.clientX), min, max));
  };
  const onGripUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    const next = clamp(drag.current.startWidth + (drag.current.startX - event.clientX), min, max);
    drag.current = null;
    setDragging(false);
    setWidth(next);
    onWidthChange?.(next);
  };
  const onGripKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (current === null || (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "Home" && event.key !== "End")) return;
    event.preventDefault();
    event.stopPropagation();
    const next = event.key === "Home" ? max : event.key === "End" ? min : clamp(current + (event.key === "ArrowLeft" ? KEY_STEP : -KEY_STEP), min, max);
    setWidth(next);
    onWidthChange?.(next);
  };

  return (
    <dialog
      ref={ref}
      className={`ui-drawer${className ? ` ${className}` : ""}`}
      aria-label={label}
      aria-modal="true"
      data-closing={closing ? "true" : undefined}
      data-dragging={dragging ? "true" : undefined}
      data-testid={testId}
      onPointerDown={(event) => {
        pressedBackdrop.current = event.target === event.currentTarget;
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget && pressedBackdrop.current) close();
        pressedBackdrop.current = false;
      }}
    >
      <div ref={panel} tabIndex={-1} className="ui-drawer__panel" style={current === null ? { width: "100%" } : { width: current }} data-testid={testId ? `${testId}-panel` : undefined}>
        {typeof children === "function" ? children({ close }) : children}
        {current !== null && (
          <div
            className="ui-drawer__grip"
            role="separator"
            aria-orientation="vertical"
            aria-label="Largura da gaveta"
            aria-valuemin={min}
            aria-valuemax={max}
            aria-valuenow={current}
            tabIndex={0}
            title="Arraste para alargar ou estreitar"
            onPointerDown={onGripDown}
            onPointerMove={onGripMove}
            onPointerUp={onGripUp}
            onPointerCancel={onGripUp}
            onKeyDown={onGripKey}
            data-testid={testId ? `${testId}-grip` : undefined}
          />
        )}
      </div>
    </dialog>
  );
}
