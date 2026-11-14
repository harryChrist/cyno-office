import type { FormEvent, KeyboardEvent, RefObject } from "react";
import { useDictation, type Dictation } from "../dictation/useDictation";
import type { MaestroPrompt } from "./useMaestroPrompt";

export type MaestroDictation = {
  dictation: Dictation;
  /** Digitar no campo encerra o ditado (o texto fica como o usuário deixou). */
  change: (next: string) => void;
  /** Enter envia (e desliga o microfone antes); Shift+Enter quebra a linha. */
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  submit: (event?: FormEvent) => Promise<boolean>;
};

/** O pedido ao Maestro com ditado por voz: a fala só escreve no campo; enviar é sempre do usuário. */
export function useMaestroDictation(maestro: MaestroPrompt, inputRef: RefObject<HTMLTextAreaElement | null>): MaestroDictation {
  const dictation = useDictation({ value: maestro.prompt, onChange: maestro.change, inputRef });
  return {
    dictation,
    change(next) {
      dictation.cancel();
      maestro.change(next);
    },
    onKeyDown(event) {
      if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) dictation.cancel();
      maestro.onKeyDown(event);
    },
    submit(event) {
      dictation.cancel();
      return maestro.submit(event);
    },
  };
}
