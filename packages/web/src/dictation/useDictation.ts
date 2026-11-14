import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { browserTranscriber, dictationErrorMessage, UNAVAILABLE_MESSAGES, type DictationAvailability, type Transcriber, type TranscriberFactory } from "./speech";
import { composeDictation, type DictationBase } from "./transcript";

export type DictationState = "idle" | "listening" | "error";

export type Dictation = {
  availability: DictationAvailability;
  state: DictationState;
  /** Erro (ou por que não dá para ditar), em pt-BR; null quando não há o que dizer. */
  message: string | null;
  /** Começa a ouvir; se já está ouvindo, para (o texto ditado fica no campo). */
  toggle: () => void;
  /** Para na hora sem mexer no campo (o usuário digitou ou enviou) e apaga o aviso de erro. */
  cancel: () => void;
};

type Options = {
  /** Texto atual do campo. */
  value: string;
  /** Troca o texto do campo (o ditado nunca envia: só escreve). */
  onChange: (next: string) => void;
  /** O campo, para saber onde está o cursor e devolvê-lo depois da fala. */
  inputRef: RefObject<HTMLTextAreaElement | null>;
  lang?: string;
  /** Quem transcreve (padrão: a Web Speech API do navegador). */
  transcriber?: TranscriberFactory;
};

type Session = { transcriber: Transcriber; base: DictationBase; caret: number };

/**
 * Ditado por voz num campo de texto: a fala entra no lugar do cursor (com o trecho interino ao
 * vivo) e o usuário revisa e envia quando quiser. Nunca envia sozinho.
 */
export function useDictation({ value, onChange, inputRef, lang = "pt-BR", transcriber = browserTranscriber }: Options): Dictation {
  const [availability] = useState(() => transcriber.availability());
  const [state, setState] = useState<DictationState>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const session = useRef<Session | null>(null);
  const latest = useRef({ value, onChange });
  useEffect(() => {
    latest.current = { value, onChange };
  });

  const cancel = useCallback(() => {
    const current = session.current;
    session.current = null;
    current?.transcriber.abort();
    setState("idle");
    setMessage(null);
  }, []);

  const start = useCallback(() => {
    if (!availability.ok) {
      setState("error");
      setMessage(UNAVAILABLE_MESSAGES[availability.reason]);
      return;
    }
    const input = inputRef.current;
    const text = latest.current.value;
    const caret = input && document.activeElement === input ? input.selectionEnd : text.length;
    const current: Session = { transcriber: transcriber.create(lang), base: { text, caret }, caret };
    session.current = current;
    setState("listening");
    setMessage(null);
    current.transcriber.start({
      onUpdate(finalText, interimText) {
        if (session.current !== current) return;
        const next = composeDictation(current.base, finalText, interimText);
        current.caret = next.caret;
        latest.current.onChange(next.text);
      },
      onError(code) {
        if (session.current !== current) return;
        const problem = dictationErrorMessage(code);
        if (!problem) return;
        setMessage(problem);
        setState("error");
      },
      onEnd() {
        if (session.current !== current) return;
        session.current = null;
        setState((now) => (now === "error" ? "error" : "idle"));
        // Cursor logo depois do que foi ditado, para seguir digitando ou dar Enter.
        const field = inputRef.current;
        if (field?.isConnected) {
          field.focus({ preventScroll: true });
          field.setSelectionRange(current.caret, current.caret);
        }
      },
    });
  }, [availability, inputRef, lang, transcriber]);

  const toggle = useCallback(() => {
    if (session.current) session.current.transcriber.stop();
    else start();
  }, [start]);

  // Fechar o painel (ou trocar de página) no meio do ditado desliga o microfone.
  useEffect(() => () => session.current?.transcriber.abort(), []);

  return { availability, state, message, toggle, cancel };
}
