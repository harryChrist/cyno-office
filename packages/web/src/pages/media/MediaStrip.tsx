import type { MediaItem } from "@cyno/shared";
import { useEffect, useMemo, useState } from "react";
import { useMediaStore } from "../../store/mediaStore";
import { MediaFull, MediaThumb, MIcon, useMediaUrl } from "./MediaParts";
import { MediaLightbox } from "./MediaViewer";
import { KIND_LABELS_SINGULAR, mediaByIds } from "./mediaView";

/** Os itens da biblioteca para uma lista de ids (carrega a biblioteca uma vez por workspace). */
export function useMediaItems(ids: readonly string[] | undefined): MediaItem[] {
  const items = useMediaStore((state) => state.items);
  const wanted = !!ids?.length;
  useEffect(() => {
    if (wanted) useMediaStore.getState().ensureLoaded();
  }, [wanted]);
  return useMemo(() => mediaByIds(items, ids), [items, ids]);
}

/** Miniatura pequena da primeira mídia do item (linha da lista do Para você); some se ainda não carregou. */
export function RowThumb({ ids }: { ids: readonly string[] | undefined }) {
  const media = useMediaItems(ids);
  const first = media[0];
  if (!first) return null;
  return (
    <span className="md-rowthumb" data-testid="foryou-row-media">
      <MediaThumb item={first} />
      {(ids?.length ?? 0) > 1 && <span className="md-rowthumb__more">+{(ids?.length ?? 1) - 1}</span>}
    </span>
  );
}

function Tile({ item, onOpen }: { item: MediaItem; onOpen: () => void }) {
  return (
    <button type="button" className="md-strip__tile" onClick={onOpen} aria-label={`Ver ${item.title}`}>
      <MediaThumb item={item} />
    </button>
  );
}

function DocLink({ item }: { item: MediaItem }) {
  const url = useMediaUrl(item);
  return (
    <a className="md-strip__doc" href={url ?? undefined} target="_blank" rel="noreferrer noopener">
      <MIcon name="file" size={16} />
      <span>{item.title}</span>
      <small>{KIND_LABELS_SINGULAR[item.kind]}</small>
    </a>
  );
}

/**
 * Faixa de mídia do item do Para você: 1 imagem = preview grande; várias = grade; o clique abre
 * a tela cheia; vídeo toca na hora; áudio e documentos viram linhas.
 */
export function MediaStrip({ ids, label = "Mídia do pedido" }: { ids: readonly string[] | undefined; label?: string }) {
  const media = useMediaItems(ids);
  const [open, setOpen] = useState<number | null>(null);
  if (media.length === 0) return null;
  const visual = media.filter((item) => item.kind === "image" || item.kind === "video");
  const others = media.filter((item) => item.kind !== "image" && item.kind !== "video");
  const single = visual.length === 1 ? visual[0] : undefined;
  return (
    <section className="md-strip" aria-label={label} data-testid="foryou-media">
      <div className="md-strip__head">
        <p className="md-strip__label">
          <MIcon name="image" size={13} />
          {label}
        </p>
        <button type="button" className="fy-link" onClick={() => useMediaStore.getState().open(media[0]!.id)} data-testid="foryou-media-open">
          Ver na Mídia
        </button>
      </div>
      {single ? (
        single.kind === "video" ? (
          <MediaFull item={single} />
        ) : (
          <button type="button" className="md-strip__hero" onClick={() => setOpen(visual.indexOf(single))} aria-label={`Ampliar ${single.title}`} data-testid="foryou-media-hero">
            <MediaFull item={single} />
          </button>
        )
      ) : (
        visual.length > 1 && (
          <div className="md-strip__grid">
            {visual.map((item, index) => (
              <Tile key={item.id} item={item} onOpen={() => setOpen(index)} />
            ))}
          </div>
        )
      )}
      {others.map((item) => (item.kind === "audio" ? <MediaFull key={item.id} item={item} /> : <DocLink key={item.id} item={item} />))}
      {open !== null && <MediaLightbox items={visual} index={open} onIndex={setOpen} onClose={() => setOpen(null)} />}
    </section>
  );
}

/** Miniaturas clicáveis das mídias de uma fonte (ex.: a captura do post original). */
export function SourceMedia({ ids }: { ids: readonly string[] | undefined }) {
  const media = useMediaItems(ids);
  const [open, setOpen] = useState<number | null>(null);
  if (media.length === 0) return null;
  const visual = media.filter((item) => item.kind === "image" || item.kind === "video");
  return (
    <div className="md-source" data-testid="foryou-source-media">
      {visual.map((item, index) => (
        <Tile key={item.id} item={item} onOpen={() => setOpen(index)} />
      ))}
      {media
        .filter((item) => item.kind !== "image" && item.kind !== "video")
        .map((item) => (
          <DocLink key={item.id} item={item} />
        ))}
      {open !== null && <MediaLightbox items={visual} index={open} onIndex={setOpen} onClose={() => setOpen(null)} />}
    </div>
  );
}
