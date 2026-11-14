/**
 * Vagas de gateway do Hermes (revisão 2, M3): cada agente em turno sobe um gateway (~270 MB). Sem teto, dez subtarefas em paralelo
 * seriam ~2,7 GB além do servidor. Quem passa do teto espera na fila (em ordem de chegada) e o terminal mostra o motivo.
 */
export type GatewayWait = { inUse: number; cap: number; position: number };

export class GatewaySlots {
  private active = 0;
  private readonly waiters: { grant: () => void; signal: AbortSignal | undefined }[] = [];

  /** `cap`: lido a cada pedido (o dono muda na tela Motores sem reiniciar). */
  constructor(private readonly cap: () => number) {}

  inUse(): number {
    return this.active;
  }

  waiting(): number {
    return this.waiters.length;
  }

  limit(): number {
    return Math.max(1, Math.floor(this.cap()));
  }

  /**
   * Pede uma vaga. Devolve `release` (idempotente) ou `undefined` se o pedido foi cancelado (`signal`) enquanto esperava.
   * `onWait` é chamado uma vez, ao entrar na fila.
   */
  async acquire(options: { signal?: AbortSignal; onWait?: (wait: GatewayWait) => void } = {}): Promise<(() => void) | undefined> {
    if (options.signal?.aborted) return undefined;
    if (this.active < this.limit() && this.waiters.length === 0) {
      this.active += 1;
      return this.releaser();
    }
    const granted = await new Promise<boolean>((resolve) => {
      const waiter = {
        grant: () => {
          options.signal?.removeEventListener("abort", onAbort);
          resolve(true);
        },
        signal: options.signal,
      };
      const onAbort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index !== -1) this.waiters.splice(index, 1);
        resolve(false);
      };
      options.signal?.addEventListener("abort", onAbort, { once: true });
      this.waiters.push(waiter);
      options.onWait?.({ inUse: this.active, cap: this.limit(), position: this.waiters.length });
    });
    return granted ? this.releaser() : undefined;
  }

  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active = Math.max(0, this.active - 1);
      this.drain();
    };
  }

  /** O teto subiu ou uma vaga abriu: acorda quem espera, na ordem. */
  drain(): void {
    while (this.waiters.length > 0 && this.active < this.limit()) {
      this.active += 1;
      this.waiters.shift()!.grant();
    }
  }
}
