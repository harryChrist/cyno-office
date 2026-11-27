import { BRAIN_FIXED_FILES, type BrainNoteResponse, type BrainSummary, type OfficeState } from "@cyno/shared";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { api, ApiRequestError, describeError } from "../../api/client";
import { BRAIN_KIND_ICONS, BrainIcon, NOTE_KIND_ICONS } from "./brainIcons";
import {
  absoluteDate,
  brainHash,
  cleanNoteBody,
  frontmatterChips,
  frontmatterTags,
  noteKind,
  noteTypeLabel,
  plainTitle,
  relativeDate,
  resolveWiki,
  type NoteRef,
} from "./brainView";
import { RulesEditor } from "./RulesEditor";
import { Markdown } from "../../ui/markdown/Markdown";
import { headingOutline, parseMarkdown } from "../../ui/markdown/markdownTree";

/** Quantos títulos a nota precisa ter para ganhar sumário. */
const TOC_MIN_HEADINGS = 3;

type NoteState = { note: BrainNoteResponse | null; error: string | null };

/**
 * A nota aberta (direita; em tela estreita, a área toda). Monte com `key` = Cérebro + arquivo:
 * cada nota começa do zero e uma resposta atrasada de outra nota nunca aparece aqui.
 */
export function NoteReader({
  workspaceId,
  brainId,
  file,
  brain,
  office,
  wikiIndex,
  now,
  onRulesSaved,
}: {
  workspaceId: string;
  brainId: string;
  file: string;
  brain: BrainSummary | undefined;
  office: OfficeState | null;
  wikiIndex: Map<string, NoteRef[]>;
  /** Agora (ms), para as datas relativas. */
  now: number;
  /** O `_regras.md` foi salvo: a lista de notas recarrega. */
  onRulesSaved: () => void;
}) {
  const [state, setState] = useState<NoteState>({ note: null, error: null });
  const [editing, setEditing] = useState(false);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const titleId = useId();

  useEffect(() => {
    let stale = false;
    api
      .getBrainNote(brainId, file)
      .then((note) => !stale && setState({ note, error: null }))
      .catch((error: unknown) => {
        if (stale) return;
        const message = error instanceof ApiRequestError && error.status === 404 ? "Esta nota não existe (ou foi apagada)." : describeError(error);
        setState({ note: null, error: message });
      });
    return () => {
      stale = true;
    };
  }, [brainId, file]);

  // Leva o foco para o título quando a nota abre (leitor de tela anuncia a nota).
  useEffect(() => {
    if (state.note) titleRef.current?.focus();
  }, [state.note]);

  const wikiHref = useCallback(
    (target: string) => {
      const ref = resolveWiki(wikiIndex, target, brainId);
      return ref ? brainHash(workspaceId, ref.brainId, ref.file) : null;
    },
    [wikiIndex, brainId, workspaceId],
  );

  // Celular: volta para a lista de notas do Cérebro.
  const back = (
    <a className="brain-back brain-reader__back" href={brainHash(workspaceId, brainId)} data-testid="brain-back-notes">
      <BrainIcon name="voltar" size={16} />
      {brain ? brain.name : "Notas"}
    </a>
  );

  if (!state.note) {
    return (
      <article className="brain-col brain-col--reader brain-reader" aria-busy={!state.error} data-testid="brain-reader">
        {back}
        {state.error ? <p className="brain-error">{state.error}</p> : <p className="brain-empty">Abrindo a nota…</p>}
      </article>
    );
  }

  const { note } = state;
  const clean = cleanNoteBody(note.body, note.title);
  // O frontmatter de verdade ganha do que estava colado no corpo.
  const frontmatter = { ...clean.frontmatter, ...note.frontmatter };
  const chips = frontmatterChips(frontmatter, office, (iso) => relativeDate(iso, new Date(now)));
  const tags = frontmatterTags(frontmatter);
  const summary = brain?.notes.find((item) => item.file === note.file);
  const kind = noteKind(summary ?? { file: note.file, layer: note.file.startsWith("historico/") ? "history" : "note" });
  const fixed = summary?.layer === "fixed";
  const isRulesFile = note.file === BRAIN_FIXED_FILES.regras;
  // Sumário (títulos h2/h3) para notas longas; só aparece em tela larga.
  const outline = headingOutline(parseMarkdown(clean.body), titleId);

  return (
    <article
      className={`brain-col brain-col--reader brain-reader brain-reader--${kind}${outline.length >= TOC_MIN_HEADINGS ? " brain-reader--has-toc" : ""}`}
      aria-labelledby={titleId}
      data-testid="brain-reader"
    >
      {back}
      <div className="brain-reader__inner">
        <header className="brain-reader__header">
          <p className="brain-reader__eyebrow">
            <span className="brain-reader__type">
              <BrainIcon name={NOTE_KIND_ICONS[kind]} size={14} />
              {noteTypeLabel(frontmatter, kind)}
            </span>
            {fixed && (isRulesFile || note.file === BRAIN_FIXED_FILES.briefing) && <span className="brain-reader__fixed">Entra em toda tarefa</span>}
          </p>
          <h3 id={titleId} ref={titleRef} tabIndex={-1} className="brain-reader__title" data-testid="brain-reader-title">
            {plainTitle(note.title)}
          </h3>
          <p className="brain-reader__where">
            {brain && <BrainIcon name={BRAIN_KIND_ICONS[brain.kind]} size={13} />}
            <span>{brain?.name ?? brainId}</span>
            <span aria-hidden="true">/</span>
            <span className="brain-reader__file">{note.file}</span>
          </p>
          {isRulesFile && !editing && (
            <div className="brain-reader__tools">
              <button type="button" className="ui-button ui-button--small ui-button--secondary" onClick={() => setEditing(true)} data-testid="brain-rules-edit">
                Editar
              </button>
            </div>
          )}
          {(chips.length > 0 || tags.length > 0) && (
            <ul className="brain-chips" aria-label="Dados da nota">
              {chips.map((chip) => (
                <li key={chip.key} className={`brain-chip brain-chip--${chip.key}`}>
                  <span className="brain-chip__label">{chip.label}</span>{" "}
                  {chip.iso ? (
                    <time dateTime={chip.iso} title={absoluteDate(chip.iso)}>
                      {chip.value}
                    </time>
                  ) : (
                    chip.value
                  )}
                </li>
              ))}
              {tags.map((tag) => (
                <li key={`tag-${tag}`} className="brain-tag">
                  #{tag}
                </li>
              ))}
            </ul>
          )}
        </header>
        {isRulesFile && editing ? (
          <RulesEditor
            testId="brain-rules-editor"
            label={`Regras de ${brain?.name ?? "esta sala"}`}
            initial={clean.body.trim()}
            onCancel={() => setEditing(false)}
            onSave={async (content) => {
              const saved = await api.setBrainRules(brainId, content);
              setState({ note: saved, error: null });
              setEditing(false);
              onRulesSaved();
            }}
          />
        ) : (
          <div className="brain-reader__body" data-testid="brain-reader-body">
            {clean.body.trim() ? <Markdown source={clean.body} resolveWiki={wikiHref} idPrefix={titleId} /> : <p className="brain-empty">Esta nota está vazia.</p>}
          </div>
        )}
        {outline.length >= TOC_MIN_HEADINGS && (
          <nav className="brain-toc" aria-label="Nesta nota" data-testid="brain-toc">
            <p className="brain-toc__title">Nesta nota</p>
            <ul>
              {outline.map((entry) => (
                <li key={entry.id} className={`brain-toc__item brain-toc__item--${entry.level}`}>
                  <button type="button" onClick={() => document.getElementById(entry.id)?.scrollIntoView({ block: "start", behavior: "smooth" })}>
                    {entry.text}
                  </button>
                </li>
              ))}
            </ul>
          </nav>
        )}
      </div>
    </article>
  );
}
