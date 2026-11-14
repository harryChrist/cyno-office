import { useId, useState } from "react";
import { useAsyncAction } from "../../ui/useAsyncAction";
import { ErrorText } from "../../ui/widgets";
import { batchLabel, type BatchProgress } from "./forYouView";
import { Icon } from "./icons";

type BatchBarProps = {
  batch: BatchProgress;
  /** Aprova todos os pendentes do lote, um por vez (com o texto de cada um, editado ou não). */
  onApproveAll: () => Promise<unknown>;
  /** Recusa todos os pendentes do lote com o mesmo motivo (opcional). */
  onRejectAll: (reason: string) => Promise<unknown>;
};

/**
 * Faixa de um lote de aprovações (vários itens abertos juntos pelo mesmo agente): quantos já foram
 * decididos e as ações "Aprovar todos" e "Recusar todos" (esta pede o motivo antes).
 */
export function BatchBar({ batch, onApproveAll, onRejectAll }: BatchBarProps) {
  const baseId = useId();
  const { pending, error, run, clearError } = useAsyncAction();
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const remaining = batch.pending.length;
  const done = remaining === 0;

  return (
    <section className="fy-batch" data-testid="foryou-batch" aria-label="Lote de aprovações">
      <div className="fy-batch__top">
        <span className="fy-batch__label">
          <Icon name="todos" size={14} />
          Lote · <strong data-testid="foryou-batch-progress">{batchLabel(batch)}</strong>
        </span>
        <span className="fy-batch__track" aria-hidden="true">
          <span className="fy-batch__fill" style={{ width: `${(batch.decided / batch.total) * 100}%` }} />
        </span>
        {!done && !rejecting && (
          <span className="fy-batch__actions">
            <button type="button" className="ui-button ui-button--small ui-button--success" disabled={pending} onClick={() => void run(onApproveAll)} data-testid="foryou-batch-approve">
              <Icon name="check" size={13} />
              {pending ? "Enviando…" : `Aprovar todos (${remaining})`}
            </button>
            <button
              type="button"
              className="ui-button ui-button--small ui-button--ghost fy-reject"
              disabled={pending}
              onClick={() => {
                clearError();
                setRejecting(true);
              }}
              data-testid="foryou-batch-reject"
            >
              <Icon name="cross" size={13} />
              Recusar todos
            </button>
          </span>
        )}
      </div>
      {rejecting && !done && (
        <div className="fy-batch__reject">
          <label htmlFor={`${baseId}-r`} className="fy-field__label">
            Por que está recusando? <span className="fy-field__hint">· opcional, mas ajuda o agente a refazer</span>
          </label>
          <textarea
            id={`${baseId}-r`}
            className="ui-input fy-textarea fy-textarea--note"
            rows={2}
            autoFocus
            value={reason}
            placeholder="Ex.: ficaram formais demais; use um tom mais direto."
            onChange={(event) => setReason(event.currentTarget.value)}
            data-testid="foryou-batch-reason"
          />
          <span className="fy-batch__actions">
            <button type="button" className="ui-button ui-button--small ui-button--ghost" disabled={pending} onClick={() => setRejecting(false)}>
              Voltar
            </button>
            <button type="button" className="ui-button ui-button--small ui-button--danger" disabled={pending} onClick={() => void run(() => onRejectAll(reason.trim()))} data-testid="foryou-batch-reject-confirm">
              {pending ? "Enviando…" : `Recusar ${remaining === 1 ? "o último" : `os ${remaining}`}`}
            </button>
          </span>
        </div>
      )}
      <ErrorText testId="foryou-batch-error">{error}</ErrorText>
    </section>
  );
}
