import { MEDIA_LIMITS, type Avatar, type MediaItem, type Task, type UpdateMediaBody } from "@cyno/shared";
import { useEffect, useState, type ReactNode } from "react";
import { api } from "../../api/client";
import { useForYouFocus } from "../../store/forYouFocus";
import { useMuralStore } from "../../store/muralStore";
import { useMediaStore } from "../../store/mediaStore";
import { useTaskFocus } from "../../store/taskFocus";
import { AvatarSprite } from "../../ui/AvatarSprite";
import { copyText } from "../../ui/clipboard";
import { useAsyncAction } from "../../ui/useAsyncAction";
import { formatAgo, formatDateTime, truncate } from "../../ui/format";
import { ConfirmDialog, ErrorText } from "../../ui/widgets";
import { carouselTitle, entryItems, slideInfo, type GalleryEntry, type Located } from "./mediaGroups";
import { positionLabel } from "./mediaNav";
import { MediaStage, MediaThumb, MIcon, useMediaUrl } from "./MediaParts";
import { cameFrom, dimensionsLabel, extensionLabel, formatBytes, KIND_LABELS_SINGULAR, ORIGIN_LABELS, ratioLabel, safeHttpUrl, STATUS_LABELS, statusTone } from "./mediaView";

export type BringAction = { label: string; done: boolean; busy: boolean; onBring: () => void };

/** Onde a mídia está na lista que a grade mostra e como ir para a vizinha (sem fechar a gaveta). */
export type DetailNav = { index: number; total: number; onPrev: (() => void) | null; onNext: (() => void) | null };

type DetailProps = {
  entry: GalleryEntry;
  /** Workspace em que o dono está (as ações de mudar valem só para mídia dele). */
  currentWs: string;
  agentName: (ws: string, id: string) => string;
  agentAvatar: (ws: string, id: string) => Avatar | undefined;
  workspaceName: (id: string) => string;
  tasks: ReadonlyMap<string, Pick<Task, "id" | "prompt" | "projectId" | "work">>;
  projectTitle: (projectId: string | undefined) => string | undefined;
  /** Só nos escopos de outro workspace. */
  bring?: BringAction;
  /** Abre o visualizador em tela cheia neste cartão (com a mídia ativa, se for slide ou versão). */
  onView: (entry: GalleryEntry, activeId: string) => void;
  /** Fecha a gaveta (com a animação de saída). */
  onClose: () => void;
  nav: DetailNav;
  /** Endereço da página com esta mídia aberta (o "Copiar link"). */
  linkTo: (entry: GalleryEntry) => string;
};

type Mode = "view" | "edit" | "publish";

function Block({ title, children, testId, wide = false }: { title: string; children: ReactNode; testId?: string; wide?: boolean }) {
  return (
    <section className={`md-block${wide ? " md-block--wide" : ""}`} aria-label={title} data-testid={testId}>
      <h4 className="md-block__title">{title}</h4>
      {children}
    </section>
  );
}

/**
 * O conteúdo da gaveta de detalhe: a mídia grande no topo e, abaixo, blocos claros com quem fez, de onde veio, os dados do
 * arquivo, as etiquetas, a descrição e as ações. A barra de cima leva anterior/próxima (e as teclas ← →), a posição e o fechar.
 */
export function MediaDetail({ entry, currentWs, agentName, agentAvatar, workspaceName, tasks, projectTitle, bring, onView, onClose, nav, linkTo }: DetailProps) {
  const [activeId, setActiveId] = useState(entry.main.item.id);
  const parts = entryItems(entry);
  const active: Located = parts.find((part) => part.item.id === activeId) ?? entry.main;
  const { item, ws } = active;
  const readOnly = ws !== currentWs;
  const [mode, setMode] = useState<Mode>("view");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [copied, setCopied] = useState(false);
  const action = useAsyncAction();
  const download = useMediaUrl(item, true, ws);
  const fileUrl = useMediaUrl(item, false, ws);
  const publicUrl = safeHttpUrl(item.publishedUrl);
  const task = !readOnly && item.taskId ? tasks.get(item.taskId) : undefined;
  const project = projectTitle(task?.projectId ?? task?.work?.projectId);
  const dimensions = dimensionsLabel(item);
  const ratio = item.width && item.height ? ratioLabel(item.width, item.height) : null;
  const origin = cameFrom(item);
  const isVersion = entry.type === "single" && item !== entry.main.item;
  const title = entry.type === "carousel" ? `${carouselTitle(entry.slides)}` : item.title;
  const avatar = agentAvatar(ws, item.createdBy);
  const who = agentName(ws, item.createdBy);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1800);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const patch = (body: UpdateMediaBody) => action.run(() => useMediaStore.getState().patch(item.id, body));

  // Compartilhar com os outros workspaces (o mural): eles ficam sabendo e podem trazer a mídia.
  const share = () =>
    action.run(async () => {
      await api.shareToMural({ workspace: currentWs, mediaId: item.id });
      await useMuralStore.getState().load();
    });
  const unshare = () =>
    action.run(async () => {
      await useMuralStore.getState().load();
      const found = useMuralStore.getState().entries.find((candidate) => candidate.mediaRef?.workspace === currentWs && candidate.mediaRef.mediaId === item.id);
      if (found) await api.retireFromMural(found.id);
      await useMuralStore.getState().load();
    });
  const copyLink = async () => {
    const ok = await copyText(new URL(linkTo(entry), window.location.href).toString());
    setCopied(ok);
  };

  const hasWhere = !readOnly && (!!item.taskId || (item.forYouIds?.length ?? 0) > 0 || !!item.where || !!publicUrl);
  const facts = [dimensions, ratio, `${extensionLabel(item)} · ${formatBytes(item.size)}`].filter(Boolean).join(" · ");

  return (
    <div className="md-dw" data-testid="media-detail">
      <header className="md-dw__bar">
        <div className="md-dw__nav" role="group" aria-label="Navegar pela lista">
          <button type="button" className="ui-icon-button" onClick={() => nav.onPrev?.()} disabled={!nav.onPrev} aria-label="Mídia anterior" title="Anterior (←)" data-testid="media-prev">
            <MIcon name="back" size={16} />
          </button>
          <span className="md-dw__pos" aria-live="polite" data-testid="media-position">
            {nav.index >= 0 ? positionLabel(nav.index, nav.total) : "Fora da lista"}
          </span>
          <button type="button" className="ui-icon-button" onClick={() => nav.onNext?.()} disabled={!nav.onNext} aria-label="Próxima mídia" title="Próxima (→)" data-testid="media-next">
            <MIcon name="next" size={16} />
          </button>
        </div>
        <span className="md-dw__where">{readOnly ? `De ${workspaceName(ws)} · só para ver` : "Deste workspace"}</span>
        <button type="button" className="ui-icon-button md-dw__close" onClick={onClose} aria-label="Fechar detalhe" title="Fechar (Esc)" data-testid="media-close">
          <MIcon name="close" size={18} />
        </button>
      </header>

      <div className="md-dw__scroll">
        <div className="md-dw__stage" data-kind={item.kind}>
          <MediaStage key={item.id} item={item} workspaceId={ws} onFullscreen={() => onView(entry, item.id)} />
          <button type="button" className="md-dw__full" onClick={() => onView(entry, item.id)} aria-label="Abrir em tela cheia" title="Abrir em tela cheia" data-testid="media-fullscreen">
            <MIcon name="zoom" size={15} />
            Tela cheia
          </button>
        </div>

        {entry.type === "carousel" && (
          <section className="md-parts" aria-label="Slides">
            <h4 className="md-parts__title">{entry.slides.length} slides</h4>
            <ul className="md-parts__row">
              {entry.slides.map((slide, index) => (
                <li key={slide.item.id}>
                  <button type="button" className="md-part" aria-pressed={slide.item.id === item.id} onClick={() => setActiveId(slide.item.id)} aria-label={`Ver o slide ${slideInfo(slide.item.title)?.n ?? index + 1}`}>
                    <MediaThumb item={slide.item} workspaceId={slide.ws} />
                    <span className="md-part__n">{slideInfo(slide.item.title)?.n ?? index + 1}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
        {entry.type === "single" && entry.versions.length > 0 && (
          <section className="md-parts" aria-label="Versões" data-testid="media-versions">
            <h4 className="md-parts__title">{entry.versions.length + 1} versões</h4>
            <ul className="md-parts__row">
              {parts.map((part, index) => (
                <li key={part.item.id}>
                  <button type="button" className="md-part" aria-pressed={part.item.id === item.id} onClick={() => setActiveId(part.item.id)} aria-label={index === 0 ? "Ver a versão atual" : `Ver a versão descartada de ${formatAgo(part.item.createdAt)}`}>
                    <MediaThumb item={part.item} workspaceId={part.ws} />
                    <span className="md-part__n">{index === 0 ? "Atual" : formatAgo(part.item.createdAt)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        <div className="md-dw__body">
          {mode === "edit" ? (
            <EditForm
              item={item}
              pending={action.pending}
              error={action.error}
              onCancel={() => {
                action.clearError();
                setMode("view");
              }}
              onSave={async (body) => {
                if (await patch(body)) setMode("view");
              }}
            />
          ) : (
            <>
              <div className="md-dw__head">
                <h3 className="md-dw__title">{entry.type === "carousel" ? `${title} · slide ${slideInfo(item.title)?.n ?? ""}`.trim() : title}</h3>
                <span className={`md-state md-state--${statusTone(item.status)}`}>
                  <span className="md-state__dot" aria-hidden="true" />
                  {STATUS_LABELS[item.status]}
                  {isVersion ? " (versão antiga)" : ""}
                </span>
              </div>
              <p className="md-dw__facts" data-testid="media-facts">
                {facts}
              </p>
            </>
          )}
          {item.shared && !readOnly && (
            <p className="md-detail__shared" data-testid="media-shared">
              Compartilhada com os outros workspaces{item.shared.note ? ` · ${item.shared.note}` : ""}
            </p>
          )}

          {mode === "view" && (
            <div className="md-blocks">
              <Block title="Quem fez" testId="media-who" wide={(item.tags?.length ?? 0) === 0}>
                <div className="md-who">
                  {avatar ? (
                    <span className="md-who__avatar">
                      <AvatarSprite avatar={avatar} seedId={item.createdBy} size={36} framing="head" />
                    </span>
                  ) : (
                    <span className="md-who__avatar md-who__avatar--none" aria-hidden="true">
                      {who.slice(0, 1).toUpperCase()}
                    </span>
                  )}
                  <span className="md-who__text">
                    <strong>{who}</strong>
                    <span>
                      {ORIGIN_LABELS[item.origin]} · {formatAgo(item.createdAt)}
                    </span>
                  </span>
                </div>
              </Block>

              {(item.tags?.length ?? 0) > 0 && (
                <Block title="Etiquetas" testId="media-tags">
                  <ul className="md-chips">
                    {item.tags!.map((tag) => (
                      <li key={tag} className="md-tag">
                        {tag}
                      </li>
                    ))}
                  </ul>
                </Block>
              )}

              <Block title="Informações" wide>
                <dl className="md-meta md-meta--grid">
                  <div>
                    <dt>Workspace</dt>
                    <dd>{workspaceName(ws)}</dd>
                  </div>
                  {project && (
                    <div>
                      <dt>Projeto</dt>
                      <dd>{project}</dd>
                    </div>
                  )}
                  <div>
                    <dt>Criada em</dt>
                    <dd>{formatDateTime(item.createdAt)}</dd>
                  </div>
                  <div>
                    <dt>Tamanho</dt>
                    <dd>{formatBytes(item.size)}</dd>
                  </div>
                  {dimensions && (
                    <div>
                      <dt>Dimensões</dt>
                      <dd>
                        {dimensions}
                        {ratio ? ` · ${ratio}` : ""}
                      </dd>
                    </div>
                  )}
                  <div>
                    <dt>Tipo</dt>
                    <dd>
                      {KIND_LABELS_SINGULAR[item.kind]} · {item.mime}
                    </dd>
                  </div>
                  {item.folder && (
                    <div className="md-meta__wide">
                      <dt>Pasta</dt>
                      <dd data-testid="media-detail-folder">{item.folder.split("/").join(" / ")}</dd>
                    </div>
                  )}
                  <div className="md-meta__wide">
                    <dt>Arquivo</dt>
                    <dd className="md-meta__file">
                      {item.fileName} · {item.id}
                    </dd>
                  </div>
                </dl>
              </Block>

              {item.note && !origin && (
                <Block title="Descrição" testId="media-note" wide>
                  <p className="md-detail__note">{item.note}</p>
                </Block>
              )}

              <Block title="De onde veio" testId="media-where" wide>
                <ul className="md-where__list">
                  {origin && (
                    <li className="md-where__text" data-testid="media-came-from">
                      <MIcon name="download" size={14} />
                      <span>
                        Veio de {origin.workspace}
                        {origin.mediaId ? ` (${origin.mediaId})` : ""}
                      </span>
                    </li>
                  )}
                  {readOnly && (
                    <li className="md-where__text">
                      <MIcon name="inbox" size={14} />
                      <span>Guardada em {workspaceName(ws)}</span>
                    </li>
                  )}
                  {!readOnly && item.taskId && (
                    <li>
                      <button type="button" className="md-where__link" onClick={() => useTaskFocus.getState().open(item.taskId!)} data-testid="media-open-task">
                        <MIcon name="task" size={14} />
                        <span>Tarefa · {task ? truncate(task.prompt.split("\n")[0] ?? "", 70) : item.taskId.slice(0, 8)}</span>
                      </button>
                    </li>
                  )}
                  {!readOnly &&
                    item.forYouIds?.map((id) => (
                      <li key={id}>
                        <button type="button" className="md-where__link" onClick={() => useForYouFocus.getState().open(id)} data-testid={`media-open-foryou-${id}`}>
                          <MIcon name="inbox" size={14} />
                          <span>Aprovação · {id}</span>
                        </button>
                      </li>
                    ))}
                  {item.where && (
                    <li className="md-where__text">
                      <MIcon name="link" size={14} />
                      <span>{item.where}</span>
                    </li>
                  )}
                  {publicUrl && (
                    <li>
                      <a className="md-where__link" href={publicUrl} target="_blank" rel="noreferrer noopener" data-testid="media-open-published">
                        <MIcon name="link" size={14} />
                        <span>Abrir publicação</span>
                      </a>
                    </li>
                  )}
                </ul>
                {!hasWhere && !readOnly && !origin && <p className="md-where__empty">Ainda não está ligada a nenhuma tarefa, aprovação ou publicação.</p>}
              </Block>
            </div>
          )}

          {mode === "publish" && (
            <PublishForm
              initial={item.publishedUrl ?? ""}
              pending={action.pending}
              error={action.error}
              onCancel={() => {
                action.clearError();
                setMode("view");
              }}
              onSave={async (url) => {
                if (await patch({ status: "publicado", publishedUrl: url || null })) setMode("view");
              }}
            />
          )}

          {mode === "view" && (
            <div className="md-actions">
              {readOnly && bring && (
                <button type="button" className="ui-button md-actions__main" disabled={bring.done || bring.busy} onClick={bring.onBring} data-testid="media-bring">
                  <MIcon name={bring.done ? "check" : "download"} />
                  {bring.done ? "Já está neste workspace" : bring.busy ? "Trazendo…" : bring.label}
                </button>
              )}
              {download && (
                <a className="ui-button ui-button--secondary" href={download} data-testid="media-download">
                  <MIcon name="download" />
                  Baixar
                </a>
              )}
              <button type="button" className="ui-button ui-button--secondary" onClick={() => void copyLink()} data-testid="media-copy-link">
                <MIcon name={copied ? "check" : "link"} />
                {copied ? "Link copiado" : "Copiar link"}
              </button>
              {fileUrl && (
                <a className="ui-button ui-button--secondary" href={fileUrl} target="_blank" rel="noreferrer noopener" data-testid="media-open-tab">
                  <MIcon name="eye" />
                  Nova aba
                </a>
              )}
              {!readOnly && (
                <>
                  {item.status === "rascunho" && (
                    <button type="button" className="ui-button ui-button--secondary" onClick={() => void patch({ status: "aprovado" })} disabled={action.pending} data-testid="media-approve">
                      <MIcon name="check" />
                      Aprovar
                    </button>
                  )}
                  {item.status !== "publicado" && item.status !== "descartado" && (
                    <button type="button" className="ui-button" onClick={() => setMode("publish")} data-testid="media-publish">
                      <MIcon name="link" />
                      Marcar como publicado
                    </button>
                  )}
                  {item.status === "publicado" && (
                    <button type="button" className="ui-button ui-button--secondary" onClick={() => setMode("publish")}>
                      <MIcon name="link" />
                      Mudar o link
                    </button>
                  )}
                  {item.shared ? (
                    <button type="button" className="ui-button ui-button--secondary" onClick={() => void unshare()} disabled={action.pending} data-testid="media-unshare" title={`Compartilhada com os outros workspaces${item.shared.note ? `: ${item.shared.note}` : ""}`}>
                      <MIcon name="link" />
                      Parar de compartilhar
                    </button>
                  ) : (
                    item.status !== "descartado" && (
                      <button type="button" className="ui-button ui-button--secondary" onClick={() => void share()} disabled={action.pending} data-testid="media-share" title="Os outros workspaces ficam sabendo e podem trazer esta mídia para a biblioteca deles">
                        <MIcon name="link" />
                        Compartilhar com os outros workspaces
                      </button>
                    )
                  )}
                  <button type="button" className="ui-button ui-button--secondary" onClick={() => setMode("edit")} data-testid="media-edit">
                    <MIcon name="edit" />
                    Editar título e nota
                  </button>
                  {item.status === "descartado" ? (
                    <button type="button" className="ui-button ui-button--secondary" onClick={() => void patch({ status: "rascunho" })} disabled={action.pending} data-testid="media-restore">
                      Restaurar como rascunho
                    </button>
                  ) : (
                    <button type="button" className="ui-button ui-button--secondary" onClick={() => void patch({ status: "descartado" })} disabled={action.pending} data-testid="media-discard">
                      Descartar
                    </button>
                  )}
                  <button type="button" className="ui-button ui-button--danger" onClick={() => setConfirmDelete(true)} data-testid="media-delete">
                    <MIcon name="trash" />
                    Excluir
                  </button>
                </>
              )}
            </div>
          )}
          {mode === "view" && <ErrorText>{action.error}</ErrorText>}
        </div>
      </div>

      {confirmDelete && (
        <ConfirmDialog
          title="Excluir esta mídia?"
          message={
            <p>
              “{item.title}” será apagada da biblioteca e o arquivo também. Isso não dá para desfazer.
              {(item.forYouIds?.length ?? 0) > 0 && " Ela está anexada a itens de Aprovações."}
            </p>
          }
          confirmLabel="Excluir"
          testId="media-delete-dialog"
          onClose={() => setConfirmDelete(false)}
          onConfirm={async () => {
            await useMediaStore.getState().remove(item.id);
            onClose();
          }}
        />
      )}
    </div>
  );
}

function EditForm({ item, pending, error, onSave, onCancel }: { item: MediaItem; pending: boolean; error: string | null; onSave: (body: { title: string; note: string | null; where: string | null }) => Promise<void>; onCancel: () => void }) {
  const [title, setTitle] = useState(item.title);
  const [note, setNote] = useState(item.note ?? "");
  const [where, setWhere] = useState(item.where ?? "");
  const valid = title.trim().length > 0;
  return (
    <form
      className="md-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (valid) void onSave({ title: title.trim(), note: note.trim() || null, where: where.trim() || null });
      }}
      data-testid="media-edit-form"
    >
      <label className="md-form__field">
        <span>Título</span>
        <input className="ui-input" value={title} maxLength={MEDIA_LIMITS.title} onChange={(event) => setTitle(event.target.value)} autoFocus />
      </label>
      <label className="md-form__field">
        <span>Nota</span>
        <textarea className="ui-input" rows={3} value={note} maxLength={MEDIA_LIMITS.note} onChange={(event) => setNote(event.target.value)} placeholder="Para que serve, o que lembrar…" />
      </label>
      <label className="md-form__field">
        <span>Onde foi usada</span>
        <input className="ui-input" value={where} maxLength={MEDIA_LIMITS.where} onChange={(event) => setWhere(event.target.value)} placeholder="Ex.: Post do LinkedIn de segunda" />
      </label>
      <ErrorText>{error}</ErrorText>
      <div className="md-form__actions">
        <button type="button" className="ui-button ui-button--secondary" onClick={onCancel}>
          Cancelar
        </button>
        <button type="submit" className="ui-button" disabled={!valid || pending}>
          {pending ? "Salvando…" : "Salvar"}
        </button>
      </div>
    </form>
  );
}

function PublishForm({ initial, pending, error, onSave, onCancel }: { initial: string; pending: boolean; error: string | null; onSave: (url: string) => Promise<void>; onCancel: () => void }) {
  const [url, setUrl] = useState(initial);
  const trimmed = url.trim();
  const invalid = trimmed !== "" && !safeHttpUrl(trimmed);
  return (
    <form
      className="md-form md-form--publish"
      onSubmit={(event) => {
        event.preventDefault();
        if (!invalid) void onSave(trimmed);
      }}
      data-testid="media-publish-form"
    >
      <label className="md-form__field">
        <span>Link da publicação (opcional)</span>
        <input className="ui-input" type="url" inputMode="url" value={url} maxLength={MEDIA_LIMITS.url} onChange={(event) => setUrl(event.target.value)} placeholder="https://www.linkedin.com/posts/…" autoFocus aria-invalid={invalid} />
      </label>
      {invalid && <ErrorText>Use um endereço que comece com http:// ou https://.</ErrorText>}
      <ErrorText>{error}</ErrorText>
      <div className="md-form__actions">
        <button type="button" className="ui-button ui-button--secondary" onClick={onCancel}>
          Cancelar
        </button>
        <button type="submit" className="ui-button" disabled={invalid || pending}>
          {pending ? "Salvando…" : "Marcar como publicado"}
        </button>
      </div>
    </form>
  );
}
