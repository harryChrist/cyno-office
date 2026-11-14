import type { RoutineProposalPayload, RoutineProposalSchedule, RoutineProposalView } from "@cyno/shared";
import { diffViews, FIELD_TYPE_LABELS, goalDetails, goalLine, lifespanText, suggestedModeText, TYPE_LABELS, whenText, whoText } from "./routineProposal";

type Props = { payload: RoutineProposalPayload; view: RoutineProposalView; before?: RoutineProposalView; choice: "pede-ok" | "automatico"; onChoice?: (choice: "pede-ok" | "automatico") => void };

function ScheduleRow({ schedule, owner, tag, before }: { schedule: RoutineProposalSchedule; owner: string; tag?: string; before?: RoutineProposalSchedule }) {
  return (
    <li className={`fy-rp__sched${schedule.enabled ? "" : " is-off"}`} data-testid="foryou-routine-schedule">
      <div className="fy-rp__when">
        <strong>{whenText(schedule)}</strong>
        {tag && <span className="fy-rp__tag">{tag}</span>}
        {!schedule.enabled && <span className="fy-rp__tag fy-rp__tag--muted">desligado</span>}
        <span className="fy-rp__who">{whoText(schedule, owner)}</span>
      </div>
      <div className="fy-rp__what">
        <span className="fy-rp__label">{schedule.label}</span>
        {schedule.scope === "itens_vencidos" && <span className="fy-rp__tag fy-rp__tag--muted">só com item para conferir</span>}
        <p>{schedule.action}</p>
      </div>
      {before && (
        <p className="fy-rp__before">
          Antes: {whenText(before)} · {whoText(before, owner)}
          {before.action !== schedule.action ? " · ação mudou" : ""}
        </p>
      )}
    </li>
  );
}

/** Corpo do cartão de proposta (criar e alterar): tipo, horários, meta ou tabela, e o modo. */
export function RoutineProposalBody({ payload, view, before, choice, onChoice }: Props) {
  const diff = diffViews(before, view);
  const unit = payload.unit || "item";
  const suggested = payload.suggestedMode;
  return (
    <div className="fy-rp" data-testid="foryou-routine">
      <div className="fy-rp__head">
        <span className="fy-rp__type" data-testid="foryou-routine-type">
          {TYPE_LABELS[view.type]}
        </span>
        <strong>{view.title}</strong>
        <span className="fy-rp__sub">Quem faz: {view.owner}</span>
      </div>

      {before && diff.notes.length > 0 && (
        <section className="fy-rp__sec" data-testid="foryou-routine-changes">
          <h4>O que muda</h4>
          <ul className="fy-rp__notes">
            {diff.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </section>
      )}

      {view.goal && (
        <section className="fy-rp__sec">
          <h4>Meta</h4>
          <p className="fy-rp__big">{goalLine(view.goal, unit)}</p>
          <p className="fy-rp__sub">{[view.site, ...goalDetails(view.goal)].filter(Boolean).join(" · ")}</p>
        </section>
      )}

      <section className="fy-rp__sec">
        <h4>{view.type === "meta" ? "Lembretes (horários)" : "Horários"}</h4>
        {view.schedules.length === 0 ? (
          <p className="fy-rp__sub">Sem horários fixos: o servidor vigia o ritmo da meta sozinho.</p>
        ) : (
          <ul className="fy-rp__list">
            {diff.schedules.map(({ schedule, status, before: was }) => (
              <ScheduleRow key={schedule.id ?? schedule.label + whenText(schedule)} schedule={schedule} owner={view.owner} {...(status === "novo" ? { tag: "novo" } : status === "mudou" ? { tag: "mudou" } : {})} {...(was ? { before: was } : {})} />
            ))}
            {diff.removed.map((schedule) => (
              <li key={`rm-${schedule.id ?? schedule.label}`} className="fy-rp__sched is-removed">
                <div className="fy-rp__when">
                  <strong>{whenText(schedule)}</strong>
                  <span className="fy-rp__tag fy-rp__tag--danger">removido</span>
                  <span className="fy-rp__who">{schedule.label}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {view.tracking && (
        <section className="fy-rp__sec" data-testid="foryou-routine-tracking">
          <h4>Itens acompanhados</h4>
          {view.tracking.fields.length > 0 && (
            <table className="fy-rp__table">
              <thead>
                <tr>
                  <th>Campo</th>
                  <th>Tipo</th>
                </tr>
              </thead>
              <tbody>
                {view.tracking.fields.map((field) => (
                  <tr key={field.key}>
                    <td>
                      {field.label}
                      {field.required ? " *" : ""}
                    </td>
                    <td>
                      {FIELD_TYPE_LABELS[field.type]}
                      {field.options?.length ? `: ${field.options.join(", ")}` : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <ul className="fy-rp__chips" aria-label="Status">
            {view.tracking.statuses.map((status, index) => (
              <li key={status.name} className={status.terminal ? "is-final" : status.alert ? "is-alert" : ""}>
                {status.name}
                <small>{[index === 0 ? "inicial" : "", status.terminal ? "final" : "", status.alert ? "alerta" : ""].filter(Boolean).join(" · ")}</small>
              </li>
            ))}
          </ul>
          <p className="fy-rp__sub">Vida do item: {lifespanText(view.tracking)}</p>
        </section>
      )}

      {view.instruction && (
        <section className="fy-rp__sec">
          <h4>Instruções gerais</h4>
          <p className="fy-rp__instruction">{view.instruction}</p>
        </section>
      )}

      <section className="fy-rp__sec" data-testid="foryou-routine-mode">
        <h4>Modo</h4>
        {suggested && onChoice ? (
          <div className="fy-rp__modes" role="radiogroup" aria-label="Modo da rotina">
            <label className={choice === "pede-ok" ? "is-on" : ""}>
              <input type="radio" name="routine-mode" checked={choice === "pede-ok"} onChange={() => onChoice("pede-ok")} data-testid="foryou-routine-mode-pede-ok" />
              <span>
                <strong>Criar em Pede OK</strong>
                <small>Publicar, enviar ou clicar em algo sensível pede o seu OK. Ler nunca pede.</small>
              </span>
            </label>
            <label className={choice === "automatico" ? "is-on" : ""}>
              <input type="radio" name="routine-mode" checked={choice === "automatico"} onChange={() => onChoice("automatico")} data-testid="foryou-routine-mode-auto" />
              <span>
                <strong>Criar já no Automático</strong>
                <small>O Maestro sugeriu. {suggestedModeText(suggested).join(" · ")}. Tudo fica na Atividade e você desliga quando quiser.</small>
              </span>
            </label>
          </div>
        ) : (
          <p className="fy-rp__sub">Pede OK: publicar, enviar ou clicar em algo sensível pede o seu OK. Ler nunca pede. Você pode ligar o Automático depois, na própria rotina.</p>
        )}
      </section>
    </div>
  );
}
