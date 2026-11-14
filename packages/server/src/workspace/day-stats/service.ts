import {
  addDays,
  buildDayStats,
  compareDays,
  dayKeyOf,
  dayRange,
  DAY_STATS_RETENTION_DAYS,
  COMPARE_AVG_DAYS,
  ownerWaits,
  type Agent,
  type DayStats,
  type ForYouItem,
  type Project,
  type Task,
  type UsageRecord,
} from "@cyno/shared";
import { dayUsageOf } from "./usage";
import type { StateClock } from "./state-clock";

export type DayStatsServiceDeps = {
  clock: Pick<StateClock, "read" | "days" | "since">;
  tasks: () => readonly Task[];
  projects: () => readonly Project[];
  agents: () => readonly Agent[];
  forYou: () => readonly ForYouItem[];
  /** As linhas do histórico de gastos entre dois instantes (o `UsageHistory.read`). */
  usage: (fromMs: number, toMs: number) => Promise<UsageRecord[]>;
  usdBrl: () => number;
  now: () => number;
};

/**
 * "Meu dia" de um workspace: junta o relógio de estados (trabalhando, fila, esperando outro, Maestro, sem cota), os
 * itens do "Para você" (esperando você) e o histórico de gastos num `DayStats`, com as comparações. Só leitura.
 */
export class DayStatsService {
  constructor(private readonly deps: DayStatsServiceDeps) {}

  /** O dia `day` ("AAAA-MM-DD"), com as comparações (ontem, mesmo dia da semana passada e a média dos 7 anteriores). */
  async day(day: string, options: { compare?: boolean } = {}): Promise<DayStats> {
    const withCompare = options.compare !== false;
    const first = withCompare ? addDays(day, -7) : day;
    const records = await this.deps.usage(dayRange(first).start, dayRange(day).end);
    const stats = this.build(day, records);
    if (!withCompare) return stats;
    const at = (offset: number) => this.build(addDays(day, offset), records);
    const last7 = Array.from({ length: COMPARE_AVG_DAYS }, (_, index) => at(-(index + 1)));
    stats.compare = compareDays(stats, { yesterday: last7[0]!, sameWeekday: at(-7), last7 });
    return stats;
  }

  /** Os dias de `from` a `to` (inclusive), sem comparação (um só acesso ao histórico de gastos). */
  async range(from: string, to: string): Promise<DayStats[]> {
    const records = await this.deps.usage(dayRange(from).start, dayRange(to).end);
    const out: DayStats[] = [];
    for (let day = from; day <= to; day = addDays(day, 1)) out.push(this.build(day, records));
    return out;
  }

  /** Os dias (dos últimos 90) em que há alguma coisa: estados, esperas pelo dono ou gasto. */
  async days(): Promise<string[]> {
    const now = this.deps.now();
    const today = dayKeyOf(now);
    const oldest = addDays(today, -DAY_STATS_RETENTION_DAYS);
    const found = new Set(this.deps.clock.days());
    const { waits } = ownerWaits(this.deps.forYou(), this.deps.tasks(), now);
    for (const wait of waits) {
      for (let day = dayKeyOf(wait.start); day <= dayKeyOf(wait.end); day = addDays(day, 1)) found.add(day);
    }
    for (const record of await this.deps.usage(dayRange(oldest).start, dayRange(today).end)) {
      if (record.turns !== 0) found.add(dayKeyOf(Date.parse(record.at)));
    }
    return [...found].filter((day) => day >= oldest && day <= today).sort();
  }

  private build(day: string, records: readonly UsageRecord[]): DayStats {
    const agents = this.deps.agents();
    const tasks = this.deps.tasks();
    const since = this.deps.clock.since();
    return buildDayStats({
      day,
      now: this.deps.now(),
      clock: this.deps.clock.read(day) ?? null,
      ...(since !== undefined ? { clockFrom: since } : {}),
      items: this.deps.forYou(),
      tasks,
      projects: this.deps.projects(),
      agents,
      usage: dayUsageOf(records, day, this.deps.usdBrl(), { agents, tasks }),
    });
  }
}
