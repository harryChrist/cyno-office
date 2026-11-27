import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { api, describeError } from "../api/client";
import { Markdown } from "../ui/markdown/Markdown";
import { useAgentLogStore } from "../store/agentLogStore";
import { useChatStatusStore } from "../store/chatStatusStore";
import { useTerminalsStore } from "../store/terminalsStore";
import type { AgentChatItem } from "./agentChat";
import { canRetry, canSend, counterText, enterSends, getDraft, MESSAGE_MAX, messageText, nextCheckIn, sendStatusText, setDraft, viewSend, type SendState } from "./composerModel";
import { clockLabel } from "./timelineLogic";
import "./maestroPanel.css";

const STICK_PX = 64;
const noWiki = () => null;

function Item({ item, agentName, now }: { item: AgentChatItem; agentName: string; now: Date }) {
  const time = (
    <time className="mchat__time" dateTime={item.at}>
      {clockLabel(item.at, now)}
    </time>
  );
  if (item.kind === "notice") {
    return (
      <li className={`mchat__notice mchat__notice--${item.tone}`} data-testid="agent-chat-notice">
        {item.text} · {time}
      </li>
    );
  }
  return (
    <li className={`mchat__msg mchat__msg--${item.from}`} data-testid="agent-chat-message" data-from={item.from} data-note={item.note ? "true" : undefined}>
      <div className="mchat__bubble">
        {item.note && <span className="achat-note">{item.from === "user" ? "Nota para a tarefa" : "Sobre a nota"}</span>}
        {item.from === "agent" ? <Markdown source={item.text} resolveWiki={noWiki} headingOffset={3} className="mchat__md" /> : <p className="mchat__text">{item.text}</p>}
      </div>
      <span className="mchat__meta">
        {item.from === "user" ? "Você" : agentName} · {time}
      </span>
    </li>
  );
}

/** A conversa direta com o agente (falas, respostas e notas para a tarefa), grudada no fim. */
export function AgentChatList({ items, agentName, thinking, empty }: { items: readonly AgentChatItem[]; agentName: string; thinking: boolean; empty: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [now] = useState(() => new Date());
  useLayoutEffect(() => {
    const scroller = ref.current;
    if (scroller && stick.current) scroller.scrollTop = scroller.scrollHeight;
  });
  const onScroll = () => {
    const scroller = ref.current;
    if (scroller) stick.current = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < STICK_PX;
  };
  return (
    <div ref={ref} className="mchat" onScroll={onScroll} tabIndex={0} role="log" aria-label={`Conversa com ${agentName}`} data-testid="agent-chat">
      {items.length === 0 && !thinking ? (
        <div className="mact__empty">{empty}</div>
      ) : (
        <ol className="mchat__list">
          {items.map((item) => (
            <Item key={item.id} item={item} agentName={agentName} now={now} />
          ))}
          {thinking && (
            <li className="mchat__msg mchat__msg--agent" aria-live="polite" data-testid="agent-chat-thinking">
              <div className="mchat__bubble mchat__bubble--thinking">{agentName} está respondendo…</div>
            </li>
          )}
        </ol>
      )}
    </div>
  );
}

/**
 * Caixa de mensagem direta para o agente. Trabalhando numa tarefa: a mensagem vira uma nota para
 * ela (ex.: "foca no público jovem"); livre: conversa. Nada vira pedido: trabalho novo é com o Maestro.
 * Mostra o estado da entrega (na fila, entregue, respondeu, falhou) pelo evento `agent:chat-status`, sem
 * consultar nada; falhou volta o texto para a caixa e oferece "Tentar de novo". Rascunho guardado por agente.
 */
export function AgentCompose({ agentId, agentName, taskTitle }: { agentId: string; agentName: string; taskTitle?: string }) {
  const [text, setText] = useState(() => getDraft(agentId));
  const [sends, setSends] = useState<Readonly<Record<string, SendState>>>({});
  const [now, setNow] = useState(() => Date.now());
  const byMessage = useChatStatusStore((state) => state.byMessage);
  const terminal = useTerminalsStore((state) => state.byAgent[agentId]);
  const ids = { input: useId(), hint: useId() };
  const restored = useRef(new Set<string>());
  const lastAgent = useRef(agentId);

  // Trocou de agente: guarda o rascunho do anterior e traz o do novo.
  useEffect(() => {
    if (lastAgent.current === agentId) return;
    lastAgent.current = agentId;
    setText(getDraft(agentId));
  }, [agentId]);

  const edit = (value: string) => {
    setText(value);
    setDraft(agentId, value);
  };

  const view = viewSend(sends[agentId], byMessage, now);
  const busy = view?.phase === "sending";
  const length = messageText(text).length;
  const canSendNow = canSend(text, busy);

  // A linha de situação some sozinha (entregue, respondeu) e a da fila vira aviso se o terminal está parado.
  useEffect(() => {
    const wait = nextCheckIn(view, Date.now());
    if (wait === null) return;
    const timer = window.setTimeout(() => setNow(Date.now()), wait + 50);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- só o estado muda o prazo; o objeto `view` é novo a cada desenho
  }, [view?.phase, view?.at, view?.error]);

  // Falhou: o texto volta para a caixa (se ela estiver vazia), para não se perder.
  useEffect(() => {
    if (view?.phase !== "failed" || !view.messageId || restored.current.has(view.messageId)) return;
    restored.current.add(view.messageId);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reage a um evento do servidor (a falha), uma vez por mensagem
    if (!getDraft(agentId)) edit(view.text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view?.phase, view?.messageId]);

  const send = (override?: string) => {
    const body = messageText(override ?? text);
    if (!canSend(body, busy)) return;
    const mark = (patch: Partial<SendState> & { phase: SendState["phase"] }) => setSends((value) => ({ ...value, [agentId]: { text: body, at: Date.now(), ...value[agentId], ...patch } }));
    setSends((value) => ({ ...value, [agentId]: { phase: "sending", text: body, at: Date.now() } }));
    api.chatWithAgent(agentId, body).then(
      (response) => {
        if (override === undefined) edit("");
        // Garante que o histórico do agente está carregado (a resposta chega ao vivo).
        void useAgentLogStore.getState().loadAgent(agentId);
        mark({ phase: "queued", messageId: response.messageId, mode: response.mode, at: Date.now() });
      },
      (error: unknown) => mark({ phase: "rejected", error: describeError(error), at: Date.now() }),
    );
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!enterSends(event.nativeEvent)) return;
    event.preventDefault();
    send();
  };
  const startTerminal = () => void api.startTerminal(agentId).catch(() => undefined);
  const status = sendStatusText(view, now, terminal);
  const stale = view?.phase === "queued" && status.startsWith("Na fila há mais");
  const counter = counterText(length);
  const placeholder = taskTitle ? `Nota para a tarefa “${taskTitle}” (ex.: foca no público jovem)…` : `Converse com ${agentName}: dúvidas, ideias, ajustes…`;

  return (
    <form
      className="work-compose"
      noValidate
      aria-label={`Mensagem para ${agentName}`}
      onSubmit={(event) => {
        event.preventDefault();
        send();
      }}
    >
      <label htmlFor={ids.input} className="sr-only">
        Mensagem para {agentName}
      </label>
      <div className="work-compose__box">
        <textarea
          id={ids.input}
          className="ui-input work-compose__input"
          rows={2}
          value={text}
          maxLength={MESSAGE_MAX}
          placeholder={placeholder}
          aria-describedby={ids.hint}
          onChange={(event) => edit(event.currentTarget.value)}
          onKeyDown={onKeyDown}
          data-testid="agent-chat-input"
        />
        <div className="work-compose__tools">
          {counter && (
            <span className="work-compose__counter" data-near-limit={length >= MESSAGE_MAX * 0.95 ? "true" : undefined} data-testid="agent-chat-counter">
              {counter}
            </span>
          )}
          <button type="submit" className="ui-button work-compose__send" disabled={!canSendNow} data-testid="agent-chat-send">
            {busy ? "Enviando…" : taskTitle ? "Mandar nota" : "Enviar"}
          </button>
        </div>
      </div>
      {status && (
        <p
          className={view && (view.phase === "failed" || view.phase === "rejected" || (view.phase === "delivered" && view.error)) ? "ui-error work-compose__error" : "work-compose__status"}
          role={view?.phase === "failed" || view?.phase === "rejected" ? "alert" : "status"}
          data-phase={view?.phase}
          data-testid="agent-chat-feedback"
        >
          {status}
          {canRetry(view) && (
            <button type="button" className="work-compose__retry" onClick={() => send(view!.text)} data-testid="agent-chat-retry">
              Tentar de novo
            </button>
          )}
          {stale && (
            <button type="button" className="work-compose__retry" onClick={startTerminal} data-testid="agent-chat-start-terminal">
              Subir o terminal agora
            </button>
          )}
        </p>
      )}
      <p id={ids.hint} className="work-compose__hint">
        <kbd>Enter</kbd> envia · <kbd>Shift</kbd>+<kbd>Enter</kbd> nova linha ·{" "}
        {taskTitle ? "vira uma nota para a tarefa em andamento, não uma tarefa nova" : "é conversa: não vira pedido (trabalho novo, peça ao Maestro)"}
      </p>
    </form>
  );
}
