import type { MediaItem } from "@cyno/shared";
import { useEffect, useRef, useState, type MutableRefObject, type PointerEvent as ReactPointerEvent } from "react";
import { mediaFileUrl } from "../../api/client";
import { useNavStore } from "../../store/navStore";
import { formatAgo } from "../../ui/format";
import { useModalDialog } from "../../ui/widgets";
import type { Located } from "./mediaGroups";
import { MediaFull, MediaThumb, MIcon } from "./MediaParts";
import { dimensionsLabel, extensionLabel, formatBytes, ratioLabel } from "./mediaView";

/** Como os itens do visualizador se relacionam: slides de um carrossel, versões da mesma peça ou uma lista de itens. */
export type ViewerMode = "slides" | "versions" | "list";

/** `scale`: o zoom sobre o ajuste (1 = ajustada); `percent`: o tamanho real na tela em relação ao arquivo (100 = pixel a pixel). */
type ZoomState = { scale: number; percent: number };

type ZoomApi = { zoomIn: () => void; zoomOut: () => void; fit: () => void; actual: () => void; scale: () => number };

const MAX_SCALE = 8;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/**
 * A imagem do visualizador: ajustada à janela; roda do mouse e botões dão zoom, duplo clique alterna entre
 * "ajustar" e 100%, arrastar move (com o zoom ligado), pinça e arrasto no celular.
 */
function ZoomImage({ src, alt, apiRef, onScale }: { src: string; alt: string; apiRef: MutableRefObject<ZoomApi | null>; onScale: (state: ZoomState) => void }) {
  const stage = useRef<HTMLDivElement>(null);
  const img = useRef<HTMLImageElement>(null);
  const [view, setView] = useState({ s: 1, x: 0, y: 0 });
  const [moving, setMoving] = useState(false);
  const [dims, setDims] = useState({ fit: 0, natural: 0 });
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ dist: number; s: number; moved: boolean } | null>(null);
  const viewRef = useRef(view);
  useEffect(() => {
    viewRef.current = view;
  });

  const limit = (s: number, x: number, y: number) => {
    const w = img.current?.clientWidth ?? 0;
    const h = img.current?.clientHeight ?? 0;
    const sw = stage.current?.clientWidth ?? 0;
    const sh = stage.current?.clientHeight ?? 0;
    const maxX = Math.max(0, (w * s - sw) / 2) + 48;
    const maxY = Math.max(0, (h * s - sh) / 2) + 48;
    return s <= 1 ? { s: 1, x: 0, y: 0 } : { s, x: clamp(x, -maxX, maxX), y: clamp(y, -maxY, maxY) };
  };
  /** Quanto ampliar sobre o ajuste para chegar a 100% do arquivo (1 se ele já cabe em tamanho real ou menor). */
  const natural = () => {
    const el = img.current;
    return el && el.clientWidth > 0 ? Math.max(el.naturalWidth / el.clientWidth, 1) : 1;
  };
  /** Troca o zoom mantendo parado o ponto (relativo ao centro da área) sob o cursor. */
  const zoomTo = (next: number, anchor?: { x: number; y: number }) => {
    const { s, x, y } = viewRef.current;
    const ns = clamp(next, 1, Math.max(MAX_SCALE, natural() * 2));
    const c = anchor ?? { x: 0, y: 0 };
    setView(limit(ns, c.x - (c.x - x) * (ns / s), c.y - (c.y - y) * (ns / s)));
  };
  const centerOf = (clientX: number, clientY: number) => {
    const rect = stage.current?.getBoundingClientRect();
    return rect ? { x: clientX - rect.left - rect.width / 2, y: clientY - rect.top - rect.height / 2 } : { x: 0, y: 0 };
  };

  useEffect(() => {
    apiRef.current = {
      zoomIn: () => zoomTo(viewRef.current.s * 1.5),
      zoomOut: () => zoomTo(viewRef.current.s / 1.5),
      fit: () => setView({ s: 1, x: 0, y: 0 }),
      actual: () => zoomTo(natural()),
      scale: () => viewRef.current.s,
    };
    return () => {
      apiRef.current = null;
    };
  });
  // O tamanho do ajuste muda com a janela e quando a imagem carrega: o percentual acompanha.
  useEffect(() => {
    const el = stage.current;
    const image = img.current;
    if (!el || !image) return;
    const measure = () => setDims({ fit: image.clientWidth, natural: image.naturalWidth });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    observer.observe(image);
    return () => observer.disconnect();
  }, []);
  const percent = dims.natural > 0 && dims.fit > 0 ? Math.round(((dims.fit * view.s) / dims.natural) * 100) : 100;
  useEffect(() => onScale({ scale: view.s, percent }), [view.s, percent, onScale]);

  // A roda precisa de listener não passivo para impedir a rolagem da página.
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      zoomTo(viewRef.current.s * Math.exp(-event.deltaY * 0.0016), centerOf(event.clientX, event.clientY));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  });

  const down = (event: ReactPointerEvent) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      gesture.current = { dist: Math.hypot(a!.x - b!.x, a!.y - b!.y), s: viewRef.current.s, moved: true };
    } else gesture.current = { dist: 0, s: viewRef.current.s, moved: false };
    setMoving(true);
  };
  const move = (event: ReactPointerEvent) => {
    const prev = pointers.current.get(event.pointerId);
    if (!prev) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.current.size === 2 && gesture.current) {
      const [a, b] = [...pointers.current.values()];
      const dist = Math.hypot(a!.x - b!.x, a!.y - b!.y);
      if (gesture.current.dist > 0) zoomTo(gesture.current.s * (dist / gesture.current.dist), centerOf((a!.x + b!.x) / 2, (a!.y + b!.y) / 2));
    } else if (pointers.current.size === 1 && viewRef.current.s > 1) {
      const { s, x, y } = viewRef.current;
      if (gesture.current) gesture.current.moved = true;
      setView(limit(s, x + event.clientX - prev.x, y + event.clientY - prev.y));
    }
  };
  const up = (event: ReactPointerEvent) => {
    pointers.current.delete(event.pointerId);
    if (pointers.current.size === 0) setMoving(false);
    else if (pointers.current.size === 1) gesture.current = { dist: 0, s: viewRef.current.s, moved: true };
  };

  return (
    <div
      ref={stage}
      className={`md-vz${view.s > 1 ? " md-vz--zoomed" : ""}${moving ? " md-vz--moving" : ""}`}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onDoubleClick={(event) => (viewRef.current.s > 1.05 ? setView({ s: 1, x: 0, y: 0 }) : zoomTo(Math.max(natural(), 2), centerOf(event.clientX, event.clientY)))}
      data-testid="media-viewer-stage"
    >
      <img ref={img} src={src} alt={alt} draggable={false} onLoad={(event) => setDims({ fit: event.currentTarget.clientWidth, natural: event.currentTarget.naturalWidth })} style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.s})` }} />
    </div>
  );
}

type ViewerProps = {
  items: readonly Located[];
  index: number;
  onIndex: (index: number) => void;
  onClose: () => void;
  mode?: ViewerMode;
  agentName: (ws: string, id: string) => string;
};

/**
 * Visualizador em tela cheia: a peça grande sobre fundo escuro, com zoom (imagem), setas para a anterior e a próxima,
 * contador, título, dados da peça e as ações baixar e abrir em nova aba. Fecha com Esc, o X ou clicando fora;
 * o foco fica preso dentro (é um <dialog> modal). Com versões, "Alternar versão" troca entre a atual e a anterior.
 */
export function MediaViewer({ items, index, onIndex, onClose, mode = "list", agentName }: ViewerProps) {
  const ref = useModalDialog(onClose, { closeOnBackdrop: false });
  const api = useRef<ZoomApi | null>(null);
  const [zoom, setZoom] = useState<ZoomState>({ scale: 1, percent: 100 });
  const scale = zoom.scale;
  const located = items[index];
  const last = items.length - 1;
  const go = (to: number) => onIndex(clamp(to, 0, last));

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT|AUDIO|VIDEO)$/.test(event.target.tagName) && event.key.startsWith("Arrow")) return;
      if (event.key === "ArrowRight") go(index + 1);
      else if (event.key === "ArrowLeft") go(index - 1);
      else if (event.key === "+" || event.key === "=") api.current?.zoomIn();
      else if (event.key === "-") api.current?.zoomOut();
      else if (event.key === "0") api.current?.fit();
      else if ((event.key === "v" || event.key === "V") && mode === "versions" && items.length > 1) go(index === 0 ? 1 : 0);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (!located) return null;
  const { item, ws } = located;
  const image = item.kind === "image";
  const url = mediaFileUrl(ws, item.id);
  const dims = dimensionsLabel(item);
  const ratio = item.width && item.height ? ratioLabel(item.width, item.height) : null;
  const info = [dims, ratio, `${extensionLabel(item)} · ${formatBytes(item.size)}`, `${agentName(ws, item.createdBy)}, ${formatAgo(item.createdAt)}`].filter(Boolean).join(" · ");
  const counter = mode === "versions" ? `${index === 0 ? "Versão atual" : "Versão anterior"} (${index + 1} de ${items.length})` : `${index + 1} de ${items.length}`;
  const showStrip = mode !== "list" && items.length > 1;

  return (
    <dialog ref={ref} className="md-lightbox md-viewer" aria-label={item.title} data-testid="media-lightbox">
      <div className="md-lightbox__bar">
        <span className="md-viewer__head">
          <span className="md-lightbox__title">
            {item.title}
            {items.length > 1 && <span className="md-lightbox__count"> · {counter}</span>}
          </span>
          <span className="md-viewer__info" data-testid="media-viewer-info">
            {info}
          </span>
        </span>
        {mode === "versions" && items.length > 1 && (
          <button type="button" className="ui-button ui-button--secondary md-viewer__compare" onClick={() => go(index === 0 ? 1 : 0)} data-testid="media-viewer-compare">
            Alternar versão
          </button>
        )}
        {image && (
          <span className="md-viewer__zoom" role="group" aria-label="Zoom">
            <button type="button" className="ui-icon-button md-lightbox__btn" onClick={() => api.current?.zoomOut()} aria-label="Diminuir" title="Diminuir (−)">
              <span aria-hidden="true">−</span>
            </button>
            <button
              type="button"
              className="md-viewer__pct"
              onClick={() => (scale > 1.05 ? api.current?.fit() : api.current?.actual())}
              aria-label={scale > 1.05 ? "Ajustar à janela" : "Ver em 100%"}
              title={scale > 1.05 ? "Ajustar à janela (0)" : "Ver em 100% (tamanho real)"}
              data-testid="media-viewer-mode"
            >
              {scale <= 1.05 ? "Ajustar" : zoom.percent === 100 ? "100%" : "Livre"}
            </button>
            <span className="md-viewer__level" aria-live="polite" data-testid="media-viewer-level">
              {zoom.percent}%
            </span>
            <button type="button" className="ui-icon-button md-lightbox__btn" onClick={() => api.current?.zoomIn()} aria-label="Aumentar" title="Aumentar (+)">
              <span aria-hidden="true">+</span>
            </button>
          </span>
        )}
        <a className="ui-icon-button md-lightbox__btn" href={mediaFileUrl(ws, item.id, true)} aria-label="Baixar" title="Baixar" data-testid="media-viewer-download">
          <MIcon name="download" size={17} />
        </a>
        <a className="ui-icon-button md-lightbox__btn" href={url} target="_blank" rel="noreferrer noopener" aria-label="Abrir em nova aba" title="Abrir em nova aba">
          <MIcon name="eye" size={17} />
        </a>
        <button type="button" className="ui-icon-button md-lightbox__btn" onClick={() => ref.current?.close()} aria-label="Fechar" data-testid="media-viewer-close">
          <MIcon name="close" size={18} />
        </button>
      </div>
      <div
        className="md-lightbox__stage"
        onClick={(event) => {
          if (event.target === event.currentTarget || (event.target as HTMLElement).classList.contains("md-vz")) ref.current?.close();
        }}
      >
        {index > 0 && (
          <button type="button" className="md-lightbox__nav md-lightbox__nav--prev" onClick={() => go(index - 1)} aria-label="Anterior" data-testid="media-viewer-prev">
            <MIcon name="back" size={22} />
          </button>
        )}
        {image ? <ZoomImage key={`${ws}:${item.id}`} src={url} alt={item.title} apiRef={api} onScale={setZoom} /> : <div className="md-viewer__other"><MediaFull key={`${ws}:${item.id}`} item={item} workspaceId={ws} /></div>}
        {index < last && (
          <button type="button" className="md-lightbox__nav md-lightbox__nav--next" onClick={() => go(index + 1)} aria-label="Próxima" data-testid="media-viewer-next">
            <MIcon name="next" size={22} />
          </button>
        )}
      </div>
      {showStrip && (
        <ul className="md-viewer__strip" aria-label={mode === "slides" ? "Slides" : "Versões"}>
          {items.map((entry, i) => (
            <li key={`${entry.ws}:${entry.item.id}`}>
              <button type="button" className="md-part" aria-pressed={i === index} onClick={() => go(i)} aria-label={mode === "slides" ? `Slide ${i + 1}` : i === 0 ? "Versão atual" : "Versão anterior"}>
                <MediaThumb item={entry.item} workspaceId={entry.ws} />
                <span className="md-part__n">{mode === "slides" ? i + 1 : i === 0 ? "Atual" : "Anterior"}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </dialog>
  );
}

/** Para quem só tem itens da biblioteca do workspace atual (Para você): o mesmo visualizador, sem versões. */
export function MediaLightbox({ items, index, onIndex, onClose }: { items: readonly MediaItem[]; index: number; onIndex: (index: number) => void; onClose: () => void }) {
  const ws = useNavStore((state) => state.workspaceId) ?? "";
  const names = (_ws: string, id: string) => (id === "usuario" ? "Você" : id);
  return <MediaViewer items={items.map((item) => ({ ws, item }))} index={index} onIndex={onIndex} onClose={onClose} agentName={names} />;
}
