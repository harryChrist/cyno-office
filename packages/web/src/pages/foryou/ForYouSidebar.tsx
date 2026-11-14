import type { ForYouItem } from "@cyno/shared";
import { MOD_KEY } from "./ForYouCard";
import { STATUS_VIEW_LABELS, STATUS_VIEWS, statusCounts, typeOptions, typeStyle, type StatusView, type TypeFilter, type TypeList } from "./forYouView";
import { Icon } from "./icons";

type ForYouSidebarProps = {
  items: readonly ForYouItem[];
  types: TypeList;
  status: StatusView;
  type: TypeFilter;
  onStatus: (status: StatusView) => void;
  onType: (type: TypeFilter) => void;
  /** Abre a janela "Tipos" (editar, juntar, excluir). */
  onManageTypes: () => void;
};

/**
 * Trilho da esquerda: números (Pendentes, Decididos, Cancelados; cada um troca a situação), filtro
 * por tipo com contagem (e o botão dos tipos) e os atalhos no rodapé. No celular vira uma faixa no topo.
 */
export function ForYouSidebar({ items, types, status, type, onStatus, onType, onManageTypes }: ForYouSidebarProps) {
  const counts = statusCounts(items);
  const options = typeOptions(items, status, type, types);
  return (
    <aside className="fy-side" aria-label="Resumo e filtros">
      <div className="fy-stats" role="group" aria-label="Situação" data-testid="foryou-pending-summary">
        {STATUS_VIEWS.map((value) => (
          <button key={value} type="button" className={`fy-stat fy-stat--${value}`} aria-pressed={status === value} onClick={() => onStatus(value)} data-testid={`foryou-filter-${value}`}>
            <span className="fy-stat__n">{value === "todos" ? items.length : counts[value]}</span>
            <span className="fy-stat__label">{STATUS_VIEW_LABELS[value]}</span>
          </button>
        ))}
      </div>
      <p className="fy-side__lead">{counts.pendente === 0 ? "Nada esperando você." : counts.pendente === 1 ? "1 item esperando você." : `${counts.pendente} itens esperando você.`}</p>

      <div className="fy-types-box">
        <div className="fy-types-head">
          <p className="fy-side__title" id="fy-types-title">
            Por tipo
          </p>
          <button type="button" className="fy-icon-btn" onClick={onManageTypes} aria-label="Tipos de aprovação" title="Tipos de aprovação" data-testid="foryou-manage-types">
            <Icon name="gear" size={15} />
          </button>
        </div>
        <div className="fy-types" role="group" aria-labelledby="fy-types-title">
          {options.map((option) => (
            <button
              key={option.type}
              type="button"
              style={option.display ? typeStyle(option.display) : undefined}
              aria-pressed={type === option.type}
              onClick={() => onType(option.type)}
              data-testid={`foryou-type-${option.type}`}
            >
              <Icon name={option.display?.icon ?? "todos"} />
              <span>{option.label}</span>
              <span className={`fy-types__n${option.count > 0 ? " fy-types__n--some" : ""}`}>{option.count}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="fy-shortcuts" aria-label="Atalhos de teclado">
        <p>
          <kbd>{MOD_KEY}</kbd>+<kbd>Enter</kbd> aprova ou responde o item aberto
        </p>
        <p>
          <kbd>J</kbd> / <kbd>K</kbd> próximo / anterior na lista
        </p>
        <p>
          <kbd>Enter</kbd> abre o item da lista
        </p>
        <p>
          <kbd>Esc</kbd> sai do campo de texto
        </p>
      </div>
    </aside>
  );
}
