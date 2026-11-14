import type { FieldDef, TrackedItem, TrackingStatus } from "@cyno/shared";
import { useState } from "react";
import { api } from "../../api/client";
import { formatDateTime } from "../../ui/format";
import { useAsyncAction } from "../../ui/useAsyncAction";
import { ErrorText } from "../../ui/widgets";
import { ItemStatus } from "./ItemsTable";
import { BY_LABELS, dueText, historyNewestFirst, historyText, isHttpUrl, itemLabel } from "./routineView";

type Props = {
  routineId: string;
  item: TrackedItem;
  fields: FieldDef[];
  statuses: TrackingStatus[];
  onBack: () => void;
  /** Recarrega a lista depois de uma ação. */
  onChanged: () => void;
};

const inputType = (field: FieldDef): string => (field.type === "data" ? "date" : field.type === "numero" ? "number" : field.type === "link" ? "url" : "text");

/** Um item: campos editáveis, status, Parar/Reabrir e a linha do tempo (data, de → para, nota). */
export function ItemDetail({ routineId, item, fields, statuses, onBack, onChanged }: Props) {
  const initial = Object.fromEntries(fields.map((field) => [field.key, item.values[field.key] === undefined ? "" : String(item.values[field.key])]));
  const [values, setValues] = useState<Record<string, string>>(initial);
  const [status, setStatus] = useState(item.status);
  const edit = useAsyncAction();
  const toggle = useAsyncAction();
  const label = itemLabel(fields, item);
  const changedValues = Object.fromEntries(fields.filter((field) => values[field.key] !== initial[field.key] && values[field.key]?.trim() !== "").map((field) => [field.key, field.type === "numero" ? Number(values[field.key]) : (values[field.key] ?? "").trim()]));
  const dirty = Object.keys(changedValues).length > 0 || status !== item.status;
  const fieldLabel = (key: string) => fields.find((field) => field.key === key)?.label ?? key;
  const now = new Date();

  const save = async () => {
    const done = await edit.run(() => api.editRoutineItem(routineId, item.id, { ...(Object.keys(changedValues).length > 0 ? { values: changedValues } : {}), ...(status !== item.status ? { status } : {}) }));
    if (done) onChanged();
  };
  const stopOrReopen = async () => {
    const done = await toggle.run(() => (item.state === "ativo" ? api.stopRoutineItem(routineId, item.id) : api.reopenRoutineItem(routineId, item.id)));
    if (done) onChanged();
  };

  return (
    <div className="idet" data-testid="item-detail">
      <button type="button" className="ui-link idet__back" onClick={onBack} data-testid="item-back">
        ← Voltar aos itens
      </button>
      <header className="idet__head">
        <div>
          <h4 className="idet__title">{label}</h4>
          <p className="goal__muted">
            {item.id} · {item.state === "ativo" ? "Ativo" : item.state === "parado" ? "Parado por você" : "Encerrado"} · {dueText(item, now)}
          </p>
        </div>
        <ItemStatus item={item} statuses={statuses} />
      </header>

      <div className="idet__actions">
        <button type="button" className="ui-button ui-button--secondary ui-button--small" disabled={toggle.pending} onClick={() => void stopOrReopen()} data-testid={item.state === "ativo" ? "item-stop" : "item-reopen"}>
          {item.state === "ativo" ? "Parar este item" : item.state === "parado" ? "Retomar" : "Reabrir"}
        </button>
        <ErrorText>{toggle.error}</ErrorText>
      </div>

      <section className="idet__section" aria-label="Editar">
        <h5 className="gweek__title">Dados do item</h5>
        <div className="idet__form">
          <label className="ui-field">
            <span className="ui-field__label">Status</span>
            <select className="ui-input" value={status} onChange={(e) => setStatus(e.currentTarget.value)} data-testid="item-status">
              {statuses.map((candidate) => (
                <option key={candidate.name} value={candidate.name}>
                  {candidate.name}
                  {candidate.alert ? " (alerta)" : candidate.terminal ? " (final)" : ""}
                </option>
              ))}
            </select>
          </label>
          {fields.map((field) => (
            <label key={field.key} className="ui-field">
              <span className="ui-field__label">{field.label}</span>
              {field.type === "opcao" ? (
                <select className="ui-input" value={values[field.key] ?? ""} onChange={(e) => setValues({ ...values, [field.key]: e.currentTarget.value })}>
                  <option value="">–</option>
                  {(field.options ?? []).map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              ) : (
                <input className="ui-input" type={inputType(field)} value={values[field.key] ?? ""} onChange={(e) => setValues({ ...values, [field.key]: e.currentTarget.value })} data-testid={`item-field-${field.key}`} />
              )}
              {field.type === "link" && values[field.key] && isHttpUrl(values[field.key]!) && (
                <a className="glist__link" href={values[field.key]} target="_blank" rel="noopener noreferrer">
                  Abrir o link
                </a>
              )}
            </label>
          ))}
        </div>
        <div className="idet__actions">
          <button type="button" className="ui-button ui-button--small" disabled={!dirty || edit.pending} onClick={() => void save()} data-testid="item-save">
            {edit.pending ? "Salvando…" : "Salvar alterações"}
          </button>
        </div>
        <ErrorText>{edit.error}</ErrorText>
      </section>

      <section className="idet__section" aria-label="Histórico do item" data-testid="item-history">
        <h5 className="gweek__title">Histórico</h5>
        <ol className="itl">
          {historyNewestFirst(item.history).map((entry, index) => (
            <li key={`${entry.at}-${index}`} className="itl__row">
              <span className="itl__when">{formatDateTime(entry.at)}</span>
              <span className="itl__what">
                {historyText(entry, fieldLabel)}
                {entry.note && entry.field !== "nota" ? <span className="itl__note"> · {entry.note}</span> : null}
                {entry.field === "nota" ? <span className="itl__note"> · {entry.note}</span> : null}
              </span>
              <span className="itl__by">{BY_LABELS[entry.by]}</span>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
