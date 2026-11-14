import { useRef, useState } from "react";
import { ConnectorStrip } from "../connectors/ConnectorStrip";
import { useNavStore } from "../store/navStore";
import { useOfficeStore } from "../store/officeStore";
import { useViewStore } from "../store/viewStore";
import { BotaoTelaCheia } from "../ui/BotaoTelaCheia";
import { CreateRoomDialog } from "../ui/CreateDialogs";
import { useTelaCheia } from "../ui/useTelaCheia";
import { mundoAtual } from "./mundoAtual";
import { abrir as abrirReplay } from "./replay/replayStore";

/**
 * Controles do Escritório na cena nova (canto de baixo, à direita): os conectores do workspace, zoom (−, +,
 * enquadrar tudo, tela cheia), "Navegador" e "+ Quarto". O zoom é do motor
 * (níveis nítidos, sem rótulo). O minimapa não vem: o prédio cabe na visão geral.
 */
export function CenaControles() {
  const pronto = useOfficeStore((state) => state.office !== null);
  const go = useNavStore((state) => state.go);
  const [criando, setCriando] = useState(false);
  // Tela cheia do mapa: o menu lateral e o painel somem (classe na raiz); a caixa de pedir ao Maestro e estes controles ficam.
  const botaoCheia = useRef<HTMLButtonElement>(null);
  const cheia = useTelaCheia({ classeNaRaiz: "is-mapa-cheio", focoAoSair: () => botaoCheia.current });

  const visaoGeral = () => {
    // A câmera volta ao prédio inteiro; o foco do Cyno acompanha para o botão da barra não ficar desatualizado.
    useViewStore.getState().setFocus({ kind: "map" });
    mundoAtual()?.overview?.();
  };

  return (
    <section className="office-controls" aria-label="Controles do escritório" data-testid="office-controls">
      {pronto && <ConnectorStrip />}
      <div className="hud__zoom" role="group" aria-label="Zoom" title="Zoom: roda do mouse, pinça ou as teclas + e −; 0 enquadra tudo">
        <button type="button" onClick={() => mundoAtual()?.zoomBy?.(0.5)} disabled={!pronto} aria-label="Diminuir zoom" data-testid="cena-zoom-out">
          −
        </button>
        <button type="button" onClick={visaoGeral} disabled={!pronto} aria-label="Enquadrar tudo" title="Enquadrar tudo" data-testid="nav-map">
          ⤢
        </button>
        <BotaoTelaCheia ref={botaoCheia} ativa={cheia.ativa} onClick={() => void cheia.alternar()} disabled={!pronto} testId="office-tela-cheia" />
        <button type="button" onClick={() => mundoAtual()?.zoomBy?.(2)} disabled={!pronto} aria-label="Aumentar zoom" data-testid="cena-zoom-in">
          +
        </button>
      </div>
      {pronto && (
        <div className="office-controls__row">
          <button type="button" className="ui-button ui-button--secondary ui-button--small office-controls__button" onClick={() => go("navegador")} title="Navegador dos agentes" data-testid="office-browser">
            Navegador
          </button>
          <button type="button" className="ui-button ui-button--small office-controls__button" onClick={() => setCriando(true)} data-testid="add-room">
            + Sala
          </button>
          <button type="button" className="ui-button ui-button--secondary ui-button--small office-controls__button" onClick={() => void abrirReplay()} title="Rever como foi o dia do escritório" data-testid="replay-open">
            Rever o dia
          </button>
        </div>
      )}
      {criando && <CreateRoomDialog onClose={() => setCriando(false)} />}
    </section>
  );
}
