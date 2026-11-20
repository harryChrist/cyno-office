import { DISPATCH_LIMITS, dispatchSettings, type Workspace } from "@cyno/shared";
import { useId, useState } from "react";
import { api } from "../../api/client";
import { useAsyncAction } from "../../ui/useAsyncAction";
import { ErrorText } from "../../ui/widgets";
import { ResetDefaultButton } from "./ResetDefault";
import { OptionHead, StateBadge } from "./SettingsOption";

/** Números de min a max (as opções do select). */
const range = (min: number, max: number) => Array.from({ length: max - min + 1 }, (_, index) => min + index);

/**
 * Seção do workspace "Trabalho em paralelo": quantas tarefas de projeto rodam ao mesmo tempo no
 * workspace e por agente. As que passam esperam a vez (a distribuição é do server). Enquanto o
 * workspace nunca mexeu nisso, vale o padrão da plataforma (com "Mudar só aqui" para ajustar).
 */
export function DispatchSettings({ workspace }: { workspace: Workspace }) {
  const id = useId();
  const saved = dispatchSettings(workspace.dispatch);
  const [draft, setDraft] = useState(saved);
  const { pending, error, run } = useAsyncAction();
  const [done, setDone] = useState(false);
  const untouched = workspace.dispatch?.maxRunning === undefined && workspace.dispatch?.perAgent === undefined;
  const [editing, setEditing] = useState(false);
  const showControls = !untouched || editing;
  // Voltou ao padrão (ou mudou por outro lado): os campos acompanham o valor gravado.
  const savedKey = `${saved.maxRunning}/${saved.perAgent}/${untouched}`;
  const [seenKey, setSeenKey] = useState(savedKey);
  if (seenKey !== savedKey) {
    setSeenKey(savedKey);
    setDraft(saved);
    if (untouched) setEditing(false);
  }
  const dirty = draft.maxRunning !== saved.maxRunning || draft.perAgent !== saved.perAgent;
  const save = async () => {
    setDone(false);
    const result = await run(() => api.updateWorkspaceDispatch(workspace.id, draft));
    if (result) setDone(true);
  };
  return (
    <section className="settings__card" data-testid="settings-dispatch">
      <OptionHead
        title="Quantos trabalham ao mesmo tempo"
        seal="workspace"
        inherited={untouched}
        state={
          <StateBadge tone="value" testId="settings-dispatch-state">
            {saved.maxRunning} ao mesmo tempo · {saved.perAgent} por agente
          </StateBadge>
        }
        line={`Limite de tarefas rodando juntas. Com ${saved.maxRunning}, a ${saved.maxRunning + 1}ª espera uma vaga.`}
      />
      <details className="settings__more">
        <summary>Subir ou descer o limite</summary>
        <p>Quando você aprova um projeto, o servidor distribui as tarefas sozinho. Subir deixa o trabalho mais rápido, mas gasta mais da sua assinatura de uma vez. Descer deixa mais calmo e mais lento. As tarefas que esperam você não contam.</p>
      </details>
      <ResetDefaultButton workspaceId={workspace.id} fields={["dispatch.maxRunning", "dispatch.perAgent"]} own={!untouched} testId="settings-dispatch-reset" />
      {!showControls && (
        <div>
          <button type="button" className="ui-button ui-button--secondary ui-button--small" onClick={() => setEditing(true)} data-testid="settings-dispatch-edit">
            Mudar só aqui
          </button>
        </div>
      )}
      {showControls && (
        <>
          <div className="settings__dispatch">
            <label htmlFor={`${id}-max`} className="settings__dispatch-field">
              <span>Tarefas ao mesmo tempo no workspace</span>
              <select
                id={`${id}-max`}
                className="ui-input"
                value={draft.maxRunning}
                onChange={(event) => setDraft({ ...draft, maxRunning: Number(event.currentTarget.value) })}
                data-testid="settings-dispatch-max"
              >
                {range(DISPATCH_LIMITS.maxRunning.min, DISPATCH_LIMITS.maxRunning.max).map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
            <label htmlFor={`${id}-agent`} className="settings__dispatch-field">
              <span>Por agente (ao mesmo tempo)</span>
              <select
                id={`${id}-agent`}
                className="ui-input"
                value={draft.perAgent}
                onChange={(event) => setDraft({ ...draft, perAgent: Number(event.currentTarget.value) })}
                data-testid="settings-dispatch-agent"
              >
                {range(DISPATCH_LIMITS.perAgent.min, DISPATCH_LIMITS.perAgent.max).map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <ErrorText testId="settings-dispatch-error">{error}</ErrorText>
          <div className="settings__models-actions">
            {done && !dirty && (
              <span className="settings__card-hint" role="status">
                Salvo.
              </span>
            )}
            <button type="button" className="ui-button ui-button--secondary ui-button--small" onClick={() => setDraft(saved)} disabled={!dirty || pending}>
              Desfazer
            </button>
            <button type="button" className="ui-button ui-button--primary ui-button--small" onClick={() => void save()} disabled={!dirty || pending} aria-busy={pending} data-testid="settings-dispatch-save">
              {pending ? "Salvando…" : "Salvar"}
            </button>
          </div>
          </>
        )}
    </section>
  );
}
