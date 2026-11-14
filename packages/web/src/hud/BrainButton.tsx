import { useNavStore } from "../store/navStore";
import { openBrain } from "../store/navTargets";
import { PageIcon } from "./pageIcons";

/**
 * Botão do Cérebro na barra, à esquerda da lista de agentes (as notas que eles leem e escrevem).
 * Já no Cérebro, o mesmo botão volta ao escritório.
 */
export function BrainButton() {
  const open = useNavStore((state) => state.page === "biblioteca" && state.sub.startsWith("cerebro"));
  const go = useNavStore((state) => state.go);
  return (
    <button
      type="button"
      className="topbar__icon-button topbar__brain-button"
      aria-label="Cérebro"
      title={open ? "Fechar o Cérebro" : "Cérebro: as notas dos agentes"}
      aria-pressed={open}
      onClick={() => (open ? go("office") : openBrain())}
      data-testid="nav-cerebro"
    >
      <PageIcon name="brain" />
    </button>
  );
}
