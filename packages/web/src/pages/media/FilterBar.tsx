import { useEffect, useRef, useState } from "react";
import { MIcon } from "./MediaParts";
import { NO_FILTERS, type MediaFilters, type Option } from "./mediaView";

export type FilterOptions = { kind: Option<string>[]; status: Option<string>[]; agent: Option<string>[] };

type Props = {
  filters: MediaFilters;
  onChange: (filters: MediaFilters) => void;
  options: FilterOptions;
  showDiscarded: boolean;
  onShowDiscarded: (value: boolean) => void;
  /** Só mostra o interruptor quando existe algum descartado. */
  hasDiscarded: boolean;
};

const LABELS = { kind: "Tipo", status: "Estado", agent: "Agente" } as const;
type Key = keyof typeof LABELS;
const KEYS = ["kind", "status", "agent"] as const;

/** Um filtro só faz sentido com mais de uma opção para escolher (ou já ligado, para dar para desligar). */
const useful = (options: Option<string>[], value: string) => options.length > 2 || value !== "todos";

const activeKeys = (filters: MediaFilters): Key[] => KEYS.filter((key) => filters[key] !== "todos");

function Switch({ checked, onChange }: { checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <label className="md-switch">
      <input type="checkbox" role="switch" checked={checked} onChange={(event) => onChange(event.currentTarget.checked)} data-testid="media-show-discarded" />
      <span className="md-switch__track" aria-hidden="true" />
      <span className="md-switch__label">Mostrar descartados</span>
    </label>
  );
}

/** Um filtro como fichas para escolher (uma só marcada), cada uma com a contagem. */
function ChipGroup({ label, options, value, onChange, testId }: { label: string; options: Option<string>[]; value: string; onChange: (value: string) => void; testId: string }) {
  return (
    <div className="md-fgroup" role="radiogroup" aria-label={label} data-testid={testId}>
      <span className="md-fgroup__label">{label}</span>
      <div className="md-fgroup__chips">
        {options.map((option) => (
          <button key={option.value} type="button" role="radio" aria-checked={option.value === value} className="md-fchip" onClick={() => onChange(option.value)}>
            {option.label}
            <span className="md-fchip__n">{option.count}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * O botão "Filtros" (com a quantidade de filtros ligados) e o painel que ele abre: tipo, estado e agente em fichas e o
 * interruptor dos descartados. No computador o painel desce do botão; no celular vira uma folha de baixo.
 * Esc e clique fora fecham. Os filtros ligados aparecem como fichas removíveis (`ActiveFilters`).
 */
export function FilterBar({ filters, onChange, options, showDiscarded, onShowDiscarded, hasDiscarded }: Props) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const set = (key: Key, value: string) => onChange({ ...filters, [key]: value } as MediaFilters);
  const shown = KEYS.filter((key) => useful(options[key], filters[key]));
  const on = activeKeys(filters);
  const count = on.length + (showDiscarded ? 1 : 0);

  useEffect(() => {
    if (!open) return;
    const down = (event: MouseEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", down);
      document.removeEventListener("keydown", key);
    };
  }, [open]);

  if (shown.length === 0 && !hasDiscarded && on.length === 0) return null;
  return (
    <div className="md-filters" ref={box} data-testid="media-filters">
      <button type="button" className={`md-filters__btn${count > 0 ? " md-filters__btn--on" : ""}`} aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen((value) => !value)} data-testid="media-filters-open">
        <MIcon name="filter" size={14} />
        Filtros
        {count > 0 && <span className="md-filters__badge">{count}</span>}
      </button>
      {open && (
        <>
          <button type="button" className="md-filters__scrim" aria-label="Fechar filtros" onClick={() => setOpen(false)} />
          <div className="md-filters__panel" role="dialog" aria-label="Filtros" data-testid="media-filter-sheet">
            {shown.map((key) => (
              <ChipGroup key={key} label={LABELS[key]} options={options[key]} value={filters[key]} onChange={(value) => set(key, value)} testId={`media-filter-${key}`} />
            ))}
            {hasDiscarded && <Switch checked={showDiscarded} onChange={onShowDiscarded} />}
            <div className="md-filters__actions">
              <button
                type="button"
                className="ui-button ui-button--secondary"
                onClick={() => {
                  onChange({ ...NO_FILTERS, q: filters.q });
                  onShowDiscarded(false);
                }}
                disabled={count === 0}
              >
                Limpar
              </button>
              <button type="button" className="ui-button" onClick={() => setOpen(false)}>
                Pronto
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/** As etiquetas removíveis dos filtros ligados, numa linha só (some quando não há nenhum). */
export function ActiveFilters({ filters, onChange, options }: { filters: MediaFilters; onChange: (filters: MediaFilters) => void; options: FilterOptions }) {
  const on = activeKeys(filters);
  if (on.length === 0) return null;
  const labelOf = (key: Key) => options[key].find((option) => option.value === filters[key])?.label ?? filters[key];
  return (
    <div className="md-active" data-testid="media-active-filters">
      {on.map((key) => (
        <button key={key} type="button" className="md-active__chip" onClick={() => onChange({ ...filters, [key]: "todos" } as MediaFilters)} aria-label={`Tirar o filtro ${LABELS[key]}: ${labelOf(key)}`}>
          {LABELS[key]}: {labelOf(key)}
          <MIcon name="close" size={11} />
        </button>
      ))}
      <button type="button" className="fy-link" onClick={() => onChange({ ...NO_FILTERS, q: filters.q })}>
        Limpar
      </button>
    </div>
  );
}
