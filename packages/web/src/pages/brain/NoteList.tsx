import type { BrainNoteSummary, BrainSummary, OfficeState } from "@cyno/shared";
import { useId } from "react";
import { countLabel } from "../../ui/format";
import { BRAIN_KIND_ICONS, BrainIcon, NOTE_KIND_ICONS } from "./brainIcons";
import {
  absoluteDate,
  BRAIN_KIND_LABELS,
  brainAudience,
  brainHash,
  cleanExcerpt,
  filterNotes,
  fixedName,
  groupNotes,
  latestDate,
  noteKind,
  plainTitle,
  relativeDate,
} from "./brainView";

type ItemProps = { workspaceId: string; brainId: string; note: BrainNoteSummary; activeFile: string | null; now: number; pinned?: boolean };

/** Data relativa ("há 2 h"), com a data completa ao passar o mouse. */
export function RelativeTime({ iso, now, className }: { iso: string; now: number; className?: string }) {
  return (
    <time className={className} dateTime={iso} title={absoluteDate(iso)}>
      {relativeDate(iso, new Date(now))}
    </time>
  );
}

/** Uma nota da lista (link para abrir à direita): ícone do tipo, título, data, tags e o começo do texto. */
function NoteItem({ workspaceId, brainId, note, activeFile, now, pinned }: ItemProps) {
  const kind = noteKind(note);
  const excerpt = cleanExcerpt(note.excerpt, note.title);
  return (
    <li>
      <a
        className={`brain-note brain-note--${kind}${pinned ? " brain-note--pinned" : ""}`}
        href={brainHash(workspaceId, brainId, note.file)}
        aria-current={note.file === activeFile ? "page" : undefined}
        data-testid="brain-note"
        data-layer={note.layer}
      >
        <span className="brain-note__icon" aria-hidden="true">
          <BrainIcon name={NOTE_KIND_ICONS[kind]} size={15} />
        </span>
        <span className="brain-note__main">
          <span className="brain-note__title">{pinned ? fixedName(note) : plainTitle(note.title)}</span>
          {!pinned && (note.date || note.tags.length > 0) && (
            <span className="brain-note__meta">
              {note.date && <RelativeTime className="brain-note__date" iso={note.date} now={now} />}
              {note.tags.map((tag) => (
                <span key={tag} className="brain-tag">
                  #{tag}
                </span>
              ))}
            </span>
          )}
          {excerpt && <span className="brain-note__excerpt">{excerpt}</span>}
        </span>
      </a>
    </li>
  );
}

/**
 * Coluna do meio: as notas do Cérebro escolhido em camadas — as fixas (regras, briefing e índice,
 * que entram em toda tarefa) no topo, as notas curtas e o histórico de tarefas fechado embaixo
 * (abre sozinho quando a busca acha algo nele ou a nota aberta é dele). Busca por título, tags e trecho.
 */
export function NoteList({
  workspaceId,
  brain,
  activeFile,
  query,
  onQueryChange,
  now,
  office,
}: {
  workspaceId: string;
  brain: BrainSummary;
  office: OfficeState | null;
  activeFile: string | null;
  query: string;
  onQueryChange: (query: string) => void;
  now: number;
}) {
  const searchId = useId();
  const titleId = useId();
  const found = filterNotes(brain.notes, query);
  const searching = query.trim() !== "";
  const audience = brainAudience(brain, office);
  const groups = groupNotes(found);
  const latestHistory = latestDate(groups.history);
  const historyOpen = (searching && groups.history.length > 0) || groups.history.some((note) => note.file === activeFile);
  const item = (note: BrainNoteSummary, pinned = false) => (
    <NoteItem key={note.file} workspaceId={workspaceId} brainId={brain.id} note={note} activeFile={activeFile} now={now} pinned={pinned} />
  );

  return (
    <section className={`brain-col brain-col--notes brain-col--${brain.kind}`} aria-labelledby={titleId}>
      <header className="brain-col__head">
        {/* Celular: volta para a lista de Cérebros. */}
        <a className="brain-back" href={brainHash(workspaceId, null)} data-testid="brain-back-brains">
          <BrainIcon name="voltar" size={16} />
          Cérebros
        </a>
        <div className="brain-notes__heading">
          <span className="brain-kind-tile brain-kind-tile--small" aria-hidden="true">
            <BrainIcon name={BRAIN_KIND_ICONS[brain.kind]} size={15} />
          </span>
          <h3 id={titleId} className="brain-notes__name">
            {brain.name}
          </h3>
          <p className="brain-notes__count" role="status">
            {searching
              ? `${countLabel(found.length, "encontrada", "encontradas")} de ${brain.notes.length}`
              : countLabel(brain.notes.length, "nota", "notas")}
          </p>
        </div>
        {/* Tipo do Cérebro e quem o enxerga (a lista de Cérebros no desktop mostra só ícone e nome). */}
        <p className="brain-notes__audience" title={`${BRAIN_KIND_LABELS[brain.kind]} · ${audience}`}>
          <span className="brain-notes__kind">{BRAIN_KIND_LABELS[brain.kind]}</span>
          <span aria-hidden="true">·</span>
          <span className="brain-notes__crew">{audience}</span>
        </p>
        <div className="brain-search">
          <label htmlFor={searchId} className="sr-only">
            Buscar notas
          </label>
          <BrainIcon name="busca" size={15} className="brain-search__icon" />
          <input
            id={searchId}
            className="ui-input brain-search__input"
            type="search"
            value={query}
            placeholder="Buscar por título, #tag ou trecho"
            autoComplete="off"
            onChange={(event) => onQueryChange(event.target.value)}
            data-testid="brain-search"
          />
        </div>
      </header>
      <div className="brain-col__scroll">
        {found.length === 0 ? (
          <p className="brain-empty">{searching ? "Nenhuma nota com esse texto." : "Sem notas ainda. Decisões e documentos que os agentes salvarem aparecem aqui."}</p>
        ) : (
          <>
            {groups.fixed.length > 0 && (
              <div className="brain-group brain-group--fixed" data-testid="brain-group-fixed">
                <p className="brain-group__title" title="Regras, briefing e índice entram em toda tarefa dos agentes deste Cérebro.">
                  <BrainIcon name="fixa" size={13} />
                  Sempre no contexto
                </p>
                <ul className="brain-notes brain-notes--fixed">{groups.fixed.map((note) => item(note, true))}</ul>
              </div>
            )}
            {groups.notes.length > 0 && (
              <div className="brain-group" data-testid="brain-group-notes">
                <p className="brain-group__title">
                  Notas <span className="brain-group__count">{groups.notes.length}</span>
                </p>
                <ul className="brain-notes" data-testid="brain-notes">
                  {groups.notes.map((note) => item(note))}
                </ul>
              </div>
            )}
            {groups.history.length > 0 && (
              <details className="brain-group brain-group--history" open={historyOpen || undefined} data-testid="brain-group-history">
                <summary className="brain-group__title">
                  <BrainIcon name="historico" size={14} className="brain-group__icon" />
                  Histórico de tarefas <span className="brain-group__count">{groups.history.length}</span>
                  {latestHistory && (
                    <span className="brain-group__latest">
                      último <RelativeTime iso={latestHistory} now={now} />
                    </span>
                  )}
                </summary>
                <p className="brain-group__hint">Resultados das tarefas: não entram no contexto dos agentes (eles acham pela busca).</p>
                <ul className="brain-notes">{groups.history.map((note) => item(note))}</ul>
              </details>
            )}
          </>
        )}
      </div>
    </section>
  );
}
