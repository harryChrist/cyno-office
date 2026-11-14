import type { FreebuffUsageDetail, SubscriptionUsage } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { agentAvailability } from "../ui/availability";
import { freebuffUsageView } from "./freebuffUsage";
import { planRows, planSummary, usageViews } from "./usage";

const NOW = Date.parse("2026-11-12T15:00:00.000Z");
const iso = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString();

function usage(detail: Partial<FreebuffUsageDetail> = {}, fetched = -2): SubscriptionUsage {
  return {
    provider: "freebuff",
    windows: [{ id: "daily_hours", utilization: 4 / 21, label: "Horas do dia", resetsAt: iso(8 * 60 + 30) }],
    updatedAt: iso(fetched),
    source: "cli",
    freebuff: {
      settings: { model: "DeepSeek V4.1 Flash", effort: "high", maxOpenHours: 1, multiplier: 2 },
      hours: { total: 21, remaining: 17, wallet: 25, resetsAt: iso(8 * 60 + 30), measuredAt: iso(fetched), openedSince: 0 },
      sessions: [{ agentId: "beto", agentName: "Beto", workspaceId: "ws", openedAt: iso(-23), endsAt: iso(37), endsAtSource: "measured", multiplier: 2, model: "DeepSeek V4.1 Flash", hasProcess: true }],
      ...detail,
    },
  };
}

describe("Freebuff no Uso do plano", () => {
  it("horas do dia (usadas/total), renovação, carteira e a hora em uso por agente com a barra", () => {
    const view = freebuffUsageView(usage(), NOW)!;
    expect(view).toMatchObject({ used: 4, total: 21, remaining: 17, wallet: 25, percent: 19, tone: "ok", shortText: "4/21 h", old: false, estimated: false });
    expect(view.resetLabel).toMatch(/^renova em 8 h 30 min \(às \d\d:\d\d\)$/);
    expect(view.measuredLabel).toBe("lido na tela do Freebuff há 2 min");
    expect(view.sessions).toEqual([
      expect.objectContaining({ agentName: "Beto", label: "hora em uso: restam 37 min", minutesLeft: 37, elapsedPercent: 38, modelLabel: "DeepSeek V4.1 Flash · gasta 2 h", hasProcess: true, measured: true }),
    ]);
    expect(view.modelLine).toBe("DeepSeek V4.1 Flash · high · gasta 2 horas por hora aberta");
  });

  it("estimado: o que o Cyno abriu depois da última leitura; dado antigo é marcado como nos outros motores", () => {
    const estimated = freebuffUsageView(usage({ hours: { total: 21, remaining: 15, resetsAt: iso(500), measuredAt: iso(-10), openedSince: 2 } }), NOW)!;
    expect(estimated).toMatchObject({ estimated: true, openedSince: 2, used: 6 });
    const old = freebuffUsageView(usage({}, -45), NOW)!;
    expect(old.old).toBe(true);
    expect(old.measuredLabel).toBe("lido na tela do Freebuff há 45 min");
  });

  it("sem o total do dia lido, só as horas abertas; sem nada, nada", () => {
    const noTotal = freebuffUsageView(usage({ hours: { openedSince: 2 } }), NOW)!;
    expect(noTotal).toMatchObject({ percent: null, shortText: "1 hora aberta" });
    expect(freebuffUsageView(usage({ hours: { openedSince: 0 }, sessions: [] }), NOW)).toBeUndefined();
    expect(freebuffUsageView(undefined, NOW)).toBeUndefined();
  });

  it("a linha do menu lateral: Freebuff 4/21 h, com a barra e a dica das horas abertas", () => {
    const views = usageViews({ freebuff: usage() }, NOW);
    expect(views).toHaveLength(1);
    const [row] = planRows(views);
    expect(row).toMatchObject({ provider: "freebuff", providerLabel: "Freebuff", valueText: "4/21 h", percent: 19, tone: "ok", old: false });
    expect(row!.title).toContain("Beto: hora em uso: restam 37 min");
    expect(planSummary(views).label).toBe("Uso do plano: Freebuff 4/21 h");
  });

  it("o agente que tem a hora aberta nunca espera; o outro espera pelo nome do dono da hora", () => {
    const byProvider = { freebuff: usage() };
    expect(agentAvailability({ id: "beto", engine: "freebuff" }, byProvider, undefined, NOW, "ws")).toBeNull();
    const other = agentAvailability({ id: "caio", engine: "freebuff" }, byProvider, undefined, NOW, "ws");
    expect(other?.block).toMatchObject({ reason: "hour", holder: "Beto" });
    expect(other?.label).toMatch(/^esperando a hora do Freebuff de Beto acabar \(às /);
  });
});
