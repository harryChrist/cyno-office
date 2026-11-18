import type { Board, BoardKitExportFormat } from "@cyno/shared";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api } from "../../api/client";
import { useBoardStore } from "../../store/boardStore";
import { useNavStore } from "../../store/navStore";
import { useOfficeStore } from "../../store/officeStore";
import { BotaoTelaCheia } from "../../ui/BotaoTelaCheia";
import { useTelaCheia } from "../../ui/useTelaCheia";
import { ConfirmDialog } from "../../ui/widgets";
import { QuadroExample, QuadroEmpty } from "./QuadroEmpty";
import { QuadroFrame, type QuadroFrameHandle } from "./QuadroFrame";
import { QuadroHome } from "./QuadroHome";
import { QuadroPicker } from "./QuadroPicker";
import { DownloadMenu, QIcon, RenameDialog, ShareDialog, useNow } from "./QuadroParts";
import { authorLabel, boardIdFromSub, dataAgeLabel, deleteMessage, resolveRoute, type ExampleId } from "./quadroView";
import { useBoardContent } from "./useBoardContent";
import "./quadro.css";

/** Página "Quadro": os dados que os agentes montam para o dono olhar, cada quadro numa página própria dentro de um iframe isolado. */
export function QuadroPage() {
  // Trocar de workspace recomeça a página (a lista de abas e o quadro aberto eram do anterior).
  const workspaceId = useNavStore((state) => state.workspaceId);
  return (
    <section className="page page--fill quadro" aria-labelledby="quadro-title" data-testid="page-quadro">
      <h1 className="sr-only" id="quadro-title">
        Quadro
      </h1>
      <QuadroView key={workspaceId ?? ""} />
    </section>
  );
}

function QuadroView() {
  const boards = useBoardStore((state) => state.boards);
  const error = useBoardStore((state) => state.error);
  const sub = useNavStore((state) => state.sub);
  const go = useNavStore((state) => state.go);
  const [example, setExample] = useState<ExampleId | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Quadros já vistos abertos (id e título): se o aberto some da lista, foi apagado (e não é um endereço que nunca existiu).
  const seen = useRef(new Map<string, string>());

  useEffect(() => {
    useBoardStore.getState().ensureLoaded();
  }, []);

  const raw = sub.split("?")[0]?.split("/")[0] ?? "";
  const route = boards ? resolveRoute(boards, boardIdFromSub(sub) ?? (raw || null)) : null;

  const openId = route?.kind === "board" ? route.board.id : null;
  const openTitle = route?.kind === "board" ? route.board.title : "";
  const missingId = route?.kind === "missing" ? route.id : null;
  useEffect(() => {
    if (openId) seen.current.set(openId, openTitle);
  }, [openId, openTitle]);
  // Layout effect: a volta para a tela inicial acontece antes de pintar (sem piscar o aviso de "não existe").
  useLayoutEffect(() => {
    if (!missingId || !seen.current.has(missingId)) return;
    // O quadro aberto foi apagado: volta para a tela inicial com um aviso curto.
    const title = seen.current.get(missingId);
    seen.current.delete(missingId);
    setNotice(`O quadro “${title}” foi apagado.`);
    go("quadro", "", true);
  }, [missingId, go]);

  if (boards === null || route === null) {
    return error ? (
      <div className="quadro-state" role="alert" data-testid="quadro-error">
        <p>Não deu para carregar os quadros: {error}</p>
        <button type="button" className="ui-button ui-button--secondary" onClick={() => void useBoardStore.getState().load()}>
          Tentar de novo
        </button>
      </div>
    ) : (
      <div className="quadro-state" role="status" data-testid="quadro-loading-list">
        <span className="quadro-spinner" aria-hidden="true" />
        Carregando os quadros…
      </div>
    );
  }

  if (boards.length === 0 && route.kind !== "missing") {
    return example ? <QuadroExample id={example} onBack={() => setExample(null)} /> : <QuadroEmpty onOpenExample={setExample} />;
  }

  if (route.kind === "home") return <QuadroHome boards={boards} notice={notice} onDismissNotice={() => setNotice(null)} />;

  if (route.kind === "missing") {
    return (
      <div className="quadro-state" role="alert" data-testid="quadro-missing">
        <p>Este quadro não existe (ou já foi apagado): {route.id}.</p>
        <button type="button" className="ui-button ui-button--secondary" onClick={() => go("quadro")} data-testid="quadro-missing-back">
          Voltar para os quadros
        </button>
      </div>
    );
  }

  return <BoardView key={route.board.id} board={route.board} boards={boards} />;
}

/** Um quadro aberto: cabeçalho compacto e o iframe ocupando o resto. */
function BoardView({ board, boards }: { board: Board; boards: readonly Board[] }) {
  const go = useNavStore((state) => state.go);
  const { content, reload } = useBoardContent(board);
  const now = useNow();
  const agents = useOfficeStore((state) => state.office?.agents);
  const stageRef = useRef<HTMLDivElement>(null);
  const full = useTelaCheia({ classeNaRaiz: "is-quadro-cheio", focoAoSair: () => stageRef.current?.querySelector<HTMLElement>("[data-testid=quadro-fullscreen]") ?? null });
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [sharing, setSharing] = useState(false);
  // Ao abrir a confirmação de apagar, vê se o quadro está compartilhado (para avisar que o link para de funcionar).
  const [deleteShared, setDeleteShared] = useState(false);
  const frameRef = useRef<QuadroFrameHandle>(null);
  const exportAs = useCallback(
    (format: BoardKitExportFormat) => (frameRef.current ? frameRef.current.exportAs(format) : Promise.reject(new Error("O quadro ainda está abrindo. Tente de novo em instantes."))),
    [],
  );
  const downloadSource = content.status === "ready" ? { html: content.html, data: content.payload.data } : null;
  const askDelete = () => {
    setDeleteShared(false);
    setDeleting(true);
    api.getBoardShare(board.id).then(
      (state) => setDeleteShared(state.shared),
      () => undefined,
    );
  };

  return (
    <div className="quadro-view" data-testid="quadro-view" data-board={board.id}>
      <header className="quadro-head">
        <div className="quadro-head__text">
          <div className="quadro-head__line">
            <button type="button" className="quadro-back" onClick={() => go("quadro")} data-testid="quadro-back">
              <QIcon name="back" />
              Quadros
            </button>
            <h2 className="quadro-head__title">
              <QuadroPicker boards={boards} current={board} onPick={(id) => go("quadro", id)} />
            </h2>
            <div className="quadro-head__actions">
              <button type="button" className="ui-icon-button" onClick={reload} aria-label="Recarregar o quadro" title="Recarregar" data-testid="quadro-reload">
                <QIcon name="refresh" />
              </button>
              <button type="button" className="ui-icon-button" onClick={() => setSharing(true)} aria-label="Compartilhar o quadro" title="Compartilhar" data-testid="quadro-share">
                <QIcon name="share" />
              </button>
              <DownloadMenu board={board} source={downloadSource} exportAs={content.status === "ready" ? exportAs : null} />
              <button type="button" className="ui-icon-button" onClick={() => setRenaming(true)} aria-label="Renomear o quadro" title="Renomear" data-testid="quadro-rename">
                <QIcon name="edit" />
              </button>
              <BotaoTelaCheia ativa={full.ativa} onClick={() => void full.alternar()} className="ui-icon-button" testId="quadro-fullscreen" />
              <button type="button" className="ui-icon-button quadro-head__danger" onClick={askDelete} aria-label="Apagar o quadro" title="Apagar" data-testid="quadro-delete">
                <QIcon name="trash" />
              </button>
            </div>
          </div>
          {board.description && (
            <p className="quadro-head__desc" data-testid="quadro-description">
              {board.description}
            </p>
          )}
          <div className="quadro-head__meta">
            <span data-testid="quadro-age">{dataAgeLabel(board, now)}</span>
            <span className="quadro-head__dot" aria-hidden="true">
              ·
            </span>
            <span>{authorLabel(board.createdBy, agents ?? [])}</span>
            {board.source && (
              <>
                <span className="quadro-head__dot" aria-hidden="true">
                  ·
                </span>
                <details className="quadro-how" data-testid="quadro-how">
                  <summary title="Como os dados deste quadro são atualizados">
                    <QIcon name="info" />
                    Como é atualizado
                  </summary>
                  <p className="quadro-how__body">{board.source}</p>
                </details>
              </>
            )}
          </div>
        </div>
      </header>
      <div ref={stageRef} className={`quadro-stage${full.ativa ? " quadro-stage--full" : ""}`} data-testid="quadro-stage">
        {full.ativa && (
          <div className="quadro-stage__bar">
            <span className="quadro-stage__name">{board.title}</span>
            <BotaoTelaCheia ativa onClick={() => void full.alternar()} className="ui-icon-button" testId="quadro-fullscreen-exit" />
          </div>
        )}
        {content.status === "loading" && (
          <div className="quadro-state" role="status" data-testid="quadro-loading">
            <span className="quadro-spinner" aria-hidden="true" />
            Abrindo o quadro…
          </div>
        )}
        {content.status === "error" && (
          <div className="quadro-state" role="alert" data-testid="quadro-content-error">
            <p>Não deu para abrir este quadro: {content.message}</p>
            <button type="button" className="ui-button ui-button--secondary" onClick={reload}>
              Tentar de novo
            </button>
          </div>
        )}
        {content.status === "ready" && <QuadroFrame ref={frameRef} key={content.nonce} title={`Quadro: ${board.title}`} doc={content.doc} payload={content.payload} />}
      </div>
      {renaming && <RenameDialog board={board} onSubmit={(body) => useBoardStore.getState().rename(board.id, body)} onClose={() => setRenaming(false)} />}
      {sharing && <ShareDialog board={board} onClose={() => setSharing(false)} />}
      {deleting && (
        <ConfirmDialog
          title="Apagar o quadro"
          message={<p>{deleteMessage(board.title, deleteShared)}</p>}
          confirmLabel="Apagar o quadro"
          pendingLabel="Apagando…"
          onConfirm={() => useBoardStore.getState().remove(board.id)}
          onClose={() => setDeleting(false)}
          testId="quadro-delete-dialog"
        />
      )}
    </div>
  );
}
