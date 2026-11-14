import { CARD_SUMMARY_MAX, type Card } from "@cyno/shared";
import { useEffect, useId, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { useCynoStore } from "../../store/cynoStore";
import { useNavStore } from "../../store/navStore";
import { WorkspaceForm } from "../../ui/WorkspaceForm";
import { useMuralStore } from "../../store/muralStore";
import { muralBadge, openRequestsOf, requestsBadge } from "./cynoRequests";
import { busyAgents, maestroStatusLabel, modelLabel, nextRoutine, sortCards, teamLine, usageLabel, waitingBadge, workingLines } from "./cynoHome";
import "./cynoHome.css";

/** Abre o workspace (o Office dele): o seletor lembra o último, e os links antigos continuam valendo. */
export function enterWorkspace(workspace: string): void {
  const nav = useNavStore.getState();
  nav.setWorkspace(workspace);
  nav.go("office");
}

/** A frase "o que este workspace faz": texto, ou o campo para escrever (dono). */
function Summary({ card }: { card: Card }) {
  const save = useCynoStore((state) => state.saveSummary);
  const dismiss = useCynoStore((state) => state.dismissProposal);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  const hintId = useId();
  const text = card.summary.summary;
  const proposal = card.summary.proposal;

  useEffect(() => {
    if (editing) field.current?.focus();
  }, [editing]);

  const open = (initial: string) => {
    setDraft(initial);
    setEditing(true);
  };
  const submit = async () => {
    if (saving || draft.trim().length > CARD_SUMMARY_MAX) return;
    setSaving(true);
    const ok = await save(card.workspace, draft);
    setSaving(false);
    if (ok) setEditing(false);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      setEditing(false);
    } else if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit();
    }
  };

  if (editing) {
    const length = draft.trim().length;
    return (
      <div className="wcard__edit" data-testid="card-summary-edit">
        <textarea ref={field} className="wcard__field" rows={3} value={draft} maxLength={CARD_SUMMARY_MAX + 40} onChange={(event) => setDraft(event.currentTarget.value)} onKeyDown={onKeyDown} aria-label={`O que ${card.name} faz`} aria-describedby={hintId} placeholder="Em uma frase: o que este workspace faz e para quem" />
        <div className="wcard__edit-row">
          <span id={hintId} className={`wcard__count${length > CARD_SUMMARY_MAX ? " wcard__count--over" : ""}`}>
            {length}/{CARD_SUMMARY_MAX}
          </span>
          <button type="button" className="ui-button ui-button--ghost wcard__btn" onClick={() => setEditing(false)}>
            Cancelar
          </button>
          <button type="button" className="ui-button wcard__btn wcard__btn--solid" onClick={() => void submit()} disabled={saving || length > CARD_SUMMARY_MAX} data-testid="card-summary-save">
            {saving ? "Salvando…" : "Salvar"}
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="wcard__summary">
      {text ? (
        <p className="wcard__text" data-testid="card-summary">
          {text}
        </p>
      ) : (
        <button type="button" className="wcard__empty" onClick={() => open("")} data-testid="card-summary-empty">
          Escreva o que este workspace faz
        </button>
      )}
      {text && (
        <button type="button" className="wcard__edit-btn" onClick={() => open(text)} aria-label={`Editar a frase de ${card.name}`} title="Editar a frase" data-testid="card-summary-edit-btn">
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
            <path d="M4 20h4l10-10-4-4L4 16v4zM13 7l4 4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" />
          </svg>
        </button>
      )}
      {proposal && (
        <div className="wcard__proposal" data-testid="card-proposal">
          <p className="wcard__proposal-text">
            <strong>{proposal.by === "maestro" ? "O Maestro" : "O Cyno"} sugere:</strong> {proposal.summary}
          </p>
          <div className="wcard__proposal-actions">
            <button type="button" className="ui-button ui-button--ghost wcard__btn" onClick={() => void dismiss(card.workspace)}>
              Ignorar
            </button>
            <button type="button" className="ui-button wcard__btn wcard__btn--solid" onClick={() => void save(card.workspace, proposal.summary)}>
              Usar
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Uma ficha: o que o workspace faz, o que está em andamento, quantos itens esperam você. Clicar entra nele. */
export function WorkspaceCardView({ card, now }: { card: Card; now: Date }) {
  const titleId = useId();
  const working = workingLines(card);
  const more = card.projects.active.length - working.length;
  const routine = nextRoutine(card, now);
  const busy = busyAgents(card);
  const badge = waitingBadge(card);
  const fromCyno = useCynoStore((state) => openRequestsOf(state.requests, card.workspace).length);
  const news = useMuralStore((state) => state.news[card.workspace] ?? 0);
  // O cartão inteiro leva ao workspace; botões e o campo da frase não.
  const onClick = (event: MouseEvent) => {
    if ((event.target as HTMLElement).closest("button, textarea, a, input")) return;
    enterWorkspace(card.workspace);
  };
  return (
    <article className="wcard" aria-labelledby={titleId} onClick={onClick} data-testid="workspace-card" data-workspace={card.workspace}>
      <header className="wcard__head">
        <h3 className="wcard__name" id={titleId}>
          {card.name}
        </h3>
        <span className={`wcard__maestro wcard__maestro--${card.team.maestro.status}`} title={`${maestroStatusLabel(card.team.maestro.status)} · ${modelLabel(card.team.maestro.engine, card.team.maestro.model)}`}>
          <span className="wcard__dot" aria-hidden="true" />
          {maestroStatusLabel(card.team.maestro.status)}
        </span>
      </header>
      <Summary card={card} />
      {news > 0 && (
        <span className="wcard__requests wcard__requests--mural" title="Itens que outros workspaces compartilharam e o Maestro deste ainda não viu (ele fica sabendo quando acordar)" data-testid="card-mural">
          {muralBadge(news)}
        </span>
      )}
      {fromCyno > 0 && (
        <span className="wcard__requests" title="Pedidos que o Cyno enviou a este workspace e ainda estão abertos" data-testid="card-requests">
          {requestsBadge(fromCyno)}
        </span>
      )}
      <dl className="wcard__facts">
        <div className="wcard__fact">
          <dt>Equipe</dt>
          <dd>
            {teamLine(card)}
            {busy > 0 && <span className="wcard__busy"> · {busy} trabalhando</span>}
          </dd>
        </div>
        <div className="wcard__fact">
          <dt>Em andamento</dt>
          <dd>
            {working.length === 0 ? (
              <span className="wcard__muted">Nada agora</span>
            ) : (
              <ul className="wcard__list">
                {working.map((line) => (
                  <li key={line.id}>
                    <span className="wcard__list-text">{line.text}</span>
                    {line.progress && <span className="wcard__progress">{line.progress}</span>}
                  </li>
                ))}
                {more > 0 && <li className="wcard__muted">e mais {more}</li>}
              </ul>
            )}
          </dd>
        </div>
        <div className="wcard__fact">
          <dt>Rotinas</dt>
          <dd>{card.routines.length === 0 ? <span className="wcard__muted">Nenhuma ativa</span> : `${card.routines.length} ${card.routines.length === 1 ? "ativa" : "ativas"}${routine ? ` · ${routine}` : ""}`}</dd>
        </div>
      </dl>
      <footer className="wcard__foot">
        <span className={`wcard__waiting${badge ? " wcard__waiting--on" : ""}`} data-testid="card-waiting">
          {badge || "Nada esperando você"}
        </span>
        <span className="wcard__usage">{usageLabel(card)}</span>
        <button type="button" className="ui-button wcard__enter" onClick={() => enterWorkspace(card.workspace)} aria-label={`Entrar em ${card.name}`} data-testid="card-enter">
          Entrar
        </button>
      </footer>
    </article>
  );
}

/** Sem nenhum workspace: o primeiro nasce aqui mesmo (esta página absorve a antiga tela "sem workspace"). */
function FirstWorkspace() {
  return (
    <div className="wcards__first" data-testid="no-workspace">
      <p className="wcards__eyebrow">Nenhum workspace ainda</p>
      <h3 className="wcards__first-title">Crie o seu primeiro workspace</h3>
      <p className="wcards__first-text">Um workspace é um escritório separado, com salas, agentes, tarefas e Cérebros próprios, coordenados por um Maestro. Use um para cada projeto ou cliente.</p>
      <WorkspaceForm variant="hero" onCreated={(created) => enterWorkspace(created.id)} />
    </div>
  );
}

/** A coluna das fichas: um cartão por workspace (quem espera você primeiro). */
export function WorkspaceCards({ now }: { now: Date }) {
  const cards = useCynoStore((state) => state.cards);
  const loaded = useCynoStore((state) => state.cardsLoaded);
  const [showForm, setShowForm] = useState(false);
  const sorted = sortCards(cards);
  return (
    <section className="wcards" aria-labelledby="wcards-title" data-testid="workspace-cards">
      <header className="wcards__head">
        <h3 className="wcards__title" id="wcards-title">
          Workspaces
        </h3>
        {cards.length > 0 && <span className="wcards__count">{cards.length}</span>}
      </header>
      <div className="wcards__scroll">
        {!loaded ? (
          <p className="wcards__loading">Carregando as fichas…</p>
        ) : cards.length === 0 ? (
          <FirstWorkspace />
        ) : (
          <>
            {sorted.map((card) => (
              <WorkspaceCardView key={card.workspace} card={card} now={now} />
            ))}
            {showForm ? (
              <div className="wcards__new-form" data-testid="new-workspace-form">
                <WorkspaceForm variant="dialog" onCreated={(created) => {
                  setShowForm(false);
                  enterWorkspace(created.id);
                }} onCancel={() => setShowForm(false)} />
              </div>
            ) : (
              <button type="button" className="wcards__new" onClick={() => setShowForm(true)} data-testid="new-workspace">
                <span aria-hidden="true">+</span> Novo workspace
              </button>
            )}
          </>
        )}
      </div>
    </section>
  );
}
