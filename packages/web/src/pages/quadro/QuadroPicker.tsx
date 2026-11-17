import type { Board } from "@cyno/shared";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { QIcon } from "./QuadroParts";
import { filterBoards, moveIndex, sortBoards } from "./quadroView";

/**
 * O título do quadro aberto, que é também um seletor: abre uma lista pesquisável de todos os quadros do workspace
 * (setas, Enter e Esc; clicar fora fecha; o atual vem marcado).
 */
export function QuadroPicker({ boards, current, onPick }: { boards: readonly Board[]; current: Board; onPick: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listId = useId();
  const items = useMemo(() => sortBoards(filterBoards(boards, query), "nome"), [boards, query]);

  // Clicar fora fecha.
  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  const close = (focusButton: boolean) => {
    setOpen(false);
    if (focusButton) buttonRef.current?.focus();
  };
  const show = () => {
    setQuery("");
    setActive(Math.max(0, sortBoards(boards, "nome").findIndex((board) => board.id === current.id)));
    setOpen(true);
  };
  const choose = (board: Board) => {
    close(true);
    if (board.id !== current.id) onPick(board.id);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setActive((index) => moveIndex(index, event.key === "ArrowDown" ? 1 : -1, items.length));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const board = items[active];
      if (board) choose(board);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    }
  };
  const optionId = (id: string) => `${listId}-${id}`;
  const activeBoard = items[active];

  return (
    <div className="quadro-picker" ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        className="quadro-picker__button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={`Quadro: ${current.title}. Trocar de quadro`}
        onClick={() => (open ? close(false) : show())}
        data-testid="quadro-picker"
      >
        <span className="quadro-picker__title" data-testid="quadro-title">
          {current.title}
        </span>
        <QIcon name="chevron" />
      </button>
      {open && (
        <div className="quadro-picker__pop" onKeyDown={onKeyDown} data-testid="quadro-picker-pop">
          <input
            type="search"
            className="ui-input ui-input--compact"
            placeholder="Buscar quadro"
            aria-label="Buscar quadro"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={activeBoard ? optionId(activeBoard.id) : undefined}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            autoFocus
            data-testid="quadro-picker-search"
          />
          <ul className="quadro-picker__list" role="listbox" id={listId} aria-label="Quadros do workspace" data-testid="quadro-picker-list">
            {items.map((board, index) => (
              <li
                key={board.id}
                id={optionId(board.id)}
                role="option"
                aria-selected={board.id === current.id}
                className={`quadro-picker__item${index === active ? " is-active" : ""}${board.id === current.id ? " is-current" : ""}`}
                onMouseEnter={() => setActive(index)}
                onClick={() => choose(board)}
                data-testid={`quadro-picker-item-${board.id}`}
              >
                <span className="quadro-picker__name">{board.title}</span>
                {board.id === current.id && <span className="quadro-picker__now">Aberto</span>}
              </li>
            ))}
            {items.length === 0 && (
              <li className="quadro-picker__none" role="presentation">
                Nenhum quadro encontrado.
              </li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
