import type { PaceStatus, RoutineRunOutcome } from "./routines";
import type { TodayRoutineRun, TodayUpcoming, TodayView } from "./today";

/**
 * As rotinas do painel "Hoje" e da agenda (GET /api/w/:ws/routines/today e GET /api/routines/today).
 * Os campos são um superconjunto dos de `TodayView.routines/changes/goals`: o painel "Hoje" pode copiar
 * `ran`, `upcoming`, `goals` e `changes` direto. Tudo calculado no servidor, sem token.
 */

/** Uma execução de horário que já terminou hoje (dia de São Paulo). */
export type RoutinesTodayRan = TodayRoutineRun & {
  scheduleId?: string;
  scheduleLabel?: string;
  /** Quem executou (nome do agente). */
  agent?: string;
  endedAt?: string;
  outcome: Exclude<RoutineRunOutcome, "rodando">;
  skipReason?: string;
};

/** Uma execução em andamento agora. */
export type RoutinesTodayRunning = { routineId: string; title: string; scheduleId?: string; scheduleLabel?: string; startedAt: string; taskId?: string; agent?: string };

/** Um horário que ainda vai rodar hoje. */
export type RoutinesTodayUpcoming = TodayUpcoming & { scheduleId: string; label: string; agent?: string; action: string };

/** A meta do período (semana ou mês): N de M, no ritmo, atrasada ou batida. */
export type RoutinesTodayGoal = NonNullable<TodayView["goals"]>[number] & {
  period: "week" | "month";
  periodKey: string;
  pace: PaceStatus;
  /** Aprovadas sem link registrado (não contam como entregues). */
  approvedNoLink?: number;
  /** Texto do bloqueio do vigia, se houver. */
  blocked?: string;
};

/** Uma mudança de hoje num acompanhamento (item novo, status que mudou, item encerrado). */
export type RoutinesTodayChange = NonNullable<TodayView["changes"]>[number] & { title: string; text: string; at: string; alert?: boolean };

export type RoutinesToday = {
  /** Id do workspace. */
  workspace: string;
  at: string;
  ran: RoutinesTodayRan[];
  running: RoutinesTodayRunning[];
  upcoming: RoutinesTodayUpcoming[];
  goals: RoutinesTodayGoal[];
  changes: RoutinesTodayChange[];
};

/** A soma da plataforma: um bloco por workspace, mais as listas já juntas (cada item com o seu `workspace`). */
export type PlatformRoutinesToday = {
  at: string;
  workspaces: RoutinesToday[];
  ran: (RoutinesTodayRan & { workspace: string })[];
  running: (RoutinesTodayRunning & { workspace: string })[];
  upcoming: (RoutinesTodayUpcoming & { workspace: string })[];
  goals: (RoutinesTodayGoal & { workspace: string })[];
  changes: (RoutinesTodayChange & { workspace: string })[];
};
