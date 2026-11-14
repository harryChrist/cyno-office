import { forwardRef, useCallback, useEffect, useRef, useState } from "react";
import { REPORT_FRAME_SANDBOX, sandboxedHtml } from "./reportsView";

/**
 * A página do relatório num iframe `srcdoc` sem scripts (sandbox sem `allow-scripts` e uma CSP sem script dentro do documento):
 * ela não roda código nem alcança a sessão do app. A altura acompanha o conteúdo, então a página rola uma vez só.
 */
export const ReportFrame = forwardRef<HTMLIFrameElement, { html: string; title: string }>(function ReportFrame({ html, title }, ref) {
  const own = useRef<HTMLIFrameElement | null>(null);
  const [height, setHeight] = useState(900);
  const measure = useCallback(() => {
    const element = own.current;
    const doc = element?.contentDocument;
    if (!element || !doc?.documentElement) return;
    // A moldura tem borda: a altura dela é a do conteúdo mais as duas bordas (sem isso sobravam 2 px e nascia uma rolagem interna).
    const borders = element.offsetHeight - element.clientHeight;
    setHeight(Math.max(480, doc.documentElement.scrollHeight + borders));
  }, []);
  const content = useRef<ResizeObserver | null>(null);
  // Mede de novo quando a moldura muda de largura e quando o conteúdo muda de altura depois de carregar.
  const watchContent = useCallback(() => {
    measure();
    content.current?.disconnect();
    const body = own.current?.contentDocument?.body;
    if (!body || typeof ResizeObserver === "undefined") return;
    content.current = new ResizeObserver(() => measure());
    content.current.observe(body);
  }, [measure]);
  useEffect(() => {
    const element = own.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => measure());
    observer.observe(element);
    return () => {
      observer.disconnect();
      content.current?.disconnect();
    };
  }, [measure]);
  return (
    <iframe
      ref={(node) => {
        own.current = node;
        if (typeof ref === "function") ref(node);
        else if (ref) ref.current = node;
      }}
      className="rel__frame"
      title={`Relatório: ${title}`}
      sandbox={REPORT_FRAME_SANDBOX}
      referrerPolicy="no-referrer"
      srcDoc={sandboxedHtml(html)}
      style={{ height }}
      onLoad={watchContent}
      data-testid="rel-frame"
    />
  );
});
