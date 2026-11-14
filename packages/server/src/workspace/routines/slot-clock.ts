import { dueSlots, isRoutinePaused } from "@cyno/shared";
import type { FastifyBaseLogger } from "fastify";
import type { RoutineRunner } from "./routine-runner";
import type { RoutineService } from "./routine-service";
import type { RoutineTracking } from "./tracking";

/** De quanto em quanto tempo o relógio confere os horários (a hora mais fina é o minuto). */
export const SLOT_TICK_MS = 60_000;

export type SlotClockDeps = {
  routines: RoutineService;
  runner: Pick<RoutineRunner, "start">;
  /** Vida dos itens (acompanhamento): a cada passada expira o que venceu, sem token. */
  tracking?: Pick<RoutineTracking, "sweep">;
  log: Pick<FastifyBaseLogger, "info" | "warn" | "error">;
  now: () => Date;
  /** Intervalo (testes e app de teste). */
  everyMs?: number;
};

/**
 * Relógio dos horários das rotinas, irmão do vigia das metas. Não cria um timer por horário: a cada
 * minuto (e já no boot) pergunta a `dueSlots` o que venceu e entrega ao `RoutineRunner`. É só código,
 * sem token: sem horário vencido, não faz nada. Rotina pausada (ou parada por data) não dispara e
 * também não acumula: ao voltar, só valem os horários de agora em diante.
 */
export class SlotClock {
  private timer: NodeJS.Timeout | undefined;
  private stopped = true;
  private running = false;

  constructor(private readonly deps: SlotClockDeps) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    // Já no boot: recupera o último horário recente de cada schedule (e marca os antigos como pulados).
    void this.tick().catch((error: unknown) => this.deps.log.error({ err: error }, "relógio de horários falhou"));
    this.schedule();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.tick()
        .catch((error: unknown) => this.deps.log.error({ err: error }, "relógio de horários falhou"))
        .finally(() => this.schedule());
    }, this.deps.everyMs ?? SLOT_TICK_MS);
    this.timer.unref();
  }

  /** Uma passada (os testes chamam direto). */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const now = this.deps.now();
      this.deps.tracking?.sweep();
      for (const routine of this.deps.routines.activeAll()) {
        if (routine.schedules.length === 0) continue;
        // Rotina fabricada pela semente do app de teste: nunca dispara motor de verdade.
        if (routine.seed) continue;
        if (isRoutinePaused(routine, now)) {
          this.deps.routines.syncSlotMarks(routine.id);
          continue;
        }
        for (const slot of dueSlots(routine, now)) {
          // Marca ANTES de executar: um horário nunca roda duas vezes, mesmo que a criação do trabalho falhe.
          this.deps.routines.markSlot(routine.id, slot.scheduleId, slot.slotKey);
          const schedule = routine.schedules.find((candidate) => candidate.id === slot.scheduleId);
          if (!schedule) continue;
          if (slot.action === "skip") {
            this.deps.routines.addRun(routine.id, { scheduleId: slot.scheduleId, slotKey: slot.slotKey, startedAt: now.toISOString(), endedAt: now.toISOString(), outcome: "pulada", skipReason: slot.skipReason ?? "pulada" });
            continue;
          }
          try {
            await this.deps.runner.start(this.deps.routines.get(routine.id), schedule, slot);
          } catch (error) {
            this.deps.log.error({ err: error, routineId: routine.id, scheduleId: slot.scheduleId }, "falha ao disparar o horário");
          }
        }
      }
    } finally {
      this.running = false;
    }
  }
}
