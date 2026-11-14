import type { FieldDef, TrackedItem, TrackingStatus } from "@cyno/shared";
import { useId, useState } from "react";
import { formatAgo } from "../../ui/format";
import { GIcon } from "./GIcon";
import { ITEM_FILTERS, ITEM_FILTER_LABELS, alertStatuses, cellText, dueText, isHttpUrl, itemFilterCounts, itemLabel, visibleItems, type ItemFilter } from "./routineView";

type Props = {
  items: TrackedItem[];
  fields: FieldDef[];
  statuses: TrackingStatus[];
  onOpen: (item: TrackedItem) => void;
};

/** Selo do status do item: o alerta ganha destaque (cor, ícone e texto); o final ganha o traço cheio. */
export function ItemStatus({ item, statuses }: { item: Pick<TrackedItem, "status" | "state">; statuses: TrackingStatus[] }) {
  const def = statuses.find((status) => status.name === item.status);
  const tone = def?.alert ? "alert" : def?.terminal ? "final" : "plain";
  return (
    <span className={`istatus istatus--${tone}`} data-tone={tone}>
      {def?.alert && <GIcon name="alert" size={12} />}
      {item.status}
    </span>
  );
}

/**
 * Tabela dos itens do acompanhamento (colunas = campos do esquema, status, última verificação, vence em),
 * com filtros (ativos, com alerta, encerrados, parados) e busca. No celular vira lista de cartões.
 */
export function ItemsTable({ items, fields, statuses, onOpen }: Props) {
  const [filter, setFilter] = useState<ItemFilter>("ativos");
  const [query, setQuery] = useState("");
  const searchId = useId();
  const now = new Date();
  const alerts = alertStatuses(statuses);
  const counts = itemFilterCounts(items, alerts);
  const shown = visibleItems(items, filter, query, alerts);

  return (
    <div className="itab" data-testid="items-table">
      <div className="itab__bar">
        <div className="itab__chips" role="group" aria-label="Filtrar itens">
          {ITEM_FILTERS.filter((id) => id !== "alerta" || alerts.size > 0).map((id) => (
            <button key={id} type="button" className="itab__chip" aria-pressed={filter === id} onClick={() => setFilter(id)} data-testid={`items-filter-${id}`}>
              {ITEM_FILTER_LABELS[id]} <span className="itab__count">{counts[id]}</span>
            </button>
          ))}
        </div>
        <label className="sr-only" htmlFor={searchId}>
          Buscar nos itens
        </label>
        <input id={searchId} type="search" className="ui-input ui-input--compact itab__search" placeholder="Buscar nos itens…" value={query} onChange={(e) => setQuery(e.currentTarget.value)} data-testid="items-search" />
      </div>

      {shown.length === 0 ? (
        <p className="goal__muted itab__empty" data-testid="items-empty">
          {items.length === 0 ? "Nenhum item ainda. O agente cria os itens nas execuções dos horários." : "Nenhum item com esse filtro."}
        </p>
      ) : (
        <>
          <div className="itab__scroll">
            <table className="itab__table">
              <thead>
                <tr>
                  {fields.map((field) => (
                    <th key={field.key} scope="col">
                      {field.label}
                    </th>
                  ))}
                  <th scope="col">Status</th>
                  <th scope="col">Última verificação</th>
                  <th scope="col">Vence em</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((item) => (
                  <tr key={item.id} className={`itab__row${item.state === "ativo" ? "" : " itab__row--off"}${alerts.has(item.status) ? " itab__row--alert" : ""}`} data-testid={`item-row-${item.id}`} data-state={item.state}>
                    {fields.map((field, index) => (
                      <td key={field.key}>
                        {index === 0 ? (
                          <button type="button" className="itab__open" onClick={() => onOpen(item)} data-testid={`item-open-${item.id}`}>
                            {cellText(field, item.values[field.key]) === "–" ? item.id : cellText(field, item.values[field.key])}
                          </button>
                        ) : (
                          <Cell field={field} value={item.values[field.key]} />
                        )}
                      </td>
                    ))}
                    <td>
                      <ItemStatus item={item} statuses={statuses} />
                    </td>
                    <td className="itab__muted">{item.lastCheckedAt ? formatAgo(item.lastCheckedAt, now) : "Ainda não"}</td>
                    <td className="itab__muted">{dueText(item, now)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <ul className="icards" aria-label="Itens">
            {shown.map((item) => (
              <li key={item.id} className={`icard${item.state === "ativo" ? "" : " icard--off"}${alerts.has(item.status) ? " icard--alert" : ""}`} data-state={item.state}>
                <button type="button" className="icard__main" onClick={() => onOpen(item)}>
                  <span className="icard__name">{itemLabel(fields, item)}</span>
                  <ItemStatus item={item} statuses={statuses} />
                </button>
                <dl className="icard__facts">
                  {fields.slice(1).map((field) => (
                    <div key={field.key}>
                      <dt>{field.label}</dt>
                      <dd>
                        <Cell field={field} value={item.values[field.key]} />
                      </dd>
                    </div>
                  ))}
                  <div>
                    <dt>Verificado</dt>
                    <dd>{item.lastCheckedAt ? formatAgo(item.lastCheckedAt, now) : "Ainda não"}</dd>
                  </div>
                  <div>
                    <dt>Prazo</dt>
                    <dd>{dueText(item, now)}</dd>
                  </div>
                </dl>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function Cell({ field, value }: { field: FieldDef; value: string | number | undefined }) {
  const text = cellText(field, value);
  if (field.type === "link" && value !== undefined && isHttpUrl(String(value))) {
    return (
      <a className="glist__link" href={String(value)} target="_blank" rel="noopener noreferrer" title={String(value)}>
        {text}
        <GIcon name="link" size={12} />
      </a>
    );
  }
  return <span className={text === "–" ? "itab__muted" : undefined}>{text}</span>;
}
