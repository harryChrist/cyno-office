// O "Rever o dia": a loja do player e o controle que liga a reprodução à cena. A cena passa a ser alimentada pelos
// quadros gravados (pelo mesmo adaptador do ao vivo), com um relógio próprio; o ao vivo fica pausado por baixo.
import { dayKeyOf, mergeParts, parseTimeline, TIMELINE_PART_MS, type TimelineDayInfo, type TimelineDaysResponse, type TimelineRecord } from "@cyno/shared";
import type { OfficeSnapshot, WorldApi, WorldPlayback } from "@cyno/cena";
import { create } from "zustand";
import { useNavStore } from "../../store/navStore";
import {
  alternar,
  escalaDeAnimacao,
  irPara,
  iniciar,
  mudarVelocidade,
  passo,
  tocar,
  type EstadoDoPlayer,
  type Velocidade,
} from "./modelo";
import { Reproducao } from "./reproducao";

/** O que o controle usa da cena aberta. */
export interface CenaDoReplay {
  workspaceId: string;
  workspaceName: string;
  mundo: Pick<WorldApi, "setPlayback">;
  /** Entrega um retrato (o primeiro liga o modo replay da loja) e volta ao ao vivo. */
  publicar(retrato: OfficeSnapshot): void;
  voltarAoVivo(): void;
  /** Liga e desliga o retrato ao vivo (pausado durante o replay). */
  pausarVivo(pausado: boolean): void;
}

export type SituacaoDoReplay = "fechado" | "carregando" | "pronto" | "vazio" | "erro";

/** Quanto tempo real entre um retrato e outro enquanto toca (como o hub do servidor). */
export const EMPURRAO_MS = 200;
/** Arrastando a régua, a cena recomeça no máximo a cada tanto. */
export const BUSCA_MS = 120;

interface ReplayState {
  situacao: SituacaoDoReplay;
  mensagem: string;
  gravando: boolean;
  dias: TimelineDayInfo[];
  dia: string | null;
  player: EstadoDoPlayer | null;
  /** Há agentes no instante mostrado? (falso = "sem dados"). */
  semDados: boolean;
  limitado: boolean;
  /** O dia de hoje (de São Paulo), de quando o player abriu. */
  hoje: string;
  /** Versão do gráfico (sobe quando um dia novo é carregado). */
  versao: number;
}

export const useReplayStore = create<ReplayState>()(() => ({ situacao: "fechado", mensagem: "", gravando: true, dias: [], dia: null, player: null, semDados: false, limitado: false, versao: 0, hoje: "" }));

/** O replay está aberto (a cena é só para olhar)? Lido pela interface a cada clique. */
export const replayAtivo = (): boolean => useReplayStore.getState().situacao !== "fechado";

// ------------------------------------------------------------------ busca

export async function buscarDias(workspaceId: string, sinal?: AbortSignal): Promise<TimelineDaysResponse> {
  const res = await fetch(`/api/w/${encodeURIComponent(workspaceId)}/timeline/days`, { signal: sinal, headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as Partial<TimelineDaysResponse>;
  const days = Array.isArray(body.days) ? body.days.filter((d) => typeof d?.day === "string" && Number.isFinite(d.from) && Number.isFinite(d.to)) : [];
  return { recording: body.recording === true, days };
}

/** O dia gravado, buscado por partes de 3 h (cada uma leva na frente o quadro completo que vale no começo). */
export async function buscarDia(workspaceId: string, info: TimelineDayInfo, sinal?: AbortSignal): Promise<TimelineRecord[]> {
  const partes: { from: number; records: TimelineRecord[] }[] = [];
  for (let from = info.from - 1; from < info.to; from += TIMELINE_PART_MS) {
    const to = Math.min(info.to, from + TIMELINE_PART_MS);
    const res = await fetch(`/api/w/${encodeURIComponent(workspaceId)}/timeline/${info.day}?from=${from}&to=${to}`, { signal: sinal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    partes.push({ from, records: parseTimeline(await res.text()) });
  }
  return mergeParts(partes);
}

// ------------------------------------------------------------------ controle

let cena: CenaDoReplay | null = null;
let reproducao: Reproducao | null = null;
let raf = 0;
let ultimoReal = 0;
let ultimoEmpurrao = 0;
let ultimaBusca = 0;
let temporizadorDeBusca: ReturnType<typeof setTimeout> | null = null;
let sequencia = 0;
let abortar: AbortController | null = null;
let ativo = false;
const diasEmCache = new Map<string, Reproducao>();

const relogio: WorldPlayback = {
  clock: () => useReplayStore.getState().player?.t ?? 0,
  scale: () => {
    const p = useReplayStore.getState().player;
    return p?.tocando ? escalaDeAnimacao(p.velocidade) : 0;
  },
};

const set = (parcial: Partial<ReplayState>) => useReplayStore.setState(parcial);
const player = (): EstadoDoPlayer | null => useReplayStore.getState().player;

/** A cena aberta avisa (ou deixa de avisar, com null) quem a controla. Trocar de cena fecha o replay. */
export function registrarCena(nova: CenaDoReplay | null): void {
  if (cena && nova !== cena) fechar();
  cena = nova;
}

function empurrar(): void {
  const p = player();
  if (!cena || !reproducao || !p) return;
  reproducao.moveTo(p.t);
  set({ semDados: reproducao.isOff(p.t), limitado: reproducao.limited });
  cena.publicar(reproducao.retrato(p.t, cena.workspaceId, cena.workspaceName));
}

/** Pula para `t`: a cena recomeça (todos já no lugar, sem andar até a mesa) e mostra aquele instante. */
function buscar(t: number): void {
  const p = player();
  if (!cena || !reproducao || !p) return;
  set({ player: irPara(p, t) });
  ativo = true;
  cena.pausarVivo(true);
  reproducao.moveTo(player()!.t);
  reproducao.reiniciarMemoria(player()!.t);
  cena.mundo.setPlayback?.(relogio);
  empurrar();
  ultimoEmpurrao = performance.now();
}

function laco(): void {
  raf = 0;
  const p = player();
  if (!p?.tocando) return;
  const agora = performance.now();
  const proximo = passo(p, agora - ultimoReal);
  ultimoReal = agora;
  set({ player: proximo });
  if (!proximo.tocando || agora - ultimoEmpurrao >= EMPURRAO_MS) {
    ultimoEmpurrao = agora;
    empurrar();
  }
  if (proximo.tocando) raf = requestAnimationFrame(laco);
}

function comecarAToc(): void {
  ultimoReal = performance.now();
  if (!raf) raf = requestAnimationFrame(laco);
}

function carregar(info: TimelineDayInfo, instante: number | undefined, tocando: boolean): void {
  const minha = ++sequencia;
  const workspaceId = cena?.workspaceId;
  if (!workspaceId) return;
  const pronto = (r: Reproducao) => {
    if (r.empty) {
      set({ situacao: "vazio", mensagem: "Não há nada gravado neste dia." });
      return;
    }
    reproducao = r;
    const inicio = instante !== undefined ? Math.min(r.to, Math.max(r.from, instante)) : r.from;
    set({ situacao: "pronto", mensagem: "", dia: info.day, player: iniciar(r.from, r.to, inicio, player()?.velocidade), versao: useReplayStore.getState().versao + 1 });
    buscar(inicio);
    if (tocando) {
      set({ player: tocar(player()!) });
      comecarAToc();
    }
  };
  const cache = diasEmCache.get(info.day);
  if (cache && info.day !== dayKeyOf(Date.now())) return pronto(cache);
  set({ situacao: "carregando", mensagem: "Carregando o dia…" });
  buscarDia(workspaceId, info, abortar?.signal).then(
    (registros) => {
      if (minha !== sequencia || !replayAtivo()) return;
      const r = new Reproducao(info.day, registros);
      diasEmCache.set(info.day, r);
      pronto(r);
    },
    (erro: unknown) => {
      if (minha !== sequencia || !replayAtivo() || (erro instanceof DOMException && erro.name === "AbortError")) return;
      console.warn("[rever o dia]", erro);
      set({ situacao: "erro", mensagem: "Não foi possível carregar este dia." });
    },
  );
}

/** Abre o player (no dia e instante pedidos; sem pedido, no dia mais recente, do começo). */
export async function abrir(opcoes: { dia?: string; instante?: number; tocar?: boolean } = {}): Promise<void> {
  if (!cena || replayAtivo()) {
    if (replayAtivo() && opcoes.dia !== undefined) return irParaDia(opcoes.dia, opcoes.instante);
    return;
  }
  abortar?.abort();
  abortar = new AbortController();
  diasEmCache.clear();
  set({ situacao: "carregando", mensagem: "Carregando os dias gravados…", hoje: dayKeyOf(Date.now()), dia: null, player: null, semDados: false, limitado: false });
  if (typeof document !== "undefined") document.documentElement.classList.add("is-replay");
  try {
    const resposta = await buscarDias(cena.workspaceId, abortar.signal);
    if (!replayAtivo()) return;
    set({ dias: resposta.days, gravando: resposta.recording });
    if (resposta.days.length === 0) {
      set({ situacao: "vazio", mensagem: resposta.recording ? "Ainda não há gravação: ela começa hoje." : "A gravação está desligada neste servidor e não há dias gravados." });
      return;
    }
    const alvo = opcoes.dia ? resposta.days.find((d) => d.day === opcoes.dia) : undefined;
    if (opcoes.dia && !alvo) {
      set({ situacao: "vazio", mensagem: "Esse dia não tem gravação. A gravação começa quando o servidor liga e guarda 7 dias." });
      return;
    }
    const info = alvo ?? resposta.days[resposta.days.length - 1]!;
    carregar(info, alvo ? opcoes.instante : undefined, opcoes.tocar ?? false);
  } catch (erro) {
    if (!replayAtivo() || (erro instanceof DOMException && erro.name === "AbortError")) return;
    console.warn("[rever o dia]", erro);
    set({ situacao: "erro", mensagem: "Não foi possível buscar a gravação no servidor." });
  }
}

/** "Ver esse momento": abre o Escritório no replay do instante (dia de São Paulo). */
export function verEsseMomento(t: number): void {
  useNavStore.getState().go("office");
  void abrir({ dia: dayKeyOf(t), instante: t });
}

export function irParaDia(dia: string, instante?: number): void {
  const info = useReplayStore.getState().dias.find((d) => d.day === dia);
  if (!info || !replayAtivo()) return;
  const tocando = player()?.tocando ?? false;
  pausarLaco();
  carregar(info, instante, tocando);
}

function pausarLaco(): void {
  if (raf) cancelAnimationFrame(raf);
  raf = 0;
}

export function alternarTocar(): void {
  const p = player();
  if (!p || useReplayStore.getState().situacao !== "pronto") return;
  const proximo = alternar(p);
  if (proximo.t !== p.t) {
    set({ player: proximo });
    buscar(proximo.t);
  } else set({ player: proximo });
  if (proximo.tocando) comecarAToc();
  else {
    pausarLaco();
    empurrar(); // o último ponto exato (a pausa congela o mundo nele)
  }
}

export function escolherVelocidade(velocidade: Velocidade): void {
  const p = player();
  if (p) set({ player: mudarVelocidade(p, velocidade) });
}

/** Arrastar a régua: o relógio segue o dedo e a cena recomeça no máximo a cada `BUSCA_MS`. */
export function arrastar(t: number, final: boolean): void {
  const p = player();
  if (!p) return;
  set({ player: irPara(p, t) });
  if (temporizadorDeBusca) clearTimeout(temporizadorDeBusca);
  temporizadorDeBusca = null;
  const espera = BUSCA_MS - (performance.now() - ultimaBusca);
  if (final || espera <= 0) {
    ultimaBusca = performance.now();
    buscar(t);
    return;
  }
  temporizadorDeBusca = setTimeout(() => {
    temporizadorDeBusca = null;
    ultimaBusca = performance.now();
    buscar(player()?.t ?? t);
  }, espera);
}

export function irParaInstante(t: number): void {
  arrastar(t, true);
}

/** "Voltar ao agora": sai do replay, a cena volta ao escritório de verdade. */
export function fechar(): void {
  if (!replayAtivo()) return;
  pausarLaco();
  sequencia++;
  abortar?.abort();
  abortar = null;
  if (temporizadorDeBusca) clearTimeout(temporizadorDeBusca);
  temporizadorDeBusca = null;
  if (ativo) {
    ativo = false;
    cena?.mundo.setPlayback?.(null);
    cena?.voltarAoVivo();
    cena?.pausarVivo(false);
  }
  reproducao = null;
  diasEmCache.clear();
  if (typeof document !== "undefined") document.documentElement.classList.remove("is-replay");
  set({ situacao: "fechado", mensagem: "", dia: null, player: null, dias: [], semDados: false, limitado: false });
}

/** A cena foi suspensa pela interface (o dono saiu do Escritório): o replay fecha, para o laço e tira a classe `is-replay`. */
export function aoSuspenderCena(suspensa: boolean): void {
  if (suspensa) fechar();
}

/** O retrato de agora (para o replay) — usado pelos testes da tela e pela interface do player. */
export function reproducaoAtual(): Reproducao | null {
  return reproducao;
}

/** Para os testes: volta ao estado inicial. */
export function reiniciarReplay(): void {
  fechar();
  cena = null;
  useReplayStore.setState({ situacao: "fechado", mensagem: "", gravando: true, dias: [], dia: null, player: null, semDados: false, limitado: false, versao: 0, hoje: "" });
}
