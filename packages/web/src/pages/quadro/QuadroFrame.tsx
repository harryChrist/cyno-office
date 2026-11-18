import { buildBoardDocument, type BoardKitExportFormat, type BoardMeta } from "@cyno/shared";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { parseFrameMessage } from "./quadroView";

/** O que o iframe recebe por postMessage quando os dados mudam (sem recarregar a página do quadro). */
export type FramePayload = { data: unknown; meta: BoardMeta };

/** Monta o documento do iframe (a página do agente dentro do kit). */
export const makeDoc = (html: string, payload: FramePayload): string => buildBoardDocument({ html, data: payload.data, meta: payload.meta });

/** Prazo para o kit dentro do iframe responder a um pedido de exportação (um quadro com kit antigo nunca responde). */
export const EXPORT_TIMEOUT_MS = 8000;

/** O que a página-mãe pode pedir ao quadro aberto: exportar em Markdown ou CSV (o texto vem do kit, dentro do iframe). */
export type QuadroFrameHandle = { exportAs: (format: BoardKitExportFormat) => Promise<string> };

type PendingExport = { resolve: (text: string) => void; reject: (error: Error) => void; timer: number };

/**
 * O quadro num iframe isolado (`sandbox="allow-scripts"`, sem `allow-same-origin`): rola por dentro e ocupa a área toda.
 * `doc` só muda quando a página muda (recarrega); `payload` mudando manda dados novos por postMessage.
 * Quem usa põe `key` para recomeçar o estado (carregando, aviso de erro) quando a página recarrega.
 */
export const QuadroFrame = forwardRef<QuadroFrameHandle, { title: string; doc: string; payload: FramePayload; testId?: string }>(function QuadroFrame({ title, doc, payload, testId = "quadro-frame" }, handle) {
  const ref = useRef<HTMLIFrameElement>(null);
  const pending = useRef(new Map<string, PendingExport>());
  const counter = useRef(0);
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
      else if (message.type === "export-result") {
        const request = pending.current.get(message.result.requestId);
        if (!request) return;
        pending.current.delete(message.result.requestId);
        window.clearTimeout(request.timer);
        if (message.result.ok) request.resolve(message.result.text);
        else request.reject(new Error(message.result.error));
      }
    };
    window.addEventListener("message", onMessage);
    const requests = pending.current;
    return () => {
      window.removeEventListener("message", onMessage);
      for (const request of requests.values()) {
        window.clearTimeout(request.timer);
        request.reject(new Error("O quadro foi recarregado. Tente de novo."));
      }
      requests.clear();
    };
  }, []);

  useImperativeHandle(handle, () => ({
    exportAs: (format) =>
      new Promise<string>((resolve, reject) => {
        const target = ref.current?.contentWindow;
        if (!target) {
          reject(new Error("O quadro ainda está abrindo. Tente de novo em instantes."));
          return;
        }
        counter.current += 1;
        const requestId = `exp-${Date.now().toString(36)}-${counter.current}`;
        const timer = window.setTimeout(() => {
          pending.current.delete(requestId);
          reject(new Error("Este quadro não respondeu ao pedido de exportação. Peça ao agente para atualizar a página do quadro."));
        }, EXPORT_TIMEOUT_MS);
        pending.current.set(requestId, { resolve, reject, timer });
        target.postMessage({ type: "quadro:export", requestId, format }, "*");
      }),
  }));

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
});
