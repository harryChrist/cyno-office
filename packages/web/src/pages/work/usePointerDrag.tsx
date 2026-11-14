import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * Arrastar com o ponteiro (mouse), sem biblioteca: a linha só começa a "voar" depois de mexer uns pixels (um
 * clique simples continua abrindo o painel), o alvo vem de `hit` a cada movimento, solta com o botão, Esc cancela e
 * a rolagem acompanha quando o ponteiro chega à beira. O clique que sobra do soltar é engolido. O toque (celular)
 * não arrasta: lá fica o menu da linha ("Mover para…", "Subir", "Descer").
 */

export type DragSession<V> = { id: string; label: string; x: number; y: number; verdict: V | null };

type Options<V> = {
  enabled: boolean;
  /** O veredito do que está sob o ponteiro (null = fora de qualquer alvo). */
  hit: (point: { x: number; y: number }, id: string) => V | null;
  /** O veredito deixa soltar? */
  accepts: (verdict: V) => boolean;
  /** Soltou num alvo; `verdict` pode não aceitar (a tela mostra o aviso). */
  onDrop: (id: string, verdict: V) => void;
};

const INTERACTIVE = "button, input, textarea, select, a, [contenteditable='true'], [data-no-drag]";
const THRESHOLD = 5;

export function usePointerDrag<V>({ enabled, hit, accepts, onDrop }: Options<V>) {
  const [session, setSession] = useState<DragSession<V> | null>(null);
  const live = useRef({ hit, accepts, onDrop });
  // Os ouvintes do arrasto leem sempre a versão mais nova (atualizada depois de cada desenho, não durante).
  useEffect(() => {
    live.current = { hit, accepts, onDrop };
  });
  const cleanup = useRef<(() => void) | null>(null);

  useEffect(() => () => cleanup.current?.(), []);

  /** `onPointerDown` da linha: começa a acompanhar o ponteiro (só mouse, botão principal, fora dos controles da linha). */
  const start = useCallback(
    (id: string, label: string, event: ReactPointerEvent<HTMLElement>) => {
      if (!enabled || event.button !== 0 || event.pointerType === "touch" || event.pointerType === "pen") return;
      // Controles dentro da linha (botões, campos) não arrastam; a própria linha pode ser um botão (cartão da sprint).
      const control = (event.target as HTMLElement).closest(INTERACTIVE);
      if (control && control !== event.currentTarget) return;
      cleanup.current?.();
      const origin = { x: event.clientX, y: event.clientY };
      let dragging = false;
      let last: V | null = null;
      const scroller = scrollParent(event.currentTarget);
      let frame = 0;
      let pointer = { ...origin };

      const stopEdge = () => {
        if (frame) cancelAnimationFrame(frame);
        frame = 0;
      };
      const edgeScroll = () => {
        frame = 0;
        if (!dragging || !scroller) return;
        const rect = scroller.getBoundingClientRect();
        const zone = 48;
        const delta = pointer.y < rect.top + zone ? -(rect.top + zone - pointer.y) / 3 : pointer.y > rect.bottom - zone ? (pointer.y - (rect.bottom - zone)) / 3 : 0;
        if (delta !== 0) {
          scroller.scrollTop += Math.max(-18, Math.min(18, delta));
          update();
          frame = requestAnimationFrame(edgeScroll);
        }
      };
      const update = () => {
        last = live.current.hit(pointer, id);
        setSession({ id, label, x: pointer.x, y: pointer.y, verdict: last });
      };
      const move = (e: PointerEvent) => {
        pointer = { x: e.clientX, y: e.clientY };
        if (!dragging) {
          if (Math.hypot(pointer.x - origin.x, pointer.y - origin.y) < THRESHOLD) return;
          dragging = true;
          document.body.classList.add("dnd-active");
        }
        e.preventDefault();
        update();
        if (!frame) frame = requestAnimationFrame(edgeScroll);
      };
      const finish = (drop: boolean) => {
        stopEdge();
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", cancel);
        window.removeEventListener("keydown", key, true);
        document.body.classList.remove("dnd-active");
        cleanup.current = null;
        if (dragging) {
          // O "click" que vem logo depois do soltar não pode abrir a tarefa.
          const swallow = (e: MouseEvent) => {
            e.stopPropagation();
            e.preventDefault();
          };
          window.addEventListener("click", swallow, { capture: true, once: true });
          window.setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 0);
          setSession(null);
          if (drop && last) live.current.onDrop(id, last);
        }
      };
      const up = () => finish(true);
      const cancel = () => finish(false);
      const key = (e: KeyboardEvent) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          finish(false);
        }
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", cancel);
      window.addEventListener("keydown", key, true);
      cleanup.current = () => finish(false);
    },
    [enabled],
  );

  return { session, start };
}

/** O ancestral que rola (o mais próximo com `overflow-y` auto ou scroll). */
function scrollParent(node: HTMLElement | null): HTMLElement | null {
  for (let current = node?.parentElement ?? null; current; current = current.parentElement) {
    const overflow = getComputedStyle(current).overflowY;
    if ((overflow === "auto" || overflow === "scroll") && current.scrollHeight > current.clientHeight) return current;
  }
  return null;
}

/** O fantasma que segue o ponteiro (nome da linha) e o aviso curto quando o alvo não aceita. */
export function DragGhost({ session, reason }: { session: DragSession<unknown> | null; reason: string | null }): ReactNode {
  if (!session) return null;
  return createPortal(
    <div className={`dnd-ghost${reason ? " dnd-ghost--no" : ""}`} style={{ left: session.x + 14, top: session.y + 12 }} data-testid="drag-ghost" role="status">
      <span className="dnd-ghost__label">{session.label}</span>
      {reason && <span className="dnd-ghost__reason">{reason}</span>}
    </div>,
    document.body,
  );
}
