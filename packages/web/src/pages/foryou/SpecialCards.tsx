import { answeredCount, FOR_YOU_STATUS_LABELS, planProgress, type ForYouAnswer, type ForYouItem, type Plan } from "@cyno/shared";
import { useEffect, useId, useRef, useState, type Ref } from "react";
import { api } from "../../api/client";
import { formatDateTime } from "../../ui/format";
import { useAsyncAction } from "../../ui/useAsyncAction";
import { Markdown } from "../../ui/markdown/Markdown";
import { ErrorText } from "../../ui/widgets";
import { PlanDecision } from "../work/PlanDecision";
import { openProject } from "../work/openProject";
import { Icon, type IconName } from "./icons";
import { CancelledNote, ItemMenu, UpdatedChip, UpdateHistory, type DiscardHandler } from "./ItemExtras";
import "./specialCards.css";
import { Linkify } from "../../ui/Linkify";

/** O texto do plano não tem wiki links do Cérebro. */
const noWiki = () => null;

/** Espera depois da última tecla antes de gravar o rascunho das respostas (sem acordar ninguém). */
export const ANSWER_DEBOUNCE_MS = 700;

export type CardShellProps = {
  item: ForYouItem;
  label: string;
  icon: IconName;
  title: string;
  agentName?: string;
  cardRef?: Ref<HTMLElement>;
  /** "Descartar" no menu ⋯ (planos não têm: eles têm o próprio Cancelar). */
  onDiscard?: DiscardHandler;
  children: React.ReactNode;
};

/** Moldura comum (tipo, id, status, título, quem pediu, por quê) dos cards de plano e questionário. */
export function CardShell({ item, label, icon, title, agentName, cardRef, onDiscard, children }: CardShellProps) {
  const titleId = useId();
  const [historyOpen, setHistoryOpen] = useState(false);
  return (
    <article ref={cardRef} className="fy-card fy-card--special" tabIndex={-1} aria-labelledby={titleId} data-item-id={item.id} data-status={item.status} data-kind={item.kind} data-testid={`foryou-card-${item.id}`}>
      <div className="fy-card__top">
        <span className="fy-type-chip">
          <Icon name={icon} size={14} />
          {label}
        </span>
        <span className="fy-card__id">{item.id}</span>
        <span className={`fy-status fy-status--${item.status}`} data-testid="foryou-status">
          {FOR_YOU_STATUS_LABELS[item.status]}
        </span>
        {onDiscard && <ItemMenu item={item} onDiscard={onDiscard} />}
      </div>
      <h3 id={titleId} className="fy-card__title">
        {title}
      </h3>
      <ul className="fy-chips" aria-label="Detalhes">
        {agentName && (
          <li>
            <Icon name="agent" size={12} />
            {agentName}
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
      {item.why && (
        <p className="fy-card__why">
          <Linkify text={item.why} />
        </p>
      )}
      {children}
    </article>
  );
}

/** Plano de um pedido para aprovar: as tarefas (dono e etapas) e Aprovar / Ajustar / Cancelar. */
export function PlanItemCard({ item, plan, agentName, cardRef }: { item: ForYouItem; plan: Plan | undefined; agentName?: string; cardRef?: Ref<HTMLElement> }) {
  const live = plan && item.status === "pendente" && plan.forYouId === item.id ? plan : undefined;
  return (
    <CardShell item={item} label="Plano" icon="estrela" title={item.title ?? plan?.title ?? "Plano"} agentName={agentName} cardRef={cardRef}>
      <div className="fy-readonly fy-plan-text" data-testid="foryou-plan-text">
        <Markdown source={item.text} resolveWiki={noWiki} headingOffset={3} className="md--compact" />
      </div>
      {item.response && item.status !== "pendente" && <p className="fy-card__note">Sua nota: {item.response}</p>}
      {plan && (
        <div className="fy-actions">
          <button type="button" className="fy-link" onClick={() => openProject(plan.id)} data-testid="foryou-plan-board">
            Ver quadro ({planProgress(plan).done}/{planProgress(plan).total})
          </button>
        </div>
      )}
      {live && <PlanDecision plan={live} compact />}
      {item.status === "pendente" && !live && <p className="fy-card__note">Este plano já mudou (versão nova ou decidido em outro lugar).</p>}
    </CardShell>
  );
}

/** Junta o rascunho local com o do server (o local, ainda não gravado, vence). */
function merged(item: ForYouItem, local: Record<string, ForYouAnswer>): Record<string, ForYouAnswer> {
  return { ...item.answers, ...local };
}

/**
 * Questionário: cada pergunta com opções (chips), o padrão ("se não responder: X"), o campo e "Decide
 * você". O rascunho grava sozinho no server (sem acordar ninguém); "Enviar respostas" manda tudo de
 * uma vez para quem perguntou (o Maestro, ou só a tarefa do agente).
 */
export function QuestionnaireCard({
  item,
  fromMaestro,
  agentName,
  cardRef,
  onDiscard,
}: {
  item: ForYouItem;
  fromMaestro: boolean;
  agentName?: string;
  cardRef?: Ref<HTMLElement>;
  onDiscard?: DiscardHandler;
}) {
  const baseId = useId();
  const open = item.status === "pendente";
  const [local, setLocal] = useState<Record<string, ForYouAnswer>>({});
  const pendingSave = useRef<Record<string, ForYouAnswer>>({});
  const timer = useRef<number | undefined>(undefined);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const { pending, error, run } = useAsyncAction();
  const answers = merged(item, local);
  const questions = item.questions ?? [];
  const count = answeredCount({ questions, answers });

  const flush = async () => {
    window.clearTimeout(timer.current);
    const batch = pendingSave.current;
    pendingSave.current = {};
    if (Object.keys(batch).length === 0) return;
    setSaveState("saving");
    try {
      await api.saveForYouAnswers(item.id, batch);
      setSaveState("saved");
    } catch {
      pendingSave.current = { ...batch, ...pendingSave.current };
      setSaveState("error");
    }
  };

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const change = (questionId: string, answer: ForYouAnswer) => {
    setLocal((current) => ({ ...current, [questionId]: answer }));
    pendingSave.current[questionId] = answer;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void flush(), ANSWER_DEBOUNCE_MS);
  };

  const submit = () =>
    run(async () => {
      await flush();
      return api.submitForYou(item.id);
    });

  return (
    <CardShell item={item} label="Perguntas" icon="interrogacao" title={item.title ?? "Perguntas"} agentName={agentName} cardRef={cardRef} onDiscard={onDiscard}>
      <ol className="fy-quiz" data-testid="foryou-questions">
        {questions.map((question, index) => {
          const answer = answers[question.id] ?? {};
          const fieldId = `${baseId}-${question.id}`;
          const skipped = answer.skipped === true;
          return (
            <li key={question.id} className={`fy-quiz__item${skipped ? " fy-quiz__item--skipped" : ""}`} data-testid={`foryou-question-${question.id}`}>
              <label htmlFor={fieldId} className="fy-quiz__q">
                <span className="fy-quiz__n">{index + 1}.</span> <Linkify text={question.text} />
              </label>
              {question.options && question.options.length > 0 && (
                <div className="fy-quiz__options" role="group" aria-label="Opções">
                  {question.options.map((option) => (
                    <button
                      key={option}
                      type="button"
                      className="fy-quiz__chip"
                      aria-pressed={answer.text === option}
                      disabled={!open}
                      onClick={() => change(question.id, { text: option })}
                    >
                      {option}
                    </button>
                  ))}
                </div>
              )}
              <textarea
                id={fieldId}
                className="ui-input fy-textarea fy-textarea--note"
                rows={2}
                value={skipped ? "" : (answer.text ?? "")}
                disabled={!open || skipped}
                placeholder={skipped ? "O Maestro decide." : "Sua resposta"}
                onChange={(event) => change(question.id, { text: event.currentTarget.value })}
              />
              <div className="fy-quiz__foot">
                {question.default && <span className="fy-quiz__default">Se não responder: {question.default}</span>}
                {open && (
                  <label className="fy-quiz__skip">
                    <input type="checkbox" checked={skipped} onChange={(event) => change(question.id, event.currentTarget.checked ? { skipped: true } : { text: "" })} />
                    Decide você
                  </label>
                )}
              </div>
            </li>
          );
        })}
      </ol>
      {!open && item.response && item.status !== "cancelado" && <div className="fy-readonly">{item.response}</div>}
      <ErrorText testId="foryou-quiz-error">{error}</ErrorText>
      <div className="fy-actions">
        <span className="fy-quiz__count" data-testid="foryou-answered">
          {count}/{questions.length} respondidas
          {saveState === "saving" ? " · salvando…" : saveState === "saved" ? " · rascunho salvo" : saveState === "error" ? " · não salvou (tenta de novo ao enviar)" : ""}
        </span>
        <span className="fy-actions__space" />
        {open && (
          <button type="button" className="ui-button ui-button--success" disabled={pending} onClick={() => void submit()} data-testid="foryou-submit-answers">
            <Icon name="check" />
            {pending ? "Enviando…" : fromMaestro ? "Enviar respostas ao Maestro" : "Enviar respostas"}
          </button>
        )}
      </div>
    </CardShell>
  );
}
