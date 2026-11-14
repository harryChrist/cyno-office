import { describe, expect, it } from "vitest";
import { WriteQueue } from "./write-queue";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("WriteQueue", () => {
  it("executa uma tarefa por vez, na ordem", async () => {
    const queue = new WriteQueue();
    const log: string[] = [];
    const task = (name: string, ms: number) => async () => {
      log.push(`início ${name}`);
      await delay(ms);
      log.push(`fim ${name}`);
    };
    await Promise.all([queue.enqueue(task("a", 20)), queue.enqueue(task("b", 1))]);
    expect(log).toEqual(["início a", "fim a", "início b", "fim b"]);
  });

  it("continua funcionando depois de uma falha", async () => {
    const queue = new WriteQueue();
    await expect(queue.enqueue(async () => Promise.reject(new Error("disco cheio")))).rejects.toThrow("disco cheio");
    let ran = false;
    await queue.enqueue(async () => {
      ran = true;
    });
    await queue.idle();
    expect(ran).toBe(true);
  });
});
