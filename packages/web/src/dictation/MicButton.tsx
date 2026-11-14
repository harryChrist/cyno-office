import { UNAVAILABLE_MESSAGES } from "./speech";
import type { Dictation } from "./useDictation";
import "./dictation.css";

/** Botão do microfone: clica para ditar, clica de novo para parar. Pulsa enquanto ouve. */
export function MicButton({ dictation, testId }: { dictation: Dictation; testId?: string }) {
  const { availability, state } = dictation;
  const listening = state === "listening";
  const reason = availability.ok ? null : UNAVAILABLE_MESSAGES[availability.reason];
  const label = listening ? "Parar o ditado" : "Ditar por voz";
  return (
    <button
      type="button"
      className={`mic-button${listening ? " mic-button--live" : ""}`}
      // aria-disabled (não disabled): o botão continua focável e o clique explica por que não dá.
      aria-disabled={reason ? true : undefined}
      aria-pressed={listening}
      aria-label={label}
      title={reason ?? (listening ? "Parar o ditado (o texto fica no campo)" : "Ditar por voz (pt-BR). Você revisa antes de enviar.")}
      onClick={dictation.toggle}
      data-testid={testId}
      data-state={reason ? "unavailable" : state}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <rect x="9" y="3" width="6" height="11" rx="3" />
        <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" />
      </svg>
    </button>
  );
}

/** Linha de estado do ditado ("Ouvindo…" ou o erro), lida pelo leitor de tela. */
export function DictationStatus({ dictation, className, testId }: { dictation: Dictation; className?: string; testId?: string }) {
  const { state, message } = dictation;
  const text = state === "listening" ? "Ouvindo… o texto entra no campo. Clique no microfone para parar e revise antes de enviar." : message;
  return (
    <p className={`dictation-status${state === "error" ? " dictation-status--error" : ""}${className ? ` ${className}` : ""}`} role="status" data-testid={testId}>
      {/* A região fica sempre no DOM (vazia some pelo CSS) para o leitor de tela anunciar as mudanças. */}
      {state === "listening" && <span className="dictation-status__dot" aria-hidden="true" />}
      {text}
    </p>
  );
}
