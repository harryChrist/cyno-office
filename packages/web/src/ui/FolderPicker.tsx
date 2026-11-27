import { FS_BROWSE_LIMIT, type FsBrowseResponse } from "@cyno/shared";
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type MutableRefObject } from "react";
import { api, ApiRequestError } from "../api/client";
import {
  canGoUp,
  canSelectCurrent,
  handlePickerListKey,
  hasDrivesList,
  pathBreadcrumbs,
  visiblePickerItems,
  type FolderPickerItem,
} from "./folderPickerLogic";
import { Modal } from "./widgets";
import "./folderPicker.css";

export type FolderPickerProps = {
  /** Caminho inicial (opcional; se vazio ou inválido ao abrir, cai na pasta pessoal). */
  initialPath?: string;
  /** Chamado com o caminho escolhido ao clicar em "Usar esta pasta". */
  onSelect: (path: string) => void;
  /** Chamado ao cancelar ou fechar o modal. */
  onClose: () => void;
  /** Função de navegação injetável (padrão: `api.browseFolders`). */
  browse?: (dirPath?: string, hidden?: boolean) => Promise<FsBrowseResponse>;
};

export type FolderPickerViewProps = {
  data: FsBrowseResponse | null;
  showingRoots: boolean;
  hidden: boolean;
  loading: boolean;
  error: string | null;
  focusedIndex: number;
  itemRefs?: MutableRefObject<(HTMLButtonElement | null)[]>;
  onOpen: (path: string) => void;
  onUp: () => void;
  onHome: () => void;
  onRoots: () => void;
  onToggleHidden: (next: boolean) => void;
  onRetry: () => void;
  onConfirm: () => void;
  onCancel: () => void;
  onFocusIndex: (index: number) => void;
  onListKeyDown?: (event: KeyboardEvent<HTMLElement>) => void;
};

function FolderIcon({ item }: { item: FolderPickerItem }) {
  if (item.isRoot) {
    return (
      <svg className="folder-picker__icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" data-icon="drive">
        <rect x="2" y="4" width="12" height="8" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
        <circle cx="11.5" cy="8" r="1" fill="currentColor" />
      </svg>
    );
  }
  if (item.isGitRepo) {
    return (
      <svg className="folder-picker__icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" data-icon="git">
        <path
          d="M2 4.2A1.2 1.2 0 0 1 3.2 3h3.1l1.4 1.4h5.1A1.2 1.2 0 0 1 14 5.6v6.2a1.2 1.2 0 0 1-1.2 1.2H3.2A1.2 1.2 0 0 1 2 11.8z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.35"
          strokeLinejoin="round"
        />
        <circle cx="6.2" cy="7.4" r="1" fill="currentColor" />
        <circle cx="10" cy="7.4" r="1" fill="currentColor" />
        <circle cx="6.2" cy="10.4" r="1" fill="currentColor" />
        <path d="M6.2 8.4v1M7.1 7.4h1.9" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg className="folder-picker__icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" data-icon="folder">
      <path
        d="M2 4.2A1.2 1.2 0 0 1 3.2 3h3.1l1.4 1.4h5.1A1.2 1.2 0 0 1 14 5.6v6.2a1.2 1.2 0 0 1-1.2 1.2H3.2A1.2 1.2 0 0 1 2 11.8z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Visão pura do seletor de pastas (facilita testes de renderização em todos os estados). */
export function FolderPickerView({
  data,
  showingRoots,
  hidden,
  loading,
  error,
  focusedIndex,
  itemRefs,
  onOpen,
  onUp,
  onHome,
  onRoots,
  onToggleHidden,
  onRetry,
  onConfirm,
  onCancel,
  onFocusIndex,
  onListKeyDown,
}: FolderPickerViewProps) {
  const hiddenId = useId();
  const drivesMode = hasDrivesList(data);
  const crumbs = data && !showingRoots ? pathBreadcrumbs(data.path) : [];
  const items = visiblePickerItems(data, showingRoots);
  const upEnabled = !loading && canGoUp(data, showingRoots);
  const confirmEnabled = canSelectCurrent(data, showingRoots, loading, error);

  return (
    <div className="folder-picker" data-testid="folder-picker-content">
      <div className="folder-picker__toolbar">
        <div className="folder-picker__nav-buttons">
          <button
            type="button"
            className="ui-button ui-button--secondary ui-button--small"
            disabled={!upEnabled}
            onClick={onUp}
            data-testid="folder-picker-up"
          >
            ↑ Subir
          </button>
          <button
            type="button"
            className="ui-button ui-button--ghost ui-button--small"
            disabled={loading || !data?.home}
            onClick={onHome}
            data-testid="folder-picker-home"
          >
            Pasta pessoal
          </button>
          <button
            type="button"
            className="ui-button ui-button--ghost ui-button--small"
            disabled={loading || !data || data.roots.length === 0}
            onClick={onRoots}
            data-testid="folder-picker-roots"
          >
            {drivesMode ? "Unidades" : "Raiz (/)"}
          </button>
        </div>
        <label htmlFor={hiddenId} className="folder-picker__hidden">
          <input
            id={hiddenId}
            type="checkbox"
            checked={hidden}
            disabled={loading}
            onChange={(event) => onToggleHidden(event.currentTarget.checked)}
            data-testid="folder-picker-hidden"
          />
          Mostrar ocultas
        </label>
      </div>

      <nav className="folder-picker__breadcrumbs" aria-label="Caminho atual" data-testid="folder-picker-breadcrumbs">
        {showingRoots ? (
          <span className="folder-picker__crumb folder-picker__crumb--current" aria-current="location">
            Unidades
          </span>
        ) : (
          <>
            {drivesMode && (
              <>
                <button type="button" className="folder-picker__crumb" onClick={onRoots} data-testid="folder-picker-crumb-roots">
                  Unidades
                </button>
                {crumbs.length > 0 && (
                  <span className="folder-picker__sep" aria-hidden="true">
                    ›
                  </span>
                )}
              </>
            )}
            {crumbs.map((crumb, index) => {
              const last = index === crumbs.length - 1;
              return (
                <span key={crumb.path} style={{ display: "inline-flex", alignItems: "center", gap: 2 }}>
                  {index > 0 && (
                    <span className="folder-picker__sep" aria-hidden="true">
                      ›
                    </span>
                  )}
                  <button
                    type="button"
                    className={`folder-picker__crumb${last ? " folder-picker__crumb--current" : ""}`}
                    aria-current={last ? "location" : undefined}
                    disabled={last || loading}
                    onClick={() => !last && onOpen(crumb.path)}
                    data-testid="folder-picker-crumb"
                  >
                    {crumb.label}
                  </button>
                </span>
              );
            })}
          </>
        )}
      </nav>

      <div className="folder-picker__panel" aria-busy={loading} onKeyDown={onListKeyDown}>
        {loading ? (
          <div className="folder-picker__state" role="status" data-testid="folder-picker-loading">
            <p>Carregando pastas…</p>
          </div>
        ) : error ? (
          <div className="folder-picker__state" role="alert" data-testid="folder-picker-error">
            <p className="ui-error">{error}</p>
            <div className="folder-picker__state-actions">
              <button type="button" className="ui-button ui-button--secondary ui-button--small" onClick={onRetry} data-testid="folder-picker-retry">
                Tentar de novo
              </button>
              <button type="button" className="ui-button ui-button--ghost ui-button--small" onClick={onHome}>
                Ir para a pasta pessoal
              </button>
            </div>
          </div>
        ) : items.length === 0 ? (
          <div className="folder-picker__state" data-testid="folder-picker-empty">
            <p>{showingRoots ? "Nenhuma unidade encontrada." : hidden ? "Nenhuma subpasta aqui." : "Nenhuma subpasta visível aqui."}</p>
          </div>
        ) : (
          <ul className="folder-picker__list" aria-label={showingRoots ? "Unidades disponíveis" : "Subpastas"} data-testid="folder-picker-list">
            {items.map((item, index) => {
              const focused = index === focusedIndex;
              return (
                <li key={item.path}>
                  <button
                    ref={(node) => {
                      if (itemRefs) itemRefs.current[index] = node;
                    }}
                    type="button"
                    className={`folder-picker__item${item.isGitRepo ? " folder-picker__item--git" : ""}${item.isRoot ? " folder-picker__item--root" : ""}${focused ? " folder-picker__item--focused" : ""}`}
                    title={item.isGitRepo ? `${item.name} (repositório Git)` : item.name}
                    onFocus={() => onFocusIndex(index)}
                    onClick={() => onOpen(item.path)}
                    onDoubleClick={() => onOpen(item.path)}
                    data-testid="folder-picker-entry"
                    data-path={item.path}
                    data-git={item.isGitRepo ? "true" : "false"}
                  >
                    <FolderIcon item={item} />
                    <span className="folder-picker__name">{item.name}</span>
                    {item.isGitRepo && (
                      <span className="folder-picker__git-badge" aria-label="Repositório Git">
                        Git
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {!loading && !error && !showingRoots && data?.truncated && (
          <p className="folder-picker__truncated" role="note" data-testid="folder-picker-truncated">
            Mostrando as primeiras {FS_BROWSE_LIMIT} pastas.
          </p>
        )}
      </div>

      <footer className="folder-picker__footer">
        <p className="folder-picker__selected" title={data?.path} data-testid="folder-picker-current">
          {data && !showingRoots ? <code>{data.path}</code> : "Escolha uma unidade para continuar."}
        </p>
        <div className="folder-picker__actions">
          <button type="button" className="ui-button ui-button--secondary ui-button--small" onClick={onCancel} data-testid="folder-picker-cancel">
            Cancelar
          </button>
          <button
            type="button"
            className="ui-button ui-button--small"
            disabled={!confirmEnabled}
            onClick={onConfirm}
            data-testid="folder-picker-confirm"
          >
            Usar esta pasta
          </button>
        </div>
      </footer>
    </div>
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return "Não foi possível listar as pastas.";
}

/** Modal acessível de seleção de pasta no disco do servidor (navegação por clique e teclado). */
export function FolderPicker({ initialPath, onSelect, onClose, browse = api.browseFolders }: FolderPickerProps) {
  const [data, setData] = useState<FsBrowseResponse | null>(null);
  const [showingRoots, setShowingRoots] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const [lastRequested, setLastRequested] = useState<string | undefined>(initialPath);
  const requestIdRef = useRef(0);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const load = useCallback(
    async (targetPath: string | undefined, nextHidden: boolean) => {
      const requestId = ++requestIdRef.current;
      setLoading(true);
      setError(null);
      setShowingRoots(false);
      setLastRequested(targetPath);
      try {
        const result = await browse(targetPath, nextHidden);
        if (requestIdRef.current !== requestId) return;
        setData(result);
        setFocusedIndex(-1);
        itemRefs.current = [];
        setLoading(false);
      } catch (err) {
        if (requestIdRef.current !== requestId) return;
        setError(errorMessage(err));
        setLoading(false);
      }
    },
    [browse],
  );

  // Carga inicial ao abrir o modal: se o caminho digitado antes não existir, cai na pasta pessoal.
  useEffect(() => {
    const requestId = ++requestIdRef.current;
    let cancelled = false;
    void (async () => {
      try {
        let result: FsBrowseResponse;
        try {
          result = await browse(initialPath, false);
        } catch (err) {
          if (!initialPath) throw err;
          result = await browse(undefined, false);
        }
        if (cancelled || requestIdRef.current !== requestId) return;
        setData(result);
        setError(null);
        setShowingRoots(false);
        setFocusedIndex(-1);
        itemRefs.current = [];
        setLoading(false);
      } catch (err) {
        if (cancelled || requestIdRef.current !== requestId) return;
        setError(errorMessage(err));
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [initialPath, browse]);

  const handleOpen = (nextPath: string) => {
    void load(nextPath, hidden);
  };

  const handleUp = () => {
    if (!data) return;
    if (data.parent !== null) {
      void load(data.parent, hidden);
      return;
    }
    if (hasDrivesList(data)) {
      setShowingRoots(true);
      setError(null);
      setFocusedIndex(0);
    }
  };

  const handleHome = () => {
    void load(data?.home, hidden);
  };

  const handleRoots = () => {
    if (!data) return;
    if (hasDrivesList(data)) {
      setShowingRoots(true);
      setError(null);
      setFocusedIndex(0);
    } else if (data.roots[0]) {
      void load(data.roots[0], hidden);
    }
  };

  const handleToggleHidden = (next: boolean) => {
    setHidden(next);
    if (!showingRoots) {
      void load(data?.path ?? lastRequested, next);
    }
  };

  const handleConfirm = () => {
    if (!canSelectCurrent(data, showingRoots, loading, error) || !data) return;
    onSelect(data.path);
  };

  const items = visiblePickerItems(data, showingRoots);

  const handleListKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const action = handlePickerListKey(event.key, {
      items,
      focusedIndex,
      canUp: canGoUp(data, showingRoots),
    });
    if (!action) return;
    if (action.kind === "close") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (action.kind === "focus") {
      event.preventDefault();
      setFocusedIndex(action.index);
      const node = itemRefs.current[action.index];
      node?.focus();
      node?.scrollIntoView?.({ block: "nearest" });
      return;
    }
    if (action.kind === "open") {
      event.preventDefault();
      handleOpen(action.path);
      return;
    }
    if (action.kind === "up") {
      event.preventDefault();
      handleUp();
    }
  };

  return (
    <Modal title="Escolher pasta" onClose={onClose} testId="folder-picker" wide>
      <div
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
          }
        }}
      >
        <FolderPickerView
          data={data}
          showingRoots={showingRoots}
          hidden={hidden}
          loading={loading}
          error={error}
          focusedIndex={focusedIndex}
          itemRefs={itemRefs}
          onOpen={handleOpen}
          onUp={handleUp}
          onHome={handleHome}
          onRoots={handleRoots}
          onToggleHidden={handleToggleHidden}
          onRetry={() => void load(lastRequested, hidden)}
          onConfirm={handleConfirm}
          onCancel={onClose}
          onFocusIndex={setFocusedIndex}
          onListKeyDown={handleListKeyDown}
        />
      </div>
    </Modal>
  );
}
