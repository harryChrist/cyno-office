import type { Project } from "@cyno/shared";
import { useId, useState } from "react";
import { api } from "../../api/client";
import { useAsyncAction } from "../../ui/useAsyncAction";
import { ErrorText } from "../../ui/widgets";
import { PLAN_APPROVALS } from "./releaseView";
import { syncProjectResponse } from "./useTaskActions";
import "./work.css";

/** Aprovar plano (começar ou deixar planejado) / Pedir ajuste / Cancelar, para um projeto cujo plano espera o OK. Usado na trilha e em Aprovações. */
export function PlanDecision({ plan, compact = false }: { plan: Pick<Project, "id" | "status"> & { sprints?: Project["sprints"] }; compact?: boolean }) {
  const { pending, error, run } = useAsyncAction();
  const [adjusting, setAdjusting] = useState(false);
  const [feedback, setFeedback] = useState("");
  const fieldId = useId();
  if (plan.status !== "proposto") return null;
  const [approveStart, approvePlanned] = PLAN_APPROVALS;
  const approve = (release: "all" | "none") => void run(async () => syncProjectResponse(await api.approvePlan(plan.id, release)));
  return (
    <div className={`plan-decision${compact ? " plan-decision--compact" : ""}`} data-testid="plan-decision">
      {adjusting && (
        <div className="plan-decision__adjust">
          <label htmlFor={fieldId} className="plan-decision__label">
            O que ajustar? <span className="ui-muted">· vai para o Maestro numa mensagem só</span>
          </label>
          <textarea
            id={fieldId}
            className="ui-input"
            rows={3}
            value={feedback}
            placeholder="Ex.: junte as tarefas de revisão, inclua o Instagram, troque o Beto pela Clara na T3…"
            onChange={(event) => setFeedback(event.currentTarget.value)}
            data-testid="plan-adjust-text"
          />
        </div>
      )}
      <ErrorText testId="plan-decision-error">{error}</ErrorText>
      <div className="plan-decision__actions">
        <button type="button" className="ui-button ui-button--danger ui-button--small" disabled={pending} onClick={() => void run(() => api.cancelPlan(plan.id))} data-testid="plan-cancel">
          Cancelar
        </button>
        <span className="plan-decision__space" />
        {adjusting ? (
          <>
            <button type="button" className="ui-button ui-button--secondary ui-button--small" disabled={pending} onClick={() => setAdjusting(false)}>
              Voltar
            </button>
            <button
              type="button"
              className="ui-button ui-button--small"
              disabled={pending || !feedback.trim()}
              onClick={() => void run(() => api.adjustPlan(plan.id, feedback.trim()))}
              data-testid="plan-adjust-send"
            >
              Mandar ajuste ao Maestro
            </button>
          </>
        ) : (
          <>
            <button type="button" className="ui-button ui-button--secondary ui-button--small" disabled={pending} onClick={() => setAdjusting(true)} data-testid="plan-adjust">
              Pedir ajuste
            </button>
            <button type="button" className="ui-button ui-button--secondary ui-button--small" disabled={pending} onClick={() => approve(approvePlanned.release)} data-testid={approvePlanned.testId}>
              {pending ? "Enviando…" : approvePlanned.label}
            </button>
            <button type="button" className="ui-button ui-button--success ui-button--small" disabled={pending} onClick={() => approve(approveStart.release)} data-testid={approveStart.testId}>
              {pending ? "Enviando…" : approveStart.label}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
