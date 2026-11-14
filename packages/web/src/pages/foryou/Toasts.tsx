import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "./icons";

export type ToastTone = "ok" | "aviso" | "erro";

export type ToastInput = {
  message: string;
  tone?: ToastTone;
  /** Botão do aviso (ex.: "Desfazer"); clicar fecha o aviso. */
  action?: { label: string; run: () => void };
};

type Toast = ToastInput & { id: number };

/** No máximo 3 avisos na tela; os mais velhos saem primeiro. */
const MAX_TOASTS = 3;

function lifetime(toast: ToastInput): number {
  if (toast.tone === "erro") return 9000;
  return toast.action ? 7000 : 4500;
}

/** Pilha de avisos da página, com o tempo de vida de cada um. */
export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer) clearTimeout(timer);
    timers.current.delete(id);
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const push = useCallback(
    (input: ToastInput) => {
      const id = nextId.current++;
      setToasts((current) => [...current, { ...input, id }].slice(-MAX_TOASTS));
      timers.current.set(id, setTimeout(() => dismiss(id), lifetime(input)));
    },
    [dismiss],
  );

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
    };
  }, []);

  return { toasts, push, dismiss };
}

/** Avisos no canto de baixo (região viva: o leitor de tela anuncia). */
export function ToastStack({ toasts, dismiss }: { toasts: readonly Toast[]; dismiss: (id: number) => void }) {
  return (
    <div className="fy-toasts" aria-live="polite" data-testid="foryou-toasts">
      {toasts.map((toast) => (
        <div key={toast.id} className={`fy-toast fy-toast--${toast.tone ?? "ok"}`} role={toast.tone === "erro" ? "alert" : "status"}>
          <Icon name={toast.tone === "ok" || toast.tone === undefined ? "check" : "alert"} size={18} />
          <span className="fy-toast__msg">{toast.message}</span>
          {toast.action && (
            <button
              type="button"
              className="fy-toast__action"
              onClick={() => {
                dismiss(toast.id);
                toast.action!.run();
              }}
            >
              {toast.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
