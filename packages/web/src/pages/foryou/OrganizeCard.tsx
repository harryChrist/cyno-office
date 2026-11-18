import type {
  BrainOrganizePlan,
  ForYouDecisionStatus,
  ForYouItem,
} from "@cyno/shared";
import { useId, useState, type Ref } from "react";
import { useAsyncAction } from "../../ui/useAsyncAction";
import { ErrorText } from "../../ui/widgets";
import type { DecisionValues } from "./ForYouCard";
import { CardShell } from "./SpecialCards";
import {
  actionPreview,
  actionTitle,
  applyCount,
  applyLabel,
  appliedSummary,
  beforeAfterLine,
  failedRows,
  groupOrganizeActions,
  mergeTitles,
  ORGANIZE_COLLAPSE_AFTER,
  skipList,
  type OrganizeGroup,
  type OrganizeRow,
} from "./organizeView";
import "./organizeCard.css";

type Props = {
  item: ForYouItem;
  plan: BrainOrganizePlan;
  agentName?: string;
  cardRef?: Ref<HTMLElement>;
  /** Item do arquivo ("Mais antigos"): só leitura, sem caixas nem botões. */
  readOnly?: boolean;
  onDecide: (
    item: ForYouItem,
    status: ForYouDecisionStatus,
    values: DecisionValues,
  ) => Promise<unknown>;
};

/** Uma linha da proposta: caixa (só pendente), título, motivo e o texto novo sob demanda. */
function ActionRow({
  row,
  checked,
  selectable,
  state,
  onToggle,
}: {
  row: OrganizeRow;
  checked: boolean;
  selectable: boolean;
  state?: "skipped" | "failed";
  onToggle: () => void;
}) {
  const [open, setOpen] = useState(false);
  const previewId = useId();
  const { action } = row;
  const title = actionTitle(action);
  const preview = actionPreview(action);
  const reason = action.reason?.trim();
  // Regra é curta e é o que o dono está aprovando: o texto fica à vista, sem precisar abrir.
  const inline = action.type === "agent_rule" || action.type === "make_rule";
  return (
    <li
      className="fy-org__row"
      data-testid="organize-action"
      data-type={action.type}
      data-index={row.index}
      data-state={state}
    >
      <div className="fy-org__line">
        {selectable ? (
          <label className="fy-org__check">
            <input
              type="checkbox"
              checked={checked}
              onChange={onToggle}
              aria-label={`Aplicar: ${title}`}
              data-testid="organize-action-check"
            />
            <span className="fy-org__title">{title}</span>
          </label>
        ) : (
          <span className="fy-org__title">{title}</span>
        )}
        {state === "skipped" && <span className="fy-org__tag">desmarcada</span>}
        {state === "failed" && (
          <span className="fy-org__tag fy-org__tag--bad">não aplicada</span>
        )}
      </div>
      {action.type === "merge" && (
        <p className="fy-org__merge">Junta: {mergeTitles(action).join(", ")}</p>
      )}
      {reason && <p className="fy-org__reason">{reason}</p>}
      {preview && inline && (
        <pre className="fy-org__preview" data-testid="organize-preview">
          {preview}
        </pre>
      )}
      {preview && !inline && (
        <>
          <button
            type="button"
            className="fy-link fy-org__more"
            aria-expanded={open}
            aria-controls={previewId}
            onClick={() => setOpen((current) => !current)}
            data-testid="organize-preview-toggle"
          >
            {open ? "Esconder o texto" : "Ver o texto"}
          </button>
          {open && (
            <pre
              id={previewId}
              className="fy-org__preview"
              data-testid="organize-preview"
            >
              {preview}
            </pre>
          )}
        </>
      )}
    </li>
  );
}

/** Um grupo de ações do mesmo tipo; o de muitas linhas mostra as primeiras e "Mostrar mais N". */
function Group({
  group,
  skipped,
  selectable,
  failedIndexes,
  onToggle,
}: {
  group: OrganizeGroup;
  skipped: ReadonlySet<number>;
  selectable: boolean;
  failedIndexes: ReadonlySet<number>;
  onToggle: (index: number) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const hidden =
    group.rows.length > ORGANIZE_COLLAPSE_AFTER && !expanded
      ? group.rows.length - ORGANIZE_COLLAPSE_AFTER
      : 0;
  const rows =
    hidden > 0 ? group.rows.slice(0, ORGANIZE_COLLAPSE_AFTER) : group.rows;
  return (
    <section
      className="fy-org__group"
      data-testid="organize-group"
      data-type={group.type}
    >
      <h4 className="fy-org__group-title">
        {group.label} <span className="fy-org__count">{group.rows.length}</span>
      </h4>
      <ul className="fy-org__rows">
        {rows.map((row) => (
          <ActionRow
            key={row.index}
            row={row}
            selectable={selectable}
            checked={!skipped.has(row.index)}
            state={
              failedIndexes.has(row.index)
                ? "failed"
                : !selectable && skipped.has(row.index)
                  ? "skipped"
                  : undefined
            }
            onToggle={() => onToggle(row.index)}
          />
        ))}
      </ul>
      {hidden > 0 && (
        <button
          type="button"
          className="fy-link fy-org__more"
          onClick={() => setExpanded(true)}
          data-testid="organize-show-more"
        >
          Mostrar mais {hidden}
        </button>
      )}
    </section>
  );
}

/**
 * Cartão "organizacao" do Para você: a proposta do Maestro para deixar o Cérebro de uma sala enxuto
 * (o que vira regra, o que vira resumo, o que vai para o histórico). Cada ação vem marcada; o dono
 * desmarca o que não quer e "Aplicar" manda só as marcadas. Nada é apagado: o que sai vai para o histórico.
 */
export function OrganizeCard({
  item,
  plan,
  agentName,
  cardRef,
  readOnly,
  onDecide,
}: Props) {
  const open = item.status === "pendente" && !readOnly;
  const [skipped, setSkipped] = useState<ReadonlySet<number>>(new Set());
  const [refusing, setRefusing] = useState(false);
  const [reason, setReason] = useState("");
  const { pending, error, run } = useAsyncAction();
  const reasonId = useId();
  const groups = groupOrganizeActions(plan.actions);
  const count = applyCount(plan.actions.length, skipped);
  const decidedSkipped = new Set(plan.skipped ?? []);
  const failures = failedRows(plan);
  const failedIndexes = new Set(failures.map((failure) => failure.index));
  const approved = item.status === "aprovado";

  const toggle = (index: number) =>
    setSkipped((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  const apply = () =>
    run(() =>
      onDecide(item, "aprovado", {
        organize: { skip: skipList(skipped, plan.actions.length) },
      }),
    );
  const refuse = () =>
    run(() =>
      onDecide(
        item,
        "rejeitado",
        reason.trim() ? { reason: reason.trim() } : {},
      ),
    );

  return (
    <CardShell
      item={item}
      label="Organização"
      icon="marcador"
      title={`Organizar o Cérebro de ${plan.brainName}`}
      agentName={agentName}
      cardRef={cardRef}
    >
      {/* `display: contents`: o cartão precisa ser filho direto do painel e as ações, filhas dele, para o pé colado e as margens valerem como nos outros cartões. */}
      <div data-testid="organize-card" className="fy-org">
        {plan.summary && (
          <p className="fy-org__summary" data-testid="organize-summary">
            {plan.summary}
          </p>
        )}
        <p className="fy-org__weight" data-testid="organize-weight">
          {beforeAfterLine(plan.before, plan.after)}
        </p>

        {groups.length === 0 ? (
          <p className="fy-org__empty">
            O Maestro não encontrou nada para mudar.
          </p>
        ) : (
          <div className="fy-org__groups">
            {groups.map((group) => (
              <Group
                key={group.type}
                group={group}
                skipped={open ? skipped : decidedSkipped}
                selectable={open}
                failedIndexes={failedIndexes}
                onToggle={toggle}
              />
            ))}
          </div>
        )}

        <p className="fy-org__safe">
          Nada é apagado: o que sai vai para o histórico e continua achável pela
          busca.
        </p>

        {approved && (
          <div className="fy-org__done" data-testid="organize-done">
            <p className="fy-org__done-line">
              {appliedSummary(plan).join(" · ")}
            </p>
            {failures.length > 0 && (
              <ul className="fy-org__failed" data-testid="organize-failed">
                {failures.map((failure) => (
                  <li key={failure.index}>
                    <strong>{failure.title}:</strong> {failure.error}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {item.status === "rejeitado" && (
          <p className="fy-card__note">
            Proposta recusada: nada mudou no Cérebro.
            {item.rejection?.reason ? ` Motivo: ${item.rejection.reason}` : ""}
          </p>
        )}

        <ErrorText testId="organize-error">{error}</ErrorText>
        {open && refusing && (
          <div className="fy-org__refuse">
            <label className="fy-org__label" htmlFor={reasonId}>
              Por que está recusando? (opcional)
            </label>
            <textarea
              id={reasonId}
              className="ui-input fy-textarea fy-textarea--note"
              rows={2}
              value={reason}
              onChange={(event) => setReason(event.currentTarget.value)}
              autoFocus
              data-testid="organize-reason"
            />
          </div>
        )}
        {open && (
          <div className="fy-actions">
            {refusing ? (
              <button
                type="button"
                className="ui-button ui-button--secondary"
                disabled={pending}
                onClick={() => setRefusing(false)}
              >
                Voltar
              </button>
            ) : null}
            <button
              type="button"
              className="ui-button ui-button--secondary"
              disabled={pending}
              onClick={() => (refusing ? void refuse() : setRefusing(true))}
              data-testid="organize-reject"
            >
              {refusing
                ? pending
                  ? "Recusando…"
                  : "Confirmar recusa"
                : "Recusar"}
            </button>
            <span className="w-grow" />
            {!refusing && (
              <button
                type="button"
                className="ui-button ui-button--success"
                disabled={pending || count === 0}
                onClick={() => void apply()}
                data-testid="organize-apply"
              >
                {pending ? "Aplicando…" : applyLabel(count)}
              </button>
            )}
          </div>
        )}
      </div>
    </CardShell>
  );
}
