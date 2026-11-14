import { ROUTINE_KIND_LABELS, ROUTINE_LIMITS_TABLE, clampTarget, type ForYouDecisionStatus, type ForYouItem, type RoutineApprovalOverrides, type RoutineProposalPayload } from "@cyno/shared";
import { useState, type Ref } from "react";
import { useAsyncAction } from "../../ui/useAsyncAction";
import { ErrorText, Field, Switch } from "../../ui/widgets";
import { approvalView, limitsText, parseWhole, targetWarning } from "../gestao/gestaoView";
import { RoutineProposalBody } from "./RoutineProposalBody";
import { defaultChoice, PROPOSAL_TITLES, proposalMode as proposalModeOf, type ProposalMode } from "./routineProposal";
import type { DecisionValues } from "./ForYouCard";
import { Icon } from "./icons";
import type { DiscardHandler } from "./ItemExtras";
import { CardShell } from "./SpecialCards";

type Props = {
  item: ForYouItem;
  routine: RoutineProposalPayload;
  agentName?: string;
  cardRef?: Ref<HTMLElement>;
  onDecide: (item: ForYouItem, status: ForYouDecisionStatus, values: DecisionValues) => Promise<unknown>;
  onDiscard?: DiscardHandler;
};

/** Botões, rótulos e a frase de cada modo do cartão. */
const MODE_COPY: Record<ProposalMode, { approve: string; reject: string; approving: string }> = {
  criar: { approve: "Criar rotina", reject: "Recusar", approving: "Criando…" },
  ajustar: { approve: "Baixar meta", reject: "Manter", approving: "Baixando…" },
  revisar: { approve: "Retomar", reject: "Manter pausada", approving: "Retomando…" },
  alterar: { approve: "Aplicar mudança", reject: "Recusar", approving: "Aplicando…" },
};

const MODE_LEAD: Record<ProposalMode, string> = {
  criar: "O Maestro propõe esta rotina. Ela só passa a valer depois do seu OK: você pode criar, pedir um ajuste ao Maestro ou recusar.",
  ajustar: "A meta não foi batida nas duas últimas semanas. Baixar a meta evita cobrar o que o site ou o time não entrega. Você decide o novo número.",
  revisar: "A rotina foi pausada depois de várias tentativas sem nenhum item entregue. Retome se o problema foi resolvido, ou deixe pausada até você mexer.",
  alterar: "O Maestro propõe mudar esta rotina. Nada muda antes do seu OK: abaixo estão o antes e o depois.",
};

/** "10 convites por semana". */
function goalText(target: number, unit: string, period: RoutineProposalPayload["period"]): string {
  return `${target} ${unit}${target === 1 ? "" : "s"} por ${period === "week" ? "semana" : "mês"}`;
}

/**
 * Cartão "rotina" do Para você: proposta de uma rotina nova (criar), pergunta de baixar a meta
 * (ajustar) ou de retomar uma rotina pausada (revisar). Os ajustes valem só ao aprovar.
 */
export function RoutineCard({ item, routine, agentName, cardRef, onDecide, onDiscard }: Props) {
  const mode = proposalModeOf(routine);
  const open = item.status === "pendente";
  const copy = MODE_COPY[mode];
  const limits = routine.limits ?? ROUTINE_LIMITS_TABLE[routine.kind];
  const startTarget = mode === "ajustar" ? (routine.suggestedTarget ?? routine.target) : routine.target;
  const [target, setTarget] = useState(String(startTarget));
  const [cap, setCap] = useState(routine.dailyCap === undefined ? "" : String(routine.dailyCap));
  const [needsApproval, setNeedsApproval] = useState(routine.needsApproval);
  const [localError, setLocalError] = useState<string | null>(null);
  const { pending, error, run } = useAsyncAction();
  const [choice, setChoice] = useState<"pede-ok" | "automatico">(defaultChoice(routine));
  const [adjusting, setAdjusting] = useState(false);
  const [adjustText, setAdjustText] = useState("");
  const v2 = (mode === "criar" || mode === "alterar") && routine.view !== undefined;

  const ceiling = clampTarget(routine.kind, Number.MAX_SAFE_INTEGER);
  const parsedTarget = parseWhole(target, ceiling);
  const warning = /^\d+$/.test(target.trim()) ? targetWarning(routine.kind, Number(target)) : "";
  const hint = routine.suggestedNeedsApproval;
  const showApproval = mode === "criar";
  const editsTarget = mode === "criar" || mode === "ajustar";

  const decide = async (status: ForYouDecisionStatus) => {
    setLocalError(null);
    const values: DecisionValues = {};
    if (v2) {
      if (status === "respondido") {
        if (!adjustText.trim()) {
          setLocalError("Diga o que ajustar.");
          return;
        }
        values.response = adjustText.trim();
      } else if (status === "aprovado" && routine.suggestedMode) values.routine = { mode: choice };
      await run(() => onDecide(item, status, values));
      return;
    }
    if (status === "aprovado") {
      const overrides: RoutineApprovalOverrides = {};
      if (editsTarget) {
        if (parsedTarget === null) {
          setLocalError("A meta precisa ser um número inteiro, de 1 para cima.");
          return;
        }
        overrides.target = parsedTarget;
      }
      if (mode === "criar") {
        overrides.needsApproval = needsApproval;
        if (cap.trim() !== "") {
          const parsedCap = parseWhole(cap, 1000);
          if (parsedCap === null) {
            setLocalError("O teto por dia precisa ser um número inteiro, ou fique vazio.");
            return;
          }
          overrides.dailyCap = limits.daily !== undefined ? Math.min(parsedCap, limits.daily) : parsedCap;
        }
      }
      if (Object.keys(overrides).length > 0) values.routine = overrides;
    }
    await run(() => onDecide(item, status, values));
  };

  const approval = approvalView({ needsApproval, kind: routine.kind, dailyCap: parsedCap(cap) });

  return (
    <CardShell item={item} label={mode === "criar" ? "Rotina" : mode === "alterar" ? "Mudança em rotina" : mode === "ajustar" ? "Meta em risco" : "Rotina pausada"} icon="bandeira" title={item.title ?? PROPOSAL_TITLES[mode]} agentName={agentName} cardRef={cardRef} onDiscard={onDiscard}>
      <p className="fy-routine__lead">{MODE_LEAD[mode]}</p>

      {v2 && routine.view && <RoutineProposalBody payload={routine} view={routine.view} {...(routine.before ? { before: routine.before } : {})} choice={choice} {...(open && routine.suggestedMode ? { onChoice: setChoice } : {})} />}
      {v2 && routine.reason && mode === "alterar" && <p className="fy-routine__lead">Por que: {routine.reason}</p>}

      {!v2 && <dl className="fy-routine" data-testid="foryou-routine">
        <div>
          <dt>Meta</dt>
          <dd>
            <strong>{routine.title}</strong>
            <span className="fy-routine__sub">
              {mode === "ajustar" ? (
                <>
                  Hoje: {goalText(routine.target, routine.unit, routine.period)}
                  {routine.suggestedTarget !== undefined && <> · sugestão: {routine.suggestedTarget}</>}
                </>
              ) : (
                goalText(routine.target, routine.unit, routine.period)
              )}
            </span>
          </dd>
        </div>
        <div>
          <dt>Quem executa</dt>
          <dd>{routine.owner}</dd>
        </div>
        <div>
          <dt>Site e tipo</dt>
          <dd>
            {routine.site} · {ROUTINE_KIND_LABELS[routine.kind]}
          </dd>
        </div>
        <div>
          <dt>Limites do site</dt>
          <dd>{limitsText(limits)}</dd>
        </div>
        {routine.instruction && (
          <div className="fy-routine__wide">
            <dt>Instrução</dt>
            <dd className="fy-routine__instruction">{routine.instruction}</dd>
          </div>
        )}
        {routine.reason && (
          <div className="fy-routine__wide">
            <dt>{mode === "criar" ? "Por que" : "O que aconteceu"}</dt>
            <dd>{routine.reason}</dd>
          </div>
        )}
      </dl>}

      {open && !v2 && editsTarget && (
        <div className="fy-routine__edit">
          <Field label={mode === "ajustar" ? "Nova meta por semana" : "Meta por semana"} hint={warning || `Até ${ceiling} por semana neste tipo.`}>
            {(props) => (
              <input
                {...props}
                className="ui-input fy-routine__num"
                inputMode="numeric"
                value={target}
                onChange={(e) => setTarget(e.currentTarget.value)}
                onBlur={() => parsedTarget !== null && setTarget(String(parsedTarget))}
                data-testid="foryou-routine-target"
              />
            )}
          </Field>
          {mode === "criar" && (
            <Field label="Teto por dia" hint={limits.daily !== undefined ? `Vazio = ${limits.daily} (o do tipo).` : "Vazio = sem teto diário."}>
              {(props) => <input {...props} className="ui-input fy-routine__num" inputMode="numeric" value={cap} onChange={(e) => setCap(e.currentTarget.value)} data-testid="foryou-routine-cap" />}
            </Field>
          )}
        </div>
      )}

      {open && !v2 && showApproval && (
        <Switch
          label="Precisa do meu OK"
          description={approval.hint}
          checked={needsApproval}
          onChange={setNeedsApproval}
          testId="foryou-routine-needs-approval"
        >
          {hint !== undefined && (
            <p className="fy-routine__suggest" data-testid="foryou-routine-suggest">
              <Icon name="agent" size={12} />O Maestro sugeriu: {hint ? "precisa do meu OK" : "age sozinho"}.
            </p>
          )}
        </Switch>
      )}

      {!open && item.response && item.status !== "cancelado" && <p className="fy-card__note">Sua nota: {item.response}</p>}

      <ErrorText>{localError ?? error}</ErrorText>
      {open && v2 && adjusting && (
        <div className="fy-rp__adjust">
          <textarea className="ui-input" rows={3} placeholder="O que você quer mudar? (ex.: troque as 9h por 8h, acrescente sexta…)" value={adjustText} onChange={(e) => setAdjustText(e.currentTarget.value)} data-testid="foryou-routine-adjust-text" />
          <div className="fy-actions">
            <button type="button" className="ui-button ui-button--secondary" disabled={pending} onClick={() => setAdjusting(false)}>
              Voltar
            </button>
            <span className="fy-actions__space" />
            <button type="button" className="ui-button ui-button--primary" disabled={pending} onClick={() => void decide("respondido")} data-testid="foryou-routine-adjust-send">
              Enviar ajuste ao Maestro
            </button>
          </div>
        </div>
      )}
      {open && !(v2 && adjusting) && (
        <div className="fy-actions">
          <button type="button" className={`ui-button ${mode === "criar" ? "ui-button--danger" : "ui-button--secondary"}`} disabled={pending} onClick={() => void decide("rejeitado")} data-testid="foryou-routine-reject">
            <Icon name="cross" />
            {copy.reject}
          </button>
          <span className="fy-actions__space" />
          {v2 && (
            <button type="button" className="ui-button ui-button--secondary" disabled={pending} onClick={() => setAdjusting(true)} data-testid="foryou-routine-adjust">
              Ajustar
            </button>
          )}
          <button type="button" className="ui-button ui-button--success" disabled={pending} onClick={() => void decide("aprovado")} data-testid="foryou-routine-approve">
            <Icon name="check" />
            {pending ? copy.approving : copy.approve}
          </button>
        </div>
      )}
    </CardShell>
  );
}

function parsedCap(text: string): number | undefined {
  const value = parseWhole(text, 1000);
  return value === null ? undefined : value;
}
