import { FOR_YOU_STATUS_LABELS, formatCharCount, type ForYouDecisionStatus, type ForYouItem, type ForYouRuleScope, type RejectionCategory, type RoutineApprovalOverrides, type Task } from "@cyno/shared";
import { useId, useMemo, useState, type KeyboardEvent, type Ref } from "react";
import { formatDateTime, TASK_STATUS_LABELS } from "../../ui/format";
import { Linkify } from "../../ui/Linkify";
import { useAsyncAction } from "../../ui/useAsyncAction";
import { ConfirmDialog, ErrorText } from "../../ui/widgets";
import {
  approvalConfirm,
  cardTitle,
  counterState,
  crivoTone,
  extraMeta,
  overLimitWarning,
  primaryAction,
  typeDisplay,
  typeStyle,
  type BatchProgress,
  type CardDraft,
  type OverLimitConfirm,
  type TypeList,
} from "./forYouView";
import { BatchBar } from "./BatchBar";
import { Icon } from "./icons";
import { CancelledNote, ItemMenu, UpdatedChip, UpdateHistory, type DiscardHandler } from "./ItemExtras";
import { MediaStrip } from "../media/MediaStrip";
import { ItemContext } from "./ItemContext";
import { joinOptions, shortOptionLabel, splitOptions } from "./options";
import { RejectionCategories } from "./RejectionCategories";

/** Ctrl no Windows/Linux, ⌘ no Mac (só o rótulo; o atalho aceita os dois). */
export const MOD_KEY = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl";

export type DecisionValues = { text?: string; response?: string; /** Recusa: por que o usuário recusou (volta ao agente para refazer). */ reason?: string; /** Recusa: a categoria rápida do motivo (opcional). */ category?: RejectionCategory; routine?: RoutineApprovalOverrides; /** Cartão da sprint, ao devolver: as tarefas entregues que voltam como retrabalho. */ returnRefs?: string[]; /** Cartão da regra, ao aprovar: o texto e o escopo que o dono ajustou. */ rule?: { text?: string; scope?: ForYouRuleScope } };

type ForYouCardProps = {
  item: ForYouItem;
  /** Tipos do workspace (nome, ícone, cor, limites e comportamento do card). */
  types: TypeList;
  agentName?: string;
  roomName?: string;
  /** A tarefa ligada (undefined se o item não tem tarefa ou ela sumiu). */
  linkedTask?: Task;
  draft: CardDraft;
  onDraft: (id: string, draft: CardDraft) => void;
  onDecide: (item: ForYouItem, status: ForYouDecisionStatus, values: DecisionValues) => Promise<unknown>;
  onCopy: (item: ForYouItem, text: string) => void;
  onUndoEdit: (item: ForYouItem, previous: string) => void;
  /** "Descartar" (menu ⋯ do card pendente). */
  onDiscard: DiscardHandler;
  /** O item é de um lote: a faixa "3 de 10 decididos" com "Aprovar todos" / "Recusar todos". */
  batch?: { progress: BatchProgress; onApproveAll: () => Promise<unknown>; onRejectAll: (reason: string) => Promise<unknown> };
  cardRef?: Ref<HTMLElement>;
};

function Counter({ item, text, types }: { item: ForYouItem; text: string; types: TypeList }) {
  const counter = counterState(item, text, types);
  const number = (value: number) => value.toLocaleString("pt-BR");
  if (!counter.limit) {
    return <p className="fy-counter">{number(counter.length)} caracteres</p>;
  }
  return (
    <p className={`fy-counter fy-counter--${counter.tone}`} data-testid="foryou-counter">
      <span className="fy-counter__track" aria-hidden="true">
        <span className="fy-counter__fill" style={{ width: `${(counter.fill * 100).toFixed(1)}%` }} />
      </span>
      <span>
        {number(counter.length)} / {number(counter.limit.max)}
      </span>
      <span className="sr-only">{counter.over > 0 ? `passou ${number(counter.over)} do limite de ${counter.limit.name}` : `limite de ${counter.limit.name}`}</span>
      {counter.over > 0 && <span aria-hidden="true">· passou {number(counter.over)}</span>}
    </p>
  );
}

/** Aviso claro, perto do contador, quando o texto passa do limite do tipo. */
function OverLimitWarning({ item, text, types }: { item: ForYouItem; text: string; types: TypeList }) {
  const warning = overLimitWarning(item, text, types);
  if (!warning) return null;
  return (
    <p className="fy-limit-warning" role="status" data-testid="foryou-over-limit">
      <Icon name="alert" size={14} />
      {warning}. Dá para aprovar assim mesmo, mas a plataforma pode cortar ou recusar o texto.
    </p>
  );
}

/** Aviso quando a tarefa ligada não espera mais por este item (reaberto, cancelada…). */
function linkedTaskNote(item: ForYouItem, task: Task | undefined): string | null {
  if (item.status !== "pendente" || !item.taskId) return null;
  if (!task) return "A tarefa deste item não existe mais: decidir aqui só muda o item.";
  if (task.status === "waiting_approval") return null;
  return `A tarefa já está "${TASK_STATUS_LABELS[task.status]}": decidir aqui só muda o item.`;
}

/**
 * Card de um item: tipo, id e status; título; chips (agente, crivo, editado, decidido em); o
 * "por quê"; metadados; o texto que vai sair (editável, com limite) ou a pergunta; a nota ou a
 * resposta; e as ações. Ctrl/⌘+Enter faz a ação principal e Esc sai do campo de texto.
 */
export function ForYouCard({ item, types, agentName, roomName, linkedTask, draft, onDraft, onDecide, onCopy, onUndoEdit, onDiscard, batch, cardRef }: ForYouCardProps) {
  const baseId = useId();
  const titleId = `${baseId}-t`;
  const { pending, error, run, clearError } = useAsyncAction();
  const [localError, setLocalError] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  /** "Recusar" clicado: o campo "Por que está recusando?" aberto, esperando a confirmação. */
  const [rejecting, setRejecting] = useState(false);
  /** Recusa: a categoria rápida escolhida (opcional). */
  const [category, setCategory] = useState<RejectionCategory | null>(null);
  /** Aprovar acima do limite: o diálogo de confirmação aberto (com os valores a enviar). */
  const [overConfirm, setOverConfirm] = useState<{ info: OverLimitConfirm; values: DecisionValues } | null>(null);
  const open = item.status === "pendente";
  const type = typeDisplay(types, item.type);
  const question = type.behavior === "pergunta";
  const editable = open && !question;
  const text = draft.text ?? item.text;
  const response = draft.response ?? (open ? "" : (item.response ?? ""));
  const reason = draft.reason ?? "";
  const changed = editable && text !== item.originalText;
  // Várias opções num texto só: abas para ver uma por vez (só apresentação; o texto segue sendo um campo único).
  const options = useMemo(() => (editable ? splitOptions(text) : null), [editable, text]);
  const [pickedOption, setOption] = useState(0);
  const activeOption = options ? Math.min(pickedOption, options.parts.length - 1) : -1;
  const shown = options && activeOption >= 0 ? options.parts[activeOption]!.body : text;
  const primary = primaryAction(item, types);
  const crivo = item.meta.crivo ?? item.meta.Crivo;
  const simulated = item.meta.simulado !== undefined;
  const extras = extraMeta(item);
  const note = linkedTaskNote(item, linkedTask);


  const draftHead = !question && (
    <div className="fy-draft-head" aria-hidden="true">
      <span className="fy-avatar fy-avatar--agent">{(agentName?.trim()[0] ?? "A").toUpperCase()}</span>
      <span className="fy-draft-head__who">
        <strong>{agentName ?? "Agente"}</strong>
        <span>{item.to ? `Para ${item.to}` : `Rascunho de ${type.name.toLowerCase()}`}</span>
      </span>
    </div>
  );

  const decide = async (status: ForYouDecisionStatus) => {
    setLocalError(null);
    clearError();
    if (status === "respondido" && !response.trim()) {
      setLocalError("Escreva a resposta antes de enviar.");
      document.getElementById(`${baseId}-r`)?.focus();
      return;
    }
    if (status === "aprovado" && editable && !text.trim()) {
      setLocalError("O texto não pode ficar vazio.");
      return;
    }
    const values: DecisionValues = {};
    if (editable) values.text = text;
    if (open && response.trim()) values.response = response;
    if (status === "rejeitado" && reason.trim()) values.reason = reason.trim();
    if (status === "rejeitado" && category) values.category = category;
    // Acima do limite não bloqueia: pede confirmação (vale para o botão e para o Ctrl/⌘+Enter).
    const confirm = editable ? approvalConfirm(item, status, text, types) : null;
    if (confirm) {
      setOverConfirm({ info: confirm, values });
      return;
    }
    await run(() => onDecide(item, status, values));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && open && !pending && !overConfirm) {
      event.preventDefault();
      void decide(rejecting ? "rejeitado" : primary.status);
      return;
    }
    if (event.key === "Escape" && event.target instanceof HTMLTextAreaElement) {
      event.preventDefault();
      (event.currentTarget as HTMLElement).focus();
    }
  };

  return (
    <article
      ref={cardRef}
      className="fy-card"
      style={typeStyle(type)}
      data-type={item.type}
      tabIndex={-1}
      aria-labelledby={titleId}
      aria-busy={pending || undefined}
      onKeyDown={onKeyDown}
      data-item-id={item.id}
      data-status={item.status}
      data-testid={`foryou-card-${item.id}`}
    >
      {batch && <BatchBar batch={batch.progress} onApproveAll={batch.onApproveAll} onRejectAll={batch.onRejectAll} />}

      <div className="fy-card__top">
        <span className="fy-type-chip">
          <Icon name={type.icon} size={14} />
          {type.name}
        </span>
        <span className="fy-card__id">{item.id}</span>
        <span className={`fy-status fy-status--${item.status}`} data-testid="foryou-status">
          {FOR_YOU_STATUS_LABELS[item.status]}
        </span>
        <ItemMenu item={item} onDiscard={onDiscard} />
      </div>

      <h3 id={titleId} className="fy-card__title">
        <Linkify text={cardTitle(item, agentName, types)} />
      </h3>

      <ul className="fy-chips" aria-label="Detalhes">
        {agentName && (
          <li title="Agente que preparou">
            <Icon name="agent" size={12} />
            {agentName}
            {roomName ? ` · ${roomName}` : ""}
          </li>
        )}
        {crivo && (
          <li className={`fy-chip--crivo-${crivoTone(crivo)}`}>
            {crivoTone(crivo) === "ok" && <Icon name="check" size={12} />}
            {crivoTone(crivo) === "no" && <Icon name="cross" size={12} />}
            Crivo: {crivo.toLowerCase()}
          </li>
        )}
        {simulated && <li title={item.meta.simulado}>Simulado</li>}
        {item.decidedBy === "automatico" && (
          <li className="fy-chip--auto" title={item.meta["Modo Automático"] ?? "Aprovado pelo Modo Automático do projeto"} data-testid="foryou-auto-chip">
            <Icon name="check" size={12} />
            Decidido sozinho
          </li>
        )}
        {item.status === "pendente" && item.meta["Modo Automático"] && (
          <li className="fy-chip--auto-note" data-testid="foryou-auto-note">
            Automático: {item.meta["Modo Automático"]}; pede o seu OK
          </li>
        )}
        {item.editedByUser && (
          <li className="fy-chip--edited">
            <Icon name="pencil" size={12} />
            Editado por você
          </li>
        )}
        <UpdatedChip item={item} agentName={agentName} open={historyOpen} onToggle={() => setHistoryOpen((current) => !current)} />
        {item.decidedAt && item.status !== "cancelado" && (
          <li>
            <Icon name="clock" size={12} />
            Decidido em {formatDateTime(item.decidedAt)}
          </li>
        )}
      </ul>
      {historyOpen && <UpdateHistory item={item} agentName={agentName} />}
      <CancelledNote item={item} agentName={agentName} />

      {/* O original em que o rascunho se baseia (some quando não há fonte nem link). */}
      <ItemContext item={item} />

      {/* A mídia do pedido (a arte do post, o vídeo…), logo acima do rascunho. */}
      <MediaStrip ids={item.mediaIds} />

      {item.why && (
        <p className="fy-card__why">
          <span className="fy-card__why-label">Por quê</span>
          <Linkify text={item.why} />
        </p>
      )}

      {extras.length > 0 && (
        <dl className="fy-card__extra">
          {extras.map(([key, value]) => (
            <div key={key}>
              <dt>{key}</dt>
              <dd>
                <Linkify text={value} />
              </dd>
            </div>
          ))}
        </dl>
      )}

      {editable ? (
        <div className={`fy-field${changed ? " fy-field--changed" : ""}${counterState(item, text, types).tone === "passou" ? " fy-field--over" : ""}`}>
          <div className="fy-field__top">
            <label htmlFor={`${baseId}-x`} className="fy-field__label">
              Rascunho <span className="fy-field__hint">· é isto que vai sair; pode editar</span>
            </label>
            {changed && <span className="fy-edited-mark">Editado</span>}
            {changed && (
              <button type="button" className="fy-undo" onClick={() => onUndoEdit(item, text)} data-testid="foryou-undo-edit">
                <Icon name="undo" />
                Desfazer edição
              </button>
            )}
          </div>
          {options && (
            <div className="fy-options" role="tablist" aria-label="Opções do texto" data-testid="foryou-options">
              {options.parts.map((part, index) => (
                <button
                  key={index}
                  type="button"
                  role="tab"
                  className="fy-options__tab"
                  aria-selected={activeOption === index}
                  title={part.label}
                  onClick={() => setOption(index)}
                >
                  {activeOption === index ? part.label : shortOptionLabel(part.label)}
                </button>
              ))}
              <button type="button" role="tab" className="fy-options__tab fy-options__tab--all" aria-selected={activeOption === -1} onClick={() => setOption(-1)}>
                Texto inteiro
              </button>
            </div>
          )}
          {draftHead}
          <textarea
            id={`${baseId}-x`}
            className="ui-input fy-textarea"
            value={shown}
            rows={3}
            spellCheck
            onChange={(event) => {
              const value = event.currentTarget.value;
              onDraft(item.id, { ...draft, text: options && activeOption >= 0 ? joinOptions(options, activeOption, value) : value });
            }}
            data-testid="foryou-text"
          />
          <Counter item={item} text={text} types={types} />
          <OverLimitWarning item={item} text={text} types={types} />
        </div>
      ) : (
        <div className="fy-field">
          <div className="fy-field__top">
            <span className="fy-field__label">{question ? "Pergunta" : open || item.status === "cancelado" ? "Texto" : "Texto decidido"}</span>
          </div>
          {draftHead}
          <div className="fy-readonly" data-testid="foryou-readonly">
            <Linkify text={item.text} />
          </div>
          {!question && <Counter item={item} text={item.text} types={types} />}
        </div>
      )}

      {open ? (
        <div className="fy-field">
          <div className="fy-field__top">
            <label htmlFor={`${baseId}-r`} className="fy-field__label">
              {question ? "Sua resposta" : "Nota para o time"} <span className="fy-field__hint">{question ? "· obrigatória" : "· opcional"}</span>
            </label>
          </div>
          <textarea
            id={`${baseId}-r`}
            className="ui-input fy-textarea fy-textarea--note"
            value={response}
            rows={question ? 4 : 2}
            placeholder={question ? "Escreva aqui. Se a pergunta for numerada, responda com os mesmos números." : "Ex.: troque a palavra X por Y."}
            aria-required={question || undefined}
            onChange={(event) => {
              setLocalError(null);
              onDraft(item.id, { ...draft, response: event.currentTarget.value });
            }}
            data-testid="foryou-response"
          />
        </div>
      ) : (
        item.response && (
          <div className="fy-field">
            <div className="fy-field__top">
              <span className="fy-field__label">{question ? "Sua resposta" : "Sua nota"}</span>
            </div>
            <div className="fy-readonly">
              <Linkify text={item.response} />
            </div>
          </div>
        )
      )}

      {open && rejecting && (
        <div className="fy-field fy-field--reject" data-testid="foryou-reject-box">
          <div className="fy-field__top">
            <label htmlFor={`${baseId}-m`} className="fy-field__label">
              Por que está recusando? <span className="fy-field__hint">· opcional, mas ajuda o agente a refazer</span>
            </label>
          </div>
          <RejectionCategories value={category} onChange={setCategory} disabled={pending} />
          <textarea
            id={`${baseId}-m`}
            className="ui-input fy-textarea fy-textarea--note"
            value={reason}
            rows={2}
            autoFocus
            placeholder="Ex.: ficou formal demais; escreva em tom direto e sem emojis."
            onChange={(event) => onDraft(item.id, { ...draft, reason: event.currentTarget.value })}
            data-testid="foryou-reject-reason"
          />
          <p className="fy-field__hint fy-field__hint--block">Com o motivo, o texto volta para o mesmo agente refazer (até 2 vezes); sem ele, o Maestro decide o que fazer.</p>
        </div>
      )}
      {!open && item.rejection?.reason && (
        <div className="fy-field fy-field--reject" data-testid="foryou-rejection">
          <div className="fy-field__top">
            <span className="fy-field__label">Motivo da recusa</span>
          </div>
          <div className="fy-readonly">
            <Linkify text={item.rejection.reason} />
          </div>
        </div>
      )}
      {note && <p className="fy-card__note">{note}</p>}
      <ErrorText testId="foryou-error">{localError ?? error}</ErrorText>

      <div className="fy-actions">
        <button type="button" className="ui-button ui-button--ghost ui-button--small" onClick={() => onCopy(item, editable ? text : item.text)} data-testid="foryou-copy">
          <Icon name="copy" />
          Copiar texto
        </button>
        <span className="fy-actions__space" />
        {open && !question && rejecting && (
          <>
            <button type="button" className="ui-button ui-button--ghost" onClick={() => { setRejecting(false); setCategory(null); }} disabled={pending} data-testid="foryou-reject-back">
              Voltar
            </button>
            <button type="button" className="ui-button ui-button--danger" onClick={() => void decide("rejeitado")} disabled={pending} aria-keyshortcuts="Control+Enter Meta+Enter" data-testid="foryou-reject-confirm">
              <Icon name="cross" />
              {pending ? "Enviando…" : "Confirmar recusa"}
              <kbd className="fy-kbd">{MOD_KEY}+Enter</kbd>
            </button>
          </>
        )}
        {open && !question && !rejecting && (
          <button type="button" className="ui-button ui-button--ghost fy-reject" onClick={() => setRejecting(true)} disabled={pending} data-testid="foryou-reject">
            <Icon name="cross" />
            Recusar
          </button>
        )}
        {open && !rejecting && (
          <button
            type="button"
            className={`ui-button ${question ? "" : "ui-button--success"}`}
            onClick={() => void decide(primary.status)}
            disabled={pending}
            aria-keyshortcuts="Control+Enter Meta+Enter"
            data-testid={question ? "foryou-answer" : "foryou-approve"}
          >
            <Icon name="check" />
            {pending ? "Enviando…" : primary.label}
            <kbd className="fy-kbd">{MOD_KEY}+Enter</kbd>
          </button>
        )}
        {!open && item.status !== "cancelado" && (
          <button type="button" className="ui-button ui-button--secondary" onClick={() => void decide("pendente")} disabled={pending} data-testid="foryou-reopen">
            <Icon name="reopen" />
            Reabrir
          </button>
        )}
      </div>

      {overConfirm && (
        <ConfirmDialog
          title="Aprovar mesmo acima do limite?"
          message={
            <p>
              O texto tem {formatCharCount(overConfirm.info.length)} caracteres e o limite de {overConfirm.info.label} é {formatCharCount(overConfirm.info.max)}. A
              plataforma pode cortar ou recusar o texto.
            </p>
          }
          confirmLabel="Aprovar assim mesmo"
          pendingLabel="Enviando…"
          tone="success"
          onConfirm={() => onDecide(item, "aprovado", overConfirm.values)}
          onClose={() => setOverConfirm(null)}
          testId="foryou-over-limit-confirm"
        />
      )}
    </article>
  );
}
