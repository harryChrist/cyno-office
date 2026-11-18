import { brainShelf, type BrainNoteSummary, type BrainShelf, type BrainSummary, type OfficeState } from "@cyno/shared";
import { useId } from "react";
import { countLabel } from "../../ui/format";
import { AgentRulesBlock } from "./AgentRules";
import { BrainActions } from "./BrainActions";
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
  SHELF_LABELS,
  shelfHint,
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
  // Nota curta que é regra (a fixa `_regras.md` já está na prateleira certa e não precisa do selo).
  const isRule = note.layer !== "fixed" && brainShelf(note) === "regra";
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
          <span className="brain-note__title">
            {pinned ? fixedName(note) : plainTitle(note.title)}
            {isRule && (
              <span className="brain-rule-badge" data-testid="brain-rule-badge">
                regra
              </span>
            )}
          </span>
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

/** Título de uma prateleira, com a dica de uma linha embaixo. */
function ShelfTitle({ shelf, lobby, count }: { shelf: BrainShelf; lobby: boolean; count: number }) {
  return (
    <>
      <p className="brain-group__title">
        {shelf === "regra" && <BrainIcon name="fixa" size={13} />}
        {SHELF_LABELS[shelf]} <span className="brain-group__count">{count}</span>
      </p>
      <p className="brain-group__hint">{shelfHint(shelf, lobby)}</p>
    </>
  );
}

/**
 * Coluna do meio: as notas do Cérebro escolhido em três prateleiras: Regras (entram em toda tarefa),
 * Referência (o agente só vê o título) e Histórico (só por busca; fechado, abre sozinho quando a busca
 * acha algo nele ou a nota aberta é dele). Busca por título, tags e trecho.
 */
export function NoteList({
  workspaceId,
  brain,
  activeFile,
  activeAgentId,
  rulesVersion,
  query,
  onQueryChange,
  now,
  office,
}: {
  workspaceId: string;
  brain: BrainSummary;
  office: OfficeState | null;
  activeFile: string | null;
  /** Agente cujas regras estão abertas no leitor. */
  activeAgentId: string | null;
  /** Muda quando uma regra de agente é salva (a lista do bloco recarrega). */
  rulesVersion: number;
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
  const lobby = brain.kind === "lobby";
  const historyOpen = (searching && groups.registro.length > 0) || groups.registro.some((note) => note.file === activeFile);
  const latestHistory = latestDate(groups.registro);
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
        <BrainActions brain={brain} />
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
            {groups.regra.length > 0 && (
              <div className="brain-group brain-group--fixed" data-testid="brain-group-regra">
                <ShelfTitle shelf="regra" lobby={lobby} count={groups.regra.length} />
                <ul className="brain-notes brain-notes--fixed">{groups.regra.map((note) => item(note, note.layer === "fixed"))}</ul>
              </div>
            )}
            {!searching && !lobby && <AgentRulesBlock workspaceId={workspaceId} brainId={brain.id} office={office} activeAgentId={activeAgentId} version={rulesVersion} />}
            {groups.referencia.length > 0 && (
              <div className="brain-group" data-testid="brain-group-referencia">
                <ShelfTitle shelf="referencia" lobby={lobby} count={groups.referencia.length} />
                <ul className="brain-notes" data-testid="brain-notes">
                  {groups.referencia.map((note) => item(note, note.layer === "fixed"))}
                </ul>
              </div>
            )}
            {groups.registro.length > 0 && (
              <details className="brain-group brain-group--history" open={historyOpen || undefined} data-testid="brain-group-history">
                <summary className="brain-group__title">
                  <BrainIcon name="historico" size={14} className="brain-group__icon" />
                  {SHELF_LABELS.registro} <span className="brain-group__count">{groups.registro.length}</span>
                  {latestHistory && (
                    <span className="brain-group__latest">
                      último <RelativeTime iso={latestHistory} now={now} />
                    </span>
                  )}
                </summary>
                <p className="brain-group__hint">{shelfHint("registro", lobby)}</p>
                <ul className="brain-notes">{groups.registro.map((note) => item(note))}</ul>
              </details>
            )}
          </>
        )}
      </div>
    </section>
  );
}
