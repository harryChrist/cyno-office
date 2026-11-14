import { FIELD_TYPES } from "@cyno/shared";
import type { FieldErrors } from "../../ui/validation";
import { GIcon } from "./GIcon";
import { FIELD_TYPE_LABELS, type FieldFormValues, type RoutineFormField, type RoutineFormValues, type StatusFormValues } from "./routineForm";

type Props = {
  values: RoutineFormValues;
  errors: FieldErrors<RoutineFormField>;
  trackingFields: string[];
  trackingStatuses: string[];
  onChange: (patch: Partial<RoutineFormValues>) => void;
  editing: boolean;
};

/**
 * Esquema do acompanhamento: as colunas da tabela, os status (com "final" e "alerta") e a vida do item.
 * Ao editar, o que já existe fica travado (os itens dependem disso) e só dá para acrescentar.
 */
export function TrackingEditor({ values, errors, trackingFields, trackingStatuses, onChange, editing }: Props) {
  const setField = (index: number, patch: Partial<FieldFormValues>) => onChange({ fields: values.fields.map((field, i) => (i === index ? { ...field, ...patch } : field)) });
  const setStatus = (index: number, patch: Partial<StatusFormValues>) => onChange({ statuses: values.statuses.map((status, i) => (i === index ? { ...status, ...patch } : status)) });
  const expireOptions = values.statuses.map((status) => status.name.trim()).filter(Boolean);

  return (
    <div className="ted" data-testid="tracking-editor">
      <section className="ted__section" aria-label="Colunas da tabela">
        <h4 className="ted__h">Colunas da tabela</h4>
        <p className="ted__hint">O que o agente anota de cada item. A primeira coluna é o nome da linha.{editing ? " As colunas que já existem não mudam; você pode acrescentar novas." : ""}</p>
        <ul className="ted__list">
          {values.fields.map((field, index) => (
            <li key={field.locked ? field.key : `new-${index}`} className="ted__row ted__row--field">
              <input className="ui-input" value={field.label} maxLength={80} disabled={field.locked} placeholder="Nome da coluna" aria-label={`Nome da coluna ${index + 1}`} aria-invalid={Boolean(trackingFields[index])} onChange={(e) => setField(index, { label: e.currentTarget.value })} data-testid={`field-label-${index}`} />
              <select className="ui-input" value={field.type} disabled={field.locked} aria-label={`Tipo da coluna ${index + 1}`} onChange={(e) => setField(index, { type: e.currentTarget.value as FieldFormValues["type"] })} data-testid={`field-type-${index}`}>
                {FIELD_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {FIELD_TYPE_LABELS[type]}
                  </option>
                ))}
              </select>
              <label className="ted__check">
                <input type="checkbox" checked={field.required} disabled={field.locked} onChange={(e) => setField(index, { required: e.currentTarget.checked })} />
                Obrigatória
              </label>
              {field.locked ? (
                <span className="ted__lock" title="Já usada pelos itens">
                  fixa
                </span>
              ) : (
                <button type="button" className="ui-button ui-button--ghost ui-button--small" aria-label={`Remover a coluna ${index + 1}`} onClick={() => onChange({ fields: values.fields.filter((_, i) => i !== index) })} data-testid={`field-remove-${index}`}>
                  <GIcon name="close" size={13} />
                </button>
              )}
              {field.type === "opcao" && (
                <input className="ui-input ted__options" value={field.options} disabled={field.locked} placeholder="Opções separadas por vírgula" aria-label={`Opções da coluna ${index + 1}`} onChange={(e) => setField(index, { options: e.currentTarget.value })} />
              )}
              {trackingFields[index] && <p className="ui-field__error ted__error">{trackingFields[index]}</p>}
            </li>
          ))}
        </ul>
        {errors.fields && <p className="ui-field__error">{errors.fields}</p>}
        <button type="button" className="ui-button ui-button--secondary ui-button--small" onClick={() => onChange({ fields: [...values.fields, { key: "", label: "", type: "texto", options: "", required: false, locked: false }] })} data-testid="field-add">
          <GIcon name="plus" size={13} />
          Adicionar coluna
        </button>
      </section>

      <section className="ted__section" aria-label="Status">
        <h4 className="ted__h">Status</h4>
        <p className="ted__hint">O primeiro é o status inicial. “Final” encerra o item; “Alerta” destaca a mudança e avisa você.{editing ? " Os que existem não mudam; você pode acrescentar novos." : ""}</p>
        <ul className="ted__list">
          {values.statuses.map((status, index) => (
            <li key={status.locked ? status.name : `new-${index}`} className="ted__row ted__row--status">
              <input className="ui-input" value={status.name} maxLength={60} disabled={status.locked} placeholder="Nome do status" aria-label={`Nome do status ${index + 1}`} aria-invalid={Boolean(trackingStatuses[index])} onChange={(e) => setStatus(index, { name: e.currentTarget.value })} data-testid={`status-name-${index}`} />
              <label className="ted__check">
                <input type="checkbox" checked={status.terminal} onChange={(e) => setStatus(index, { terminal: e.currentTarget.checked })} data-testid={`status-final-${index}`} />
                Final
              </label>
              <label className="ted__check">
                <input type="checkbox" checked={status.alert} onChange={(e) => setStatus(index, { alert: e.currentTarget.checked })} data-testid={`status-alert-${index}`} />
                Alerta
              </label>
              {index === 0 ? (
                <span className="ted__lock">inicial</span>
              ) : status.locked ? (
                <span className="ted__lock" title="Já usado pelos itens">
                  fixo
                </span>
              ) : (
                <button type="button" className="ui-button ui-button--ghost ui-button--small" aria-label={`Remover o status ${index + 1}`} onClick={() => onChange({ statuses: values.statuses.filter((_, i) => i !== index) })} data-testid={`status-remove-${index}`}>
                  <GIcon name="close" size={13} />
                </button>
              )}
              {trackingStatuses[index] && <p className="ui-field__error ted__error">{trackingStatuses[index]}</p>}
            </li>
          ))}
        </ul>
        {errors.statuses && <p className="ui-field__error">{errors.statuses}</p>}
        <button type="button" className="ui-button ui-button--secondary ui-button--small" onClick={() => onChange({ statuses: [...values.statuses, { name: "", terminal: false, alert: false, locked: false }] })} data-testid="status-add">
          <GIcon name="plus" size={13} />
          Adicionar status
        </button>
      </section>

      <section className="ted__section" aria-label="Vida do item">
        <h4 className="ted__h">Vida do item e conferência</h4>
        <div className="ui-form__row">
          <div className="ui-field">
            <label className="ui-field__label" htmlFor="ted-days">
              Vida do item (dias)
            </label>
            <input id="ted-days" className="ui-input" inputMode="numeric" value={values.lifespanDays} placeholder="Sem prazo" aria-invalid={Boolean(errors.lifespanDays)} onChange={(e) => onChange({ lifespanDays: e.currentTarget.value })} data-testid="tracking-days" />
            {errors.lifespanDays ? <p className="ui-field__error">{errors.lifespanDays}</p> : <p className="ui-field__hint">Passado esse prazo, o item se encerra sozinho.</p>}
          </div>
          <div className="ui-field">
            <label className="ui-field__label" htmlFor="ted-every">
              Conferir a cada (horas)
            </label>
            <input id="ted-every" className="ui-input" inputMode="numeric" value={values.checkEveryHours} placeholder="Toda vez" aria-invalid={Boolean(errors.checkEveryHours)} onChange={(e) => onChange({ checkEveryHours: e.currentTarget.value })} data-testid="tracking-every" />
            {errors.checkEveryHours ? <p className="ui-field__error">{errors.checkEveryHours}</p> : <p className="ui-field__hint">Ex.: 24 confere cada item uma vez por dia.</p>}
          </div>
        </div>
        <div className="ui-form__row">
          <div className="ui-field">
            <label className="ui-field__label" htmlFor="ted-expire">
              Status ao vencer
            </label>
            <select id="ted-expire" className="ui-input" value={values.expireStatus} aria-invalid={Boolean(errors.expireStatus)} onChange={(e) => onChange({ expireStatus: e.currentTarget.value })} data-testid="tracking-expire">
              <option value="">Nenhum (só encerra)</option>
              {expireOptions.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
            {errors.expireStatus && <p className="ui-field__error">{errors.expireStatus}</p>}
          </div>
          <label className="ted__check ted__check--block">
            <input type="checkbox" checked={values.untilTerminal} onChange={(e) => onChange({ untilTerminal: e.currentTarget.checked })} data-testid="tracking-until-terminal" />
            Encerrar o item ao chegar a um status final
          </label>
        </div>
      </section>
    </div>
  );
}
