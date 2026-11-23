import { describe, expect, it } from "vitest";
import { createQueryGate } from "./query-gate";

describe("createQueryGate", () => {
  it("limita as consultas simultâneas e mantém a ordem da fila", async () => {
    const gate = createQueryGate(2);
    let running = 0;
    let peak = 0;
    const order: number[] = [];
    const task = (n: number) =>
      gate(async () => {
        running += 1;
        peak = Math.max(peak, running);
        order.push(n);
        await new Promise((resolve) => setTimeout(resolve, 5));
        running -= 1;
        return n;
      });
    const results = await Promise.all([1, 2, 3, 4, 5, 6].map(task));
    expect(results).toEqual([1, 2, 3, 4, 5, 6]);
    expect(peak).toBe(2);
    expect(order).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("uma consulta que falha libera a vaga e não trava as outras", async () => {
    const gate = createQueryGate(1);
    await expect(gate(async () => Promise.reject(new Error("falhou")))).rejects.toThrow("falhou");
    await expect(gate(async () => "ok")).resolves.toBe("ok");
  });
});
