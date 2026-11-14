import type { ServerEvent } from "@cyno/shared";
import { describe, expect, it, vi } from "vitest";
import { persist, persistOrThrow } from "./persist";

const options = () => {
  const events: ServerEvent[] = [];
  return { events, label: "os projetos", log: { error: vi.fn() }, publish: (event: ServerEvent) => void events.push(event), delaysMs: [0, 0] as const, now: () => new Date("2026-11-11T12:00:00.000Z") };
};

describe("persist", () => {
  it("grava na primeira e não avisa", async () => {
    const o = options();
    const write = vi.fn(async () => undefined);
    expect(await persist(write, o)).toBe(true);
    expect(write).toHaveBeenCalledTimes(1);
    expect(o.events).toEqual([]);
  });

  it("tenta de novo (attempt 0, 1, 2…) e grava sem aviso se alguma der certo", async () => {
    const o = options();
    const attempts: number[] = [];
    const write = vi.fn(async (attempt: number) => {
      attempts.push(attempt);
      if (attempt < 2) throw new Error("EAGAIN");
    });
    expect(await persist(write, o)).toBe(true);
    expect(attempts).toEqual([0, 1, 2]);
    expect(o.events).toEqual([]);
    expect(o.log.error).toHaveBeenCalledTimes(2);
  });

  it("esgotadas as tentativas: loga, publica system:warning e devolve false (nunca lança)", async () => {
    const o = options();
    const write = vi.fn(async () => {
      throw new Error("ENOSPC");
    });
    expect(await persist(write, o)).toBe(false);
    expect(write).toHaveBeenCalledTimes(3);
    expect(o.events).toEqual([{ type: "system:warning", message: expect.stringContaining("ENOSPC"), at: "2026-11-11T12:00:00.000Z" }]);
  });

  it("persistOrThrow lança o erro de verdade (caminhos do usuário)", async () => {
    const o = options();
    await expect(persistOrThrow(async () => Promise.reject(new Error("EIO")), { ...o, fail: (error) => new Error(`não gravou: ${(error as Error).message}`) })).rejects.toThrow("não gravou: EIO");
  });
});
