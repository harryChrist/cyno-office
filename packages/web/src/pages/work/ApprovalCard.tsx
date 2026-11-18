import { forYouKind, forYouOriginalText, type ForYouDecisionBody, type ForYouItem, type RejectionCategory } from "@cyno/shared";
import { useId, useState } from "react";
import { api } from "../../api/client";
import { useForYouFocus } from "../../store/forYouFocus";
import { Linkify } from "../../ui/Linkify";
import { useAsyncAction } from "../../ui/useAsyncAction";
import { ErrorText } from "../../ui/widgets";
import { RejectionCategories } from "../foryou/RejectionCategories";
import { approvalConfirm, cardTitle, counterState, overLimitWarning, primaryAction, typeDisplay, typeStyle, waitingAge, type TypeList } from "../foryou/forYouView";

type ApprovalCardProps = {
  item: ForYouItem;
  types: TypeList;
  agentName?: string;
  now: number;
};

/** Texto de um item para a tela: o que o agente quer aprovar. */
const KIND_LABEL = { aprovacao: "Aprovação", plano: "Plano do projeto", questionario: "Pergunta", rotina: "Rotina", sprint: "Entrega da sprint", regra: "Regra da retrospectiva", organizacao: "Organização do Cérebro" } as const;

/**
 * Aprovação ali mesmo, na trilha do projeto (o cartão do Para você em modo compacto): o texto que vai sair
 * (editável, com contador), Aprovar e Recusar (com o motivo). Várias ficam abertas ao mesmo tempo, uma por item.
 * Pergunta e questionário se respondem em Aprovações (o cartão leva até lá).
 */
export function ApprovalCard({ item, types, agentName, now }: ApprovalCardProps) {
  const baseId = useId();
  const { pending, error, run, clearError } = useAsyncAction();
  const kind = forYouKind(item);
  const type = typeDisplay(types, item.type);
  const question = type.behavior === "pergunta";
  const [draft, setDraft] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [category, setCategory] = useState<RejectionCategory | null>(null);
  const [response, setResponse] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const [confirmOver, setConfirmOver] = useState(false);
  const current = draft ?? item.text;
  const changed = draft !== null && draft !== forYouOriginalText(item);
  const counter = counterState(item, current, types);
  const warning = overLimitWarning(item, current, types);
  const primary = primaryAction(item, types);
  const title = cardTitle(item, agentName, types);
  const simple = kind === "aprovacao";

  const decide = async (status: "aprovado" | "rejeitado" | "respondido") => {
    setLocalError(null);
    clearError();
    if (status === "respondido" && !response.trim()) {
      setLocalError("Escreva a resposta antes de enviar.");
      return;
    }
    if (status === "aprovado" && !question && !current.trim()) {
      setLocalError("O texto não pode ficar vazio.");
      return;
    }
    if (status === "aprovado" && !confirmOver && approvalConfirm(item, status, current, types)) {
      setConfirmOver(true);
      return;
    }
    // A recusa leva o motivo no campo `reason`: o servidor o guarda (`rejection`) e o entrega ao agente para refazer.
    const body: ForYouDecisionBody =
      status === "rejeitado" ? { status, ...(reason.trim() ? { reason: reason.trim() } : {}), ...(category ? { category } : {}) } : status === "respondido" ? { status, response: response.trim() } : { status, text: current };
    await run(() => api.decideForYou(item.id, body));
  };

  return (
    <article className="w-appr" style={typeStyle(type)} data-testid={`work-approval-${item.id}`} data-item-id={item.id} aria-busy={pending || undefined}>
      <header className="w-appr__head">
        <span className="w-appr__type">{simple ? type.name : KIND_LABEL[kind]}</span>
        <span className="w-appr__id">{item.id}</span>
        <span className="w-appr__age">{waitingAge(item.createdAt, now)}</span>
      </header>
      <h4 className="w-appr__title">
        <Linkify text={title} />
      </h4>
      {item.why && (
        <p className="w-appr__why">
          <Linkify text={item.why} />
        </p>
      )}

      {simple && !question && (
        <div className="w-appr__field">
          <label htmlFor={`${baseId}-x`} className="w-appr__label">
            O que vai sair {changed && <span className="w-appr__edited">· editado</span>}
          </label>
          <textarea id={`${baseId}-x`} className="ui-input w-appr__text" rows={Math.min(10, Math.max(3, Math.max(current.split("\n").length + 1, Math.ceil(current.length / 46))))} value={current} onChange={(event) => setDraft(event.currentTarget.value)} data-testid="work-approval-text" />
          <p className={`w-appr__counter w-appr__counter--${counter.tone}`}>
            {counter.limit ? `${counter.length.toLocaleString("pt-BR")} / ${counter.limit.max.toLocaleString("pt-BR")}` : `${counter.length.toLocaleString("pt-BR")} caracteres`}
            {changed && (
              <button type="button" className="ui-link" onClick={() => setDraft(null)}>
                Desfazer edição
              </button>
            )}
          </p>
          {warning && <p className="w-appr__warn">{warning}. Dá para aprovar assim mesmo.</p>}
        </div>
      )}

      {simple && question && (
        <div className="w-appr__field">
          <label htmlFor={`${baseId}-r`} className="w-appr__label">
            Sua resposta
          </label>
          <textarea id={`${baseId}-r`} className="ui-input w-appr__text" rows={3} value={response} onChange={(event) => setResponse(event.currentTarget.value)} data-testid="work-approval-response" />
        </div>
      )}

      {!simple && (
        <div className="w-appr__actions">
          <button type="button" className="ui-button ui-button--small" onClick={() => useForYouFocus.getState().open(item.id)} data-testid="work-approval-open">
            {kind === "plano" ? "Abrir o plano" : kind === "sprint" ? "Abrir a entrega" : "Responder em Aprovações"}
          </button>
        </div>
      )}

      {rejecting && simple && (
        <div className="w-appr__field">
          <label htmlFor={`${baseId}-m`} className="w-appr__label">
            Por que está recusando? <span className="ui-muted">· o agente recebe o motivo</span>
          </label>
          <RejectionCategories value={category} onChange={setCategory} disabled={pending} />
          <textarea id={`${baseId}-m`} className="ui-input w-appr__text" rows={2} value={reason} onChange={(event) => setReason(event.currentTarget.value)} autoFocus data-testid="work-approval-reason" />
        </div>
      )}

      {confirmOver && (
        <p className="w-appr__warn" role="alert">
          O texto passa do limite. Aprovar mesmo assim?
        </p>
      )}
      <ErrorText testId="work-approval-error">{localError ?? error}</ErrorText>
      {simple && (
        <div className="w-appr__actions">
          {rejecting ? (
            <>
              <button type="button" className="ui-button ui-button--secondary ui-button--small" disabled={pending} onClick={() => setRejecting(false)}>
                Voltar
              </button>
              <span className="w-grow" />
              <button type="button" className="ui-button ui-button--danger ui-button--small" disabled={pending} onClick={() => void decide("rejeitado")} data-testid="work-approval-reject-confirm">
                {pending ? "Enviando…" : "Recusar"}
              </button>
            </>
          ) : (
            <>
              <button type="button" className="ui-button ui-button--secondary ui-button--small" disabled={pending} onClick={() => setRejecting(true)} data-testid="work-approval-reject">
                Recusar
              </button>
              <span className="w-grow" />
              <button type="button" className="ui-button ui-button--success ui-button--small" disabled={pending} onClick={() => void decide(primary.status)} data-testid="work-approval-approve">
                {pending ? "Enviando…" : confirmOver ? "Aprovar mesmo assim" : primary.label}
              </button>
            </>
          )}
        </div>
      )}
    </article>
  );
}
