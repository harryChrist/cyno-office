import type { AvulsasCleanupPreview, AvulsasCleanupResult } from "@cyno/shared";
import { useEffect, useId, useState } from "react";
import { api, describeError } from "../../api/client";
import { useAsyncAction } from "../../ui/useAsyncAction";
import { ErrorText, Modal, Switch } from "../../ui/widgets";
import {
  archiveOptionLabel,
  canConfirmCleanup,
  CLEANUP_AGES,
  cleanupConfirmLabel,
  cleanupCountText,
  cleanupResultText,
  DEFAULT_CLEANUP_DAYS,
  DELETE_TASK_NOTE,
  oldestText,
  type CleanupPreviewState,
} from "./avulsasCleanupView";

/**
 * "Limpar avulsas": escolhe a idade, vê na hora quantas tarefas terminadas seriam apagadas, decide se leva as do
 * arquivo junto e confirma. Depois mostra o resultado. Apagar não tem volta; o histórico da Atividade fica.
 */
export function AvulsasCleanupDialog({ onClose }: { onClose: () => void }) {
  const id = useId();
  const { pending, error, run } = useAsyncAction();
  const [days, setDays] = useState(DEFAULT_CLEANUP_DAYS);
  const [includeArchive, setIncludeArchive] = useState(false);
  const [state, setState] = useState<CleanupPreviewState>({ status: "loading" });
  const [result, setResult] = useState<AvulsasCleanupResult | null>(null);

  // A contagem acompanha a idade escolhida (o seletor a põe em "Contando…"); resposta de uma escolha antiga é descartada.
  useEffect(() => {
    let current = true;
    api.previewAvulsasCleanup(days).then(
      (preview: AvulsasCleanupPreview) => {
        if (!current) return;
        setState({ status: "ready", preview });
        if (preview.archivedCount === 0) setIncludeArchive(false);
      },
      (caught: unknown) => {
        if (current) setState({ status: "error", message: describeError(caught) });
      },
    );
    return () => {
      current = false;
    };
  }, [days]);

  const preview = state.status === "ready" ? state.preview : null;
  const archiveLabel = archiveOptionLabel(preview);
  const oldest = oldestText(preview);
  const confirm = async () => {
    const done = await run(() => api.cleanupAvulsas({ olderThanDays: days, ...(includeArchive ? { includeArchive: true } : {}) }));
    if (done) setResult(done);
  };

  if (result) {
    return (
      <Modal title="Limpar avulsas" onClose={onClose} testId="avulsas-cleanup-dialog">
        <div className="ui-confirm">
          <p role="status" data-testid="avulsas-cleanup-result">
            <strong>{cleanupResultText(result)}</strong>
          </p>
        </div>
        <div className="ui-actions">
          <button type="button" className="ui-button" onClick={onClose} autoFocus data-testid="avulsas-cleanup-done">
            Pronto
          </button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="Limpar avulsas" onClose={onClose} testId="avulsas-cleanup-dialog">
      <div className="w-new w-clean">
        <div className="w-new__field">
          <label htmlFor={`${id}-age`}>Apagar as tarefas terminadas</label>
          <select id={`${id}-age`} className="ui-input" value={days} disabled={pending} onChange={(event) => {
              setState({ status: "loading" });
              setDays(Number(event.currentTarget.value));
            }} autoFocus data-testid="avulsas-cleanup-age">
            {CLEANUP_AGES.map((age) => (
              <option key={age.days} value={age.days}>
                {age.label}
              </option>
            ))}
          </select>
        </div>
        <p className="w-clean__count" role="status" aria-live="polite" data-testid="avulsas-cleanup-count">
          {cleanupCountText(state, includeArchive)}
        </p>
        {oldest && <p className="w-new__hint">{oldest}</p>}
        {archiveLabel && <Switch label={archiveLabel} checked={includeArchive} disabled={pending} onChange={setIncludeArchive} testId="avulsas-cleanup-archive" />}
        <p className="w-new__hint">{DELETE_TASK_NOTE} Só as terminadas são apagadas; as que ainda rodam ficam.</p>
        <ErrorText testId="avulsas-cleanup-error">{error}</ErrorText>
      </div>
      <div className="ui-actions">
        <button type="button" className="ui-button ui-button--secondary" onClick={onClose}>
          Cancelar
        </button>
        <button type="button" className="ui-button ui-button--danger" disabled={!canConfirmCleanup(state, includeArchive, pending)} onClick={() => void confirm()} data-testid="avulsas-cleanup-confirm">
          {pending ? "Apagando…" : cleanupConfirmLabel(state, includeArchive)}
        </button>
      </div>
    </Modal>
  );
}
