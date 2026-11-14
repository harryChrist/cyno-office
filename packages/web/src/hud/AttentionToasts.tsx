import { useEffect, useMemo } from "react";
import { openAlert } from "../attention/openAlert";
import { useToastStore } from "../attention/toastStore";
import { toastView, type Toast } from "../attention/toasts";
import { useAttentionStore } from "../store/attentionStore";
import { NavIcon } from "./navIcons";
import "./attention.css";

/**
 * Os avisos globais da cadeia de atenção, em qualquer página: o que é, de quem e o botão
 * "Responder" (ou "Abrir"), que **só leva ao item** e nunca decide nada. Vários alertas juntos viram
 * um aviso só ("3 itens esperando você"). No celular fica no topo, logo abaixo da barra.
 */
export function AttentionToasts() {
  const toasts = useToastStore((state) => state.toasts);
  const open = useAttentionStore((state) => state.open);
  const byKey = useMemo(() => new Map(open.map((alert) => [alert.key, alert] as const)), [open]);
  const dismiss = useToastStore((state) => state.dismiss);
  const pause = useToastStore((state) => state.pause);
  const resume = useToastStore((state) => state.resume);

  // Vida dos avisos e causa que sumiu: sem polling de rede, só uma conferência local por segundo.
  useEffect(() => {
    const timer = window.setInterval(() => useToastStore.getState().tick(), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const views = toasts.flatMap((toast) => {
    const view = toastView(toast, byKey);
    return view ? [{ toast, view }] : [];
  });
  if (views.length === 0) return null;
  return (
    <div className="attn-toasts" role="region" aria-label="Avisos" data-testid="attention-toasts">
      {views.map(({ toast, view }) => (
        <ToastCard key={toast.id} toast={toast} view={view} onPause={() => pause(toast.id)} onResume={() => resume(toast.id)} onClose={() => dismiss(toast.id)} onOpen={() => {
          const alert = byKey.get(view.openKey);
          dismiss(toast.id);
          if (alert) openAlert(alert);
        }} />
      ))}
    </div>
  );
}

function ToastCard({ toast, view, onPause, onResume, onClose, onOpen }: { toast: Toast; view: NonNullable<ReturnType<typeof toastView>>; onPause: () => void; onResume: () => void; onClose: () => void; onOpen: () => void }) {
  return (
    <div
      className={`attn-toast attn-toast--${toast.level}`}
      role={toast.level === "alert" ? "alert" : "status"}
      onMouseEnter={onPause}
      onMouseLeave={onResume}
      onFocus={onPause}
      onBlur={onResume}
      data-testid="attention-toast"
    >
      <span className="attn-toast__icon" aria-hidden="true">
        <NavIcon name={toast.level === "alert" ? "mao" : "bell"} />
      </span>
      <div className="attn-toast__body">
        <p className="attn-toast__text" data-testid="attention-toast-text">
          {view.title}
        </p>
        {view.who && <p className="attn-toast__who">{view.who}</p>}
      </div>
      <button type="button" className="ui-button ui-button--small attn-toast__action" onClick={onOpen} data-testid="attention-toast-open">
        {view.actionLabel}
      </button>
      <button type="button" className="attn-toast__close" aria-label="Fechar o aviso" onClick={onClose} data-testid="attention-toast-close">
        <NavIcon name="close" className="nav-icon attn-toast__close-icon" />
      </button>
    </div>
  );
}
