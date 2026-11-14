import { useId, type KeyboardEvent, type RefObject } from "react";
import { TERMINAL_FILTERS, searchCounter, type TerminalFilter } from "./terminalSearch";

type Props = {
  live: boolean;
  filter: TerminalFilter;
  onFilter: (filter: TerminalFilter) => void;
  query: string;
  onQuery: (query: string) => void;
  /** Resultado atual (índice global) e total. */
  current: number;
  total: number;
  onStep: (dir: 1 | -1) => void;
  onCloseSearch: () => void;
  inputRef: RefObject<HTMLInputElement | null>;
  showTime: boolean;
  onToggleTimes: () => void;
};

/** Barra do terminal: estado, os três filtros, a busca (contador, anterior/próximo) e os horários. */
export function TerminalToolbar({ live, filter, onFilter, query, onQuery, current, total, onStep, onCloseSearch, inputRef, showTime, onToggleTimes }: Props) {
  const searchId = useId();
  const searching = query.trim() !== "";
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      onStep(event.shiftKey ? -1 : 1);
    } else if (event.key === "Escape") {
      // Esc fecha a busca, não a tela de trabalho.
      event.preventDefault();
      event.stopPropagation();
      onCloseSearch();
    }
  };
  return (
    <>
      <div className="aterm__bar" data-testid="agent-terminal-bar">
        <span className="aterm__badge" title="Só leitura: não aceita comandos. Para falar com o agente, use a conversa.">
          <span className="aterm__dot" data-live={live ? "true" : undefined} aria-hidden="true" />
          {live ? "trabalhando" : "aguardando"} · só leitura
        </span>
        <div className="aterm__filters" role="group" aria-label="Mostrar no terminal">
          {TERMINAL_FILTERS.map((item) => (
            <button key={item.id} type="button" className="aterm__toggle" aria-pressed={filter === item.id} title={item.hint} onClick={() => onFilter(item.id)} data-testid={`agent-terminal-filter-${item.id}`}>
              {item.label}
            </button>
          ))}
        </div>
        <div className="aterm__find">
          <label htmlFor={searchId} className="sr-only">
            Buscar na conversa
          </label>
          <input
            id={searchId}
            ref={inputRef}
            type="search"
            className="aterm__search"
            placeholder="Buscar (Ctrl+F)"
            value={query}
            onChange={(event) => onQuery(event.currentTarget.value)}
            onKeyDown={onKeyDown}
            data-testid="agent-terminal-search"
          />
          {searching && (
            <>
              <span className="aterm__counter" aria-live="polite" data-testid="agent-terminal-counter">
                {searchCounter(current, total)}
              </span>
              <button type="button" className="aterm__step" aria-label="Resultado anterior" title="Anterior (Shift+Enter)" disabled={total === 0} onClick={() => onStep(-1)} data-testid="agent-terminal-prev">
                ↑
              </button>
              <button type="button" className="aterm__step" aria-label="Próximo resultado" title="Próximo (Enter)" disabled={total === 0} onClick={() => onStep(1)} data-testid="agent-terminal-next">
                ↓
              </button>
            </>
          )}
        </div>
        <button type="button" className="aterm__toggle" aria-pressed={showTime} onClick={onToggleTimes} data-testid="agent-terminal-times">
          horários
        </button>
      </div>
      {searching && (
        <p className="aterm__hint" role="note" data-testid="agent-terminal-search-hint">
          Com a busca ligada o texto aparece sem formatação, para marcar cada resultado.
        </p>
      )}
    </>
  );
}
