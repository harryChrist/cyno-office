import type { Board } from "@cyno/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, describeError } from "../../api/client";
import { useBoardStore } from "../../store/boardStore";
import { makeDoc, type FramePayload } from "./QuadroFrame";
import { liveAction } from "./quadroView";

export type BoardContent =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; html: string; doc: string; payload: FramePayload; nonce: number };

/**
 * Busca a página e os dados do quadro e acompanha o ao vivo: `board:upserted` com página recarrega o iframe,
 * só com dados manda os dados novos por postMessage (o iframe não recarrega), só com detalhes não mexe no conteúdo.
 */
export function useBoardContent(board: Board): { content: BoardContent; reload: () => void } {
  const id = board.id;
  const boardRef = useRef(board);
  useEffect(() => {
    boardRef.current = board;
  });
  const [content, setContent] = useState<BoardContent>({ status: "loading" });
  const [reloadKey, setReloadKey] = useState(0);
  const nonce = useRef(0);

  // Carrega (e recarrega) a página e os dados. Recarregar mantém o quadro à vista até o novo chegar.
  useEffect(() => {
    let cancelled = false;
    void Promise.all([api.boardPage(id), api.boardData(id)]).then(
      ([html, data]) => {
        if (cancelled) return;
        const payload: FramePayload = { data, meta: boardRef.current };
        nonce.current += 1;
        setContent({ status: "ready", html, doc: makeDoc(html, payload), payload, nonce: nonce.current });
      },
      (error: unknown) => {
        if (!cancelled) setContent((current) => (current.status === "ready" ? current : { status: "error", message: describeError(error) }));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [id, reloadKey]);

  // Ao vivo: só os avisos que chegam depois de abrir este quadro (a loja avisa por assinatura, sem estado extra).
  useEffect(() => {
    let handled = useBoardStore.getState().signal?.seq ?? 0;
    let cancelled = false;
    const unsubscribe = useBoardStore.subscribe((state) => {
      const signal = state.signal;
      if (!signal || signal.id !== id || signal.seq <= handled) return;
      handled = signal.seq;
      const action = liveAction(signal.changed);
      if (action === "reload") setReloadKey((key) => key + 1);
      else if (action === "data") {
        void api.boardData(id).then(
          (data) => {
            if (cancelled) return;
            setContent((current) => (current.status === "ready" ? { ...current, payload: { data, meta: signal.board } } : current));
          },
          () => undefined,
        );
      }
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [id]);

  const reload = useCallback(() => {
    setContent((current) => (current.status === "ready" ? current : { status: "loading" }));
    setReloadKey((key) => key + 1);
  }, []);

  return { content, reload };
}
