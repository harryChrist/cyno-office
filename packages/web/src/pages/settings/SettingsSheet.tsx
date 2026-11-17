import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useModalDialog } from "../../ui/widgets";
import "./settingsSheet.css";

const EXIT_MS = 200;
const PHONE_QUERY = "(max-width: 767px)";

const prefersReducedMotion = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

/** Janela de celular (a mesma que o CSS das Configurações trata como "uma coluna"); acompanha o redimensionamento. */
export function useIsPhone(): boolean {
  const read = () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(PHONE_QUERY).matches;
  const [phone, setPhone] = useState(read);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(PHONE_QUERY);
    const update = () => setPhone(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return phone;
}

type SheetProps = {
  /** Nome da folha para o leitor de tela. */
  label: string;
  onClose: () => void;
  /** O conteúdo; a função recebe `close`, que fecha com a animação de saída. */
  children: (api: { close: () => void }) => ReactNode;
};

/**
 * Folha que sobe de baixo, por cima da página: um <dialog> modal (foco preso, a página de trás parada, Esc fecha) com fundo
 * escuro que fecha ao toque, entrada e saída curtas (sem movimento com "reduzir movimento") e uma alça no topo.
 */
export function BottomSheet({ label, onClose, children }: SheetProps) {
  const ref = useModalDialog(onClose, { closeOnBackdrop: false });
  const [closing, setClosing] = useState(false);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });
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

  // Ao abrir, o foco vai para a seção atual (ou para a folha): o leitor de tela anuncia o lugar e a lista já mostra onde se está.
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const current = dialog.querySelector<HTMLElement>('[aria-current="true"]');
    (current ?? dialog.querySelector<HTMLElement>(".settings-sheet__panel"))?.focus();
  }, [ref]);

  const pressedBackdrop = useRef(false);
  return (
    <dialog
      ref={ref}
      className="settings-sheet"
      aria-label={label}
      aria-modal="true"
      data-closing={closing ? "true" : undefined}
      data-testid="settings-sheet"
      onPointerDown={(event) => {
        pressedBackdrop.current = event.target === event.currentTarget;
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget && pressedBackdrop.current) close();
        pressedBackdrop.current = false;
      }}
    >
      <div className="settings-sheet__panel" tabIndex={-1} data-testid="settings-sheet-panel">
        <span className="settings-sheet__grip" aria-hidden="true" />
        {children({ close })}
      </div>
    </dialog>
  );
}

type MobileNavProps = {
  /** Seção atual (o que o botão mostra). */
  current: string;
  /** Texto do corpo da folha: busca e seções; recebe `close`. */
  children: (api: { close: () => void }) => ReactNode;
  /** A folha fechou (por qualquer caminho). */
  onClosed?: () => void;
};

/** Celular: botão flutuante com a seção atual que abre a folha de navegação das Configurações. */
export function SettingsMobileNav({ current, children, onClosed }: MobileNavProps) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="settings-fab" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)} data-testid="settings-fab">
        <svg className="settings-fab__icon" viewBox="0 0 20 20" width="18" height="18" aria-hidden="true" focusable="false">
          <path d="M3 5h14M3 10h14M3 15h9" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
        <span className="settings-fab__text">
          <span className="settings-fab__kicker">Ir para</span>
          <span className="settings-fab__label">{current}</span>
        </span>
        <svg className="settings-fab__chev" viewBox="0 0 20 20" width="16" height="16" aria-hidden="true" focusable="false">
          <path d="M5 12l5-5 5 5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <BottomSheet
          label="Seções das configurações"
          onClose={() => {
            setOpen(false);
            onClosed?.();
          }}
        >
          {({ close }) => (
            <>
              <header className="settings-sheet__head">
                <h3 className="settings-sheet__title">
                  Ir para
                </h3>
                <button type="button" className="settings-sheet__close" aria-label="Fechar" onClick={close} data-testid="settings-sheet-close">
                  <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true" focusable="false">
                    <path d="M5 5l10 10M15 5L5 15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                  </svg>
                </button>
              </header>
              {children({ close })}
            </>
          )}
        </BottomSheet>
      )}
    </>
  );
}
