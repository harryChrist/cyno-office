import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { useTempDirs } from "../../dev/test-utils";
import { IpGuard } from "./ip-guard";

const MIN = 60_000;
const HOUR = 60 * MIN;
const tempDir = useTempDirs();

/** Erra `times` vezes seguidas; devolve os segundos do bloqueio causado (0 se não bloqueou). */
function failTimes(guard: IpGuard, ip: string, times: number): number {
  let blocked = 0;
  for (let i = 0; i < times; i++) blocked = guard.fail(ip, "senha") || blocked;
  return blocked;
}

describe("bloqueio temporário por IP", () => {
  it("5 falhas bloqueiam por 15 min; outro IP segue livre; passado o tempo, libera", () => {
    let now = 0;
    const guard = new IpGuard(null, () => now);
    expect(failTimes(guard, "1.1.1.1", 4)).toBe(0);
    expect(guard.retryAfterSeconds("1.1.1.1")).toBe(0);
    expect(guard.fail("1.1.1.1", "senha")).toBe(15 * 60);
    expect(guard.retryAfterSeconds("1.1.1.1")).toBe(15 * 60);
    expect(guard.retryAfterSeconds("2.2.2.2")).toBe(0);
    now += 15 * MIN - 1000;
    expect(guard.retryAfterSeconds("1.1.1.1")).toBe(1);
    now += 1000;
    expect(guard.retryAfterSeconds("1.1.1.1")).toBe(0);
  });

  it("cada novo bloqueio dentro de 24 h dobra o tempo (15 min, 30, 1 h, 2 h…) e para no teto", () => {
    let now = 0;
    const guard = new IpGuard(null, () => now);
    const durations: number[] = [];
    // Cada rodada: erra 5 vezes assim que o bloqueio anterior acaba.
    for (let round = 0; round < 7; round++) {
      durations.push(failTimes(guard, "1.1.1.1", 5) / 60);
      now += guard.retryAfterSeconds("1.1.1.1") * 1000 + 1;
    }
    expect(durations).toEqual([15, 30, 60, 120, 240, 480, 960]);

    const capped = new IpGuard(null, () => now, undefined, { maxBlockMs: 2 * HOUR });
    const cappedDurations: number[] = [];
    for (let round = 0; round < 5; round++) {
      cappedDurations.push(failTimes(capped, "2.2.2.2", 5) / 60);
      now += capped.retryAfterSeconds("2.2.2.2") * 1000 + 1;
    }
    expect(cappedDurations).toEqual([15, 30, 60, 120, 120]);
  });

  it("depois de 24 h sem novo bloqueio, a escalada volta ao começo", () => {
    let now = 0;
    const guard = new IpGuard(null, () => now);
    expect(failTimes(guard, "1.1.1.1", 5)).toBe(15 * 60);
    now += 15 * MIN + 1;
    expect(failTimes(guard, "1.1.1.1", 5)).toBe(30 * 60);
    now += 30 * MIN + 24 * HOUR + 1;
    expect(failTimes(guard, "1.1.1.1", 5)).toBe(15 * 60);
  });

  it("acerto zera as falhas, não o histórico de bloqueios", () => {
    let now = 0;
    const guard = new IpGuard(null, () => now);
    failTimes(guard, "1.1.1.1", 4);
    guard.success("1.1.1.1");
    expect(failTimes(guard, "1.1.1.1", 4)).toBe(0);
    guard.success("1.1.1.1");
    expect(failTimes(guard, "1.1.1.1", 5)).toBe(15 * 60);
    now += 15 * MIN + 1;
    guard.success("1.1.1.1");
    // O histórico continua: o segundo bloqueio já é de 30 min.
    expect(failTimes(guard, "1.1.1.1", 5)).toBe(30 * 60);
  });

  it("falhas antigas (fora da janela) não somam", () => {
    let now = 0;
    const guard = new IpGuard(null, () => now);
    failTimes(guard, "1.1.1.1", 4);
    now += 31 * MIN;
    expect(guard.fail("1.1.1.1", "senha")).toBe(0);
  });

  it("desbloquear libera o IP e zera o histórico dele; lista bloqueios e falhas recentes", () => {
    const now = 1_000_000;
    const guard = new IpGuard(null, () => now);
    failTimes(guard, "1.1.1.1", 5);
    guard.fail("3.3.3.3", "codigo");
    expect(guard.blocks()).toEqual([{ ip: "1.1.1.1", until: now + 15 * MIN, attempts: 5 }]);
    expect(guard.failures()[0]).toEqual({ ip: "3.3.3.3", at: now, kind: "codigo" });
    expect(guard.failures()).toHaveLength(6);
    expect(guard.unblock("1.1.1.1")).toBe(true);
    expect(guard.retryAfterSeconds("1.1.1.1")).toBe(0);
    expect(guard.blocks()).toEqual([]);
    expect(guard.unblock("9.9.9.9")).toBe(false);
    expect(failTimes(guard, "1.1.1.1", 5)).toBe(15 * 60);
  });

  it("não há freio global: falhas de muitos IPs não trancam ninguém, só avisam no log", () => {
    const now = 0;
    const logs: string[] = [];
    const guard = new IpGuard(null, () => now, (_level, _data, message) => logs.push(message));
    for (let i = 0; i < 40; i++) guard.fail(`10.0.0.${i}`, "senha");
    expect(guard.retryAfterSeconds("10.0.1.1")).toBe(0);
    expect(guard.blocks()).toEqual([]);
    expect(logs.filter((message) => message.includes("possível ataque distribuído"))).toHaveLength(1);
  });

  it("os bloqueios sobrevivem a reiniciar (auth-blocks.json, 0600)", async () => {
    const file = path.join(await tempDir(), "auth-blocks.json");
    let now = 5_000_000;
    const first = new IpGuard(file, () => now);
    failTimes(first, "1.1.1.1", 5);
    await first.flush();
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readFile(file, "utf8")).not.toContain("senha-");

    const second = new IpGuard(file, () => now);
    expect(second.retryAfterSeconds("1.1.1.1")).toBe(15 * 60);
    expect(second.failures()).toHaveLength(5);
    // O histórico de escalada também volta: o próximo bloqueio dobra.
    now += 15 * MIN + 1;
    expect(failTimes(second, "1.1.1.1", 5)).toBe(30 * 60);
    await second.flush();

    second.unblock("1.1.1.1");
    await second.flush();
    expect(new IpGuard(file, () => now).retryAfterSeconds("1.1.1.1")).toBe(0);
  });

  it("arquivo ilegível: começa limpo, sem quebrar", async () => {
    const dir = await tempDir();
    const file = path.join(dir, "auth-blocks.json");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(file, "{ isso não é json");
    expect(new IpGuard(file).blocks()).toEqual([]);
  });
});
