import type { Workspace, WorkspaceResettableField } from "@cyno/shared";
import { requestJson } from "../../api/client";
import { useAsyncAction } from "../../ui/useAsyncAction";
import { ErrorText } from "../../ui/widgets";

/**
 * Botão "Voltar ao padrão": apaga o valor próprio que este workspace gravou para o campo (o PATCH com
 * `reset`) e passa a valer o padrão da plataforma. Só aparece quando o campo foi mexido (`own`).
 */
export function ResetDefaultButton({ workspaceId, fields, own, testId }: { workspaceId: string; fields: readonly WorkspaceResettableField[]; own: boolean; testId: string }) {
  const { pending, error, run } = useAsyncAction();
  if (!own) return null;
  return (
    <span className="settings__reset">
      <button
        type="button"
        className="ui-button ui-button--secondary ui-button--small"
        disabled={pending}
        aria-busy={pending}
        onClick={() => void run(() => requestJson<Workspace>(`/api/workspaces/${encodeURIComponent(workspaceId)}`, { method: "PATCH", body: { reset: fields } }))}
        data-testid={testId}
      >
        {pending ? "Voltando…" : "Voltar ao padrão"}
      </button>
      <ErrorText>{error}</ErrorText>
    </span>
  );
}
