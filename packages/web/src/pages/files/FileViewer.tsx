import { fileNameOf, fileSegments, fileSizeLabel, type FileRoot } from "@cyno/shared";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api } from "../../api/client";
import { useFilesStore, type FileState } from "../../store/filesStore";
import { copyText } from "../../ui/clipboard";
import { Markdown } from "../../ui/markdown/Markdown";
import { Modal } from "../../ui/widgets";
import { FileEditor } from "./FileEditor";
import { FilesIcon } from "./filesIcons";
import { fullPathOf, isHighlightableJson, jsonRuns, kindLabel, lineNumbers, modifiedAgo, tabKey, type CodeRun, type FileTab } from "./filesView";
import { canHighlight, highlightRuns } from "./highlight";

const UPDATED_VISIBLE_MS = 4000;
const SAVED_VISIBLE_MS = 3000;
const NO_WIKI = () => null;

/** Onde cada aba estava rolada (por chave da aba), para voltar ao mesmo ponto ao trocar de aba. Vale enquanto a página está aberta. */
const scrollMemory = new Map<string, number>();
const SCROLL_MEMORY_MAX = 60;

/** Relógio de meio minuto, para o "modificado há X" andar. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

/** O texto com número de linha: dois `<pre>` (números e texto), nunca um elemento por linha. */
function CodeBlock({ name, text, wrap }: { name: string; text: string; wrap: boolean }) {
  const numbers = useMemo(() => lineNumbers(text), [text]);
  const json = useMemo(() => (isHighlightableJson(name, text) ? jsonRuns(text) : null), [name, text]);
  // As outras linguagens: o texto aparece na hora, sem cor, e ganha cor quando o realçador responde.
  const [colored, setColored] = useState<{ name: string; text: string; runs: CodeRun[] } | null>(null);
  useEffect(() => {
    if (json || !canHighlight(name, text)) return;
    let alive = true;
    void highlightRuns(name, text).then((result) => {
      if (alive && result) setColored({ name, text, runs: result });
    });
    return () => {
      alive = false;
    };
  }, [json, name, text]);
  const runs = json ?? (colored && colored.name === name && colored.text === text ? colored.runs : null);
  return (
    <div className={`files-code${wrap ? " files-code--wrap" : ""}`} data-testid="files-code" data-colored={runs ? "true" : "false"}>
      {!wrap && (
        <pre className="files-code__nums" aria-hidden="true">
          {numbers}
        </pre>
      )}
      <pre className="files-code__text">
        {runs ? runs.map((run, index) => (run.kind ? <span key={index} className={`files-tok files-tok--${run.kind}`}>{run.text}</span> : run.text)) : text}
      </pre>
    </div>
  );
}

function ImageBlock({ root, path, version }: { root: string; path: string; version: string }) {
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  return (
    <div className="files-image" data-testid="files-image">
      <div className="files-image__stage">
        {/* A versão no endereço faz a imagem que mudou no disco ser buscada de novo. */}
        <img src={`${api.fileRawUrl(root, path)}&v=${encodeURIComponent(version)}`} alt={fileNameOf(path)} onLoad={(event) => setSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })} />
      </div>
      {size && (
        <p className="files-image__size">
          {size.width} × {size.height} px
        </p>
      )}
    </div>
  );
}

function Download({ root, path, className, testId = "files-download" }: { root: string; path: string; className?: string; testId?: string }) {
  return (
    <a className={className ?? "files-btn files-btn--primary"} href={api.fileRawUrl(root, path, true)} download={fileNameOf(path)} data-testid={testId}>
      Baixar
    </a>
  );
}

/** O arquivo da aba ativa (a página o recria a cada arquivo, então "texto puro" e "quebrar linhas" voltam ao padrão): barra (caminho, tipo, tamanho, ações) e conteúdo conforme o tipo. */
export function FileViewer({ tab, root, state, onReveal }: { tab: FileTab; root: FileRoot | undefined; state: FileState | undefined; onReveal: () => void }) {
  const now = useNow();
  const [raw, setRaw] = useState(false);
  const [wrap, setWrap] = useState(false);
  const [copied, setCopied] = useState(false);
  const [hiddenFor, setHiddenFor] = useState(0);
  const [savedHiddenFor, setSavedHiddenFor] = useState(0);
  const [editError, setEditError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const moreId = useId();
  const btnsRef = useRef<HTMLDivElement>(null);
  const crumbsRef = useRef<HTMLElement>(null);
  const store = useFilesStore.getState;
  const data = state?.data;
  const view = data?.view;
  const key = tabKey(tab);
  const session = useFilesStore((current) => current.edits[key]);
  const editing = session !== undefined && data !== undefined;

  // Rolagem por aba: ao sair da aba guarda onde estava; ao voltar, com o conteúdo já na tela, retoma dali.
  const bodyRef = useRef<HTMLDivElement>(null);
  const ready = data !== undefined;
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body || !ready) return;
    const saved = scrollMemory.get(key);
    if (saved) body.scrollTop = saved;
    return () => {
      scrollMemory.delete(key);
      scrollMemory.set(key, body.scrollTop);
      if (scrollMemory.size > SCROLL_MEMORY_MAX) scrollMemory.delete(scrollMemory.keys().next().value as string);
    };
  }, [key, ready]);

  // "Mais ações" (só no celular): fecha ao tocar fora e com Esc.
  useEffect(() => {
    if (!moreOpen) return;
    const onDown = (event: PointerEvent) => {
      if (!btnsRef.current?.contains(event.target as Node)) setMoreOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMoreOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [moreOpen]);

  // No celular o caminho fica numa linha só que rola: começa mostrando o fim, onde está o nome do arquivo.
  useLayoutEffect(() => {
    const crumbs = crumbsRef.current;
    if (crumbs) crumbs.scrollLeft = crumbs.scrollWidth;
  }, [key]);

  // "Atualizado agora": aparece uns segundos depois de uma releitura ao vivo que trouxe mudança.
  const updatedAt = state?.updatedAt;
  useEffect(() => {
    if (!updatedAt) return;
    const timer = window.setTimeout(() => setHiddenFor(updatedAt), UPDATED_VISIBLE_MS);
    return () => window.clearTimeout(timer);
  }, [updatedAt]);
  const updatedShown = updatedAt !== undefined && hiddenFor !== updatedAt;
  const savedAt = state?.savedAt;
  useEffect(() => {
    if (!savedAt) return;
    const timer = window.setTimeout(() => setSavedHiddenFor(savedAt), SAVED_VISIBLE_MS);
    return () => window.clearTimeout(timer);
  }, [savedAt]);
  const savedShown = savedAt !== undefined && savedHiddenFor !== savedAt && !editing;

  const ref = { root: tab.root, path: tab.path };
  const canEdit = root?.writable === true && (view === "markdown" || view === "text") && !editing;
  const startEdit = async () => {
    setEditError(null);
    setBusy(true);
    const message = await store().startEdit(ref);
    setBusy(false);
    if (message) setEditError(message);
  };
  const save = async (overwrite = false) => {
    if (!session || session.saving) return;
    setEditError(null);
    const result = await store().saveEdit(ref, overwrite);
    if (result.ok) return;
    if (result.conflict) setConflict(true);
    else setEditError(result.message);
  };
  const reload = async () => {
    setConflict(false);
    const message = await store().reloadEdit(ref);
    if (message) setEditError(message);
  };

  const segments = fileSegments(tab.path);
  const isMarkdown = view === "markdown";
  const isTextual = view === "markdown" || view === "text";
  const showRawText = view === "text" || (isMarkdown && raw) || editing;
  const modified = data ? modifiedAgo(data.mtime, now) : "";

  const crumb = (
    <nav className="files-crumbs" aria-label="Caminho do arquivo" ref={crumbsRef}>
      <button type="button" className="files-crumb" onClick={() => { void store().reveal(tab.root, ""); store().setFocus(tab.root, null); onReveal(); }} title="Mostrar a raiz na árvore" data-testid="files-crumb" data-path="">
        {root?.name ?? tab.root}
      </button>
      {segments.map((segment, index) => {
        const path = segments.slice(0, index + 1).join("/");
        const last = index === segments.length - 1;
        return (
          <span key={path} className="files-crumbs__item">
            <span className="files-crumbs__sep" aria-hidden="true">›</span>
            {last ? (
              <span className="files-crumb files-crumb--file" aria-current="page" data-testid="files-crumb" data-path={path}>
                {segment}
              </span>
            ) : (
              <button type="button" className="files-crumb" onClick={() => { void store().reveal(tab.root, path); onReveal(); }} title="Mostrar esta pasta na árvore" data-testid="files-crumb" data-path={path}>
                {segment}
              </button>
            )}
          </span>
        );
      })}
    </nav>
  );

  let body;
  if (editing && session) body = <FileEditor key={key} editKey={key} session={session} wrap={wrap} onSave={() => void save()} />;
  else if (!state || state.status === "loading") body = <p className="files-note">Abrindo o arquivo…</p>;
  else if (state.status === "error" || !data) {
    body = (
      <div className="files-error" role="alert" data-testid="files-error">
        <p>{state?.error ?? "Não deu para abrir o arquivo."}</p>
        <button type="button" className="files-btn" onClick={() => store().closeTab(key)}>
          Fechar a aba
        </button>
      </div>
    );
  } else if (data.view === "locked") {
    body = (
      <div className="files-empty files-empty--locked" data-testid="files-locked">
        <FilesIcon name="lock" size={28} />
        <p>Este arquivo é protegido e não abre por aqui.</p>
      </div>
    );
  } else if (data.view === "binary") {
    body = (
      <div className="files-empty" data-testid="files-binary">
        <FilesIcon name="file" size={28} />
        <p>Este tipo de arquivo não tem prévia.</p>
        <Download root={tab.root} path={tab.path} testId="files-download-empty" />
      </div>
    );
  } else if (data.view === "image") body = <ImageBlock root={tab.root} path={tab.path} version={data.version} />;
  else if (isMarkdown && !raw) body = <Markdown source={data.text ?? ""} resolveWiki={NO_WIKI} plainLinks className="files-md" testId="files-markdown" />;
  else body = <CodeBlock name={data.name} text={data.text ?? ""} wrap={wrap} />;

  return (
    <section className="files-viewer" aria-label={`Arquivo ${fileNameOf(tab.path)}`} data-testid="files-viewer" data-view={view ?? (state?.status === "error" ? "error" : "loading")} data-editing={editing ? "true" : "false"}>
      <header className="files-bar">
        <div className="files-bar__path">{crumb}</div>
        <div className={`files-bar__meta${(editing && session?.dirty) || savedShown || (updatedShown && !editing) ? " files-bar__meta--status" : ""}`}>
          {data && (
            <span className="files-meta">
              {kindLabel(data.name, data.view)} · {fileSizeLabel(data.size)}
              {modified ? ` · ${modified}` : ""}
            </span>
          )}
          {editing && session?.dirty && (
            <span className="files-dirty" role="status" data-testid="files-dirty">
              Alterações não salvas
            </span>
          )}
          {savedShown && (
            <span className="files-saved" role="status" data-testid="files-saved">
              Salvo
            </span>
          )}
          {updatedShown && !editing && (
            <span className="files-updated" role="status" data-testid="files-updated">
              Atualizado agora
            </span>
          )}
        </div>
        <div className="files-bar__btns" ref={btnsRef}>
          {editing && session && (
            <>
              <button type="button" className="files-btn files-btn--primary" disabled={!session.dirty || session.saving} onClick={() => void save()} data-testid="files-save">
                {session.saving ? "Salvando…" : "Salvar"}
              </button>
              <button type="button" className="files-btn" onClick={() => store().requestCancelEdit(key)} data-testid="files-cancel-edit">
                Cancelar
              </button>
            </>
          )}
          {/* No computador estes botões ficam na barra; no celular viram a lista do botão "Mais ações". */}
          <div id={moreId} className={`files-bar__more${moreOpen ? " files-bar__more--open" : ""}`} data-testid="files-more">
            {isMarkdown && !editing && (
              <button
                type="button"
                className="files-btn"
                aria-pressed={raw}
                onClick={() => {
                  setRaw((value) => !value);
                  setMoreOpen(false);
                }}
                data-testid="files-raw-toggle"
              >
                {raw ? "Ver formatado" : "Ver texto puro"}
              </button>
            )}
            {showRawText && (
              <button
                type="button"
                className="files-btn"
                aria-pressed={wrap}
                onClick={() => {
                  setWrap((value) => !value);
                  setMoreOpen(false);
                }}
                data-testid="files-wrap-toggle"
              >
                Quebrar linhas
              </button>
            )}
            <button
              type="button"
              className="files-btn"
              disabled={!root}
              onClick={() => {
                if (!root) return;
                void copyText(fullPathOf(root, tab.path)).then((ok) => {
                  setCopied(ok);
                  window.setTimeout(() => setMoreOpen(false), 700);
                  window.setTimeout(() => setCopied(false), 1800);
                });
              }}
              data-testid="files-copy-path"
            >
              {copied ? "Copiado" : "Copiar caminho"}
            </button>
            {editing && data?.view !== "locked" && (
              <span className="files-bar__dl" onClick={() => setMoreOpen(false)}>
                <Download root={tab.root} path={tab.path} className="files-btn" />
              </span>
            )}
          </div>
          {canEdit && (
            <button type="button" className="files-btn" disabled={busy} onClick={() => void startEdit()} data-testid="files-edit">
              Editar
            </button>
          )}
          {!editing && data?.view !== "locked" && <Download root={tab.root} path={tab.path} className="files-btn files-btn--primary" />}
          <button type="button" className="files-btn files-bar__toggle" aria-label="Mais ações" aria-haspopup="true" aria-expanded={moreOpen} aria-controls={moreId} onClick={() => setMoreOpen((value) => !value)} data-testid="files-more-toggle">
            <FilesIcon name="more" size={18} />
          </button>
        </div>
      </header>
      {editing && session?.diskChanged && (
        <div className="files-warn files-warn--row" role="alert" data-testid="files-disk-changed">
          <span>Este arquivo mudou no disco enquanto você editava.</span>
          <span className="files-warn__btns">
            <button type="button" className="files-btn" onClick={() => void reload()}>
              Recarregar e perder minhas alterações
            </button>
            <button type="button" className="files-btn" onClick={() => store().keepEditing(key)}>
              Continuar editando
            </button>
          </span>
        </div>
      )}
      {editError && (
        <p className="files-warn" role="alert" data-testid="files-edit-error">
          {editError}
        </p>
      )}
      {data?.truncated && isTextual && !editing && (
        <p className="files-warn" role="status" data-testid="files-truncated">
          Mostrando os primeiros 512 KB. Baixe para ver o arquivo inteiro.
        </p>
      )}
      <div className={`files-body${editing ? " files-body--edit" : ""}`} ref={bodyRef} data-testid="files-body">
        {body}
      </div>
      {conflict && (
        <Modal title="O arquivo mudou no disco" onClose={() => setConflict(false)} testId="files-conflict-dialog">
          <div className="ui-confirm">
            <p>O arquivo mudou no disco depois que você abriu.</p>
          </div>
          <div className="ui-actions">
            <button type="button" className="ui-button ui-button--secondary" onClick={() => setConflict(false)} autoFocus>
              Cancelar
            </button>
            <button type="button" className="ui-button ui-button--secondary" onClick={() => void reload()} data-testid="files-conflict-reload">
              Recarregar e perder minhas alterações
            </button>
            <button
              type="button"
              className="ui-button ui-button--danger"
              onClick={() => {
                setConflict(false);
                void save(true);
              }}
              data-testid="files-conflict-overwrite"
            >
              Salvar por cima
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}
