import type { ServerEvent } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { SubscriptionUsageTracker } from "./subscription-usage";

function tracker() {
  let clock = Date.parse("2026-11-08T12:00:00Z");
  const usage = new SubscriptionUsageTracker(() => new Date((clock += 1000)));
  const events: ServerEvent[] = [];
  usage.hub.subscribe((event) => events.push(event));
  return { usage, events };
}

describe("SubscriptionUsageTracker", () => {
  it("guarda o último uso por provedor, com as janelas em ordem, e publica usage:updated", () => {
    const { usage, events } = tracker();
    usage.report("claude", {
      status: "allowed",
      windows: [
        { id: "seven_day", utilization: 0.44 },
        { id: "five_hour", utilization: 0.27, resetsAt: "2026-11-08T15:00:00.000Z", status: "allowed" },
      ],
    });
    expect(usage.snapshot()).toEqual([
      {
        provider: "claude",
        status: "allowed",
        source: "cli",
        windows: [
          { id: "five_hour", utilization: 0.27, resetsAt: "2026-11-08T15:00:00.000Z", status: "allowed" },
          { id: "seven_day", utilization: 0.44 },
        ],
        updatedAt: "2026-11-08T12:00:01.000Z",
      },
    ]);
    expect(events).toEqual([{ type: "usage:updated", usage: usage.snapshot()[0] }]);
  });

  it("relato parcial atualiza só as janelas que trouxe; relato igual não publica", () => {
    const { usage, events } = tracker();
    usage.report("claude", { windows: [{ id: "five_hour", utilization: 0.2 }, { id: "seven_day", utilization: 0.4 }] });
    usage.report("claude", { windows: [{ id: "five_hour", utilization: 0.2 }] });
    expect(events).toHaveLength(1);
    usage.report("claude", { status: "allowed_warning", windows: [{ id: "five_hour", utilization: 0.85 }] });
    expect(events).toHaveLength(2);
    expect(usage.snapshot()[0]).toMatchObject({
      status: "allowed_warning",
      windows: [
        { id: "five_hour", utilization: 0.85 },
        { id: "seven_day", utilization: 0.4 },
      ],
    });
    usage.report("claude", { windows: [] });
    usage.report("codex", { windows: [{ id: "five_hour", utilization: 0.1 }] });
    expect(usage.snapshot().map((item) => item.provider)).toEqual(["claude", "codex"]);
  });

  it("o snapshot é cópia (mexer nele não muda o estado)", () => {
    const { usage } = tracker();
    usage.report("claude", { windows: [{ id: "five_hour", utilization: 0.5 }] });
    usage.snapshot()[0]!.windows[0]!.utilization = 1;
    expect(usage.snapshot()[0]!.windows[0]!.utilization).toBe(0.5);
  });

  it("uso da conta: autoritativo (substitui as janelas), sempre publica e tira o aviso de velho", () => {
    const { usage, events } = tracker();
    usage.report("claude", { windows: [{ id: "five_hour", utilization: 0.1 }, { id: "seven_day_opus", utilization: 0.3 }] });
    usage.markStale("claude", "Sem conexão com a Anthropic");
    expect(usage.get("claude")?.stale).toEqual({ reason: "Sem conexão com a Anthropic", since: "2026-11-08T12:00:02.000Z" });
    usage.markStale("claude", "Sem conexão com a Anthropic");
    expect(events).toHaveLength(2);

    usage.reportAccount("claude", [{ id: "five_hour", utilization: 0.24, severity: "normal" }, { id: "seven_day", utilization: 0.47 }], "2026-11-08T12:05:00.000Z");
    usage.reportAccount("claude", [{ id: "five_hour", utilization: 0.24, severity: "normal" }, { id: "seven_day", utilization: 0.47 }], "2026-11-08T12:08:00.000Z");
    expect(events).toHaveLength(4);
    const current = usage.get("claude")!;
    expect(current.stale).toBeUndefined();
    expect(current).toMatchObject({ source: "account", fetchedAt: "2026-11-08T12:08:00.000Z" });
    expect(current.windows.map((window) => [window.id, window.utilization])).toEqual([
      ["five_hour", 0.24],
      ["seven_day", 0.47],
    ]);

    // Entre consultas, o rate_limit_event de um agente ainda atualiza (e mantém o fetchedAt).
    usage.report("claude", { windows: [{ id: "five_hour", utilization: 0.3 }] });
    expect(usage.get("claude")).toMatchObject({ source: "cli", fetchedAt: "2026-11-08T12:08:00.000Z" });
    expect(usage.get("claude")!.windows[0]).toEqual({ id: "five_hour", utilization: 0.3 });
  });

  it("falha sem dado nenhum ainda: cria o estado só com o aviso; restore não publica", () => {
    const { usage, events } = tracker();
    usage.markStale("claude", "Login do Claude Code não encontrado neste computador");
    expect(usage.snapshot()).toEqual([
      {
        provider: "claude",
        windows: [],
        stale: { reason: "Login do Claude Code não encontrado neste computador", since: "2026-11-08T12:00:01.000Z" },
        updatedAt: "2026-11-08T12:00:01.000Z",
      },
    ]);
    expect(events).toHaveLength(1);
    const other = tracker();
    other.usage.restore(usage.snapshot());
    expect(other.usage.snapshot()).toEqual(usage.snapshot());
    expect(other.events).toHaveLength(0);
  });

  it("separa conta padrão e contas extras por usageKey, lista por provedor e remove com forget", () => {
    const { usage, events } = tracker();
    usage.reportAccount("claude", [{ id: "five_hour", utilization: 0.2 }], "2026-11-08T12:00:00.000Z");
    usage.reportAccount("claude", [{ id: "five_hour", utilization: 0.7 }], "2026-11-08T12:00:00.000Z", "trabalho");
    usage.report("claude", { windows: [{ id: "seven_day", utilization: 0.4 }] }, "trabalho");
    usage.markStale("gemini", "Login do Antigravity expirado", "google-2");

    expect(usage.get("claude")?.accountId).toBeUndefined();
    expect(usage.get("claude")?.windows[0]?.utilization).toBe(0.2);
    expect(usage.get("claude", "trabalho")).toMatchObject({
      provider: "claude",
      accountId: "trabalho",
      windows: [
        { id: "five_hour", utilization: 0.7 },
        { id: "seven_day", utilization: 0.4 },
      ],
    });
    expect(usage.listAccounts("claude").map((item) => item.accountId ?? "padrao")).toEqual(["padrao", "trabalho"]);
    expect(usage.listAccounts("gemini").map((item) => item.accountId)).toEqual(["google-2"]);
    expect(events.some((event) => event.type === "usage:updated" && event.usage.accountId === "trabalho")).toBe(true);

    const eventsBeforeForget = events.length;
    expect(usage.forget("claude", "trabalho")).toBe(true);
    expect(usage.forget("claude", "trabalho")).toBe(false);
    expect(usage.get("claude", "trabalho")).toBeUndefined();
    expect(usage.get("claude")?.windows[0]?.utilization).toBe(0.2);
    // forget não inventa evento novo no hub; o snapshot reflete a remoção
    expect(events).toHaveLength(eventsBeforeForget);
    expect(usage.snapshot().map((item) => [item.provider, item.accountId])).toEqual([
      ["claude", undefined],
      ["gemini", "google-2"],
    ]);
  });
});
