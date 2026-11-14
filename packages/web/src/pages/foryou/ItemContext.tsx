import type { ForYouItem, ForYouSource } from "@cyno/shared";
import { useState } from "react";
import { formatDateTime } from "../../ui/format";
import { Linkify } from "../../ui/Linkify";
import { Icon } from "./icons";
import { SourceMedia } from "../media/MediaStrip";
import { linkInWhere, openLinkLabel, sourcesOf } from "./forYouView";

const KIND_LABELS: Record<ForYouSource["kind"], string> = {
  post: "Post original",
  profile: "Perfil",
  article: "Artigo",
  message: "Mensagem",
  page: "Página",
  other: "Origem",
};

function initialOf(name: string | undefined): string {
  return (name?.trim()[0] ?? "?").toUpperCase();
}

function SourceBlock({ source }: { source: ForYouSource }) {
  const [open, setOpen] = useState(false);
  const label = KIND_LABELS[source.kind];
  const content = source.content?.trim();
  const long = !!content && (content.length > 280 || content.includes("\n"));
  return (
    <div className="fy-source" data-testid="foryou-source">
      <div className="fy-source__head">
        {source.author && (
          <span className="fy-avatar" aria-hidden="true">
            {initialOf(source.author)}
          </span>
        )}
        <div className="fy-source__who">
          <strong>{source.author ?? source.title ?? label}</strong>
          {source.authorDetail && <span>{source.authorDetail}</span>}
        </div>
        {source.postedAt && (
          <time className="fy-source__when" dateTime={source.postedAt}>
            {formatDateTime(source.postedAt)}
          </time>
        )}
      </div>
      {source.title && source.author && <p className="fy-source__title">{source.title}</p>}
      {source.summary && <p className="fy-source__summary">{source.summary}</p>}
      {content && (open || !source.summary) && (
        <div className={`fy-source__content${open ? " fy-source__content--open" : ""}${long ? " fy-source__content--long" : ""}`}>
          <Linkify text={content} />
        </div>
      )}
      {long && (
        <button type="button" className="fy-link fy-source__toggle" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
          {open ? "Recolher" : source.kind === "post" ? "Ver post inteiro" : "Ver texto inteiro"}
        </button>
      )}
      {source.facts && source.facts.length > 0 && (
        <ul className="fy-source__facts" aria-label="Dados">
          {source.facts.map((fact) => (
            <li key={`${fact.label}:${fact.value}`}>
              <span>{fact.label}</span>
              {fact.value}
            </li>
          ))}
        </ul>
      )}
      <SourceMedia ids={source.mediaIds} />
      {source.url && (
        <a className="fy-source__open" href={source.url} target="_blank" rel="noreferrer noopener">
          <Icon name="link" size={13} />
          {openLinkLabel(source.url)}
        </a>
      )}
    </div>
  );
}

/**
 * "Contexto": o original em que o rascunho se baseia (resumo, texto inteiro recolhível, autor, link e
 * dados). Sem fontes, cai no endereço do campo "onde" como botão "Abrir original"; sem nenhum dos dois, não desenha nada.
 */
export function ItemContext({ item }: { item: ForYouItem }) {
  const sources = sourcesOf(item);
  const fallback = sources.length === 0 ? linkInWhere(item.where) : undefined;
  if (sources.length === 0 && !fallback) return null;
  return (
    <section className="fy-context" aria-label="Contexto" data-testid="foryou-context">
      <p className="fy-context__label">Contexto · original</p>
      {sources.map((source, index) => (
        <SourceBlock key={source.url ?? index} source={source} />
      ))}
      {fallback && (
        <a className="fy-source__open" href={fallback} target="_blank" rel="noreferrer noopener">
          <Icon name="link" size={13} />
          {openLinkLabel(fallback)}
        </a>
      )}
    </section>
  );
}
