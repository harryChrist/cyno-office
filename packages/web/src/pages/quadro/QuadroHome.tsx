import type { Board } from "@cyno/shared";
import { useState } from "react";
import { hashFor, useNavStore } from "../../store/navStore";
import { useOfficeStore } from "../../store/officeStore";
import { QIcon, useNow } from "./QuadroParts";
import { accentIndex, authorLabel, boardCountLabel, BOARD_SORTS, dataAgeLabel, filterBoards, initialOf, sortBoards, type BoardSort } from "./quadroView";

/** Tela inicial dos quadros: cartões numa grade (sem carregar nenhum quadro), com busca e ordem. */
export function QuadroHome({ boards, notice, onDismissNotice }: { boards: readonly Board[]; notice: string | null; onDismissNotice: () => void }) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<BoardSort>("recentes");
  const workspaceId = useNavStore((state) => state.workspaceId);
  const now = useNow();
  const agents = useOfficeStore((state) => state.office?.agents) ?? [];
  const shown = sortBoards(filterBoards(boards, query), sort);

  return (
    <div className="quadro-home" data-testid="quadro-home">
      {notice && (
        <div className="quadro-notice" role="status" data-testid="quadro-notice">
          <span>{notice}</span>
          <button type="button" className="ui-icon-button" onClick={onDismissNotice} aria-label="Dispensar aviso">
            ×
          </button>
        </div>
      )}
      <div className="quadro-home__bar">
        <h2 className="quadro-home__title">
          Quadros <span className="quadro-home__count" data-testid="quadro-count">{boardCountLabel(boards.length)}</span>
        </h2>
        <div className="quadro-home__tools">
          <label className="quadro-search">
            <span className="sr-only">Buscar quadro por título ou descrição</span>
            <QIcon name="search" />
            <input type="search" className="ui-input" placeholder="Buscar quadro" value={query} onChange={(event) => setQuery(event.target.value)} data-testid="quadro-search" />
          </label>
          <label className="quadro-sort">
            <span className="sr-only">Ordenar quadros</span>
            <select className="ui-input ui-input--compact" value={sort} onChange={(event) => setSort(event.target.value as BoardSort)} data-testid="quadro-sort">
              {BOARD_SORTS.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>
      {shown.length === 0 ? (
        <div className="quadro-state quadro-home__none" data-testid="quadro-no-results">
          <p>
            Nenhum quadro encontrado para &ldquo;{query.trim()}&rdquo;. Tente outra palavra do título ou da descrição.
          </p>
          <button type="button" className="ui-button ui-button--secondary" onClick={() => setQuery("")} data-testid="quadro-search-clear">
            Limpar a busca
          </button>
        </div>
      ) : (
        <ul className="quadro-grid" data-testid="quadro-grid">
          {shown.map((board) => (
            <li key={board.id} className="quadro-card-item">
              <a className="quadro-card" href={hashFor({ workspaceId, page: "quadro", sub: board.id })} style={{ ["--q-accent" as string]: `var(--q-c${accentIndex(board.id) + 1})` }} data-testid={`quadro-card-${board.id}`}>
                <span className="quadro-card__badge" aria-hidden="true">
                  {initialOf(board.title)}
                </span>
                <span className="quadro-card__title">{board.title}</span>
                <span className="quadro-card__desc">{board.description || "Sem descrição."}</span>
                <span className="quadro-card__meta">
                  <span>{dataAgeLabel(board, now)}</span>
                  <span>{authorLabel(board.createdBy, agents)}</span>
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
