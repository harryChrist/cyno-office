// A cena ao vivo na tela: o servidor simula o Escritório e esta ligação só entrega o que ele manda ao `Sim` do motor
// (modo remoto, patch 14). Conecta em `/ws/scene?workspace=<id>` só enquanto o Escritório está visível; sem a chave no
// servidor, com erro ou com queda, a cena segue como sempre foi (simulação local). Sem React nem relógio global: testável.
import { parseSceneMessage, SCENE_LIVE_PATH, WS_WORKSPACE_PARAM, type SceneDelta, type SceneFull } from "@cyno/shared";

/** Quanto tempo a cena fica parada tentando reconectar antes de voltar para a simulação local. */
export const TEMPO_PARADA_MS = 10_000;
/** Espera entre tentativas: cresce de 0,5 s e nunca passa de 15 s. */
export const ESPERA_INICIAL_MS = 500;
export const ESPERA_MAXIMA_MS = 15_000;
/** De quanto em quanto tempo confere se o mundo foi recriado (o replay recria a simulação). */
export const CONFERENCIA_MS = 500;

/** Espera antes da tentativa número `tentativa` (0 = a primeira depois da queda). */
export function esperaDeReconexao(tentativa: number): number {
  return Math.min(ESPERA_MAXIMA_MS, ESPERA_INICIAL_MS * 2 ** Math.max(0, tentativa));
}

/** O que a ligação usa do `Sim` (o do motor). */
export interface SimRemoto {
  readonly remote: { readonly on: boolean };
  applyRemoteFull(full: SceneFull, now: number): void;
  applyRemoteDelta(delta: SceneDelta, now: number): void;
  freezeRemote(frozen: boolean): void;
  stopRemote(now: number): void;
}

/** O mundo de agora: o `Sim` atual (muda quando o replay recria a simulação) e se o replay está ligado. */
export interface MundoAoVivo {
  (): { sim: SimRemoto; replay: boolean } | null;
}

export interface SocketLike {
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  close(): void;
}

export type EstadoAoVivo = "desligada" | "conectando" | "remoto" | "reconectando" | "local";

export interface OpcoesAoVivo {
  workspaceId: string;
  mundo: MundoAoVivo;
  /** O servidor tem a cena ao vivo ligada? (`/api/health`) */
  disponivel: () => Promise<boolean>;
  criarSocket: (url: string) => SocketLike;
  url: (workspaceId: string) => string;
  agora?: () => number;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (id: unknown) => void;
  aoMudar?: (estado: EstadoAoVivo) => void;
}

export interface LigacaoAoVivo {
  /** A página do Escritório está aberta (não só montada)? */
  definirEscritorioVisivel(valor: boolean): void;
  /** A aba do navegador está visível? */
  definirAbaVisivel(valor: boolean): void;
  /** O "Rever o dia" está aberto? A cena toca o dia gravado, em simulação local. */
  definirReplay(valor: boolean): void;
  estado(): EstadoAoVivo;
  desligar(): void;
}

export function ligarAoVivo(opcoes: OpcoesAoVivo): LigacaoAoVivo {
  const agora = opcoes.agora ?? Date.now;
  const marcar = opcoes.setTimeout ?? ((fn: () => void, ms: number) => globalThis.setTimeout(fn, ms));
  const limpar = opcoes.clearTimeout ?? ((id: unknown) => globalThis.clearTimeout(id as ReturnType<typeof setTimeout>));

  let escritorio = false;
  let aba = true;
  let replay = false;
  /** O mundo avisou (probe) que está tocando o replay. */
  let replayDoMundo = false;
  let ativa = true;
  let estado: EstadoAoVivo = "desligada";
  /** null = ainda não perguntou; false = servidor sem a chave (não tenta de novo nesta página). */
  let disponivel: boolean | null = null;
  let perguntando = false;
  let socket: SocketLike | null = null;
  let tentativa = 0;
  let reconectar: unknown = null;
  let desistir: unknown = null;
  let conferencia: unknown = null;
  /** O `Sim` que recebeu o último `scene:full` (o replay troca de `Sim`). */
  let simRemoto: SimRemoto | null = null;

  const quer = (): boolean => ativa && escritorio && aba && !replay && !replayDoMundo && disponivel !== false;
  const mudar = (novo: EstadoAoVivo): void => {
    if (novo === estado) return;
    estado = novo;
    opcoes.aoMudar?.(novo);
  };

  const fecharSocket = (): void => {
    const velho = socket;
    socket = null;
    if (!velho) return;
    velho.onopen = velho.onmessage = velho.onclose = velho.onerror = null;
    try {
      velho.close();
    } catch {
      // já fechado
    }
  };
  const cancelarEspera = (): void => {
    if (reconectar !== null) limpar(reconectar);
    reconectar = null;
  };
  const cancelarDesistencia = (): void => {
    if (desistir !== null) limpar(desistir);
    desistir = null;
  };

  /** Volta para a simulação local (quem estava no modo remoto devolve o mundo local, com carga inicial). */
  const voltarAoLocal = (): void => {
    cancelarDesistencia();
    const sim = simRemoto ?? opcoes.mundo()?.sim ?? null;
    simRemoto = null;
    if (sim?.remote.on) sim.stopRemote(agora());
  };

  const aoCair = (): void => {
    fecharSocket();
    if (!quer()) return;
    // a cena fica parada onde estava e tenta reconectar; passando de 10 s volta a rodar sozinha
    if (estado === "remoto") {
      simRemoto?.freezeRemote(true);
      tentativa = 0;
      mudar("reconectando");
      desistir = marcar(() => {
        desistir = null;
        if (estado !== "reconectando") return;
        voltarAoLocal();
        mudar("local");
      }, TEMPO_PARADA_MS);
    } else if (estado === "conectando") {
      mudar("local");
    }
    cancelarEspera();
    reconectar = marcar(() => {
      reconectar = null;
      conectar();
    }, esperaDeReconexao(tentativa++));
  };

  const aoMensagem = (dado: unknown): void => {
    if (typeof dado !== "string") return;
    const msg = parseSceneMessage(dado);
    if (!msg) return;
    const mundo = opcoes.mundo();
    if (!mundo || mundo.replay) return;
    if (msg.t === "scene:full") {
      mundo.sim.applyRemoteFull(msg, agora());
      simRemoto = mundo.sim;
      tentativa = 0;
      cancelarDesistencia();
      mundo.sim.freezeRemote(false);
      mudar("remoto");
    } else if (msg.t === "scene:delta" && simRemoto === mundo.sim && mundo.sim.remote.on) {
      mundo.sim.applyRemoteDelta(msg, agora());
    }
  };

  function conectar(): void {
    if (!quer() || socket) return;
    if (disponivel === null) {
      if (perguntando) return;
      perguntando = true;
      void opcoes
        .disponivel()
        .catch(() => false)
        .then((ok) => {
          perguntando = false;
          disponivel = ok;
          if (ok) conectar();
        });
      return;
    }
    if (estado === "desligada") mudar("conectando");
    const aberto = opcoes.criarSocket(opcoes.url(opcoes.workspaceId));
    socket = aberto;
    // mensagens podem chegar junto da resposta do upgrade: o ouvinte entra antes de qualquer espera
    aberto.onmessage = (ev) => {
      if (socket === aberto) aoMensagem(ev.data);
    };
    aberto.onclose = () => {
      if (socket === aberto) aoCair();
    };
    aberto.onerror = () => {
      if (socket === aberto) aoCair();
    };
  }

  /** Fecha de propósito (saiu do Escritório, aba escondida, replay): sem reconectar e sem mexer na cena. */
  const parar = (): void => {
    cancelarEspera();
    cancelarDesistencia();
    fecharSocket();
    if (estado === "reconectando" || estado === "conectando") {
      // fechou no meio de uma queda: não fica mais nada parado esperando
      if (estado === "reconectando") voltarAoLocal();
      mudar("local");
    }
  };

  const reavaliar = (): void => {
    if (!ativa) return;
    if (quer()) {
      if (!socket && reconectar === null) conectar();
    } else parar();
  };

  // o replay (e a troca de workspace) recria o `Sim`: o mundo novo é local; pede o estado de novo
  const conferir = (): void => {
    conferencia = marcar(conferir, CONFERENCIA_MS);
    if (!ativa) return;
    const mundo = opcoes.mundo();
    if (!mundo) return;
    if (mundo.replay !== replayDoMundo) {
      replayDoMundo = mundo.replay;
      if (replayDoMundo && simRemoto?.remote.on) voltarAoLocal();
      if (replayDoMundo && estado === "remoto") mudar("local");
      reavaliar();
      return;
    }
    if (socket && estado === "remoto" && simRemoto && simRemoto !== mundo.sim) {
      simRemoto = null;
      fecharSocket();
      mudar("conectando");
      conectar();
    }
  };
  conferencia = marcar(conferir, CONFERENCIA_MS);

  return {
    definirEscritorioVisivel(valor) {
      if (escritorio === valor) return;
      escritorio = valor;
      reavaliar();
    },
    definirAbaVisivel(valor) {
      if (aba === valor) return;
      aba = valor;
      reavaliar();
    },
    definirReplay(valor) {
      if (replay === valor) return;
      replay = valor;
      // ao entrar no replay, a cena sai do modo remoto (o replay recria o mundo, local); ao sair, o estado vem de novo
      if (valor && simRemoto?.remote.on) voltarAoLocal();
      simRemoto = valor ? null : simRemoto;
      if (valor && estado === "remoto") mudar("local");
      reavaliar();
    },
    estado: () => estado,
    desligar() {
      if (!ativa) return;
      cancelarEspera();
      cancelarDesistencia();
      if (conferencia !== null) limpar(conferencia);
      conferencia = null;
      fecharSocket();
      ativa = false;
      const sim = simRemoto;
      simRemoto = null;
      sim?.freezeRemote(false);
      mudar("desligada");
    },
  };
}

/** O endereço do WebSocket da cena ao vivo para este navegador. */
export function urlDaCenaAoVivo(workspaceId: string): string {
  const protocolo = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocolo}//${window.location.host}${SCENE_LIVE_PATH}?${WS_WORKSPACE_PARAM}=${encodeURIComponent(workspaceId)}`;
}

/** O servidor tem a cena ao vivo? Pelo `/api/health` (a rota do WebSocket responde 404 sem a chave, e isso apareceria como erro no console). */
export async function servidorTemCenaAoVivo(): Promise<boolean> {
  const res = await fetch("/api/health", { headers: { accept: "application/json" } });
  if (!res.ok) return false;
  const body = (await res.json()) as { sceneLive?: unknown };
  return body.sceneLive === true;
}
