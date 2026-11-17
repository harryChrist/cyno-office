import type { MediaItem } from "@cyno/shared";
import { useEffect, useState } from "react";
import { mediaFileUrl } from "../../api/client";
import { useNavStore } from "../../store/navStore";
import { extensionLabel, formatBytes, KIND_LABELS_SINGULAR } from "./mediaView";
import "./media.css";

const ICON_PATHS = {
  upload: ["M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4", "m17 8-5-5-5 5", "M12 3v12"],
  download: ["M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4", "m7 10 5 5 5-5", "M12 15V3"],
  link: ["M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71", "M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"],
  back: ["m15 18-6-6 6-6"],
  next: ["m9 18 6-6-6-6"],
  close: ["M18 6 6 18", "m6 6 12 12"],
  file: ["M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z", "M14 2v6h6", "M8 13h8", "M8 17h5"],
  play: ["M6 4l14 8-14 8z"],
  music: ["M9 18V5l12-2v13", "M9 18a3 3 0 1 1-6 0a3 3 0 0 1 6 0Z", "M21 16a3 3 0 1 1-6 0a3 3 0 0 1 6 0Z"],
  video: ["m22 8-6 4 6 4V8Z", "M3 6h11a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2Z"],
  image: ["M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z", "M9 8a1 1 0 1 0 0 2a1 1 0 1 0 0-2Z", "m21 15-3.09-3.09a2 2 0 0 0-2.82 0L6 21"],
  trash: ["M3 6h18", "M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6", "M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2", "M10 11v6", "M14 11v6"],
  edit: ["M12 20h9", "M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"],
  check: ["M20 6 9 17l-5-5"],
  task: ["M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11", "m9 11 3 3L22 4"],
  inbox: ["M22 12h-6l-2 3h-4l-2-3H2", "M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"],
  pin: ["M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 0 1 16 0Z", "M12 7a3 3 0 1 0 0 6a3 3 0 0 0 0-6Z"],
  zoom: ["M11 3a8 8 0 1 0 0 16a8 8 0 0 0 0-16Z", "m21 21-4.35-4.35", "M11 8v6", "M8 11h6"],
  search: ["M11 3a8 8 0 1 0 0 16a8 8 0 0 0 0-16Z", "m21 21-4.35-4.35"],
  eye: ["M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z", "M12 9a3 3 0 1 0 0 6a3 3 0 0 0 0-6Z"],
  filter: ["M22 3H2l8 9.46V19l4 2v-8.54z"],
  grid: ["M3 3h7v7H3z", "M14 3h7v7h-7z", "M14 14h7v7h-7z", "M3 14h7v7H3z"],
  folder: ["M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"],
  folderPlus: ["M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z", "M12 11v6", "M9 14h6"],
  arrow: ["M5 12h14", "m13 6 6 6-6 6"],
  dense: ["M3 3h4v4H3z", "M10 3h4v4h-4z", "M17 3h4v4h-4z", "M3 10h4v4H3z", "M10 10h4v4h-4z", "M17 10h4v4h-4z", "M3 17h4v4H3z", "M10 17h4v4h-4z", "M17 17h4v4h-4z"],
} satisfies Record<string, string[]>;
export type MIconName = keyof typeof ICON_PATHS;

/** Ícone de traço decorativo da página Mídia. */
export function MIcon({ name, size = 15, className }: { name: MIconName; size?: number; className?: string }) {
  return (
    <svg className={`md-icon${className ? ` ${className}` : ""}`} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {ICON_PATHS[name].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

/** Endereço do arquivo no workspace atual, ou no `workspaceId` dado (mídia de outro workspace); null sem workspace. */
export function useMediaUrl(item: Pick<MediaItem, "id">, download = false, workspaceId?: string): string | null {
  const current = useNavStore((state) => state.workspaceId);
  const ws = workspaceId ?? current;
  return ws ? mediaFileUrl(ws, item.id, download) : null;
}

/** "0:06", "1:05:09". */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

const KIND_ICON: Record<MediaItem["kind"], MIconName> = { image: "image", video: "video", audio: "music", document: "file", other: "file" };

/** O navegador consegue mostrar este arquivo direto (imagem, vídeo, áudio, PDF, texto)? O resto o servidor entrega só como download. */
export const canDisplay = (item: Pick<MediaItem, "mime">): boolean => /^(image|video|audio)\//.test(item.mime) || item.mime === "application/pdf" || isTextualMime(item.mime);

const TEXT_MIMES = new Set(["text/plain", "text/markdown", "text/csv", "application/json", "text/html"]);
/** Texto que dá para mostrar (o servidor entrega como texto puro, nunca como página). */
export const isTextual = (item: Pick<MediaItem, "mime">): boolean => TEXT_MIMES.has(item.mime);
function isTextualMime(mime: string): boolean {
  return TEXT_MIMES.has(mime) || mime === "application/xml";
}

const snippets = new Map<string, Promise<string | null>>();
/** O começo do texto de um arquivo (pede só os primeiros bytes); undefined enquanto carrega, null se não deu. */
export function useTextSnippet(url: string | null, enabled: boolean, bytes: number): string | null | undefined {
  const key = url ? `${url}|${bytes}` : "";
  const [state, setState] = useState<{ key: string; text: string | null } | null>(null);
  useEffect(() => {
    if (!enabled || !url) return;
    let live = true;
    let promise = snippets.get(key);
    if (!promise) {
      promise = fetch(url, { headers: { Range: `bytes=0-${bytes - 1}` } })
        .then((response) => (response.ok ? response.text() : null))
        .then((text) => (text === null ? null : text.slice(0, bytes)))
        .catch(() => null);
      snippets.set(key, promise);
    }
    void promise.then((text) => live && setState({ key, text }));
    return () => {
      live = false;
    };
  }, [enabled, url, key, bytes]);
  return !enabled || !url ? null : state?.key === key ? state.text : undefined;
}

/**
 * Miniatura fiel: a peça inteira, sem cortar nem esticar, centralizada na caixa (que o chamador dimensiona). Imagem
 * pelo /file (com `backdrop`, a mesma imagem ampliada e desfocada atrás, para a caixa não ter faixas pretas), vídeo
 * como um quadro (com duração e play), texto como as primeiras linhas, áudio e outros como um bloco com o tipo.
 */
export function MediaThumb({ item, className, workspaceId, showDuration = false, backdrop = false }: { item: MediaItem; className?: string; workspaceId?: string; showDuration?: boolean; backdrop?: boolean }) {
  const url = useMediaUrl(item, false, workspaceId);
  const [broken, setBroken] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [duration, setDuration] = useState<number | null>(null);
  const snippet = useTextSnippet(url, !!url && item.kind === "document" && isTextual(item), 600);
  const base = `md-thumb${className ? ` ${className}` : ""}`;
  if (url && !broken && item.kind === "image") {
    return (
      <span className={`${base}${backdrop ? " md-thumb--backdrop" : ""}${loaded ? " md-thumb--ready" : ""}`}>
        {backdrop && <img className="md-thumb__bg" src={url} alt="" loading="lazy" decoding="async" aria-hidden="true" />}
        <img
          ref={(img) => {
            // Já veio do cache do navegador: o onLoad pode ter passado antes de o React ligar o evento.
            if (img?.complete && img.naturalWidth > 0) setLoaded(true);
          }}
          className="md-thumb__img"
          src={url}
          alt=""
          width={item.width}
          height={item.height}
          loading="lazy"
          decoding="async"
          onLoad={() => setLoaded(true)}
          onError={() => setBroken(true)}
        />
      </span>
    );
  }
  if (url && !broken && item.kind === "video") {
    return (
      <span className={`${base} md-thumb--video`}>
        <video
          src={`${url}#t=0.1`}
          preload="metadata"
          muted
          playsInline
          tabIndex={-1}
          onError={() => setBroken(true)}
          onLoadedMetadata={(event) => {
            const video = event.currentTarget;
            if (Number.isFinite(video.duration)) setDuration(video.duration);
            else video.currentTime = 1e7; // WebM gravado no navegador não diz a duração: ir ao fim a revela
          }}
          onDurationChange={(event) => {
            const video = event.currentTarget;
            if (Number.isFinite(video.duration)) {
              setDuration(video.duration);
              if (video.currentTime > video.duration) video.currentTime = 0.1;
            }
          }}
        />
        <span className="md-thumb__play" aria-hidden="true">
          <MIcon name="play" size={16} />
        </span>
        {showDuration && duration !== null && <span className="md-thumb__time">{formatDuration(duration)}</span>}
      </span>
    );
  }
  if (typeof snippet === "string" && snippet.trim()) {
    return (
      <span className={`${base} md-thumb--text`}>
        <pre className="md-thumb__snippet">{snippet}</pre>
        <span className="md-thumb__ext md-thumb__ext--corner">{extensionLabel(item)}</span>
        <span className="sr-only">{KIND_LABELS_SINGULAR[item.kind]}</span>
      </span>
    );
  }
  return (
    <span className={`${base} md-thumb--tile md-thumb--${item.kind}`}>
      <MIcon name={KIND_ICON[item.kind]} size={26} />
      <span className="md-thumb__ext">{extensionLabel(item)}</span>
      <span className="sr-only">{KIND_LABELS_SINGULAR[item.kind]}</span>
    </span>
  );
}

/** Texto de um arquivo (o começo, até `bytes`), em fonte de código, com a opção de abrir inteiro. */
function TextPreview({ item, url }: { item: MediaItem; url: string }) {
  const text = useTextSnippet(url, true, 6000);
  return (
    <div className="md-full__text">
      {text === undefined ? <p className="md-full__muted">Carregando…</p> : text === null || !text.trim() ? <p className="md-full__muted">Sem prévia de texto.</p> : <pre>{text}{item.size > 6000 ? "\n…" : ""}</pre>}
    </div>
  );
}

/**
 * O conteúdo grande de uma mídia: imagem (com `onOpen`, vira botão que abre o visualizador), vídeo e áudio com
 * controles, texto com as primeiras linhas; o resto (PDF e outros) vira um cartão com o nome, o tipo e o tamanho.
 */
export function MediaFull({ item, workspaceId, onOpen }: { item: MediaItem; zoom?: boolean; workspaceId?: string; onOpen?: () => void }) {
  const url = useMediaUrl(item, false, workspaceId);
  if (!url) return null;
  if (item.kind === "image") {
    if (!onOpen) return <img className="md-full__img" src={url} alt={item.title} />;
    return (
      <div className="md-zoom" data-testid="media-zoom">
        <button type="button" className="md-zoom__btn" onClick={onOpen} aria-label={`Ampliar ${item.title}`} title="Ampliar">
          <img src={url} alt={item.title} />
        </button>
        <span className="md-zoom__hint" aria-hidden="true">
          <MIcon name="zoom" size={13} />
          Clique para ampliar
        </span>
      </div>
    );
  }
  if (item.kind === "video") return <video className="md-full__video" src={url} controls preload="metadata" playsInline />;
  if (item.kind === "audio") {
    return (
      <div className="md-full__audio">
        <MIcon name="music" size={34} />
        <audio src={url} controls preload="metadata" />
      </div>
    );
  }
  if (isTextual(item)) return <TextPreview item={item} url={url} />;
  return (
    <div className="md-full__doc">
      <MIcon name="file" size={40} />
      <strong>{item.fileName}</strong>
      <span>
        {KIND_LABELS_SINGULAR[item.kind]} · {extensionLabel(item)} · {formatBytes(item.size)}
      </span>
      {item.mime === "application/pdf" && <span className="md-full__muted">A prévia de PDF não fica aqui; abra o arquivo em outra aba.</span>}
      {canDisplay(item) ? (
        <a className="ui-button" href={url} target="_blank" rel="noreferrer noopener">
          <MIcon name="eye" />
          Abrir em nova aba
        </a>
      ) : (
        <a className="ui-button" href={mediaFileUrl(workspaceId ?? useNavStore.getState().workspaceId ?? "", item.id, true)}>
          <MIcon name="download" />
          Baixar
        </a>
      )}
    </div>
  );
}

/**
 * A mídia grande da gaveta de detalhe: a imagem inteira (nunca cortada) sobre fundo neutro, vídeo e áudio com controles,
 * texto legível numa caixa rolável e, para PDF e arquivos sem prévia, o ícone, os dados e os botões de abrir e baixar.
 * `onFullscreen` (duplo clique na imagem) abre o visualizador em tela cheia.
 */
export function MediaStage({ item, workspaceId, onFullscreen }: { item: MediaItem; workspaceId?: string; onFullscreen?: () => void }) {
  const url = useMediaUrl(item, false, workspaceId);
  const download = useMediaUrl(item, true, workspaceId);
  const [broken, setBroken] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const text = useTextSnippet(url, !!url && item.kind === "document" && isTextual(item), 12000);
  if (!url) return null;
  if (item.kind === "image" && !broken) {
    return (
      <div className={`md-stage md-stage--image${loaded ? " md-stage--ready" : ""}`} data-testid="media-stage">
        <img
          ref={(img) => {
            if (img?.complete && img.naturalWidth > 0) setLoaded(true);
          }}
          className="md-stage__img"
          src={url}
          alt={item.title}
          width={item.width}
          height={item.height}
          decoding="async"
          draggable={false}
          onLoad={() => setLoaded(true)}
          onError={() => setBroken(true)}
          onDoubleClick={onFullscreen}
          title={onFullscreen ? "Duplo clique para ver em tela cheia" : undefined}
        />
      </div>
    );
  }
  if (item.kind === "video" && !broken) {
    return (
      <div className="md-stage md-stage--video" data-testid="media-stage">
        <video className="md-stage__video" src={url} controls preload="metadata" playsInline onError={() => setBroken(true)} />
      </div>
    );
  }
  if (item.kind === "audio") {
    return (
      <div className="md-stage md-stage--audio" data-testid="media-stage">
        <MIcon name="music" size={40} />
        <audio src={url} controls preload="metadata" />
      </div>
    );
  }
  if (item.kind === "document" && isTextual(item)) {
    return (
      <div className="md-stage md-stage--text" data-testid="media-stage">
        {text === undefined ? <p className="md-full__muted">Carregando…</p> : text === null || !text.trim() ? <p className="md-full__muted">Sem prévia de texto.</p> : <pre className="md-stage__pre">{text}{item.size > 12000 ? "\n…" : ""}</pre>}
      </div>
    );
  }
  const pdf = item.mime === "application/pdf";
  return (
    <div className="md-stage md-stage--file" data-testid="media-stage">
      <span className="md-stage__sheet" aria-hidden="true">
        <MIcon name="file" size={44} />
        <span className="md-stage__ext">{extensionLabel(item)}</span>
      </span>
      <strong className="md-stage__name">{item.fileName}</strong>
      <span className="md-stage__sub">
        {KIND_LABELS_SINGULAR[item.kind]} · {extensionLabel(item)} · {formatBytes(item.size)}
      </span>
      {pdf && <span className="md-full__muted">O navegador abre o PDF numa aba própria, por segurança; aqui ficam os dados e os botões.</span>}
      {!canDisplay(item) && <span className="md-full__muted">Sem prévia para este tipo de arquivo. Baixe para abrir no seu computador.</span>}
      <span className="md-stage__actions">
        {canDisplay(item) && (
          <a className="ui-button" href={url} target="_blank" rel="noreferrer noopener">
            <MIcon name="eye" />
            Abrir em nova aba
          </a>
        )}
        {download && (
          <a className={`ui-button${canDisplay(item) ? " ui-button--secondary" : ""}`} href={download} data-testid="media-stage-download">
            <MIcon name="download" />
            Baixar
          </a>
        )}
      </span>
    </div>
  );
}
