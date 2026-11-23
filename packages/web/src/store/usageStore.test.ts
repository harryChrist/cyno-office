import type { SubscriptionUsage } from "@cyno/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { makeOffice } from "../test-fixtures";
import { useOfficeStore } from "./officeStore";
import { applyUsageEvent, useUsageStore } from "./usageStore";

const usage = (utilization: number): SubscriptionUsage => ({
  provider: "claude",
  windows: [{ id: "five_hour", utilization }],
  updatedAt: "2026-11-08T12:00:00.000Z",
});

describe("usageStore", () => {
  beforeEach(() => useUsageStore.setState({ byProvider: {} }));

  it("usage:updated troca o do provedor; snapshot com usage troca tudo; o resto não mexe", () => {
    const empty = {};
    const updated = applyUsageEvent(empty, { type: "usage:updated", usage: usage(0.3) });
    expect(updated).toEqual({ claude: usage(0.3) });
    expect(applyUsageEvent(updated, { type: "office:snapshot", office: makeOffice(), usage: [] })).toEqual({});
    expect(applyUsageEvent(updated, { type: "office:snapshot", office: makeOffice() })).toBe(updated);
    expect(applyUsageEvent(updated, { type: "team:deleted", id: "x" })).toBe(updated);
  });

  it("o officeStore manda os eventos de uso para cá (e não mexe no escritório)", () => {
    const store = useOfficeStore.getState();
    store.applyEvent({ type: "office:snapshot", office: makeOffice(), usage: [usage(0.5)] });
    expect(useUsageStore.getState().byProvider.claude?.windows[0]?.utilization).toBe(0.5);
    const office = useOfficeStore.getState().office;
    store.applyEvent({ type: "usage:updated", usage: usage(0.9) });
    expect(useUsageStore.getState().byProvider.claude?.windows[0]?.utilization).toBe(0.9);
    expect(useOfficeStore.getState().office).toBe(office);
  });

  it("ignora eventos e entradas do snapshot com accountId para não sobrescrever a conta padrão", () => {
    const padrao = usage(0.25);
    const extra: SubscriptionUsage = { ...usage(0.95), accountId: "trabalho" };

    const fromSnapshot = applyUsageEvent({}, { type: "office:snapshot", office: makeOffice(), usage: [padrao, extra] });
    expect(fromSnapshot).toEqual({ claude: padrao });

    const onlyExtra = applyUsageEvent({}, { type: "office:snapshot", office: makeOffice(), usage: [extra] });
    expect(onlyExtra).toEqual({});

    const ignoredEvent = applyUsageEvent(fromSnapshot, { type: "usage:updated", usage: extra });
    expect(ignoredEvent).toBe(fromSnapshot);
    expect(ignoredEvent.claude?.windows[0]?.utilization).toBe(0.25);
  });
});
