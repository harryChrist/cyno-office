import { fileDirOf } from "@cyno/shared";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useFilesStore } from "../../store/filesStore";
import { useNavStore } from "../../store/navStore";
import { ConfirmDialog } from "../../ui/widgets";
import { FileTabs } from "./FileTabs";
import { FileTree } from "./FileTree";
import { FileViewer } from "./FileViewer";
import { FilesResizer } from "./FilesResizer";
import { clampTreeWidth, filesSub, parseFilesSub, tabKey } from "./filesView";
import "./files.css";

/** De quanto em quanto tempo as pastas abertas e o arquivo aberto são relidos (ms), enquanto a página está à vista. */
const TREE_REFRESH_MS = 15_000;
const FILE_REFRESH_MS = 4_000;

/** Largura da área das duas colunas (divisória inclusa), para os limites da divisória. */
function useWidth(ref: React.RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(1200);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const measure = () => setWidth(node.clientWidth);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

/**
 * Página "Arquivos": as pastas do workspace para ler e baixar e, nas pastas de trabalho com escrita, editar, criar, enviar, renomear e apagar. Árvore à esquerda, o arquivo aberto à
 * direita, com abas como num editor de código. O arquivo ativo vai no endereço (`#/<ws>/arquivos/<raiz>/<caminho>`).
 * No celular a árvore ocupa a tela; tocar num arquivo abre a visão dele, com "‹ Arquivos" para voltar.
 */
export function FilesPage() {
  const workspaceId = useNavStore((state) => state.workspaceId);
  const sub = useNavStore((state) => state.sub);
  const go = useNavStore((state) => state.go);
  const tabs = useFilesStore((state) => state.tabs);
  const active = useFilesStore((state) => state.active);
  const roots = useFilesStore((state) => state.roots);
  const files = useFilesStore((state) => state.files);
  const savedWidth = useFilesStore((state) => state.width);
  const discard = useFilesStore((state) => state.discard);
  const notice = useFilesStore((state) => state.notice);
  const anyDirty = useFilesStore((state) => state.tabs.some((tab) => state.edits[tabKey(tab)]?.dirty === true));
  const ready = useFilesStore((state) => state.workspaceId === workspaceId);
  const [mobileView, setMobileView] = useState<"tree" | "file">(() => (parseFilesSub(useNavStore.getState().sub) ? "file" : "tree"));
  const [liveWidth, setLiveWidth] = useState<number | null>(null);
  const [resizing, setResizing] = useState(false);
  // Endereço novo com arquivo (voltar do navegador, link): no celular, abre a visão do arquivo.
  const [seenSub, setSeenSub] = useState(sub);
  if (sub !== seenSub) {
    setSeenSub(sub);
    if (parseFilesSub(sub)) setMobileView("file");
  }
  const layout = useRef<HTMLDivElement>(null);
  const available = useWidth(layout);

  // Entra no workspace: lembra o estado dele e, se o endereço traz um arquivo, abre numa aba fixa com a árvore até ele.
  useEffect(() => {
    if (!workspaceId) return;
    void useFilesStore.getState().init(workspaceId);
    const ref = parseFilesSub(useNavStore.getState().sub);
    if (ref) {
      const store = useFilesStore.getState();
      store.openFile(ref, true);
      void store.reveal(ref.root, fileDirOf(ref.path));
    }
  }, [workspaceId]);

  // Endereço mudou por fora (voltar do navegador, link): abre o arquivo dele.
  const firstSub = useRef(true);
  useEffect(() => {
    if (firstSub.current) {
      firstSub.current = false;
      return;
    }
    const ref = parseFilesSub(sub);
    if (!ref) return;
    const store = useFilesStore.getState();
    if (store.active === tabKey(ref)) return;
    store.openFile(ref, true);
    void store.reveal(ref.root, fileDirOf(ref.path));
  }, [sub]);

  // O arquivo ativo vai para o endereço (sem empilhar histórico); sem aba, o endereço volta à página.
  const firstActive = useRef(true);
  useEffect(() => {
    if (firstActive.current) {
      firstActive.current = false;
      return;
    }
    if (!ready) return;
    const tab = useFilesStore.getState().tabs.find((candidate) => tabKey(candidate) === active);
    const wanted = filesSub(tab ?? null);
    if (useNavStore.getState().sub !== wanted) go("arquivos", wanted, true);
  }, [active, ready, go]);

  // Relê sozinho enquanto a página está à vista: as pastas abertas (15 s) e o arquivo da aba ativa (4 s).
  useEffect(() => {
    const visible = () => document.visibilityState !== "hidden";
    const tree = window.setInterval(() => {
      if (visible()) void useFilesStore.getState().refreshTree();
    }, TREE_REFRESH_MS);
    const file = window.setInterval(() => {
      if (!visible()) return;
      const state = useFilesStore.getState();
      const tab = state.tabs.find((candidate) => tabKey(candidate) === state.active);
      if (tab && state.files[tabKey(tab)]?.status === "ready") void state.loadFile(tab, true);
    }, FILE_REFRESH_MS);
    return () => {
      window.clearInterval(tree);
      window.clearInterval(file);
    };
  }, []);

  // Alteração não salva: o navegador avisa antes de fechar ou recarregar a aba.
  useEffect(() => {
    if (!anyDirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [anyDirty]);

  // O aviso de cima (recusas e erros) some sozinho.
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => useFilesStore.getState().setNotice(null), 7000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const width = clampTreeWidth(liveWidth ?? savedWidth, available);
  const onCommit = useCallback((next: number) => {
    setLiveWidth(null);
    useFilesStore.getState().setWidth(next);
  }, []);

  const activeTab = tabs.find((tab) => tabKey(tab) === active);
  const activeRoot = activeTab ? roots?.find((root) => root.id === activeTab.root) : undefined;

  return (
    <section className="page page--files page--fill" aria-labelledby="page-title-files" data-testid="files-page" data-view={activeTab ? mobileView : "tree"} data-resizing={resizing ? "true" : undefined}>
      <header className="page__header page__header--row files-header">
        <div className="page__heading">
          <h2 className="page__title" id="page-title-files">
            Arquivos
          </h2>
          <p className="page__subtitle">As pastas deste workspace. Dá para ler e baixar tudo e, nas pastas de trabalho com escrita, editar, enviar e apagar.</p>
        </div>
      </header>
      {notice && (
        <p className={`files-notice files-notice--${notice.tone}`} role="status" data-testid="files-notice">
          <span>{notice.text}</span>
          <button type="button" className="files-notice__close" aria-label="Fechar o aviso" onClick={() => useFilesStore.getState().setNotice(null)}>
            ×
          </button>
        </p>
      )}
      <div className="files-layout" ref={layout} style={{ ["--files-tree-w" as string]: `${width}px` }}>
        <aside className="files-side" aria-label="Pastas">
          <FileTree onOpenFile={() => setMobileView("file")} />
        </aside>
        <FilesResizer width={width} available={available} onChange={setLiveWidth} onCommit={onCommit} onDragging={setResizing} />
        <div className="files-main">
          {activeTab ? (
            <>
              <FileTabs onBack={() => setMobileView("tree")} />
              <FileViewer key={tabKey(activeTab)} tab={activeTab} root={activeRoot} state={files[tabKey(activeTab)]} onReveal={() => setMobileView("tree")} />
            </>
          ) : (
            <div className="files-none" data-testid="files-empty">
              <button type="button" className="files-back files-back--solo" onClick={() => setMobileView("tree")} data-testid="files-back">
                ‹ Arquivos
              </button>
              <p>Escolha um arquivo na árvore para abrir.</p>
            </div>
          )}
        </div>
      </div>
      {discard && (
        <ConfirmDialog
          title="Descartar alterações?"
          message={<p>{discard.message}</p>}
          confirmLabel="Descartar"
          pendingLabel="Descartando…"
          testId="files-discard-dialog"
          confirmTestId="files-discard-confirm"
          onConfirm={async () => useFilesStore.getState().confirmDiscard()}
          onClose={() => useFilesStore.getState().dismissDiscard()}
        />
      )}
    </section>
  );
}
