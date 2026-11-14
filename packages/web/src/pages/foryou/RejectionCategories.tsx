import { REJECTION_CATEGORIES, REJECTION_CATEGORY_LABELS, type RejectionCategory } from "@cyno/shared";

type Props = {
  value: RejectionCategory | null;
  onChange: (next: RejectionCategory | null) => void;
  disabled?: boolean;
};

/**
 * Escolha rápida do motivo da recusa (texto, tom, fato errado, formato, fora do pedido, outro). Opcional: clicar de novo
 * tira a escolha, e dá para recusar sem escolher nada. A Gestão agrupa as recusas por esta categoria.
 */
export function RejectionCategories({ value, onChange, disabled }: Props) {
  return (
    <div className="fy-cats" role="group" aria-label="Categoria da recusa (opcional)" data-testid="reject-categories">
      {REJECTION_CATEGORIES.map((category) => (
        <button
          key={category}
          type="button"
          className={`fy-cat${value === category ? " is-on" : ""}`}
          aria-pressed={value === category}
          disabled={disabled}
          onClick={() => onChange(value === category ? null : category)}
          data-testid={`reject-category-${category}`}
        >
          {REJECTION_CATEGORY_LABELS[category]}
        </button>
      ))}
    </div>
  );
}
