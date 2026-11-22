import type { PlanApprovalRule, PlanApprovalSettings as PlanApprovalState, Workspace } from "@cyno/shared";
import { useEffect, useId, useRef, useState } from "react";
import { api, describeError } from "../../api/client";
import { ErrorText } from "../../ui/widgets";
import { OptionHead, StateBadge } from "./SettingsOption";
import { DEFAULT_PLAN_APPROVAL_RULE, formatPlanApprovalNote, PLAN_APPROVAL_OPTIONS, PLAN_APPROVAL_RESET_LABEL, planApprovalOption } from "./planApprovalView";

type CardViewProps = {
  value: PlanApprovalState;
  loading: boolean;
  saving: boolean;
  saved: boolean;
  error: string | null;
  onSelect: (rule: PlanApprovalRule) => void;
};

/**
 * Cartão "Aprovação de planos" (apresentação pura, testável sem rede): três opções em rádio, nota opcional
 * quando o Maestro ajustou a regra a pedido do dono e botão para voltar a "O Maestro decide".
 */
export function PlanApprovalCardView({ value, loading, saving, saved, error, onSelect }: CardViewProps) {
  const groupId = useId();
  const current = planApprovalOption(value.rule);
  const noteText = formatPlanApprovalNote(value.note);
  const disabled = loading || saving;
  return (
    <section className="settings__card" data-testid="settings-plan-approval">
      <OptionHead
        title="Aprovação de planos"
        seal="workspace"
        state={
          <StateBadge tone="value" testId="settings-plan-approval-state">
            {loading ? "Carregando…" : current.label}
          </StateBadge>
        }
        line="Define quando o Maestro pede o seu OK antes de um projeto novo começar."
      />
      <div className="settings__radios" role="radiogroup" aria-label="Aprovação de planos" data-testid="settings-plan-approval-options">
        {PLAN_APPROVAL_OPTIONS.map((option) => {
          const checked = value.rule === option.rule;
          return (
            <label
              key={option.rule}
              className={`settings__radio${checked ? " settings__radio--on" : ""}`}
              data-testid={`settings-plan-approval-option-${option.rule}`}
            >
              <input
                type="radio"
                name={`plan-approval-${groupId}`}
                value={option.rule}
                checked={checked}
                disabled={disabled}
                onChange={() => onSelect(option.rule)}
                data-testid={`settings-plan-approval-${option.rule}`}
              />
              <span className="settings__radio-body">
                <span className="settings__radio-title">{option.label}</span>
                <span className="settings__radio-desc">{option.description}</span>
              </span>
            </label>
          );
        })}
      </div>
      {noteText && (
        <div className="settings__approval-note" data-testid="settings-plan-approval-note">
          <p className="settings__approval-note-text">{noteText}</p>
          <div>
            <button
              type="button"
              className="ui-button ui-button--secondary ui-button--small"
              disabled={disabled}
              onClick={() => onSelect(DEFAULT_PLAN_APPROVAL_RULE)}
              data-testid="settings-plan-approval-reset"
            >
              {PLAN_APPROVAL_RESET_LABEL}
            </button>
          </div>
        </div>
      )}
      <ErrorText testId="settings-plan-approval-error">{error}</ErrorText>
      {(saving || saved) && !error && (
        <p className="settings__card-hint" role="status" data-testid="settings-plan-approval-status">
          {saving ? "Salvando…" : "Salvo."}
        </p>
      )}
    </section>
  );
}

/**
 * Cartão "Aprovação de planos" do workspace: lê `GET /api/w/:ws/settings/plan-approval` e salva ao escolher
 * (`PUT` no mesmo caminho, que devolve o estado atualizado e limpa a nota).
 */
export function PlanApprovalSettings({ workspace }: { workspace: Workspace }) {
  const [value, setValue] = useState<PlanApprovalState>({ rule: DEFAULT_PLAN_APPROVAL_RULE });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    api
      .getPlanApproval(workspace.id)
      .then((next) => {
        if (!aliveRef.current) return;
        setValue(next);
        setError(null);
      })
      .catch((caught: unknown) => {
        if (!aliveRef.current) return;
        setError(describeError(caught));
      })
      .finally(() => {
        if (!aliveRef.current) return;
        setLoading(false);
      });
    return () => {
      aliveRef.current = false;
    };
  }, [workspace.id]);

  const select = async (rule: PlanApprovalRule) => {
    if (saving || (rule === value.rule && !value.note)) return;
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      const next = await api.setPlanApproval(workspace.id, rule);
      if (!aliveRef.current) return;
      setValue(next);
      setSaved(true);
    } catch (caught) {
      if (!aliveRef.current) return;
      setError(describeError(caught));
    } finally {
      if (aliveRef.current) setSaving(false);
    }
  };

  return <PlanApprovalCardView value={value} loading={loading} saving={saving} saved={saved} error={error} onSelect={(rule) => void select(rule)} />;
}
