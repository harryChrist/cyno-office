import { buildBoardDocument, type BoardMeta } from "@cyno/shared";
import { useEffect, useRef, useState } from "react";
import { parseFrameMessage } from "./quadroView";

/** O que o iframe recebe por postMessage quando os dados mudam (sem recarregar a página do quadro). */
export type FramePayload = { data: unknown; meta: BoardMeta };

/** Monta o documento do iframe (a página do agente dentro do kit). */
export const makeDoc = (html: string, payload: FramePayload): string => buildBoardDocument({ html, data: payload.data, meta: payload.meta });

/**
 * O quadro num iframe isolado (`sandbox="allow-scripts"`, sem `allow-same-origin`): rola por dentro e ocupa a área toda.
 * `doc` só muda quando a página muda (recarrega); `payload` mudando manda dados novos por postMessage.
 * Quem usa põe `key` para recomeçar o estado (carregando, aviso de erro) quando a página recarrega.
 */
export function QuadroFrame({ title, doc, payload, testId = "quadro-frame" }: { title: string; doc: string; payload: FramePayload; testId?: string }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [loaded, setLoaded] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (!ref.current || event.source !== ref.current.contentWindow) return;
      const message = parseFrameMessage(event.data);
      if (!message) return;
      if (message.type === "ready") {
        setReady(true);
        setLoaded(true);
      } else if (message.type === "error") setError(message.message);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  // Dados novos (e, quando a página acaba de carregar, os mais recentes): sem recarregar o iframe.
  useEffect(() => {
    if (!ready) return;
    ref.current?.contentWindow?.postMessage({ type: "quadro:data", data: payload.data, meta: payload.meta }, "*");
  }, [ready, payload]);

  return (
    <div className="quadro-frame" data-testid={`${testId}-box`}>
      <iframe ref={ref} className="quadro-frame__iframe" title={title} sandbox="allow-scripts" srcDoc={doc} onLoad={() => setLoaded(true)} data-testid={testId} data-ready={ready ? "true" : "false"} />
      {!loaded && (
        <div className="quadro-frame__loading" role="status" data-testid="quadro-loading">
          <span className="quadro-spinner" aria-hidden="true" />
          Abrindo o quadro…
        </div>
      )}
      {error && (
        <div className="quadro-frame__warn" role="alert" data-testid="quadro-script-error">
          <span className="quadro-frame__warn-text">
            <strong>A página deste quadro tem um erro.</strong> Mensagem: &ldquo;{error.replace(/[.\s]+$/, "")}&rdquo;. Os dados continuam aqui; peça ao agente para corrigir a página.
          </span>
          <button type="button" className="ui-icon-button" onClick={() => setError(null)} aria-label="Dispensar aviso" data-testid="quadro-script-error-close">
            ×
          </button>
        </div>
      )}
    </div>
  );
}
