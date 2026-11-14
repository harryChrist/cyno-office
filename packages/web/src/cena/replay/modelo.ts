// O modelo do player do "Rever o dia": o instante, tocar e pausar, a velocidade, os limites do dia. Puro: o relógio
// real entra por `passo`. A fórmula `t += min(250 ms, delta) × velocidade` é a do player do Habblaud.

export const VELOCIDADES = [60, 300, 900] as const;
export type Velocidade = (typeof VELOCIDADES)[number];
export const VELOCIDADE_INICIAL: Velocidade = 300;
/** O maior pedaço de tempo real que conta num passo (aba em segundo plano não pula o dia). */
export const PASSO_MAXIMO_MS = 250;
/** Passo do teclado na régua: 1 minuto. */
export const PASSO_DO_TECLADO_MS = 60_000;

export interface EstadoDoPlayer {
  /** Os limites do dia gravado (ms). */
  de: number;
  ate: number;
  /** O instante reproduzido (ms). */
  t: number;
  tocando: boolean;
  velocidade: Velocidade;
}

export const limitar = (e: Pick<EstadoDoPlayer, "de" | "ate">, t: number): number => Math.min(e.ate, Math.max(e.de, t));

export function iniciar(de: number, ate: number, t: number = de, velocidade: Velocidade = VELOCIDADE_INICIAL): EstadoDoPlayer {
  const base = { de, ate: Math.max(de, ate) };
  return { ...base, t: limitar(base, t), tocando: false, velocidade };
}

/** Toca; no fim do dia, recomeça do começo. */
export function tocar(e: EstadoDoPlayer): EstadoDoPlayer {
  return { ...e, tocando: true, t: e.t >= e.ate ? e.de : e.t };
}

export const pausar = (e: EstadoDoPlayer): EstadoDoPlayer => ({ ...e, tocando: false });
export const alternar = (e: EstadoDoPlayer): EstadoDoPlayer => (e.tocando ? pausar(e) : tocar(e));
export const mudarVelocidade = (e: EstadoDoPlayer, velocidade: Velocidade): EstadoDoPlayer => ({ ...e, velocidade });
/** Arrastar a régua, clicar num pico ou num horário. Não muda se está tocando. */
export const irPara = (e: EstadoDoPlayer, t: number): EstadoDoPlayer => ({ ...e, t: limitar(e, t) });

/** Avança `deltaMs` de tempo real. No fim do dia, para. */
export function passo(e: EstadoDoPlayer, deltaMs: number): EstadoDoPlayer {
  if (!e.tocando) return e;
  const t = limitar(e, e.t + Math.min(PASSO_MAXIMO_MS, Math.max(0, deltaMs)) * e.velocidade);
  return t >= e.ate ? { ...e, t: e.ate, tocando: false } : { ...e, t };
}

/** Fração (0 a 1) do dia gravado em que está o instante. */
export const fracao = (e: Pick<EstadoDoPlayer, "de" | "ate" | "t">): number => (e.ate > e.de ? (e.t - e.de) / (e.ate - e.de) : 0);

/** O passo de animação do mundo para a velocidade (a mesma do Habblaud: ~raiz da velocidade, de 1 a 16). */
export function escalaDeAnimacao(velocidade: number): number {
  if (!Number.isFinite(velocidade) || velocidade <= 0) return 0;
  return Math.min(16, Math.max(1, Math.round(Math.sqrt(velocidade) * 0.75)));
}
