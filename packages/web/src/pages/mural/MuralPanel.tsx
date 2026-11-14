import type { MuralEntry } from "@cyno/shared";
import { useEffect, useState } from "react";
import { mediaFileUrl } from "../../api/client";
import { useMuralStore } from "../../store/muralStore";
import { useWorkspaceStore } from "../../store/workspaceStore";
import { formatAgo } from "../../ui/format";
import "./mural.css";

/** Nome do workspace pelo id (a lista do app; o id se não achar). */
export function useWorkspaceNames(): (id: string) => string {
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  return (id) => workspaces?.find((workspace) => workspace.id === id)?.name ?? id;
}

/** Miniatura do item: a imagem (ou o primeiro quadro do vídeo) vem do arquivo do workspace de origem; texto vira um bloco. */
export function MuralThumb({ entry }: { entry: MuralEntry }) {
  const [broken, setBroken] = useState(false);
  const ref = entry.mediaRef;
  if (ref && !broken && entry.mediaKind === "image") {
    return (
      <span className="mural-thumb">
        <img src={mediaFileUrl(ref.workspace, ref.mediaId)} alt="" loading="lazy" decoding="async" onError={() => setBroken(true)} />
      </span>
    );
  }
  if (ref && !broken && entry.mediaKind === "video") {
    return (
      <span className="mural-thumb">
        <video src={`${mediaFileUrl(ref.workspace, ref.mediaId)}#t=0.1`} preload="metadata" muted playsInline tabIndex={-1} onError={() => setBroken(true)} />
      </span>
    );
  }
  const label = ref ? (entry.mediaKind === "audio" ? "Áudio" : "Arquivo") : entry.kind === "deliverable" ? "Entrega" : "Nota";
  return (
    <span className="mural-thumb mural-thumb--tile" aria-hidden="true">
      {label}
    </span>
  );
}

/**
 * O Mural, na página do Cyno: o que os workspaces compartilharam com a plataforma (mais novos primeiro),
 * de onde veio, quem já usou, e "Retirar". Os Maestros dos outros workspaces ficam sabendo sozinhos quando
 * acordam; aqui o dono só acompanha.
 */
export function MuralPanel() {
  const entries = useMuralStore((state) => state.entries);
  const loaded = useMuralStore((state) => state.loaded);
  const error = useMuralStore((state) => state.error);
  const retire = useMuralStore((state) => state.retire);
  const nameOf = useWorkspaceNames();
  useEffect(() => {
    void useMuralStore.getState().load();
  }, []);
  return (
    <section className="hstrip__panel mural" aria-labelledby="mural-title" data-testid="mural-panel">
      <header className="hstrip__head">
        <h3 className="hstrip__title" id="mural-title">
          Mural
        </h3>
        {entries.length > 0 ? <span className="hstrip__count">{entries.length}</span> : <span className="hstrip__tag">Entre workspaces</span>}
      </header>
      <div className="mural__scroll">
        {!loaded ? (
          <p className="mural__empty">Carregando…</p>
        ) : entries.length === 0 ? (
          <p className="mural__empty" data-testid="mural-empty">
            Nada compartilhado ainda. Quando um workspace faz algo muito bom (uma imagem, um vídeo), ele pode compartilhar aqui para os outros usarem.
          </p>
        ) : (
          <ul className="mural__list">
            {entries.map((entry) => (
              <li key={entry.id} className="mural__item" data-testid="mural-item" data-id={entry.id}>
                <MuralThumb entry={entry} />
                <span className="mural__body">
                  <span className="mural__title">{entry.title}</span>
                  <span className="mural__meta">
                    de <strong>{nameOf(entry.workspace)}</strong> · {formatAgo(entry.createdAt)}
                  </span>
                  {entry.note && <span className="mural__note">{entry.note}</span>}
                  {entry.usedBy.length > 0 ? (
                    <span className="mural__used" data-testid="mural-used">
                      usado por {entry.usedBy.map(nameOf).join(", ")}
                    </span>
                  ) : (
                    <span className="mural__unused">ninguém usou ainda</span>
                  )}
                </span>
                <button type="button" className="ui-button ui-button--ghost mural__retire" onClick={() => void retire(entry.id)} aria-label={`Retirar ${entry.title} do mural`} data-testid="mural-retire">
                  Retirar
                </button>
              </li>
            ))}
          </ul>
        )}
        {error && (
          <p className="mural__error" role="alert">
            {error}
          </p>
        )}
      </div>
    </section>
  );
}

/**
 * "Do mural", na página Mídia de um workspace: os itens que os OUTROS workspaces compartilharam, com
 * "Trazer para cá" (copia o arquivo para esta biblioteca, com a origem).
 */
export function MuralFromOthers({ workspace }: { workspace: string }) {
  const entries = useMuralStore((state) => state.entries);
  const busy = useMuralStore((state) => state.busy);
  const error = useMuralStore((state) => state.error);
  const nameOf = useWorkspaceNames();
  const [brought, setBrought] = useState<Record<string, string>>({});
  useEffect(() => {
    void useMuralStore.getState().load();
  }, []);
  const others = entries.filter((entry) => entry.workspace !== workspace);
  if (others.length === 0) return null;
  return (
    <section className="mural mural--media" aria-labelledby="mural-media-title" data-testid="mural-from-others">
      <header className="mural-media__head">
        <h3 className="mural-media__title" id="mural-media-title">
          Do mural
        </h3>
        <span className="mural-media__sub">O que os outros workspaces compartilharam com a plataforma</span>
      </header>
      <ul className="mural-media__row">
        {others.map((entry) => {
          const done = entry.usedBy.includes(workspace);
          const working = busy.includes(`${entry.id}:${workspace}`);
          return (
            <li key={entry.id} className="mural-card" data-testid="mural-card" data-id={entry.id}>
              <MuralThumb entry={entry} />
              <span className="mural-card__title">{entry.title}</span>
              <span className="mural-card__meta">
                de {nameOf(entry.workspace)} · {formatAgo(entry.createdAt)}
              </span>
              {entry.note && <span className="mural-card__note">{entry.note}</span>}
              {entry.mediaRef ? (
                <button
                  type="button"
                  className="ui-button ui-button--secondary mural-card__use"
                  disabled={working}
                  onClick={() => void useMuralStore.getState().use(entry.id, workspace).then((id) => id && setBrought((current) => ({ ...current, [entry.id]: id })))}
                  data-testid="mural-use"
                >
                  {working ? "Trazendo…" : done ? "Trazer de novo" : "Trazer para cá"}
                </button>
              ) : (
                <span className="mural-card__text">{entry.text ? "Item de texto: peça ao Maestro para ler (mural_use)." : ""}</span>
              )}
              {(brought[entry.id] || done) && (
                <span className="mural-card__done" data-testid="mural-brought">
                  {brought[entry.id] ? `Trazida como ${brought[entry.id]}` : "Já trazida para cá"}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      {error && (
        <p className="mural__error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
