import {
  localDayKey,
  localDayStart,
  parseAddress,
  shiftDay,
  slotsBetween,
  startOfLocalDay,
  zoned,
  ROUTINE_TIMEZONE,
  type ForYouItem,
  type OfficeState,
  type PlatformRoutinesToday,
  type RoutinesToday,
  type RoutinesTodayChange,
  type RoutinesTodayGoal,
  type RoutinesTodayRan,
  type RoutinesTodayRunning,
  type RoutinesTodayUpcoming,
  type Routine,
} from "@cyno/shared";
import { overviewItem } from "./overview";
import type { RoutineService } from "./routine-service";
import type { RoutineTracking } from "./tracking";

export type RoutinesTodayInput = {
  workspaceId: string;
  routines: RoutineService;
  tracking: Pick<RoutineTracking, "recent">;
  state: { read(): OfficeState };
  now: Date;
  forYou?: readonly ForYouItem[];
};

const MAX_UPCOMING = 50;

/** Fim do dia de São Paulo de `now` (o começo do dia seguinte). */
function endOfDay(now: Date): Date {
  const p = zoned(now.getTime(), ROUTINE_TIMEZONE);
  const next = shiftDay(p.year, p.month, p.day, 1);
  return new Date(startOfLocalDay(next.year, next.month, next.day, ROUTINE_TIMEZONE));
}

/**
 * As rotinas de hoje de um workspace, só com código: o que já rodou (com o resultado curto), o que roda
 * agora, o que ainda vai rodar hoje (hora e agente), as metas do período e as mudanças de hoje nos
 * acompanhamentos. Nada aqui gasta token.
 */
export function buildRoutinesToday(input: RoutinesTodayInput): RoutinesToday {
  const { routines, now, tracking } = input;
  const state = input.state.read();
  const dayKey = localDayKey(now);
  const dayStart = localDayStart(now);
  const agentName = (routine: Routine, address?: string): string | undefined => {
    const parsed = address ? parseAddress(address) : undefined;
    const id = parsed?.agentId ?? routine.agentId;
    if (id) return state.agents.find((agent) => agent.id === id)?.name;
    return routine.teamId ? state.teams.find((team) => team.id === routine.teamId)?.name : undefined;
  };
  const ran: RoutinesTodayRan[] = [];
  const running: RoutinesTodayRunning[] = [];
  const upcoming: RoutinesTodayUpcoming[] = [];
  const goals: RoutinesTodayGoal[] = [];
  const changes: RoutinesTodayChange[] = [];
  const end = endOfDay(now);

  for (const routine of routines.list()) {
    if (routine.status === "proposta" || routine.status === "encerrada") continue;
    for (const run of routine.lastRuns) {
      const schedule = routine.schedules.find((candidate) => candidate.id === run.scheduleId);
      const base = { routineId: routine.id, title: routine.title, ...(run.scheduleId ? { scheduleId: run.scheduleId } : {}), ...(schedule ? { scheduleLabel: schedule.label } : {}) };
      const agent = agentName(routine, schedule?.agent);
      if (run.outcome === "rodando") {
        running.push({ ...base, startedAt: run.startedAt, ...(run.taskId ? { taskId: run.taskId } : {}), ...(agent ? { agent } : {}) });
        continue;
      }
      if (run.outcome === "pulada" || localDayKey(new Date(run.endedAt ?? run.startedAt)) !== dayKey) continue;
      ran.push({ ...base, at: run.startedAt, ...(run.endedAt ? { endedAt: run.endedAt } : {}), outcome: run.outcome, ...(run.summary ? { summary: run.summary } : {}), ...(agent ? { agent } : {}) });
    }
    if (routine.status === "ativa" && !(routine.pausedUntil && Date.parse(routine.pausedUntil) > now.getTime())) {
      for (const slot of slotsBetween(routine, now, end, MAX_UPCOMING)) {
        const schedule = routine.schedules.find((candidate) => candidate.id === slot.scheduleId);
        const agent = agentName(routine, schedule?.agent);
        upcoming.push({ routineId: routine.id, title: routine.title, at: slot.at, scheduleId: slot.scheduleId, label: slot.label, action: slot.action, ...(agent ? { agent } : {}) });
      }
    }
    if (routine.type === "meta") {
      const item = overviewItem({ routines, state: input.state, now, ...(input.forYou ? { forYou: input.forYou } : {}) }, routine);
      goals.push({
        routineId: routine.id,
        title: routine.title,
        done: item.delivered,
        target: routine.target,
        period: item.period,
        periodKey: item.periodKey,
        pace: item.pace,
        ...(item.approvedNoLink ? { approvedNoLink: item.approvedNoLink } : {}),
        ...(routine.blocked ? { blocked: routine.blocked.reason } : {}),
      });
    } else if (routine.type === "acompanhamento" && routine.tracking) {
      for (const change of tracking.recent(routine.id, dayStart.getTime())) {
        changes.push({ routineId: routine.id, title: routine.title, item: change.label, text: change.text, at: change.at, to: change.to ?? change.text, ...(change.from ? { from: change.from } : {}), ...(change.alert ? { alert: true } : {}) });
      }
    }
  }
  ran.sort((a, b) => (b.endedAt ?? b.at).localeCompare(a.endedAt ?? a.at));
  upcoming.sort((a, b) => a.at.localeCompare(b.at) || a.routineId.localeCompare(b.routineId));
  changes.sort((a, b) => b.at.localeCompare(a.at));
  return { workspace: input.workspaceId, at: now.toISOString(), ran, running, upcoming, goals, changes };
}

/** A soma dos workspaces (cada item carrega o `workspace`). */
export function mergeRoutinesToday(parts: readonly RoutinesToday[], now: Date): PlatformRoutinesToday {
  const tag = <T>(key: "ran" | "running" | "upcoming" | "goals" | "changes"): (T & { workspace: string })[] => parts.flatMap((part) => (part[key] as unknown as T[]).map((item) => ({ ...item, workspace: part.workspace })));
  return {
    at: now.toISOString(),
    workspaces: [...parts],
    ran: tag<RoutinesTodayRan>("ran").sort((a, b) => (b.endedAt ?? b.at).localeCompare(a.endedAt ?? a.at)),
    running: tag<RoutinesTodayRunning>("running").sort((a, b) => a.startedAt.localeCompare(b.startedAt)),
    upcoming: tag<RoutinesTodayUpcoming>("upcoming").sort((a, b) => a.at.localeCompare(b.at)),
    goals: tag<RoutinesTodayGoal>("goals"),
    changes: tag<RoutinesTodayChange>("changes").sort((a, b) => b.at.localeCompare(a.at)),
  };
}
