import { fileDirOf, fileNameOf, fileNameError, fileSegments, fileSizeLabel, FILE_LIMITS, joinFilePath, type FileRoot, type FileSearchMatch } from "@cyno/shared";
import { createContext, useContext, useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent } from "react";
import { api } from "../../api/client";
import { useFilesStore, type UploadPanel as UploadPanelState } from "../../store/filesStore";
import { useNavStore } from "../../store/navStore";
import { copyText } from "../../ui/clipboard";
import { ConfirmDialog, Modal } from "../../ui/widgets";
import { FileMenu } from "./FileMenu";
import { fileTone } from "./highlight";
import { FilesIcon } from "./filesIcons";
import { deleteConfirmText, flattenTree, fullPathOf, indentFor, menuActions, nameStemEnd, nodeKey, readonlyHint, shortRootPath, withNamingRow, type MenuAction, type NameRow, type Naming, type TreeRow } from "./filesView";

const DEBOUNCE_MS = 250;

/** Valor com espera: só muda depois de `delay` ms sem novo valor. */
function useDebounced<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

/** Um item da árvore sobre o qual uma ação age. */
type ActionItem = { root: string; path: string; kind: "dir" | "file"; name: string; locked: boolean };

type DragHandlers = Pick<React.HTMLAttributes<HTMLElement>, "onDragOver" | "onDragLeave" | "onDrop">;

/** O que as linhas da árvore usam para alterar: menu, nome na linha, arrastar e soltar. */
type TreeActions = {
  writable: (root: string) => boolean;
  naming: Naming | null;
  dropKey: string | null;
  openMenu: (item: ActionItem, at: { x: number; y: number }, opener: HTMLElement) => void;
  run: (action: MenuAction, item: ActionItem) => void;
  /** Cria na raiz (ou na pasta em foco): usado pelos botões do título. */
  rootCreate: (root: string, kind: "file" | "dir") => void;
  rootUpload: (root: string) => void;
  dropProps: (target: { root: string; dir: string; key: string }) => DragHandlers;
  submitName: (naming: Naming, name: string) => Promise<string | null>;
  cancelName: (restoreFocus: boolean) => void;
};

const ActionsContext = createContext<TreeActions | null>(null);
const useActions = (): TreeActions => {
  const value = useContext(ActionsContext);
  if (!value) throw new Error("FileTree: sem contexto de ações");
  return value;
};

/** Campo "Filtrar nesta pasta" de uma pasta com mais de uma página: usa o filtro da rota, com espera ao digitar. */
function DirFilter({ root, path, value, depth }: { root: string; path: string; value: string; depth: number }) {
  const [text, setText] = useState(value);
  const debounced = useDebounced(text, DEBOUNCE_MS);
  const loaded = useRef(value);
  useEffect(() => {
    if (debounced.trim() === loaded.current) return;
    loaded.current = debounced.trim();
    void useFilesStore.getState().loadDir(root, path, { filter: loaded.current });
  }, [debounced, root, path]);
  return (
    <div className="files-filter" style={{ paddingLeft: 8 + indentFor(depth) }}>
      <input
        type="search"
        className="files-filter__input"
        placeholder="Filtrar nesta pasta"
        aria-label="Filtrar nesta pasta"
        value={text}
        maxLength={FILE_LIMITS.searchQuery}
        onChange={(event) => setText(event.target.value)}
        data-testid="files-filter"
      />
    </div>
  );
}

/** O campo de nome na própria linha: valida a cada tecla, Enter confirma, Esc ou sair do campo cancela. */
function NameField({ row }: { row: NameRow }) {
  const actions = useActions();
  const [value, setValue] = useState(row.initial);
  const [touched, setTouched] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const finished = useRef(false);
  const busy = useRef(false);

  useEffect(() => {
    const node = input.current;
    if (!node) return;
    node.focus();
    node.setSelectionRange(0, row.naming.mode === "rename" ? nameStemEnd(row.initial, row.nodeKind) : row.initial.length);
  }, [row.initial, row.naming.mode, row.nodeKind]);

  const problem = serverError ?? (touched ? fileNameError(value, row.nodeKind) : null);

  const submit = async () => {
    if (busy.current) return;
    setTouched(true);
    if (fileNameError(value, row.nodeKind)) return;
    if (row.naming.mode === "rename" && value === row.initial) {
      finished.current = true;
      actions.cancelName(true);
      return;
    }
    busy.current = true;
    const message = await actions.submitName(row.naming, value);
    busy.current = false;
    if (message) {
      setServerError(message);
      input.current?.focus();
    } else finished.current = true;
  };

  return (
    <div role="none" className="files-namerow" style={{ paddingLeft: 8 + indentFor(row.depth) }}>
      <div className="files-node files-node--editing">
        <span className="files-node__chevron" aria-hidden="true" />
        <span className="files-node__icon" aria-hidden="true">
          <FilesIcon name={row.nodeKind === "dir" ? "folder" : "file"} size={15} />
        </span>
        <input
          ref={input}
          type="text"
          className="files-name-input"
          value={value}
          maxLength={FILE_LIMITS.name + 1}
          spellCheck={false}
          autoComplete="off"
          aria-label={row.naming.mode === "rename" ? "Novo nome" : row.nodeKind === "dir" ? "Nome da nova pasta" : "Nome do novo arquivo"}
          aria-invalid={problem ? true : undefined}
          onChange={(event) => {
            setValue(event.target.value);
            setTouched(true);
            setServerError(null);
          }}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Enter") {
              event.preventDefault();
              void submit();
            } else if (event.key === "Escape") {
              event.preventDefault();
              finished.current = true;
              actions.cancelName(true);
            }
          }}
          onBlur={() => {
            if (!finished.current && !busy.current) actions.cancelName(false);
          }}
          data-testid="files-name-input"
        />
      </div>
      {problem && (
        <p className="files-name-error" role="alert" data-testid="files-name-error">
          {problem}
        </p>
      )}
    </div>
  );
}

function NodeRow({ row, active, tabbable, onFileClick, onFileOpen }: { row: Extract<TreeRow, { kind: "dir" | "file" }>; active: boolean; tabbable: boolean; onFileClick: () => void; onFileOpen: () => void }) {
  const actions = useActions();
  const store = useFilesStore.getState;
  const locked = row.locked;
  const isDir = row.kind === "dir";
  const title = locked ? "Protegido: não abre por aqui" : row.title;
  const item: ActionItem = { root: row.root, path: row.path, kind: row.kind, name: fileNameOf(row.path), locked };
  const writable = actions.writable(row.root);
  const hasMenu = menuActions({ kind: row.kind, name: item.name, locked, writable }).length > 0;
  const dropping = actions.dropKey === row.key;
  const drop = isDir ? actions.dropProps({ root: row.root, dir: row.path, key: row.key }) : {};
  const onClick = () => {
    if (locked) return;
    if (isDir) store().toggleDir(row.root, row.path);
    else {
      store().openFile({ root: row.root, path: row.path }, false);
      onFileClick();
    }
  };
  return (
    <div
      role="treeitem"
      aria-level={row.depth + 1}
      aria-expanded={isDir && !locked ? row.open : undefined}
      aria-selected={!isDir ? active : undefined}
      aria-disabled={locked || undefined}
      tabIndex={tabbable ? 0 : -1}
      className={`files-node files-node--${row.kind}${active ? " files-node--active" : ""}${locked ? " files-node--locked" : ""}${dropping ? " files-node--drop" : ""}`}
      style={{ paddingLeft: 8 + indentFor(row.depth) }}
      title={title}
      onClick={onClick}
      onDoubleClick={() => {
        if (!locked && !isDir) {
          store().openFile({ root: row.root, path: row.path }, true);
          onFileOpen();
        }
      }}
      onContextMenu={(event: MouseEvent<HTMLDivElement>) => {
        if (!hasMenu) return;
        event.preventDefault();
        actions.openMenu(item, { x: event.clientX, y: event.clientY }, event.currentTarget);
      }}
      {...drop}
      data-key={row.key}
      data-testid="files-node"
      data-path={row.path}
      data-kind={row.kind}
      data-locked={locked ? "true" : "false"}
    >
      <span className={`files-node__chevron${isDir && row.open ? " files-node__chevron--open" : ""}`} aria-hidden="true">
        {isDir && !locked && <FilesIcon name="chevron" size={12} />}
      </span>
      <span className="files-node__icon" aria-hidden="true">
        <FilesIcon name={locked ? "lock" : isDir ? "folder" : "file"} size={15} tone={locked || isDir ? undefined : fileTone(item.name)} />
      </span>
      <span className="files-node__name">{row.label}</span>
      {isDir && !locked && (
        <button
          type="button"
          className="files-node__focus"
          title="Focar nesta pasta"
          aria-label={`Focar na pasta ${row.label}`}
          onClick={(event) => {
            event.stopPropagation();
            store().setFocus(row.root, row.path);
          }}
          data-testid="files-focus"
        >
          <FilesIcon name="focus" size={14} />
        </button>
      )}
      {row.kind === "file" && !locked && row.size !== undefined && <span className="files-node__size">{fileSizeLabel(row.size)}</span>}
      {hasMenu && (
        <button
          type="button"
          className="files-node__menu"
          title="Mais ações"
          aria-label={`Mais ações de ${row.label}`}
          aria-haspopup="menu"
          tabIndex={-1}
          onClick={(event) => {
            event.stopPropagation();
            const box = event.currentTarget.getBoundingClientRect();
            actions.openMenu(item, { x: box.right - 4, y: box.bottom + 2 }, event.currentTarget.closest<HTMLElement>('[role="treeitem"]') ?? event.currentTarget);
          }}
          data-testid="files-node-menu"
        >
          <FilesIcon name="more" size={16} />
        </button>
      )}
    </div>
  );
}

function RowView({ row, activeKey, tabbableKey, onFileClick, onFileOpen }: { row: TreeRow | NameRow; activeKey: string | null; tabbableKey: string | null; onFileClick: () => void; onFileOpen: () => void }) {
  if (row.kind === "name") return <NameField row={row} />;
  if (row.kind === "dir" || row.kind === "file") return <NodeRow row={row} active={row.kind === "file" && row.key === activeKey} tabbable={row.key === tabbableKey} onFileClick={onFileClick} onFileOpen={onFileOpen} />;
  if (row.kind === "filter") return <DirFilter key={row.key} root={row.root} path={row.path} value={row.value} depth={row.depth} />;
  if (row.kind === "more") {
    return (
      <div role="none" className="files-more-row" style={{ paddingLeft: 8 + indentFor(row.depth) }}>
        <button type="button" className="files-more" disabled={row.loading} onClick={() => void useFilesStore.getState().loadDir(row.root, row.path, { more: true })} data-testid="files-more">
          {row.loading ? "Carregando…" : `Mostrar mais (${row.remaining} restantes)`}
        </button>
      </div>
    );
  }
  return (
    <div role="none" className={`files-status files-status--${row.tone}`} style={{ paddingLeft: 8 + indentFor(row.depth) + 20 }}>
      {row.text}
    </div>
  );
}

/** A seção de uma raiz: título com nome, caminho encurtado e (com escrita) os botões de criar e enviar, foco numa pasta e a árvore. */
function RootSection({ root, activeKey, tabbableKey, onFileClick, onFileOpen }: { root: FileRoot; activeKey: string | null; tabbableKey: string | null; onFileClick: () => void; onFileOpen: () => void }) {
  const actions = useActions();
  const closed = useFilesStore((state) => state.rootsOpen[root.id] !== true);
  const focus = useFilesStore((state) => state.focus[root.id] ?? "");
  const dirs = useFilesStore((state) => state.dirs);
  const open = useFilesStore((state) => state.open);
  const rows = useMemo(() => (closed || root.error ? [] : flattenTree(root.id, focus, { dirs, open })), [closed, root.error, root.id, focus, dirs, open]);
  const display = useMemo(() => withNamingRow(rows, actions.naming, root.id, focus), [rows, actions.naming, root.id, focus]);
  const store = useFilesStore.getState;
  const segments = fileSegments(focus);
  const hint = root.error ? null : readonlyHint(root);
  const writable = root.writable && !root.error;
  const headKey = `${root.id}\t\thead`;
  const dropping = actions.dropKey === headKey;
  const drop = actions.dropProps({ root: root.id, dir: focus, key: headKey });
  return (
    <section className={`files-root${root.error ? " files-root--error" : ""}`} data-testid="files-root" data-root={root.id} data-writable={root.writable ? "true" : "false"}>
      <h4 className={`files-root__head${dropping ? " files-root__head--drop" : ""}`} {...(root.error ? {} : drop)}>
        <button type="button" className="files-root__toggle" aria-expanded={!closed && !root.error} disabled={Boolean(root.error)} onClick={() => store().toggleRoot(root.id)} title={root.path}>
          <span className={`files-node__chevron${closed || root.error ? "" : " files-node__chevron--open"}`} aria-hidden="true">
            <FilesIcon name="chevron" size={12} />
          </span>
          <span className="files-root__name">{root.name}</span>
          {hint && (
            <span className="files-root__ro" title={hint} data-testid="files-readonly">
              só leitura
            </span>
          )}
          <span className="files-root__path">{shortRootPath(root.path)}</span>
        </button>
        {writable && (
          <span className="files-root__actions">
            <button type="button" className="files-root__act" title="Novo arquivo" aria-label={`Novo arquivo em ${root.name}`} onClick={() => actions.rootCreate(root.id, "file")} data-testid="files-root-new-file">
              <FilesIcon name="filePlus" size={15} />
            </button>
            <button type="button" className="files-root__act" title="Nova pasta" aria-label={`Nova pasta em ${root.name}`} onClick={() => actions.rootCreate(root.id, "dir")} data-testid="files-root-new-dir">
              <FilesIcon name="folderPlus" size={15} />
            </button>
            <button type="button" className="files-root__act" title="Enviar arquivos" aria-label={`Enviar arquivos para ${root.name}`} onClick={() => actions.rootUpload(root.id)} data-testid="files-root-upload">
              <FilesIcon name="upload" size={15} />
            </button>
          </span>
        )}
      </h4>
      {hint && !closed && <p className="files-root__hint">{hint}</p>}
      {root.error && (
        <p className="files-root__error" role="status">
          {root.error}
        </p>
      )}
      {!closed && !root.error && focus && (
        <div className="files-focusbar" data-testid="files-focus-bar">
          <nav className="files-focusbar__path" aria-label="Pasta em foco">
            <button type="button" className="files-focusbar__crumb" onClick={() => store().setFocus(root.id, null)} title="Voltar à raiz" data-testid="files-focus-crumb" data-path="">
              {root.name}
            </button>
            {segments.map((segment, index) => {
              const path = segments.slice(0, index + 1).join("/");
              const last = index === segments.length - 1;
              return (
                <span key={path} className="files-focusbar__item">
                  <span className="files-focusbar__sep" aria-hidden="true">
                    ›
                  </span>
                  <button type="button" className="files-focusbar__crumb" aria-current={last ? "location" : undefined} disabled={last} onClick={() => store().setFocus(root.id, path)} data-testid="files-focus-crumb" data-path={path}>
                    {segment}
                  </button>
                </span>
              );
            })}
          </nav>
          <button type="button" className="files-focusbar__exit" title="Sair do foco" aria-label="Sair do foco" onClick={() => store().setFocus(root.id, null)} data-testid="files-focus-exit">
            <FilesIcon name="exit" size={14} />
          </button>
        </div>
      )}
      {display.map((row) => (
        <RowView key={row.key} row={row} activeKey={activeKey} tabbableKey={tabbableKey} onFileClick={onFileClick} onFileOpen={onFileOpen} />
      ))}
    </section>
  );
}

type SearchState = { query: string; results: Array<FileSearchMatch & { root: string }>; truncated: boolean; loading: boolean };

/** Busca por nome em todas as raízes (uma chamada por raiz, com espera ao digitar). `loading` = o texto já digitado ainda não tem resposta. */
function useFileSearch(query: string, roots: FileRoot[]): SearchState {
  const [state, setState] = useState<Omit<SearchState, "loading">>({ query: "", results: [], truncated: false });
  const term = useDebounced(query.trim(), DEBOUNCE_MS);
  const workspaceId = useNavStore((s) => s.workspaceId);
  // Os ids das raízes que abrem (texto estável: `roots` troca de identidade a cada releitura da árvore).
  const rootIds = roots.filter((root) => !root.error).map((root) => root.id).join("\n");
  useEffect(() => {
    if (!term) return;
    let cancelled = false;
    void Promise.allSettled((rootIds ? rootIds.split("\n") : []).map((id) => api.searchFiles(id, term))).then((settled) => {
      if (cancelled) return;
      const results: SearchState["results"] = [];
      let truncated = false;
      for (const item of settled) {
        if (item.status !== "fulfilled") continue;
        truncated ||= item.value.truncated;
        for (const match of item.value.matches) results.push({ ...match, root: item.value.root });
      }
      setState({ query: term, results, truncated });
    });
    return () => {
      cancelled = true;
    };
  }, [term, workspaceId, rootIds]);
  if (!query.trim()) return { query: "", results: [], truncated: false, loading: false };
  return { ...state, loading: state.query !== query.trim() };
}

function SearchResults({ search, roots, onOpenFile, onClear }: { search: SearchState; roots: FileRoot[]; onOpenFile: () => void; onClear: () => void }) {
  const names = new Map(roots.map((root) => [root.id, root.name]));
  const store = useFilesStore.getState;
  return (
    <div className="files-search-results" role="list" aria-label="Resultados da busca">
      {search.loading && <p className="files-status files-status--loading">Buscando…</p>}
      {!search.loading && search.results.length === 0 && <p className="files-status files-status--empty">Nenhum arquivo com esse nome.</p>}
      {search.results.map((match) => {
        const dir = match.kind === "dir" ? match.path : fileDirOf(match.path);
        return (
          <button
            key={nodeKey(match.root, match.path)}
            type="button"
            role="listitem"
            className="files-search-result"
            title={match.path}
            onClick={() => {
              if (match.kind === "file") {
                store().openFile({ root: match.root, path: match.path }, false);
                void store().reveal(match.root, dir);
                onOpenFile();
              } else {
                void store().reveal(match.root, match.path);
                onClear();
              }
            }}
            data-testid="files-search-result"
            data-path={match.path}
            data-kind={match.kind}
          >
            <FilesIcon name={match.kind === "dir" ? "folder" : "file"} size={15} tone={match.kind === "dir" ? undefined : fileTone(match.name || fileNameOf(match.path))} />
            <span className="files-search-result__text">
              <span className="files-search-result__name">{match.name || fileNameOf(match.path)}</span>
              <span className="files-search-result__path">
                {roots.length > 1 ? `${names.get(match.root) ?? match.root} · ` : ""}
                {match.kind === "dir" ? match.path : dir || "raiz"}
              </span>
            </span>
          </button>
        );
      })}
      {search.truncated && !search.loading && <p className="files-status files-status--empty">Só os primeiros resultados aparecem. Escreva mais do nome para afinar.</p>}
    </div>
  );
}

/** Primeiro foco da árvore e teclado: setas, direita abre, esquerda fecha, Enter abre, F2 renomeia, Delete apaga, tecla de menu abre as ações. */
function treeKeyDown(event: KeyboardEvent<HTMLDivElement>, onFileOpen: () => void, actions: TreeActions): void {
  const current = (event.target as HTMLElement).closest<HTMLElement>('[role="treeitem"]');
  if (!current || event.target !== current) return;
  const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="treeitem"]'));
  const index = items.indexOf(current);
  const focusAt = (target: HTMLElement | undefined) => {
    if (!target) return;
    event.preventDefault();
    target.focus();
  };
  const store = useFilesStore.getState();
  const kind = current.dataset.kind === "dir" ? "dir" : "file";
  const root = current.closest<HTMLElement>("[data-root]")?.dataset.root ?? "";
  const path = current.dataset.path ?? "";
  const locked = current.dataset.locked === "true";
  const expanded = current.getAttribute("aria-expanded");
  const item: ActionItem = { root, path, kind, name: fileNameOf(path), locked };
  const allowed = locked ? [] : menuActions({ kind, name: item.name, locked, writable: actions.writable(root) });
  if (event.key === "ArrowDown") focusAt(items[index + 1]);
  else if (event.key === "ArrowUp") focusAt(items[index - 1]);
  else if (event.key === "Home") focusAt(items[0]);
  else if (event.key === "End") focusAt(items[items.length - 1]);
  else if (event.key === "F2") {
    if (allowed.includes("rename")) {
      event.preventDefault();
      actions.run("rename", item);
    }
  } else if (event.key === "Delete") {
    if (allowed.includes("delete")) {
      event.preventDefault();
      actions.run("delete", item);
    }
  } else if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
    if (allowed.length > 0) {
      event.preventDefault();
      const box = current.getBoundingClientRect();
      actions.openMenu(item, { x: box.left + 24, y: box.bottom }, current);
    }
  } else if (event.key === "ArrowRight") {
    if (kind === "dir" && !locked) {
      event.preventDefault();
      if (expanded === "false") store.setDirOpen(root, path, true);
      else focusAt(items[index + 1]);
    }
  } else if (event.key === "ArrowLeft") {
    if (kind === "dir" && expanded === "true") {
      event.preventDefault();
      store.setDirOpen(root, path, false);
    } else {
      // Sobe para a pasta que contém este item (o nível anterior mais próximo, acima).
      const level = Number(current.getAttribute("aria-level") ?? "1");
      for (let at = index - 1; at >= 0; at -= 1) {
        if (Number(items[at]!.getAttribute("aria-level") ?? "1") < level) {
          focusAt(items[at]);
          break;
        }
      }
    }
  } else if (event.key === "Enter" || event.key === " ") {
    if (locked) return;
    event.preventDefault();
    if (kind === "dir") store.toggleDir(root, path);
    else {
      store.openFile({ root, path }, true);
      onFileOpen();
    }
  }
}

/** Os arquivos soltos de um arraste (pastas ficam de fora: só arquivos sobem). */
function droppedFiles(data: DataTransfer): { files: File[]; skippedFolders: boolean } {
  const items = Array.from(data.items ?? []);
  if (items.length === 0 || typeof items[0]!.webkitGetAsEntry !== "function") return { files: Array.from(data.files), skippedFolders: false };
  const files: File[] = [];
  let skippedFolders = false;
  for (const item of items) {
    if (item.kind !== "file") continue;
    if (item.webkitGetAsEntry()?.isDirectory) {
      skippedFolders = true;
      continue;
    }
    const file = item.getAsFile();
    if (file) files.push(file);
  }
  return { files, skippedFolders };
}

const hasFiles = (event: DragEvent): boolean => Array.from(event.dataTransfer?.types ?? []).includes("Files");

/** O painel de envio, no pé da árvore: "Enviando 2 de 5", nome, porcentagem e Cancelar; no fim, o resumo por uns segundos. */
function UploadPanelView({ upload }: { upload: UploadPanelState }) {
  const running = upload.status === "running";
  const percent = Math.round(upload.fraction * 100);
  return (
    <div className="files-upload" role="status" data-testid="files-upload-panel" data-status={upload.status}>
      {running ? (
        <>
          <div className="files-upload__row">
            <strong>{upload.index > 0 ? `Enviando ${upload.index} de ${upload.total}` : "Preparando o envio…"}</strong>
            <button type="button" className="files-upload__cancel" onClick={() => useFilesStore.getState().cancelUpload()} data-testid="files-upload-cancel">
              Cancelar
            </button>
          </div>
          {upload.name && (
            <div className="files-upload__row files-upload__row--file">
              <span className="files-upload__name" title={upload.name}>
                {upload.name}
              </span>
              <span className="files-upload__pct">{percent}%</span>
            </div>
          )}
          <div className="files-upload__bar" aria-hidden="true">
            <div className="files-upload__fill" style={{ width: `${percent}%` }} />
          </div>
        </>
      ) : (
        <>
          <div className="files-upload__row">
            <strong>{upload.text}</strong>
          </div>
          {upload.notes.length > 0 && (
            <ul className="files-upload__notes">
              {upload.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

/** "Já existe 'x' nesta pasta. Substituir?" com Substituir, Pular e "Fazer o mesmo para os próximos". */
function ReplaceDialog({ name }: { name: string }) {
  const [all, setAll] = useState(false);
  const answer = (action: "replace" | "skip") => useFilesStore.getState().answerReplace({ action, all });
  return (
    <Modal title="Arquivo repetido" onClose={() => useFilesStore.getState().answerReplace({ action: "skip", all: false })} testId="files-replace-dialog">
      <div className="ui-confirm">
        <p>{`Já existe '${name}' nesta pasta. Substituir?`}</p>
        <label className="files-replace__all">
          <input type="checkbox" checked={all} onChange={(event) => setAll(event.target.checked)} data-testid="files-replace-all" />
          Fazer o mesmo para os próximos
        </label>
      </div>
      <div className="ui-actions">
        <button type="button" className="ui-button ui-button--secondary" onClick={() => answer("skip")} data-testid="files-replace-skip" autoFocus>
          Pular
        </button>
        <button type="button" className="ui-button ui-button--danger" onClick={() => answer("replace")} data-testid="files-replace-confirm">
          Substituir
        </button>
      </div>
    </Modal>
  );
}

type Deleting = { item: ActionItem; message: string | null };

/** A coluna da esquerda: busca, atualizar, uma seção por raiz e, no pé, o painel de envio. */
export function FileTree({ onOpenFile }: { onOpenFile: () => void }) {
  const roots = useFilesStore((state) => state.roots);
  const rootsError = useFilesStore((state) => state.rootsError);
  const active = useFilesStore((state) => state.active);
  const upload = useFilesStore((state) => state.upload);
  const [query, setQuery] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [naming, setNaming] = useState<Naming | null>(null);
  const [menu, setMenu] = useState<{ item: ActionItem; x: number; y: number; opener: HTMLElement } | null>(null);
  const [deleting, setDeleting] = useState<Deleting | null>(null);
  const [dropKey, setDropKey] = useState<string | null>(null);
  const pick = useRef<{ root: string; dir: string } | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const treeRef = useRef<HTMLDivElement>(null);
  const list = roots ?? [];
  const search = useFileSearch(query, list);
  const searching = query.trim() !== "";
  const store = useFilesStore.getState;

  // O primeiro nó é o que recebe o Tab (os outros só por seta).
  const [tabbable, setTabbable] = useState<string | null>(null);
  const firstKey = useFilesStore((state) => {
    for (const root of state.roots ?? []) {
      if (root.error || !state.rootsOpen[root.id]) continue;
      const base = state.focus[root.id] ?? "";
      const first = state.dirs[nodeKey(root.id, base)]?.entries[0];
      if (first) return nodeKey(root.id, joinFilePath(base, first.name));
    }
    return null;
  });
  const tabbableKey = tabbable ?? active ?? firstKey;

  const refresh = async () => {
    setRefreshing(true);
    await useFilesStore.getState().refreshTree();
    setRefreshing(false);
  };

  const writable = (rootId: string): boolean => list.some((root) => root.id === rootId && root.writable && !root.error);
  const focusRow = (key: string | null) => {
    if (!key) return;
    window.requestAnimationFrame(() => treeRef.current?.querySelector<HTMLElement>(`[role="treeitem"][data-key="${CSS.escape(key)}"]`)?.focus());
  };

  const startCreate = (root: string, dir: string, kind: "file" | "dir") => {
    const state = store();
    if (!state.rootsOpen[root]) state.toggleRoot(root);
    if (dir !== (state.focus[root] ?? "")) state.setDirOpen(root, dir, true);
    setQuery("");
    setNaming({ mode: kind === "file" ? "create-file" : "create-dir", root, dir });
  };
  const startUpload = (root: string, dir: string) => {
    pick.current = { root, dir };
    picker.current?.click();
  };
  const askDelete = (item: ActionItem) => {
    if (item.kind === "file") {
      setDeleting({ item, message: deleteConfirmText(item.name, "file") });
      return;
    }
    setDeleting({ item, message: null });
    void api
      .countFiles(item.root, item.path)
      .then((count) => deleteConfirmText(item.name, "dir", count))
      .catch(() => deleteConfirmText(item.name, "dir"))
      .then((message) => setDeleting((now) => (now && now.item.path === item.path && now.item.root === item.root ? { item, message } : now)));
  };

  const actions: TreeActions = {
    writable,
    naming,
    dropKey,
    openMenu: (item, at, opener) => setMenu({ item, x: at.x, y: at.y, opener }),
    run: (action, item) => {
      const ref = { root: item.root, path: item.path };
      const root = list.find((candidate) => candidate.id === item.root);
      if (action === "open") {
        store().openFile(ref, true);
        onOpenFile();
      } else if (action === "edit") {
        store().openFile(ref, true);
        onOpenFile();
        void store()
          .startEdit(ref)
          .then((message) => message && store().setNotice({ text: message, tone: "warn" }));
      } else if (action === "new-file") startCreate(item.root, item.path, "file");
      else if (action === "new-dir") startCreate(item.root, item.path, "dir");
      else if (action === "upload") startUpload(item.root, item.path);
      else if (action === "rename") setNaming({ mode: "rename", root: item.root, path: item.path, kind: item.kind });
      else if (action === "delete") askDelete(item);
      else if (action === "download") {
        const link = document.createElement("a");
        link.href = api.fileRawUrl(item.root, item.path, true);
        link.download = item.name;
        link.click();
      } else if (action === "focus") store().setFocus(item.root, item.path);
      else if (action === "copy-path" && root) {
        void copyText(fullPathOf(root, item.path)).then((ok) => store().setNotice({ text: ok ? "Caminho copiado." : "Não deu para copiar o caminho.", tone: ok ? "info" : "warn" }));
      }
    },
    rootCreate: (root, kind) => startCreate(root, store().focus[root] ?? "", kind),
    rootUpload: (root) => startUpload(root, store().focus[root] ?? ""),
    dropProps: ({ root, dir, key }) => ({
      onDragOver: (event) => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        event.stopPropagation();
        const ok = writable(root);
        event.dataTransfer.dropEffect = ok ? "copy" : "none";
        setDropKey(ok ? key : null);
      },
      onDragLeave: (event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setDropKey((now) => (now === key ? null : now));
      },
      onDrop: (event) => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        event.stopPropagation();
        setDropKey(null);
        if (!writable(root)) return;
        const dropped = droppedFiles(event.dataTransfer);
        if (dropped.skippedFolders) store().setNotice({ text: "Pastas não são enviadas, só arquivos.", tone: "warn" });
        void store().uploadFiles(root, dir, dropped.files);
      },
    }),
    submitName: async (target, name) => {
      const result =
        target.mode === "rename"
          ? await store().renamePath(target.root, target.path, joinFilePath(fileDirOf(target.path), name))
          : await store().createItem(target.root, joinFilePath(target.dir, name), target.mode === "create-dir" ? "dir" : "file");
      if (result.ok) {
        setNaming(null);
        return null;
      }
      if (result.conflict) return "Já existe um item com esse nome.";
      if (target.mode === "rename" && result.message.startsWith("Salve ou descarte")) {
        setNaming(null);
        store().setNotice({ text: result.message, tone: "warn" });
        return null;
      }
      return result.message;
    },
    cancelName: (restore) => {
      const was = naming;
      setNaming(null);
      if (restore && was) focusRow(was.mode === "rename" ? nodeKey(was.root, was.path) : was.dir ? nodeKey(was.root, was.dir) : null);
    },
  };

  return (
    <ActionsContext.Provider value={actions}>
      <div
        className="files-tree"
        data-testid="files-tree"
        ref={treeRef}
        onDragOver={(event) => {
          // Soltar fora de uma pasta não faz nada (e o navegador não abre o arquivo no lugar da página).
          if (!hasFiles(event)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "none";
        }}
        onDrop={(event) => {
          if (hasFiles(event)) event.preventDefault();
        }}
      >
        <div className="files-tree__top">
          <label className="files-search">
            <FilesIcon name="search" size={15} />
            <input type="search" placeholder="Buscar arquivo…" aria-label="Buscar arquivo" value={query} maxLength={FILE_LIMITS.searchQuery} onChange={(event) => setQuery(event.target.value)} data-testid="files-search" />
          </label>
          <button type="button" className={`files-refresh${refreshing ? " files-refresh--spin" : ""}`} title="Atualizar a árvore" aria-label="Atualizar a árvore" onClick={() => void refresh()} data-testid="files-refresh">
            <FilesIcon name="refresh" size={15} />
          </button>
        </div>
        <div className="files-tree__scroll">
          {rootsError && !roots && (
            <p className="files-status files-status--error" role="alert">
              Não deu para carregar as pastas: {rootsError}
            </p>
          )}
          {!roots && !rootsError && <p className="files-status files-status--loading">Carregando as pastas…</p>}
          {searching ? (
            <SearchResults search={search} roots={list} onOpenFile={onOpenFile} onClear={() => setQuery("")} />
          ) : (
            <div
              role="tree"
              aria-label="Pastas e arquivos"
              className="files-tree__list"
              onKeyDown={(event) => treeKeyDown(event, onOpenFile, actions)}
              onFocus={(event) => {
                const key = (event.target as HTMLElement).closest<HTMLElement>('[role="treeitem"]')?.dataset.key;
                if (key) setTabbable(key);
              }}
            >
              {list.map((root) => (
                <RootSection key={root.id} root={root} activeKey={active} tabbableKey={tabbableKey} onFileClick={onOpenFile} onFileOpen={onOpenFile} />
              ))}
              {roots && list.length === 0 && <p className="files-status files-status--empty">Este workspace não tem pastas para mostrar.</p>}
            </div>
          )}
        </div>
        {upload && <UploadPanelView upload={upload} />}
        <input
          ref={picker}
          type="file"
          multiple
          hidden
          onChange={(event) => {
            const files = Array.from(event.target.files ?? []);
            event.target.value = "";
            const target = pick.current;
            pick.current = null;
            if (target && files.length > 0) void store().uploadFiles(target.root, target.dir, files);
          }}
          data-testid="files-upload-input"
        />
      </div>
      {menu && (
        <FileMenu
          actions={menuActions({ kind: menu.item.kind, name: menu.item.name, locked: menu.item.locked, writable: writable(menu.item.root) })}
          x={menu.x}
          y={menu.y}
          onSelect={(action) => {
            const item = menu.item;
            setMenu(null);
            actions.run(action, item);
          }}
          onClose={(restore) => {
            const opener = menu.opener;
            setMenu(null);
            if (restore) window.requestAnimationFrame(() => opener.focus());
          }}
        />
      )}
      {deleting?.message && (
        <ConfirmDialog
          title={deleting.item.kind === "dir" ? "Apagar pasta" : "Apagar arquivo"}
          message={<p>{deleting.message}</p>}
          confirmLabel="Apagar"
          pendingLabel="Apagando…"
          testId="files-delete-dialog"
          confirmTestId="files-delete-confirm"
          onConfirm={() => store().deletePath(deleting.item.root, deleting.item.path)}
          onClose={() => setDeleting(null)}
        />
      )}
      {upload?.asking && <ReplaceDialog key={upload.asking} name={upload.asking} />}
    </ActionsContext.Provider>
  );
}
