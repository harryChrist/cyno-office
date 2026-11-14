import { buildDayStats, compareDays, dayRange, emptyClockBucket, emptyStateDayFile, type ForYouItem } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { durationText, renderDayStats } from "./text";

const T = (hhmm: string, day = "2026-11-11") => Date.parse(`${day}T${hhmm}:00.000Z`);
const item = (id: string, from: string, to: string, day = "2026-11-11"): ForYouItem =>
  ({ id, agentId: "eco", roomId: "s", type: "post", status: "aprovado", meta: {}, text: "", originalText: "", editedByUser: false, taskId: `t-${id}`, createdAt: new Date(T(from, day)).toISOString(), decidedAt: new Date(T(to, day)).toISOString() }) as ForYouItem;
const agents = [{ id: "eco", name: "Eco" }];

describe("renderDayStats / durationText", () => {
  it("durações", () => {
    expect(durationText(20_000)).toBe("20 s");
    expect(durationText(12 * 60_000)).toBe("12 min");
    expect(durationText(3_600_000)).toBe("1 h");
    expect(durationText(4_500_000)).toBe("1 h 15 min");
  });

  it("o texto traz o herói, os estados, os maiores esperas e a comparação; avisa quando os estados não foram registrados", () => {
    const clock = emptyStateDayFile("2026-11-11");
    const bucket = emptyClockBucket(T("12:00"));
    bucket.ms.working = 30 * 60_000;
    bucket.byAgent.push(["eco", { ...bucket.ms }]);
    clock.buckets.push(bucket);
    const yesterday = buildDayStats({ day: "2026-11-10", now: dayRange("2026-11-10").end, items: [item("A-1", "12:00", "13:40", "2026-11-10")], tasks: [], projects: [], agents });
    const stats = buildDayStats({ day: "2026-11-11", now: T("20:00"), clock, clockFrom: T("08:00"), items: [item("A-2", "12:00", "12:30")], tasks: [], projects: [], agents });
    stats.compare = compareDays(stats, { yesterday });
    const text = renderDayStats(stats, { workspace: "principal", workspaceName: "Marca" });
    expect(text).toContain('Day 2026-11-11 (America/Sao_Paulo), workspace principal "Marca".');
    expect(text).toContain("Waiting for the owner: 30 min in 1 wait, longest 30 min; clock time with someone waiting 30 min.");
    expect(text).toContain("Time by state: waiting for the owner 30 min, working 30 min.");
    expect(text).toContain("State times were recorded only from");
    expect(text).toContain("- 30 min Eco ");
    expect(text).toContain("- vs yesterday (2026-11-10): waiting for the owner -1 h 10 min (-70%)");
    const none = renderDayStats(buildDayStats({ day: "2026-11-10", now: T("20:00"), clockFrom: T("08:00"), items: [], tasks: [], projects: [], agents }));
    expect(none).toContain("no agent waited for the owner");
    expect(none).toContain("were not recorded this day (records start on 11/11)");
  });
});
