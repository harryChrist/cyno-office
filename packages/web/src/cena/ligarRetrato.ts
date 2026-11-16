// Liga as lojas do Cyno ao motor de cena: quando o estado muda, monta UM retrato novo (com atraso, juntando
// rajadas) e só o publica se ele for diferente do último. Sem React, para ser testável com fontes falsas.
import type { OfficeSnapshot } from "@cyno/cena";
import { memoriaDeJson, memoriaParaJson, montarRetrato, type EntradaDoRetrato, type MemoriaDaCena } from "@cyno/shared/cena";

/** Espera entre a última mudança e a montagem do retrato (rajadas de `agent:log` viram uma montagem só). */
export const ATRASO_DO_RETRATO_MS = 150;

/** O que o adaptador lê do Cyno, sem relógio nem identidade do workspace. */
export type LeituraDoCyno = Omit<EntradaDoRetrato, "agora" | "workspaceId" | "workspaceName">;

/** De onde vem o estado: `ler` devolve null enquanto o escritório não carregou; `assinar` avisa quando algo relevante muda. */
export interface FontesDoRetrato {
  ler(): LeituraDoCyno | null;
  assinar(avisar: () => void): () => void;
}

export interface DestinoDoRetrato {
  publicar(retrato: OfficeSnapshot): void;
}

export interface Armazenamento {
  ler(chave: string): string | null;
  gravar(chave: string, valor: string): void;
}

export interface OpcoesDaLigacao {
  workspaceId: string;
  workspaceName: string;
  fontes: FontesDoRetrato;
  destino: DestinoDoRetrato;
  agora?: () => number;
  atrasoMs?: number;
  /** Guarda a memória (ordem de chegada) entre recargas; padrão: `localStorage`, com tolerância a falha. */
  armazenamento?: Armazenamento;
  /** Verdadeiro enquanto o "Rever o dia" toca: o retrato ao vivo não é montado nem publicado. */
  pausado?: () => boolean;
  /** Chamado a cada retrato publicado (testes e depuração). */
  aoPublicar?: (retrato: OfficeSnapshot) => void;
}

/** Assinatura de um retrato para saber se mudou: tudo menos o número e o relógio, que sempre andam. */
export function assinaturaDoRetrato(retrato: OfficeSnapshot): string {
  return JSON.stringify({ rooms: retrato.rooms, agents: retrato.agents, accounts: retrato.accounts, meta: retrato.meta });
}

export const armazenamentoDoNavegador: Armazenamento = {
  ler(chave) {
    try {
      return localStorage.getItem(chave);
    } catch {
      return null;
    }
  },
  gravar(chave, valor) {
    try {
      localStorage.setItem(chave, valor);
    } catch {
      // Sem armazenamento (janela privada, cota): a ordem de chegada recomeça na próxima carga.
    }
  },
};

export const chaveDaMemoria = (workspaceId: string): string => `cyno.cena.memoria.${workspaceId}`;

export interface LigacaoDoRetrato {
  /** Monta e publica já (ignora o atraso), se o escritório já carregou e algo mudou. */
  agora(): void;
  desligar(): void;
}

export function ligarRetrato(opcoes: OpcoesDaLigacao): LigacaoDoRetrato {
  const relogio = opcoes.agora ?? Date.now;
  const atraso = opcoes.atrasoMs ?? ATRASO_DO_RETRATO_MS;
  const armazem = opcoes.armazenamento ?? armazenamentoDoNavegador;
  const chave = chaveDaMemoria(opcoes.workspaceId);
  let memoria: MemoriaDaCena = memoriaDeJson(armazem.ler(chave), relogio());
  let ultimaAssinatura: string | null = null;
  let guardado = memoriaParaJson(memoria);
  let temporizador: ReturnType<typeof setTimeout> | null = null;
  let ativa = true;
  let jaPublicou = false;

  const montar = (): void => {
    temporizador = null;
    if (!ativa || opcoes.pausado?.()) return;
    const leitura = opcoes.fontes.ler();
    if (!leitura) return;
    const { snapshot, memoria: proxima } = montarRetrato({ ...leitura, workspaceId: opcoes.workspaceId, workspaceName: opcoes.workspaceName, agora: relogio() }, memoria);
    memoria = proxima;
    const json = memoriaParaJson(memoria);
    if (json !== guardado) {
      guardado = json;
      armazem.gravar(chave, json);
    }
    const assinatura = assinaturaDoRetrato(snapshot);
    if (assinatura === ultimaAssinatura) return;
    ultimaAssinatura = assinatura;
    jaPublicou = true;
    opcoes.destino.publicar(snapshot);
    opcoes.aoPublicar?.(snapshot);
  };

  const agendar = (): void => {
    if (!ativa || temporizador !== null) return;
    // O primeiro retrato não espera: a cena nasce com o escritório inteiro.
    temporizador = setTimeout(montar, jaPublicou ? atraso : 0);
  };

  const desassinar = opcoes.fontes.assinar(agendar);
  agendar();

  return {
    agora() {
      if (temporizador !== null) clearTimeout(temporizador);
      montar();
    },
    desligar() {
      ativa = false;
      if (temporizador !== null) clearTimeout(temporizador);
      temporizador = null;
      desassinar();
    },
  };
}
