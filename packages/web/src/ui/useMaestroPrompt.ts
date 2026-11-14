import { agentEngine, findMaestroAgent, isCliEngine } from "@cyno/shared";
import { useState, type FormEvent, type KeyboardEvent } from "react";
import { api } from "../api/client";
import { useOfficeStore } from "../store/officeStore";
import { useAsyncAction } from "./useAsyncAction";
import { validateMessage } from "./validation";

export type MaestroPrompt = {
  prompt: string;
  /** Troca o texto (e limpa o aviso de validação, se havia). */
  change: (next: string) => void;
  /** Valida e envia ao Maestro; devolve true se a mensagem foi aceita. */
  submit: (event?: FormEvent) => Promise<boolean>;
  /** Enter envia; Shift+Enter quebra a linha. */
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  canSend: boolean;
  pending: boolean;
  /** Erro de validação ou da API. */
  message: string | undefined;
  invalid: boolean;
  /** Id do último pedido criado pela mensagem (Maestro simulado: cada mensagem vira um pedido). */
  sentId: string | null;
  /** A última mensagem foi conversa (Maestro de CLI): a resposta aparece no painel dele. */
  sentChat: boolean;
  /** A última mensagem de conversa (o servidor acompanha a entrega dela por `agent:chat-status`). */
  sentMessage: { id: string; text: string; at: number } | null;
  /** O Maestro conversa (motor de CLI) e só abre um pedido quando for para fazer algo. */
  conversational: boolean;
};

/**
 * Mensagem para o Maestro: o texto, a validação e o envio (`api.talkToMaestro`). Com o Maestro de
 * CLI é conversa (ele abre o pedido quando entende que é para fazer); com o simulado, vira pedido.
 * Usado pela caixa do Office e pelo painel do Maestro (Ctrl/⌘+K).
 */
export function useMaestroPrompt(): MaestroPrompt {
  const ready = useOfficeStore((state) => state.office !== null);
  const conversational = useOfficeStore((state) => {
    const maestro = state.office ? findMaestroAgent(state.office) : undefined;
    return maestro !== undefined && isCliEngine(agentEngine(maestro));
  });
  const [prompt, setPrompt] = useState("");
  const [validation, setValidation] = useState<string | undefined>();
  const [sentId, setSentId] = useState<string | null>(null);
  const [sentChat, setSentChat] = useState(false);
  const [sentMessage, setSentMessage] = useState<MaestroPrompt["sentMessage"]>(null);
  const { pending, error, run } = useAsyncAction();
  const canSend = ready && !pending;

  const submit = async (event?: FormEvent): Promise<boolean> => {
    event?.preventDefault();
    if (!canSend) return false;
    const problem = validateMessage(prompt);
    setValidation(problem);
    if (problem) return false;
    const response = await run(() => api.talkToMaestro(prompt.trim()));
    if (!response) return false;
    setPrompt("");
    setSentId(response.mode === "pedido" ? response.task.id : null);
    setSentChat(response.mode === "conversa");
    setSentMessage(response.mode === "conversa" ? { id: response.messageId, text: prompt.trim(), at: Date.now() } : null);
    return true;
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit();
    }
  };

  const change = (next: string) => {
    setPrompt(next);
    if (validation) setValidation(undefined);
  };

  return { prompt, change, submit, onKeyDown, canSend, pending, message: validation ?? error ?? undefined, invalid: Boolean(validation), sentId, sentChat, sentMessage, conversational };
}
