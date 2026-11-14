import type { ForYouDecisionStatus, ForYouItem, ForYouRule, ForYouRuleScope } from "@cyno/shared";
import { useId, useState, type Ref } from "react";
import { useAsyncAction } from "../../ui/useAsyncAction";
import { ErrorText } from "../../ui/widgets";
import type { DecisionValues } from "./ForYouCard";
import { CardShell } from "./SpecialCards";
import { ruleScopeLabel, ruleScopeOptions, ruleSourceLabel, ruleStateText, sameScope, scopeKey } from "./ruleView";
import "./ruleCard.css";

type Props = {
  item: ForYouItem;
  rule: ForYouRule;
  agentName?: string;
  roomName?: string;
  cardRef?: Ref<HTMLElement>;
  onDecide: (item: ForYouItem, status: ForYouDecisionStatus, values: DecisionValues) => Promise<unknown>;
};

/**
 * Cartão "regra" do Para você: uma regra que a retrospectiva da Gestão propôs a partir das suas recusas, edições e falhas. O texto e o
 * escopo se editam antes de aprovar; "Aprovar regra" grava uma nota no Cérebro (do agente, do quarto ou global) e ela passa a valer
 * no contexto dos agentes; "Recusar" esconde o padrão por 8 semanas. Nada entra no Cérebro sem o clique. Não entra em lote.
 */
export function RuleCard({ item, rule, agentName, roomName, cardRef, onDecide }: Props) {
  const open = item.status === "pendente";
  const [text, setText] = useState(rule.text);
  const [scope, setScope] = useState<ForYouRuleScope>(rule.scope);
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const { pending, error, run } = useAsyncAction();
  const textId = useId();
  const options = ruleScopeOptions(item, rule, agentName, roomName);
  const excerpts = rule.evidence.excerpts ?? [];
  const changed = text.trim() !== rule.text || !sameScope(scope, rule.scope);

  const approve = () => {
    const rest: DecisionValues = { rule: { ...(text.trim() !== rule.text ? { text: text.trim() } : {}), ...(!sameScope(scope, rule.scope) ? { scope } : {}) } };
    return run(() => onDecide(item, "aprovado", rest));
  };
  const refuse = () => run(() => onDecide(item, "rejeitado", { reason: "Regra recusada" }));

  return (
    <CardShell item={item} label="Regra" icon="escudo" title={open ? "Regra proposta pela retrospectiva" : (item.title ?? "Regra")} agentName={agentName} cardRef={cardRef}>
      <p className="fy-rule__lead" data-testid="foryou-rule-evidence">
        {rule.evidence.line ? `${rule.evidence.line.charAt(0).toUpperCase()}${rule.evidence.line.slice(1)}` : `${rule.evidence.count} itens`}, em {rule.evidence.days} {rule.evidence.days === 1 ? "dia" : "dias"} (retrospectiva <span className="fy-rule__nowrap">{rule.retro}</span>).
        <span className="fy-rule__source"> {ruleSourceLabel(rule.source)}</span>
      </p>

      {open ? (
        <div className="fy-rule__edit">
          <label className="fy-rule__label" htmlFor={textId}>
            A regra (você pode mudar o texto)
          </label>
          <textarea id={textId} className="ui-input fy-rule__text" rows={3} value={text} onChange={(event) => setText(event.currentTarget.value)} data-testid="foryou-rule-text" />
          <fieldset className="fy-rule__scope">
            <legend className="fy-rule__label">Onde ela vale</legend>
            {options.map((option) => (
              <label key={scopeKey(option.scope)} className="fy-rule__radio">
                <input type="radio" name={`${item.id}-scope`} checked={sameScope(scope, option.scope)} onChange={() => setScope(option.scope)} data-testid={`foryou-rule-scope-${scopeKey(option.scope)}`} />
                <span>
                  {option.label}
                  <small>{option.hint}</small>
                </span>
              </label>
            ))}
          </fieldset>
        </div>
      ) : (
        <div className="fy-rule__done" data-testid="foryou-rule-final">
          <p className="fy-rule__text-final">{rule.text}</p>
          <p className="fy-rule__meta">
            Vale para: {ruleScopeLabel(rule.scope, agentName, roomName)} · {ruleStateText(item)}
          </p>
        </div>
      )}

      {excerpts.length > 0 && (
        <div className="fy-rule__evidence">
          <button type="button" className="fy-link" aria-expanded={evidenceOpen} onClick={() => setEvidenceOpen((current) => !current)} data-testid="foryou-rule-evidence-toggle">
            {evidenceOpen ? "Esconder a evidência" : `Ver a evidência (${excerpts.length} ${excerpts.length === 1 ? "trecho" : "trechos"})`}
          </button>
          {evidenceOpen && (
            <ul className="fy-rule__excerpts" data-testid="foryou-rule-excerpts">
              {excerpts.map((excerpt) => (
                <li key={excerpt.itemId}>
                  <span className="fy-rule__tag">{excerpt.itemId}</span>
                  <p className="fy-rule__before">{excerpt.before}</p>
                  {excerpt.after && <p className="fy-rule__after">{excerpt.after}</p>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <ErrorText testId="foryou-rule-error">{error}</ErrorText>
      {open && (
        <>
          <p className="fy-rule__hint">Aprovar grava uma nota no Cérebro ({ruleScopeLabel(scope, agentName, roomName)}) e a regra passa a valer para o próximo trabalho. Recusar esconde este padrão por 8 semanas.</p>
          <div className="fy-actions">
            <button type="button" className="ui-button ui-button--secondary" disabled={pending} onClick={() => void refuse()} data-testid="foryou-rule-refuse">
              Recusar
            </button>
            <span className="w-grow" />
            <button type="button" className="ui-button ui-button--success" disabled={pending || text.trim().length === 0} onClick={() => void approve()} data-testid="foryou-rule-approve">
              {pending ? "Gravando…" : changed ? "Aprovar com as mudanças" : "Aprovar regra"}
            </button>
          </div>
        </>
      )}
    </CardShell>
  );
}
