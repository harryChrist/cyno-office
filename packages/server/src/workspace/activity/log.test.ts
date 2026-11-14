import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { useTempDirs } from "../../dev/test-utils";
import { ActivityLog, activity, setActivityLog, systemActivityDir, workspaceActivityDir } from "./log";
import { activityDay, spIso } from "./time";

const tempDir = useTempDirs();

const lines = async (file: string) => (await readFile(file, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);

describe("tempo de São Paulo", () => {
  it("escreve o ISO com o deslocamento -03:00 e o dia pelo fuso de São Paulo", () => {
    const ms = Date.parse("2026-11-10T02:30:15.123Z"); // 23:30 do dia 9 em São Paulo
    expect(spIso(ms)).toBe("2026-11-09T23:30:15.123-03:00");
    expect(activityDay(ms)).toBe("2026-11-09");
    expect(Date.parse(spIso(ms))).toBe(ms);
  });
});

describe("ActivityLog", () => {
  it("grava por workspace e no servidor, um arquivo por dia de São Paulo", async () => {
    const dataDir = await tempDir();
    const log = new ActivityLog({ dataDir });
    log.record({ at: "2026-11-10T02:30:00Z", workspaceId: "principal", category: "tarefa", action: "criada", actor: "usuario", summary: "Você pediu “X”", refs: { taskId: "t1" } });
    log.record({ at: "2026-11-10T15:00:00Z", category: "sistema", action: "iniciado", actor: "sistema", summary: "Servidor iniciado" });
    await log.flush();
    const ws = await lines(path.join(workspaceActivityDir(dataDir, "principal"), "2026-11-09.jsonl"));
    expect(ws).toHaveLength(1);
    expect(ws[0]).toMatchObject({ workspaceId: "principal", category: "tarefa", action: "criada", actor: "usuario", at: "2026-11-09T23:30:00.000-03:00", refs: { taskId: "t1" } });
    expect(typeof ws[0]!.id).toBe("string");
    const system = await lines(path.join(systemActivityDir(dataDir), "2026-11-10.jsonl"));
    expect(system[0]).toMatchObject({ category: "sistema", action: "iniciado" });
    expect(system[0]).not.toHaveProperty("workspaceId");
  });

  it("flushSync grava na hora (processo parando) e ignora entradas inválidas", async () => {
    const dataDir = await tempDir();
    const log = new ActivityLog({ dataDir, now: () => new Date("2026-11-10T12:00:00Z") });
    log.record({ category: "sistema", action: "desligado", actor: "sistema", summary: "Servidor desligado" });
    expect(log.record({ category: "nao-existe" as never, action: "x", actor: "a", summary: "ruim" })).toBeUndefined();
    expect(log.record({ category: "tarefa", action: "", actor: "a", summary: "sem ação" })).toBeUndefined();
    log.flushSync();
    expect(await lines(path.join(systemActivityDir(dataDir), "2026-11-10.jsonl"))).toHaveLength(1);
  });

  it("não deixa segredo nem texto enorme passar", async () => {
    const dataDir = await tempDir();
    const log = new ActivityLog({ dataDir });
    const entry = log.record({
      category: "sistema",
      action: "teste",
      actor: "sistema",
      summary: `Falhou ${"x".repeat(1000)}`,
      refs: { url: "https://site.com/p?token=abc123456789" },
      data: { password: "senha", tokens: 120, error: "Bearer abcdefghijklmnop" },
    });
    expect(entry!.summary.length).toBeLessThanOrEqual(400);
    expect(entry!.refs!.url).toContain("[redacted]");
    expect(entry!.data).toMatchObject({ password: "[redacted]", tokens: 120, error: "Bearer [redacted]" });
  });

  it("silencia repetições com a mesma chave dentro da janela (alertas)", () => {
    let now = Date.parse("2026-11-10T12:00:00Z");
    const log = new ActivityLog({ dataDir: "/nunca-grava", now: () => new Date(now), flushMs: 1_000_000 });
    const alert = () => log.record({ category: "sistema", action: "memoria_baixa", actor: "sistema", summary: "Pouca memória" }, { throttle: { key: "mem", ms: 3_600_000 } });
    expect(alert()).toBeDefined();
    now += 59 * 60_000;
    expect(alert()).toBeUndefined();
    now += 2 * 60_000;
    expect(alert()).toBeDefined();
  });

  it("avisa quem escuta e não cai com ouvinte quebrado", () => {
    const log = new ActivityLog({ dataDir: "/nunca-grava", flushMs: 1_000_000 });
    const seen: string[] = [];
    log.onAppend(() => {
      throw new Error("quebrado");
    });
    log.onAppend((entry) => seen.push(entry.action));
    log.record({ category: "midia", action: "criada", actor: "usuario", summary: "Mídia" });
    expect(seen).toEqual(["criada"]);
  });

  it("disco falhando: conta as perdidas e segue sem lançar", async () => {
    const warnings: object[] = [];
    const log = new ActivityLog({
      dataDir: "/x",
      logger: { warn: (obj) => warnings.push(obj), error: () => undefined },
      fs: { mkdir: async () => undefined, appendFile: async () => Promise.reject(new Error("disco cheio")) },
    });
    log.record({ category: "midia", action: "criada", actor: "usuario", summary: "Mídia" });
    await log.flush();
    expect(log.dropped).toBe(1);
    expect(warnings).toHaveLength(1);
  });

  it("activity() sem Atividade ligada não faz nada", () => {
    setActivityLog(undefined);
    expect(() => activity({ category: "sistema", action: "x", actor: "sistema", summary: "nada" })).not.toThrow();
  });
});
