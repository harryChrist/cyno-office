import { useEffect, useRef } from "react";
import "./cena.css";
import { parametrosDemo } from "./chave";
import { SoundBoard, type WorldApi } from "@cyno/cena";
import type { CenaStore } from "./cenaStore";
import type { LigacaoDoRetrato } from "./ligarRetrato";
import { aoSuspenderCena, registrarCena, useReplayStore } from "./replay/replayStore";
import { ligarAoVivo, servidorTemCenaAoVivo, urlDaCenaAoVivo, type LigacaoAoVivo, type SocketLike } from "./ligarAoVivo";
import { ligarInterface } from "./ligarInterface";
import { ligarSom } from "./ligarSom";
import { definirMundoAtual } from "./mundoAtual";
import { alimentarComOCyno, depsDoCyno, montarCena, type CenaMontada } from "./montarCena";

type Janela = { __cena?: unknown; __cenaAoVivo?: unknown };

function expor(cena: CenaMontada): () => void {
  // Só no dev: o mundo (com a API de depuração do motor) fica à mão para os testes de tela.
  if (!import.meta.env.DEV) return () => undefined;
  (window as unknown as Janela).__cena = cena.mundo;
  return () => delete (window as unknown as Janela).__cena;
}

/**
 * A cena do escritório (motor do Habblaud, pacote @cyno/cena) em tela cheia, alimentada pelo simulador de
 * demonstração: dados de mentira, sem servidor. Câmera (arrasto, roda, pinça), redimensionamento e DPR ficam
 * por conta do motor; aqui só se monta e se limpa (laço de animação, ouvintes e simulador) ao desmontar.
 * Carregado sob demanda (`React.lazy` no App): quem não usa a cena não baixa o motor.
 */
export function CenaCanvas({ search }: { search: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const cena = montarCena(canvas, parametrosDemo(search));
    const limpar = expor(cena);
    return () => {
      limpar();
      cena.desmontar();
    };
  }, [search]);

  return (
    <div className="cena-demo" data-testid="cena-demo">
      <canvas ref={canvasRef} className="cena-demo__canvas" data-testid="cena-canvas" />
      <div className="cena-demo__aviso" role="note">
        Cena de demonstração: dados de mentira
        <a href={window.location.pathname + window.location.hash}>Voltar ao escritório</a>
      </div>
    </div>
  );
}

/**
 * O escritório de verdade na cena nova (padrão): o workspace aberto, com as salas, os agentes e o que cada um
 * faz, vindos das lojas do Cyno pelo adaptador. Monta uma vez por workspace (`key` no chamador): trocar de
 * workspace recria a cena, sem animar a troca de prédio. Com `suspensa` (outra página aberta) o laço para.
 * Cliques, seleção, foco e a área livre da câmera ficam ligados à interface do Cyno (`ligarInterface`).
 */
export function CenaDoEscritorio({ workspaceId, workspaceName, suspensa }: { workspaceId: string; workspaceName: string; suspensa: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cenaRef = useRef<CenaMontada | null>(null);
  const aoVivoRef = useRef<LigacaoAoVivo | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // O "Rever o dia": enquanto toca, o retrato ao vivo fica pausado e a loja recebe os quadros gravados.
    let pausado = false;
    let ligacaoViva: { loja: CenaStore; ligacao: LigacaoDoRetrato } | null = null;
    const cena = montarCena(
      canvas,
      "",
      depsDoCyno,
      alimentarComOCyno(workspaceId, workspaceName, { pausado: () => pausado, aoLigar: (loja, ligacao) => (ligacaoViva = { loja, ligacao }) }),
      { bichos: workspaceId },
    );
    registrarCena({
      workspaceId,
      workspaceName,
      mundo: cena.mundo as Pick<WorldApi, "setPlayback">,
      publicar: (retrato) => ligacaoViva?.loja.publicar(retrato),
      voltarAoVivo: () => ligacaoViva?.loja.stopReplay(),
      pausarVivo: (valor) => {
        pausado = valor;
        if (!valor) ligacaoViva?.ligacao.agora();
      },
    });
    cenaRef.current = cena;
    const limpar = expor(cena);
    definirMundoAtual(cena.mundo);
    const desligarInterface = ligarInterface(cena.mundo);
    const desligarSom = ligarSom(cena.mundo, new SoundBoard());
    // A cena ao vivo: o servidor simula e esta tela só desenha (se o servidor tem a chave ligada; senão, tudo como antes).
    const aoVivo = ligarAoVivo({
      workspaceId,
      mundo: () => {
        const sonda = cena.mundo.probe?.();
        return sonda ? { sim: sonda.sim, replay: sonda.playback } : null;
      },
      disponivel: servidorTemCenaAoVivo,
      criarSocket: (url) => new WebSocket(url) as unknown as SocketLike,
      url: urlDaCenaAoVivo,
    });
    aoVivoRef.current = aoVivo;
    aoVivo.definirAbaVisivel(!document.hidden);
    const aoMudarAba = () => aoVivo.definirAbaVisivel(!document.hidden);
    document.addEventListener("visibilitychange", aoMudarAba);
    const desassinarReplay = useReplayStore.subscribe((estado) => aoVivo.definirReplay(estado.situacao !== "fechado"));
    aoVivo.definirReplay(useReplayStore.getState().situacao !== "fechado");
    if (import.meta.env.DEV) (window as unknown as Janela).__cenaAoVivo = aoVivo;
    return () => {
      desassinarReplay();
      document.removeEventListener("visibilitychange", aoMudarAba);
      aoVivo.desligar();
      aoVivoRef.current = null;
      if (import.meta.env.DEV) delete (window as unknown as Janela).__cenaAoVivo;
      registrarCena(null);
      desligarSom();
      desligarInterface();
      definirMundoAtual(null);
      limpar();
      cenaRef.current = null;
      cena.desmontar();
    };
  }, [workspaceId, workspaceName]);

  // Declarado depois do efeito que monta: roda também na montagem (e a cena nova já nasce suspensa se for o caso).
  useEffect(() => {
    cenaRef.current?.suspender(suspensa);
    aoVivoRef.current?.definirEscritorioVisivel(!suspensa);
    aoSuspenderCena(suspensa);
  }, [suspensa, workspaceId, workspaceName]);

  return (
    <div className="office-canvas cena-escritorio" data-testid="cena-escritorio" data-workspace={workspaceId}>
      <canvas ref={canvasRef} className="cena-escritorio__canvas" data-testid="cena-canvas" />
    </div>
  );
}
