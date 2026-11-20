import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FREEBUFF_NO_WALLET_KEY, type FreebuffUsageDetail, type UsageWindow } from "@cyno/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EngineAvailability } from "../../engines/usage/availability";
import { SubscriptionUsageTracker } from "../../engines/usage/subscription-usage";
import { UsageGuard, type UsageGuardDeps } from "./service";

let dir: string;
let clock: number;
const now = () => new Date(clock);
const at = (minutes: number) => new Date(clock + minutes * 60_000).toISOString();

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "usage-guard-"));
  clock = Date.parse("2026-11-19T12:00:00Z");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const ENABLED_KEYS = ["claude:five_hour", "claude:seven_day", "freebuff:daily_hours"];

function setup(extra: Partial<UsageGuardDeps> = {}, enabledRules = true) {
  const usage = new SubscriptionUsageTracker(now);
  const ref: { guard?: UsageGuard } = {};
  const availability = new EngineAvailability({ usage, now, paused: (engine, model) => ref.guard?.blockFor(engine, model) });
  const raised: { ref: string; level: string; text: string }[] = [];
  const cleared: string[] = [];
  const notifier = { paused: vi.fn(), released: vi.fn() };
  const refresh = vi.fn(async () => undefined);
  const onChange = vi.fn(() => availability.notify());
  const open = async () => {
    // As regras nascem desligadas: os cenários daqui partem de um dono que já ligou as janelas (salvo `rules: "padrão"`).
    const file = path.join(dir, "usage-guard.json");
    if (enabledRules && !(await access(file).then(() => true, () => false))) {
      await writeFile(file, JSON.stringify({ settings: { rules: Object.fromEntries(ENABLED_KEYS.map((key) => [key, { enabled: true }])) }, pauses: [], snoozed: {} }));
    }
    const guard = await UsageGuard.open({
      file: path.join(dir, "usage-guard.json"),
      now,
      usage,
      refresh,
      onChange,
      attention: { raiseUsagePause: (input) => void raised.push(input), clearUsagePause: (ref) => void cleared.push(ref) },
      notifier,
      log: { error: vi.fn(), info: vi.fn() },
      ...extra,
    });
    ref.guard = guard;
    return guard;
  };
  return { usage, availability, raised, cleared, notifier, refresh, onChange, open };
}

const five = (utilization: number, resetsAt = at(120)): UsageWindow[] => [{ id: "five_hour", utilization, resetsAt }];

describe("UsageGuard", () => {
  it("pausa o motor ao bater 90%: barra pela disponibilidade, avisa o dono e manda o recado aos agentes; outros motores seguem", async () => {
    const { usage, availability, raised, notifier, open } = setup();
    const guard = await open();
    usage.reportAccount("claude", five(0.5));
    await guard.evaluate();
    expect(availability.block("claude")).toBeUndefined();

    usage.reportAccount("claude", five(0.91));
    await guard.evaluate();
    expect(availability.block("claude")).toEqual({ reason: "paused", label: "5 h", percent: 90, resetsAt: at(120) });
    expect(availability.block("gemini")).toBeUndefined();
    expect(availability.block("freebuff")).toBeUndefined();
    expect(notifier.paused).toHaveBeenCalledTimes(1);
    expect(notifier.paused.mock.calls[0]![1]).toContain("NÃO comece a próxima tarefa");
    expect(raised.find((alert) => alert.ref === "pausa-claude-five_hour")?.text).toMatch(/Claude Code: 5 h em 91%, trabalho pausado · volta às/);
    // uma leitura nova, ainda alta, não repete o recado
    usage.reportAccount("claude", five(0.93));
    await guard.evaluate();
    expect(notifier.paused).toHaveBeenCalledTimes(1);
    await guard.close();
  });

  it("instalação nova: nada vem ligado, então nada pausa; a tela mostra a regra desligada com 90%, e ligar passa a valer", async () => {
    const { usage, availability, notifier, raised, open } = setup({}, false);
    const guard = await open();
    usage.reportAccount("claude", five(0.99));
    await guard.evaluate();
    expect(availability.block("claude")).toBeUndefined();
    expect(notifier.paused).not.toHaveBeenCalled();
    expect(raised).toEqual([]);
    expect(guard.view().rules.find((rule) => rule.key === "claude:five_hour")).toMatchObject({ enabled: false, percent: 90, paused: false });
    const view = await guard.setRule({ key: "claude:five_hour", enabled: true });
    expect(view.rules.find((rule) => rule.key === "claude:five_hour")).toMatchObject({ enabled: true, percent: 90, paused: true });
    expect(availability.block("claude")).toMatchObject({ reason: "paused" });
    await guard.close();
  });

  it("a pausa sobrevive a reinício (disco) e volta a barrar", async () => {
    const first = setup();
    const guard = await first.open();
    first.usage.reportAccount("claude", five(0.95));
    await guard.evaluate();
    await guard.close();
    expect(JSON.parse(await readFile(path.join(dir, "usage-guard.json"), "utf8")).pauses).toHaveLength(1);

    const second = setup();
    const reopened = await second.open();
    expect(reopened.blockFor("claude")).toMatchObject({ reason: "paused", resetsAt: at(120) });
    reopened.start();
    // o aviso da pausa reaparece depois do reinício
    expect(second.raised.some((alert) => alert.ref === "pausa-claude-five_hour")).toBe(true);
    await reopened.close();
  });

  it("no reset: consulta o uso de novo, só libera se o percentual caiu, avisa o dono e o Maestro", async () => {
    vi.useFakeTimers({ now: clock });
    try {
      const { usage, raised, cleared, notifier, refresh, onChange, open } = setup({ tickMs: 60_000 });
      const guard = await open();
      usage.reportAccount("claude", five(0.95));
      await guard.evaluate();
      guard.start();
      expect(onChange).toHaveBeenCalled();

      // chega a hora, mas a leitura ainda é alta (a janela nova ainda não foi lida): segue pausado
      clock += 125 * 60_000;
      vi.setSystemTime(clock);
      usage.reportAccount("claude", five(0.96, at(300)));
      await vi.advanceTimersByTimeAsync(60_000);
      expect(refresh).toHaveBeenCalledWith("claude");
      expect(guard.blockFor("claude")).toBeDefined();
      expect(notifier.released).not.toHaveBeenCalled();

      // a consulta nova mostra a janela zerada
      usage.reportAccount("claude", five(0.03, at(300)));
      await vi.advanceTimersByTimeAsync(1000);
      expect(guard.blockFor("claude")).toBeUndefined();
      expect(notifier.released).toHaveBeenCalledTimes(1);
      expect(notifier.released.mock.calls[0]![1]).toContain("retomar de onde pararam");
      expect(cleared).toContain("pausa-claude-five_hour");
      expect(raised.some((alert) => alert.ref.startsWith("liberado-claude-five_hour") && alert.level === "info")).toBe(true);
      await guard.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("liberar na mão: tira a pausa e não pausa de novo na hora, mesmo com o uso ainda alto", async () => {
    const { usage, notifier, open } = setup();
    const guard = await open();
    usage.reportAccount("claude", five(0.95));
    await guard.evaluate();
    const view = await guard.release("claude:five_hour");
    expect(view.rules.find((rule) => rule.key === "claude:five_hour")?.paused).toBe(false);
    expect(notifier.released).toHaveBeenCalledTimes(1);
    usage.reportAccount("claude", five(0.97));
    await guard.evaluate();
    expect(guard.blockFor("claude")).toBeUndefined();
    // o uso cai de verdade e depois sobe de novo: aí pausa outra vez
    usage.reportAccount("claude", five(0.4));
    await guard.evaluate();
    usage.reportAccount("claude", five(0.92));
    await guard.evaluate();
    expect(guard.blockFor("claude")).toBeDefined();
    await guard.close();
  });

  it("liberada na mão: a tela diz até quando; mexer na regra rearma a pausa; subir o percentual solta como 'regra alterada'", async () => {
    const { usage, notifier, open } = setup();
    const guard = await open();
    usage.reportAccount("claude", five(0.95));
    await guard.evaluate();
    const released = await guard.release("claude:five_hour");
    expect(released.rules.find((rule) => rule.key === "claude:five_hour")?.releasedUntil).toBeDefined();
    // O dono muda o percentual: é uma decisão nova, a folga acaba e a regra pausa de novo.
    let view = await guard.setRule({ key: "claude:five_hour", percent: 80 });
    let row = view.rules.find((rule) => rule.key === "claude:five_hour");
    expect(row?.paused).toBe(true);
    expect(row?.releasedUntil).toBeUndefined();
    // Subir o percentual acima do uso solta a pausa, e o recado diz que foi a regra (o limite não voltou).
    view = await guard.setRule({ key: "claude:five_hour", percent: 100 });
    row = view.rules.find((rule) => rule.key === "claude:five_hour");
    expect(row?.paused).toBe(false);
    expect(notifier.released.mock.calls.at(-1)![1]).toContain("regra alterada");
    await guard.close();
  });

  it("a chave e o percentual por janela: desligar libera; subir o percentual mantém solto; a tela mostra o estado", async () => {
    const { usage, open } = setup();
    const guard = await open();
    usage.reportAccount("claude", [...five(0.95), { id: "seven_day", utilization: 0.5, resetsAt: at(5000) }]);
    await guard.evaluate();
    let view = guard.view();
    expect(view.rules.map((rule) => [rule.key, rule.enabled, rule.percent, rule.paused])).toEqual([
      ["claude:five_hour", true, 90, true],
      ["claude:seven_day", true, 90, false],
    ]);
    expect(view.unsupported.map((item) => item.engine)).toContain("codex");
    view = await guard.setRule({ key: "claude:five_hour", enabled: false });
    expect(view.rules[0]).toMatchObject({ enabled: false, paused: false });
    view = await guard.setRule({ key: "claude:seven_day", percent: 50 });
    expect(view.rules[1]).toMatchObject({ percent: 50, paused: true });
    await guard.close();
  });

  it("Freebuff: um aviso por virada da cota do dia para a carteira; a chave 'não gastar a carteira' pausa", async () => {
    const { usage, raised, cleared, open } = setup();
    const guard = await open();
    const detail = (remaining: number, wallet: number): FreebuffUsageDetail => ({
      settings: { model: "m", effort: "high", maxOpenHours: 1 },
      hours: { total: 21, remaining, wallet, resetsAt: at(300), openedSince: 0 },
      sessions: [],
    });
    usage.reportFreebuff(detail(5, 12));
    await guard.evaluate();
    expect(raised.filter((alert) => alert.ref.startsWith("carteira"))).toHaveLength(0);
    usage.reportFreebuff(detail(0, 12));
    await guard.evaluate();
    usage.reportFreebuff(detail(0, 11));
    await guard.evaluate();
    const wallet = raised.filter((alert) => alert.ref.startsWith("carteira"));
    expect(wallet).toHaveLength(1);
    expect(wallet[0]!.text).toBe("Freebuff: a cota do dia acabou, agora gasta da carteira (12 h)");
    expect(guard.view().freebuff).toEqual({ wallet: 11, usingWallet: true });
    // a cota do dia volta: o estado da carteira some
    usage.reportFreebuff({ ...detail(21, 11), hours: { total: 21, remaining: 21, wallet: 11, resetsAt: at(1500), openedSince: 0 } });
    await guard.evaluate();
    expect(cleared.some((ref) => ref.startsWith("carteira"))).toBe(true);
    expect(guard.view().freebuff?.usingWallet).toBe(false);
    // chave separada, desligada por padrão
    expect(guard.view().rules.find((rule) => rule.key === FREEBUFF_NO_WALLET_KEY)).toMatchObject({ enabled: false, kind: "no_wallet" });
    await guard.setRule({ key: "freebuff:daily_hours", enabled: false });
    await guard.setRule({ key: FREEBUFF_NO_WALLET_KEY, enabled: true });
    usage.reportFreebuff(detail(0, 11));
    await guard.evaluate();
    expect(guard.blockFor("freebuff")).toMatchObject({ reason: "paused" });
    await guard.close();
  });
});
