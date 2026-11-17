import type { DragEvent } from "react";
import { formatAgo } from "../../ui/format";
import { carouselTitle, commonStatus, entryAuthor, type GalleryEntry } from "./mediaGroups";
import { MediaThumb, MIcon } from "./MediaParts";
import { DRAG_TYPE } from "./mediaFolders";
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
  /** Na busca e nos filtros (todas as pastas): em que pasta o item está ("" = raiz). Ausente = não mostra. */
  folderLabel?: string;
  /** Modo de seleção: o clique marca em vez de abrir. */
  selecting?: boolean;
  checked?: boolean;
  onToggle?: () => void;
  /** Ids que o arraste leva (vazio/ausente = o cartão não é arrastável). */
  dragIds?: () => string[];
};

/**
 * Um cartão da galeria: miniatura de caixa fixa 4:3 com a peça inteira (nada cortado, nada esticado), título em uma linha e, abaixo,
 * o estado, quem fez e há quanto tempo. Carrossel vira uma pilha; vídeo mostra play e duração.
 */
export function MediaCard({ entry, selected, agentName, onOpen, onView, bring, folderLabel, selecting = false, checked = false, onToggle, dragIds }: CardProps) {
  const main = entry.main;
  const item = main.item;
  const status = commonStatus(entry);
  const title = entry.type === "carousel" ? carouselTitle(entry.slides) : item.title;
  const origin = entry.type === "single" ? cameFrom(item) : null;
  const versions = entry.type === "single" && entry.versions.length > 0 ? entry.versions.length + 1 : 0;
  const shared = entry.type === "single" && !!item.shared;
  return (
    <li
      className={`md-card${checked ? " md-card--checked" : ""}`}
      data-status={status ?? "misto"}
      data-kind={entry.type === "carousel" ? "carousel" : item.kind}
      {...(dragIds && !bring
        ? {
            draggable: true,
            onDragStart: (event: DragEvent) => {
              event.dataTransfer.setData(DRAG_TYPE, JSON.stringify(dragIds()));
              event.dataTransfer.effectAllowed = "move";
            },
          }
        : {})}
    >
      <button
        type="button"
        className="md-card__open"
        aria-current={selected ? "true" : undefined}
        aria-pressed={selecting ? checked : undefined}
        onClick={selecting ? onToggle : onOpen}
        onDoubleClick={selecting ? undefined : onView}
        data-testid={`media-card-${item.id}`}
      >
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
          {folderLabel !== undefined && (
            <span className="md-card__folder" title={folderLabel ? `Pasta: ${folderLabel}` : "Na raiz da biblioteca"} data-testid={`media-card-folder-${item.id}`}>
              <MIcon name="folder" size={11} />
              {folderLabel || "Biblioteca"}
            </span>
          )}
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
      {selecting && (
        <span className={`md-card__check${checked ? " md-card__check--on" : ""}`} aria-hidden="true">
          {checked && <MIcon name="check" size={13} />}
        </span>
      )}
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
