/**
 * Aviso de vida dos WebSockets de eventos (escritório e Cyno).
 *
 * O servidor já manda ping de protocolo e derruba quem não responde, mas o navegador não mostra o ping ao código da
 * página. Uma conexão que morre em silêncio (celular em segundo plano, troca de rede, túnel que corta) pode ficar
 * "aberta" do lado da página por muito tempo, e a tela mostra dados velhos até recarregar. Por isso o servidor manda
 * também esta mensagem de texto a cada batida: a página anota quando ouviu o servidor pela última vez e, passado o
 * limite de silêncio, fecha a conexão e reconecta sozinha.
 */

/** A mensagem, já serializada (não é um ServerEvent: os leitores de evento a ignoram). */
export const WS_HEARTBEAT_WIRE = '{"type":"heartbeat"}';

/** De quanto em quanto tempo o servidor bate (ping e aviso de vida). */
export const WS_HEARTBEAT_MS = 30_000;

/** Silêncio a partir do qual a página dá a conexão por morta: duas batidas perdidas e uma folga. */
export const WS_SILENCE_LIMIT_MS = 70_000;

/** Ao voltar para a frente (aba, celular desbloqueado, rede de volta) a página é mais exigente: uma batida perdida e uma folga. */
export const WS_WAKE_SILENCE_MS = 40_000;

/** De quanto em quanto tempo a página confere o silêncio. */
export const WS_SILENCE_CHECK_MS = 10_000;

export function isWsHeartbeat(raw: string): boolean {
  return raw === WS_HEARTBEAT_WIRE;
}

/**
 * Conta o silêncio de UMA conexão. Só vale depois da primeira batida ouvida nela (`armed`): contra um servidor que
 * não manda o aviso, o silêncio é sempre zero e a página nunca derruba a conexão por isso.
 */
export function createWsLiveness(now: () => number = Date.now) {
  let lastSeen = now();
  let armed = false;
  return {
    /** Conexão nova: zera. */
    reset(): void {
      lastSeen = now();
      armed = false;
    },
    /** Chegou qualquer mensagem (evento ou batida). */
    seen(raw: string): void {
      lastSeen = now();
      if (!armed && isWsHeartbeat(raw)) armed = true;
    },
    /** Há quanto tempo o servidor não fala (0 enquanto não ouvimos a primeira batida). */
    silentFor(): number {
      return armed ? Math.max(0, now() - lastSeen) : 0;
    },
  };
}

export type WsLiveness = ReturnType<typeof createWsLiveness>;
