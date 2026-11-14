import { engineBlock, quotaBlock, type AgentEngine, type EngineBlock, type EngineInfo, type FreebuffAgentRef } from "@cyno/shared";
import type { SubscriptionUsageTracker } from "./subscription-usage";

/** Maior espera de um setTimeout (~24,8 dias). */
const MAX_TIMER_MS = 2 ** 31 - 1;
/** Folga depois do `resetsAt` antes de liberar (a conta pode demorar um instante para zerar). */
const RESET_GRACE_MS = 2000;

export type EngineAvailabilityDeps = {
  usage: Pick<SubscriptionUsageTracker, "snapshot" | "hub">;
  /** Motores já detectados (sem detecção ainda = undefined: nada fica indisponível por isso). */
  engines?: () => readonly EngineInfo[] | undefined;
  now: () => Date;
};

/**
 * Disponibilidade dos motores de CLI (uma para o server todo: a cota é da CONTA). Um motor fica
 * indisponível quando a cota da assinatura acabou (janela a 100%, status "rejected") ou quando a CLI
 * não está instalada; os agentes dele não pegam tarefa (ficam na fila) e nunca trocam de motor.
 * `onChange` avisa quando algo pode ter voltado: chegou uso novo ou passou um `resetsAt` (há um
 * relógio armado para o próximo).
 */
export class EngineAvailability {
  private readonly listeners = new Set<() => void>();
  private timer: NodeJS.Timeout | undefined;
  private readonly unsubscribe: () => void;
  /** Provedores que o usuário mandou tentar mesmo sem cota: vale até chegar uso novo deles. */
  private readonly retrying = new Set<string>();

  constructor(private readonly deps: EngineAvailabilityDeps) {
    this.unsubscribe = deps.usage.hub.subscribe((event) => {
      if (event.type !== "usage:updated") return;
      this.retrying.delete(event.usage.provider);
      this.arm();
      this.notify();
    });
    this.arm();
  }

  /**
   * Por que o motor está indisponível agora (undefined = disponível; o simulado sempre está).
   * `model`: o do agente (só as janelas da cota que valem para ele contam; veja quotaBlock).
   * `agent`: quem pergunta (o Freebuff cobra por hora aberta: quem já tem hora aberta nunca espera; veja freebuffBlock).
   */
  block(engine: AgentEngine | undefined, model?: string, agent?: FreebuffAgentRef): EngineBlock | undefined {
    const block = engineBlock(engine, { usage: this.deps.usage.snapshot(), engines: this.deps.engines?.(), now: this.deps.now().getTime() }, model, agent);
    return block?.reason === "quota" && engine && this.retrying.has(engine) ? undefined : block;
  }

  /**
   * "Tentar agora": ignora a cota esgotada do motor até a CLI mandar uso novo (se ainda estiver sem
   * cota, ela avisa de novo e as tarefas voltam a esperar). As filas paradas andam na hora.
   */
  retry(engine: AgentEngine): void {
    this.retrying.add(engine);
    this.notify();
  }

  /** Avisa quando a disponibilidade pode ter mudado (devolve a função que para de avisar). */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Os motores voltaram a ser checados (ex.: o usuário mandou tentar de novo). */
  notify(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        // um workspace com problema não impede os outros de retomar
      }
    }
  }

  close(): void {
    this.unsubscribe();
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.listeners.clear();
  }

  /** Arma o relógio para o próximo `resetsAt` de uma cota esgotada (quando ela zerar, as filas andam). */
  private arm(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const now = this.deps.now().getTime();
    const resets = this.deps.usage
      .snapshot()
      .map((usage) => quotaBlock(usage, now)?.resetsAt)
      .filter((iso): iso is string => iso !== undefined)
      .map((iso) => Date.parse(iso))
      .filter((at) => at > now);
    if (resets.length === 0) return;
    const wait = Math.min(MAX_TIMER_MS, Math.min(...resets) - now + RESET_GRACE_MS);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.arm();
      this.notify();
    }, wait);
    this.timer.unref();
  }
}
