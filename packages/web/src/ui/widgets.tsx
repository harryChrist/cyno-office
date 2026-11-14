import type { AgentStatus, TaskStatus } from "@cyno/shared";
import { useEffect, useId, useRef, type ReactNode } from "react";
import { percent, statusTone } from "./format";
import { useAsyncAction } from "./useAsyncAction";

type StatusBadgeProps = { status: AgentStatus | TaskStatus; label: string; testId?: string };

/** Selo de status; a cor reforça, mas o texto sempre diz o status. */
export function StatusBadge({ status, label, testId }: StatusBadgeProps) {
  return (
    <span className={`ui-badge ui-badge--${statusTone(status)}`} data-testid={testId} data-status={status}>
      {label}
    </span>
  );
}

/** Barra de progresso em blocos (pixel), com valor acessível. */
export function ProgressBar({ value, label, testId }: { value: number; label: string; testId?: string }) {
  const clamped = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
  return (
    <div
      className="ui-progress"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clamped * 100)}
      aria-valuetext={percent(clamped)}
      data-testid={testId}
    >
      <div className="ui-progress__fill" style={{ width: percent(clamped) }} />
    </div>
  );
}

export function ErrorText({ children, testId }: { children: ReactNode; testId?: string }) {
  if (!children) return null;
  return (
    <p className="ui-error" role="alert" data-testid={testId}>
      {children}
    </p>
  );
}

type FieldProps = {
  label: string;
  error?: string;
  hint?: ReactNode;
  children: (props: { id: string; "aria-invalid": boolean; "aria-describedby"?: string }) => ReactNode;
};

/** Rótulo + controle + dica/erro ligados por id (o erro é lido junto com o campo). */
export function Field({ label, error, hint, children }: FieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className={`ui-field${error ? " ui-field--error" : ""}`}>
      <label htmlFor={id} className="ui-field__label">
        {label}
      </label>
      {children({ id, "aria-invalid": Boolean(error), "aria-describedby": describedBy })}
      {hint && (
        <p id={hintId} className="ui-field__hint">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="ui-field__error">
          {error}
        </p>
      )}
    </div>
  );
}

type ModalProps = {
  title: string;
  onClose: () => void;
  children: ReactNode;
  testId?: string;
  wide?: boolean;
};

/**
 * Ciclo de vida de um <dialog> modal nativo (foco preso dentro, Esc fecha): abre ao montar, chama
 * `onClose` quando ele fecha e devolve o foco a quem abriu. Usado pelo Modal e pelo painel do Maestro.
 */
/**
 * `closeOnBackdrop` (padrão: sim): clicar fora da janela, no fundo escurecido, fecha, como o X e o Esc.
 * Só conta se o clique começou e terminou no fundo (selecionar texto e soltar fora não fecha).
 */
export function useModalDialog(onClose: () => void, options: { closeOnBackdrop?: boolean } = {}) {
  const closeOnBackdrop = options.closeOnBackdrop ?? true;
  const ref = useRef<HTMLDialogElement>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!dialog.open) dialog.showModal();
    // O StrictMode monta, desmonta (close) e remonta (showModal): o "close" atrasado da 1ª montagem
    // chega com o dialog já aberto de novo e deve ser ignorado.
    const handleClose = () => {
      if (!dialog.open) onCloseRef.current();
    };
    dialog.addEventListener("close", handleClose);
    // O fundo do <dialog> modal é o próprio elemento: clique nele fora do retângulo da janela.
    const outside = (event: MouseEvent) => {
      if (event.target !== dialog) return false;
      const rect = dialog.getBoundingClientRect();
      return event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom;
    };
    let pressedOutside = false;
    const onPointerDown = (event: PointerEvent) => {
      pressedOutside = outside(event);
    };
    const onClick = (event: MouseEvent) => {
      if (pressedOutside && outside(event)) dialog.close();
      pressedOutside = false;
    };
    if (closeOnBackdrop) {
      dialog.addEventListener("pointerdown", onPointerDown);
      dialog.addEventListener("click", onClick);
    }
    return () => {
      dialog.removeEventListener("close", handleClose);
      dialog.removeEventListener("pointerdown", onPointerDown);
      dialog.removeEventListener("click", onClick);
      if (dialog.open) dialog.close();
      if (opener?.isConnected) opener.focus();
    };
  }, [closeOnBackdrop]);

  return ref;
}

/** Janela modal (<dialog> nativo: foco preso dentro e Esc fecha). */
export function Modal({ title, onClose, children, testId, wide }: ModalProps) {
  const ref = useModalDialog(onClose);
  const titleId = useId();

  return (
    <dialog ref={ref} className={`ui-modal${wide ? " ui-modal--wide" : ""}`} aria-labelledby={titleId} data-testid={testId}>
      <header className="ui-modal__header">
        <h2 id={titleId} className="ui-modal__title">
          {title}
        </h2>
        <button type="button" className="ui-icon-button" aria-label="Fechar" onClick={() => ref.current?.close()}>
          ×
        </button>
      </header>
      <div className="ui-modal__body">{children}</div>
    </dialog>
  );
}

type ConfirmDialogProps = {
  title: string;
  message: ReactNode;
  confirmLabel: string;
  onConfirm: () => Promise<unknown>;
  onClose: () => void;
  testId?: string;
  /** Rótulo do botão enquanto a ação roda (padrão: "Excluindo…"). */
  pendingLabel?: string;
  /** Cor do botão de confirmar (padrão: "danger"). */
  tone?: "danger" | "success";
};

/** Confirmação de ação destrutiva (ou arriscada); fecha sozinha quando a ação dá certo. */
export function ConfirmDialog({ title, message, confirmLabel, onConfirm, onClose, testId, pendingLabel = "Excluindo…", tone = "danger" }: ConfirmDialogProps) {
  const { pending, error, run } = useAsyncAction();
  const confirm = async () => {
    const ok = await run(async () => {
      await onConfirm();
      return true;
    });
    if (ok) onClose();
  };
  return (
    <Modal title={title} onClose={onClose} testId={testId}>
      <div className="ui-confirm">{message}</div>
      <ErrorText>{error}</ErrorText>
      <div className="ui-actions">
        <button type="button" className="ui-button ui-button--secondary" onClick={onClose} autoFocus>
          Cancelar
        </button>
        <button type="button" className={`ui-button ui-button--${tone}`} onClick={() => void confirm()} disabled={pending} data-testid={testId ? `${testId}-confirm` : undefined}>
          {pending ? pendingLabel : confirmLabel}
        </button>
      </div>
    </Modal>
  );
}

type SwitchProps = {
  label: ReactNode;
  description?: ReactNode;
  checked: boolean;
  testId: string;
  disabled?: boolean;
  busy?: boolean;
  onChange: (next: boolean) => void;
  /** Embaixo do interruptor (ex.: o erro da requisição). */
  children?: ReactNode;
};

/** Interruptor (checkbox com role="switch") com rótulo e descrição opcional. */
export function Switch({ label, description, checked, testId, disabled, busy, onChange, children }: SwitchProps) {
  const descriptionId = useId();
  return (
    <div className="ui-switch-row">
      <label className="ui-switch">
        <input
          type="checkbox"
          role="switch"
          checked={checked}
          disabled={disabled}
          aria-busy={busy}
          aria-describedby={description ? descriptionId : undefined}
          data-testid={testId}
          onChange={(event) => onChange(event.currentTarget.checked)}
        />
        <span className="ui-switch__track" aria-hidden="true">
          <span className="ui-switch__knob" />
        </span>
        <span className="ui-switch__label">{label}</span>
      </label>
      {description && (
        <p id={descriptionId} className="ui-switch__description">
          {description}
        </p>
      )}
      {children}
    </div>
  );
}

type AsyncSwitchProps = Omit<SwitchProps, "busy" | "onChange" | "children"> & {
  /** Chama a API; o `checked` só muda quando o evento do WebSocket atualizar o store. */
  onToggle: (next: boolean) => Promise<unknown>;
};

/** Interruptor ligado ao estado do server, desabilitado enquanto a requisição roda. */
export function AsyncSwitch({ onToggle, disabled, ...props }: AsyncSwitchProps) {
  const { pending, error, run } = useAsyncAction();
  return (
    <Switch {...props} disabled={pending || disabled} busy={pending} onChange={(next) => void run(() => onToggle(next))}>
      <ErrorText>{error}</ErrorText>
    </Switch>
  );
}
