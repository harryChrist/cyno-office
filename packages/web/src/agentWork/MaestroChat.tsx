import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Markdown } from "../ui/markdown/Markdown";
import type { ChatItem } from "./maestroChatView";
import { clockLabel } from "./timelineView";

const STICK_PX = 64;
const noWiki = () => null;

function Item({ item, now, onOpenTask }: { item: ChatItem; now: Date; onOpenTask?: (taskId: string) => void }) {
  const time = (
    <time className="mchat__time" dateTime={item.at}>
      {clockLabel(item.at, now)}
    </time>
  );
  if (item.kind === "message") {
    return (
      <li className={`mchat__msg mchat__msg--${item.from}`} data-testid="maestro-chat-message" data-from={item.from}>
        <div className="mchat__bubble">
          {item.from === "agent" ? <Markdown source={item.text} resolveWiki={noWiki} headingOffset={3} className="mchat__md" /> : <p className="mchat__text">{item.text}</p>}
        </div>
        <span className="mchat__meta">
          {item.from === "user" ? "Você" : "Maestro"}
          {item.fromTerminal ? " · pelo terminal" : ""} · {time}
        </span>
      </li>
    );
  }
  if (item.kind === "notice") {
    return (
      <li className={`mchat__notice mchat__notice--${item.tone}`} data-testid="maestro-chat-notice">
        {item.text} · {time}
      </li>
    );
  }
  return (
    <li className="mchat__pedido" data-testid="maestro-chat-pedido" data-task-id={item.taskId}>
      <div className="mchat__pedido-head">
        <span className="mchat__pedido-tag">Pedido</span>
        <span className="mchat__pedido-title" title={item.title}>
          {item.title}
        </span>
        <span className={`ui-badge ui-badge--${item.tone}`}>{item.stageLabel}</span>
        {time}
        {onOpenTask && (
          <button type="button" className="mact-group__open" onClick={() => onOpenTask(item.taskId)} aria-label="Abrir em Projetos e tarefas" title="Abrir em Projetos e tarefas">
            ↗
          </button>
        )}
      </div>
      {item.result && (
        <div className="mchat__pedido-result">
          <Markdown source={item.result} resolveWiki={noWiki} headingOffset={3} className="md--compact" />
        </div>
      )}
    </li>
  );
}

/**
 * Chat com o Maestro (o painel dele quando não há terminal interativo): as falas e as respostas,
 * com os pedidos que ele abriu no meio. Gruda no fim enquanto o usuário não sobe a lista.
 */
export function MaestroChat({ items, thinking, onOpenTask, empty }: { items: readonly ChatItem[]; thinking: boolean; onOpenTask?: (taskId: string) => void; empty: ReactNode }) {
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
    <div ref={ref} className="mchat" onScroll={onScroll} tabIndex={0} role="log" aria-label="Conversa com o Maestro" data-testid="maestro-chat">
      {items.length === 0 && !thinking ? (
        <div className="mact__empty">{empty}</div>
      ) : (
        <ol className="mchat__list">
          {items.map((item) => (
            <Item key={item.id} item={item} now={now} onOpenTask={onOpenTask} />
          ))}
          {thinking && (
            <li className="mchat__msg mchat__msg--agent" aria-live="polite" data-testid="maestro-chat-thinking">
              <div className="mchat__bubble mchat__bubble--thinking">O Maestro está respondendo…</div>
            </li>
          )}
        </ol>
      )}
    </div>
  );
}
