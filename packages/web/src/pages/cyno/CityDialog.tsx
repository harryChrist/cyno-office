import { useEffect, useRef } from "react";
import { CidadeFaixa } from "../../cena/cidade/CidadeFaixa";

/**
 * A cidade dos workspaces como painel que se abre sob demanda (botão "Cidade" no cabeçalho do chat), em vez de ocupar
 * o topo da página o tempo todo. Fecha com Escape, no botão Fechar ou clicando no fundo escurecido.
 */
export function CityDialog({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDivElement>(null);

  useEffect(() => {
    dialog.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="cyno-city__veil" onMouseDown={(event) => event.target === event.currentTarget && onClose()} data-testid="cyno-city-veil">
      <div ref={dialog} className="cyno-city__dialog" role="dialog" aria-modal="true" aria-label="Cidade" tabIndex={-1} data-testid="cyno-city-dialog">
        <div className="cyno-city__bar">
          <span>Cidade</span>
          <button type="button" className="ui-button ui-button--ghost" onClick={onClose} data-testid="cyno-city-close">
            Fechar
          </button>
        </div>
        <CidadeFaixa sempreAberta />
      </div>
    </div>
  );
}
