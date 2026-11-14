import { Fragment, useMemo } from "react";
import { splitLinks } from "./linkify";

/**
 * Texto com as URLs (http/https) clicáveis, abrindo em outra aba. Todo o resto continua texto
 * puro (escapado pelo React); o link não leva quem abriu nem o endereço do app (noopener/noreferrer).
 */
export function Linkify({ text }: { text: string }) {
  const parts = useMemo(() => splitLinks(text), [text]);
  return (
    <>
      {parts.map((part, index) =>
        part.kind === "link" ? (
          <a key={index} className="ui-link" href={part.href} target="_blank" rel="noopener noreferrer" onClick={(event) => event.stopPropagation()}>
            {part.text}
          </a>
        ) : (
          <Fragment key={index}>{part.text}</Fragment>
        ),
      )}
    </>
  );
}
