import type { Agent, ForYouDecisionStatus, ForYouItem, Project } from "@cyno/shared";
import { useState, type Ref } from "react";
import { useAsyncAction } from "../../ui/useAsyncAction";
import { ErrorText } from "../../ui/widgets";
import { Markdown } from "../../ui/markdown/Markdown";
import { DeliverySummary } from "../work/DeliverySummary";
import { decisionText, deliveryHeadline } from "../work/deliveryView";
import { openProjectAt } from "../work/openProject";
import type { DecisionValues } from "./ForYouCard";
import { CardShell } from "./SpecialCards";

const noWiki = () => null;

type Props = {
  item: ForYouItem;
  /** O projeto da sprint (o resumo mora nele); sem ele o cartão mostra só o texto do item. */
  project: Project | undefined;
  agents: ReadonlyMap<string, Agent>;
  agentName?: string;
  cardRef?: Ref<HTMLElement>;
  onDecide: (item: ForYouItem, status: ForYouDecisionStatus, values: DecisionValues) => Promise<unknown>;
};

/**
 * Cartão "sprint" do Para você: o resumo de entrega de uma sprint que fechou (o que foi feito, com os links e a
 * mídia, o que sobrou e para onde foi). "Aprovar entrega" fecha a sprint; "Devolver" pede o motivo, deixa marcar
 * as entregas que voltam como retrabalho na sprint ativa e fecha a sprint mesmo assim. A sobra já andou para a
 * sprint seguinte quando o cartão apareceu: o ritmo não espera pelo seu OK.
 */
export function SprintCard({ item, project, agents, agentName, cardRef, onDecide }: Props) {
  const sprint = project?.sprints?.find((candidate) => candidate.id === item.sprintId);
  const open = item.status === "pendente";
  const [returning, setReturning] = useState(false);
  const [reason, setReason] = useState("");
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [localError, setLocalError] = useState<string | null>(null);
  const { pending, error, run } = useAsyncAction();

  const title = item.title ?? (sprint?.summary ? deliveryHeadline(sprint, sprint.summary) : "Entrega da sprint");
  const toggle = (ref: string) =>
    setPicked((current) => {
      const next = new Set(current);
      if (!next.delete(ref)) next.add(ref);
      return next;
    });

  const approve = () => {
    setLocalError(null);
    return run(() => onDecide(item, "aprovado", {}));
  };
  const giveBack = () => {
    if (!reason.trim()) {
      setLocalError("Diga o motivo da devolução: ele vai no briefing do retrabalho.");
      return;
    }
    setLocalError(null);
    return run(() => onDecide(item, "rejeitado", { reason: reason.trim(), ...(picked.size > 0 ? { returnRefs: [...picked] } : {}) }));
  };

  const outcome = sprint?.summary ? decisionText(sprint.summary) : null;

  return (
    <CardShell item={item} label="Entrega da sprint" icon="maleta" title={title} agentName={agentName} cardRef={cardRef}>
      {open && <p className="fy-sprint__lead">A sprint fechou e o que sobrou já passou para a seguinte: o trabalho não espera por este OK. Confira o que foi entregue e aprove, ou devolva com o motivo.</p>}
      {sprint && project ? (
        <DeliverySummary project={project} sprint={sprint} agents={agents} onOpenTask={(ref) => openProjectAt(project.id, "tarefas", ref)} {...(open && returning ? { pick: { refs: picked, onToggle: toggle } } : {})} testId="foryou-sprint-summary" />
      ) : (
        <div className="fy-readonly fy-plan-text" data-testid="foryou-sprint-text">
          <Markdown source={item.text} resolveWiki={noWiki} headingOffset={3} className="md--compact" />
        </div>
      )}
      {!open && item.status !== "cancelado" && (
        <p className={`fy-sprint__outcome fy-sprint__outcome--${outcome?.tone ?? "ok"}`} data-testid="foryou-sprint-outcome">
          {outcome ? `Entrega ${outcome.text}.` : item.status === "aprovado" ? "Entrega aprovada." : `Entrega devolvida${item.rejection?.reason ? `: ${item.rejection.reason}` : "."}`}
        </p>
      )}
      {project && sprint && (
        <div className="fy-actions">
          <button type="button" className="fy-link" onClick={() => openProjectAt(project.id, "sprints")} data-testid="foryou-sprint-open">
            Ver na aba Sprints
          </button>
        </div>
      )}
      {open && returning && (
        <div className="fy-sprint__return" data-testid="foryou-sprint-return">
          <p className="fy-sprint__lead">{picked.size === 0 ? "Marque acima as entregas que precisam ser refeitas (opcional) e diga o motivo." : `${picked.size === 1 ? "1 entrega volta" : `${picked.size} entregas voltam`} como tarefa de retrabalho na sprint ativa, com o motivo no briefing.`} A sprint fecha de qualquer jeito.</p>
          <label htmlFor={`${item.id}-reason`}>Motivo</label>
          <textarea id={`${item.id}-reason`} className="ui-input" rows={3} value={reason} onChange={(event) => setReason(event.currentTarget.value)} placeholder="Ex.: a cor do banner não é a da marca" data-testid="foryou-sprint-reason" />
        </div>
      )}
      <ErrorText testId="foryou-sprint-error">{localError ?? error}</ErrorText>
      {open && (
        <div className="fy-actions">
          {returning ? (
            <>
              <button type="button" className="ui-button ui-button--secondary" disabled={pending} onClick={() => setReturning(false)}>
                Voltar
              </button>
              <span className="w-grow" />
              <button type="button" className="ui-button ui-button--danger" disabled={pending} onClick={() => void giveBack()} data-testid="foryou-sprint-return-confirm">
                {pending ? "Devolvendo…" : picked.size > 0 ? `Devolver ${picked.size === 1 ? "1 entrega" : `${picked.size} entregas`}` : "Devolver a entrega"}
              </button>
            </>
          ) : (
            <>
              <button type="button" className="ui-button ui-button--secondary" disabled={pending} onClick={() => setReturning(true)} data-testid="foryou-sprint-return">
                Devolver…
              </button>
              <span className="w-grow" />
              <button type="button" className="ui-button ui-button--success" disabled={pending} onClick={() => void approve()} data-testid="foryou-sprint-approve">
                {pending ? "Aprovando…" : "Aprovar entrega"}
              </button>
            </>
          )}
        </div>
      )}
    </CardShell>
  );
}
