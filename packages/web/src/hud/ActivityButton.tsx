import { useNavStore } from "../store/navStore";
import { openActivity } from "../store/navTargets";

/**
 * Botão da barra (ao lado da engrenagem): abre a Atividade (o que foi feito no escritório e os
 * eventos do servidor). Já nela, o mesmo botão volta ao escritório.
 */
export function ActivityButton() {
  const open = useNavStore((state) => state.page === "gestao" && state.sub === "atividade");
  const go = useNavStore((state) => state.go);
  return (
    <button
      type="button"
      className="topbar__icon-button"
      aria-label="Atividade"
      title={open ? "Fechar a atividade" : "Atividade"}
      aria-pressed={open}
      onClick={() => (open ? go("office") : openActivity())}
      data-testid="activity-button"
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
      </svg>
    </button>
  );
}
