import { formatAgo } from "../../ui/format";
import { carouselTitle, commonStatus, entryAuthor, type GalleryEntry } from "./mediaGroups";
import { MediaThumb, MIcon } from "./MediaParts";
import { cameFrom, STATUS_LABELS, statusTone } from "./mediaView";

type CardProps = {
  entry: GalleryEntry;
  selected: boolean;
  agentName: (ws: string, id: string) => string;
  onOpen: () => void;
  /** Duplo clique: abre o visualizador em tela cheia. */
  onView: () => void;
  /** Só nos escopos de outro workspace: o que a ação "Trazer" mostra. */
  bring?: { label: string; done: boolean; busy: boolean; onBring: () => void };
  /** Mostra "veio de X" (itens trazidos), "Compartilhada" etc. */
  workspaceName?: string;
};

/**
 * Um cartão da galeria: miniatura de caixa fixa 4:3 com a peça inteira (nada cortado, nada esticado), título em uma linha e, abaixo,
 * o estado, quem fez e há quanto tempo. Carrossel vira uma pilha; vídeo mostra play e duração.
 */
export function MediaCard({ entry, selected, agentName, onOpen, onView, bring }: CardProps) {
  const main = entry.main;
  const item = main.item;
  const status = commonStatus(entry);
  const title = entry.type === "carousel" ? carouselTitle(entry.slides) : item.title;
  const origin = entry.type === "single" ? cameFrom(item) : null;
  const versions = entry.type === "single" && entry.versions.length > 0 ? entry.versions.length + 1 : 0;
  const shared = entry.type === "single" && !!item.shared;
  return (
    <li className="md-card" data-status={status ?? "misto"} data-kind={entry.type === "carousel" ? "carousel" : item.kind}>
      <button type="button" className="md-card__open" aria-current={selected ? "true" : undefined} onClick={onOpen} onDoubleClick={onView} data-testid={`media-card-${item.id}`}>
        <span className={`md-card__stage${entry.type === "carousel" ? " md-card__stage--stack" : ""}`}>
          <MediaThumb item={item} workspaceId={main.ws} showDuration backdrop />
        </span>
        <span className="md-card__body">
          <span className="md-card__title" title={title}>
            {title}
          </span>
          <span className="md-card__meta">
            {status && (
              <span className={`md-state md-state--${statusTone(status)}`}>
                <span className="md-state__dot" aria-hidden="true" />
                {STATUS_LABELS[status]}
              </span>
            )}
            <span className="md-card__who">{entryAuthor(entry, agentName)}</span>
            <span className="md-card__when">{formatAgo(entry.time)}</span>
          </span>
          {(origin || versions > 0 || shared) && (
            <span className="md-card__tags">
              {origin && <span className="md-tag">veio de {origin.workspace}</span>}
              {versions > 0 && <span className="md-tag">{versions} versões</span>}
              {shared && (
                <span className="md-tag md-tag--shared" title="Compartilhada com os outros workspaces">
                  <MIcon name="link" size={11} />
                  Compartilhada
                </span>
              )}
            </span>
          )}
        </span>
      </button>
      <button type="button" className="md-card__expand" onClick={onView} aria-label={`Ver ${title} em tela cheia`} title="Ver em tela cheia" data-testid={`media-expand-${item.id}`}>
        <MIcon name="zoom" size={14} />
      </button>
      {bring && (
        <button type="button" className={`ui-button ui-button--secondary md-card__bring${bring.done ? " md-card__bring--done" : ""}`} disabled={bring.done || bring.busy} onClick={bring.onBring} data-testid={`media-bring-${item.id}`}>
          {bring.done ? (
            <>
              <MIcon name="check" size={14} />
              Já está aqui
            </>
          ) : bring.busy ? (
            "Trazendo…"
          ) : (
            <>
              <MIcon name="download" size={14} />
              <span className="md-card__bring-label">{bring.label}</span>
            </>
          )}
        </button>
      )}
    </li>
  );
}
