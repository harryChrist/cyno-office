// O canvas da cidade (motor do Habblaud, `@cyno/cena/cidade`): montado só quando a faixa está aberta, carregado sob
// demanda (`React.lazy` na faixa). Recebe os prédios já montados e só desenha: zoom, arrasto, clique e destaque.
import { criarVista, type PracaDados, type Vista, type WorldBuildingPublic } from "@cyno/cena/cidade";
import { useEffect, useRef, type Ref } from "react";
import type { ClicouNaCidade } from "@cyno/cena/cidade";
import { BotaoTelaCheia } from "../../ui/BotaoTelaCheia";
import { aindaReenquadrando, guardarEnquadre, JANELA_DE_REENQUADRE_MS, restaurarEnquadre, type Enquadre } from "./enquadre";

type Janela = { __cidade?: Vista };

export interface CidadeCanvasProps {
  predios: readonly WorldBuildingPublic[];
  praca: PracaDados;
  /** Id do prédio do workspace aberto (ganha o destaque). */
  atual: string | null;
  /** Para o laço de desenho (faixa fechada, aba escondida). */
  suspensa: boolean;
  aoClicar: (clique: ClicouNaCidade) => void;
  /** Muda quando a meta bate: dispara os fogos. */
  fogos?: number;
  /** Em tela cheia a cidade ocupa a janela: reenquadra para o espaço novo e, ao sair, volta ao enquadramento de antes. */
  telaCheia?: boolean;
  aoAlternarTelaCheia?: () => void;
  /** O botão de tela cheia (o foco volta a ele ao sair). */
  botaoTelaCheiaRef?: Ref<HTMLButtonElement>;
}

export default function CidadeCanvas({ predios, praca, atual, suspensa, aoClicar, fogos = 0, telaCheia = false, aoAlternarTelaCheia, botaoTelaCheiaRef }: CidadeCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const vistaRef = useRef<Vista | null>(null);
  const aoClicarRef = useRef(aoClicar);
  useEffect(() => {
    aoClicarRef.current = aoClicar;
  });
  const ultimosFogos = useRef(fogos);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const vista = criarVista({ canvas, aoClicar: (clique) => aoClicarRef.current(clique) });
    vistaRef.current = vista;
    if (import.meta.env.DEV) (window as unknown as Janela).__cidade = vista;
    return () => {
      if (import.meta.env.DEV) delete (window as unknown as Janela).__cidade;
      vistaRef.current = null;
      vista.destruir();
    };
  }, []);

  useEffect(() => {
    vistaRef.current?.aplicar(predios, praca);
  }, [predios, praca]);

  useEffect(() => {
    vistaRef.current?.destacar(atual);
  }, [atual]);

  useEffect(() => {
    vistaRef.current?.suspender(suspensa);
  }, [suspensa]);

  // Tela cheia: guarda o enquadramento, reenquadra para o espaço novo (a troca de tamanho do navegador leva alguns
  // quadros, então reenquadra a cada resize na janela curta) e, ao sair, devolve o de antes.
  const antesTelaCheia = useRef(telaCheia);
  const enquadreGuardado = useRef<Enquadre | null>(null);
  useEffect(() => {
    const vista = vistaRef.current;
    if (!vista || antesTelaCheia.current === telaCheia) return;
    antesTelaCheia.current = telaCheia;
    const inicio = performance.now();
    if (telaCheia) enquadreGuardado.current = guardarEnquadre(vista.camera);
    const aplicar = (forcar = false) => {
      if (!forcar && !aindaReenquadrando(inicio, performance.now())) return;
      if (telaCheia) vista.enquadrar(false);
      else if (enquadreGuardado.current) restaurarEnquadre(vista.camera, enquadreGuardado.current);
    };
    const aoMudar = () => aplicar();
    aplicar(true);
    window.addEventListener("resize", aoMudar);
    document.addEventListener("fullscreenchange", aoMudar);
    const timers = [250, JANELA_DE_REENQUADRE_MS].map((ms) => window.setTimeout(() => aplicar(true), ms));
    return () => {
      window.removeEventListener("resize", aoMudar);
      document.removeEventListener("fullscreenchange", aoMudar);
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }, [telaCheia]);

  useEffect(() => {
    if (fogos !== ultimosFogos.current) {
      ultimosFogos.current = fogos;
      vistaRef.current?.festejar();
    }
  }, [fogos]);

  return (
    <div className="cidade__tela">
      <canvas ref={canvasRef} className="cidade__canvas" data-testid="cidade-canvas" aria-label="Mapa da cidade dos workspaces: um prédio por workspace" role="img" />
      <div className="cidade__zoom" role="group" aria-label="Zoom da cidade">
        <button type="button" className="cidade__botao" onClick={() => vistaRef.current?.zoomPor(1.4)} aria-label="Aproximar" title="Aproximar">
          +
        </button>
        <button type="button" className="cidade__botao" onClick={() => vistaRef.current?.zoomPor(1 / 1.4)} aria-label="Afastar" title="Afastar">
          −
        </button>
        <button type="button" className="cidade__botao" onClick={() => vistaRef.current?.enquadrar(true)} aria-label="Enquadrar a cidade" title="Enquadrar a cidade" data-testid="cidade-enquadrar">
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
            <circle cx="8" cy="8" r="3" />
            <path d="M8 1v3M8 12v3M1 8h3M12 8h3" />
          </svg>
        </button>
        {aoAlternarTelaCheia && <BotaoTelaCheia ref={botaoTelaCheiaRef} ativa={telaCheia} onClick={aoAlternarTelaCheia} className="cidade__botao" testId="cidade-tela-cheia" />}
      </div>
    </div>
  );
}
