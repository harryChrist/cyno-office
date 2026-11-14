// Liga o motor de cena (@cyno/cena) a um <canvas>: cria o mundo, alimenta com um OfficeStore e devolve a
// função que desfaz tudo. Sem React, para ser testável com peças falsas.
import { createWorld, OfficeStore, type ExtrasApi, type WorldApi, type WorldProbe } from "@cyno/cena";
import { ligarBichos } from "./bichos/ligar";
import { CenaStore } from "./cenaStore";
import type { MundoInterativo } from "./ligarInterface";
import { fontesDoCyno } from "./fontesDoCyno";
import { ligarRetrato, type LigacaoDoRetrato } from "./ligarRetrato";

/** O que a ligação usa do mundo e da loja (o mínimo; permite trocar por falsos nos testes). */
export type MundoLike = Pick<WorldApi, "destroy" | "setSuspended"> & Partial<MundoInterativo> & { probe?: () => WorldProbe; extras?: ExtrasApi };
export interface LojaLike {
  connect(): void;
  disconnect(): void;
}

export interface DepsCena {
  criarLoja(search: string): LojaLike;
  criarMundo(canvas: HTMLCanvasElement, loja: LojaLike): MundoLike;
}

/** Loja de demonstração do Habblaud: o simulador (`mock`) produz as sessões, sem rede nem servidor. */
export const depsReais: DepsCena = {
  criarLoja: (search) => new OfficeStore({ mock: true, search }),
  criarMundo: (canvas, loja) => createWorld(canvas, loja as OfficeStore),
};

/** Dados reais (padrão): a loja do Cyno, sem rede, que recebe os retratos do adaptador. */
export const depsDoCyno: DepsCena = {
  criarLoja: () => new CenaStore(),
  criarMundo: (canvas, loja) => createWorld(canvas, loja as CenaStore),
};

/** Quem alimenta a loja depois de criada (devolve a função que desliga a alimentação). */
export type LigarLoja = (loja: LojaLike) => () => void;

/** O que alimenta a cena real: as lojas do Cyno do workspace aberto, pelo adaptador. */
export function alimentarComOCyno(workspaceId: string, workspaceName: string, replay?: { pausado: () => boolean; aoLigar: (loja: CenaStore, ligacao: LigacaoDoRetrato) => void }): LigarLoja {
  return (loja) => {
    const ligacao = ligarRetrato({ workspaceId, workspaceName, fontes: fontesDoCyno(workspaceId), destino: loja as CenaStore, ...(replay ? { pausado: replay.pausado } : {}) });
    replay?.aoLigar(loja as CenaStore, ligacao);
    return () => ligacao.desligar();
  };
}

export interface CenaMontada {
  mundo: MundoLike;
  /** A interface suspende (outra página aberta) ou libera a cena; a aba escondida continua suspendendo por conta própria. */
  suspender(valor: boolean): void;
  /** Para a loja, o laço de desenho e os ouvintes (janela, documento, canvas). Pode ser chamada mais de uma vez. */
  desmontar(): void;
}

/**
 * Monta a cena no canvas. `search` são os parâmetros do simulador (`?sessions=6&seed=7&speed=2`).
 * A cena para de desenhar com a aba escondida e retoma ao voltar (o motor avança a simulação perdida).
 */
export function montarCena(canvas: HTMLCanvasElement, search: string, deps: DepsCena = depsReais, ligar?: LigarLoja, opcoes: { bichos?: string } = {}): CenaMontada {
  const loja = deps.criarLoja(search);
  const mundo = deps.criarMundo(canvas, loja);
  loja.connect();
  const desligarAlimentacao = ligar?.(loja);
  // Os bichos do escritório (gato, cachorro e calopsita): só enfeite, por cima da cena; a semente é o workspace.
  const bichos = opcoes.bichos !== undefined && mundo.probe && mundo.extras ? ligarBichos({ probe: mundo.probe, extras: mundo.extras }, { semente: opcoes.bichos }) : null;

  // Quem manda é a interface (`suspender`) E a aba: voltar para a aba não religa uma cena que a interface suspendeu.
  let suspensaPelaInterface = false;
  const aplicarSuspensao = () => mundo.setSuspended?.(document.hidden || suspensaPelaInterface);
  const aoMudarVisibilidade = () => aplicarSuspensao();
  document.addEventListener("visibilitychange", aoMudarVisibilidade);
  if (document.hidden) mundo.setSuspended?.(true);

  // Só no dev: os bichos ficam à mão para os testes de tela.
  if (import.meta.env.DEV && bichos && typeof window !== "undefined") (window as unknown as { __bichos?: unknown }).__bichos = bichos;

  let ativa = true;
  return {
    mundo,
    suspender(valor) {
      if (!ativa) return;
      suspensaPelaInterface = valor;
      aplicarSuspensao();
    },
    desmontar() {
      if (!ativa) return;
      ativa = false;
      document.removeEventListener("visibilitychange", aoMudarVisibilidade);
      bichos?.desligar();
      if (import.meta.env.DEV && bichos && typeof window !== "undefined") delete (window as unknown as { __bichos?: unknown }).__bichos;
      desligarAlimentacao?.();
      mundo.destroy();
      loja.disconnect();
    },
  };
}
