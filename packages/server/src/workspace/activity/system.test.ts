import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ActivityEntry } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { useTempDirs } from "../../dev/test-utils";
import { bindTerminal, trackTerminalExit, trackTerminalFailure, trackTerminalSpawn, trackedProcesses } from "../../platform/activity/hooks";
import { previousStopOf, ServerLifecycle } from "../../platform/activity/lifecycle";
import { ActivityLog, setActivityLog, systemActivityDir } from "./log";
import { ResourceSampler } from "../../platform/activity/sampler";

const tempDir = useTempDirs();

function capture(dataDir: string, now = () => new Date("2026-11-10T15:00:00Z")) {
  const entries: ActivityEntry[] = [];
  const log = new ActivityLog({ dataDir, now, flushMs: 1_000_000 });
  log.onAppend((entry) => entries.push(entry));
  return { log, entries };
}

describe("ServerLifecycle", () => {
  it("registra o boot com o palpite da parada anterior e o desligamento limpo (que o próximo boot enxerga)", async () => {
    const dataDir = await tempDir();
    const dir = systemActivityDir(dataDir);
    const first = capture(dataDir);
    const lifecycle = new ServerLifecycle({ log: first.log, dir, intervalMs: 0, processHooks: false });
    await lifecycle.start({ port: 3001 });
    await lifecycle.markClean("SIGTERM");
    expect(first.entries.map((entry) => entry.action)).toEqual(["iniciado", "desligado"]);
    expect(first.entries[1]!.summary).toContain("SIGTERM");

    const second = capture(dataDir);
    await new ServerLifecycle({ log: second.log, dir, intervalMs: 0, processHooks: false }).start();
    expect(second.entries[0]).toMatchObject({ action: "iniciado", data: { previousStop: "clean" } });
    expect(second.entries[0]!.summary).toBe("Servidor iniciado (a parada anterior foi normal)");
  });

  it("batimento sem marca de parada = queda sem aviso; erro fatal grava a queda", async () => {
    const dataDir = await tempDir();
    const dir = systemActivityDir(dataDir);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "heartbeat.json"), JSON.stringify({ pid: 9, startedAt: "2026-11-10T10:00:00Z", at: "2026-11-10T14:59:00Z" }));
    const boot = capture(dataDir);
    const lifecycle = new ServerLifecycle({ log: boot.log, dir, intervalMs: 0, processHooks: false });
    await lifecycle.start();
    expect(boot.entries[0]!.summary).toMatch(/encerrado sem aviso/);
    lifecycle.onFatal(new Error("estourou"), "uncaughtException");
    expect(boot.entries.at(-1)).toMatchObject({ action: "erro_fatal", summary: "Um erro inesperado derrubou o servidor: estourou" });
    const next = JSON.parse(await readFile(path.join(dir, "heartbeat.json"), "utf8")) as { crash?: { message: string } };
    expect(next.crash?.message).toBe("estourou");
    expect(previousStopOf(next as never, {}, new Date()).previousStop).toBe("crash");
  });
});

describe("ResourceSampler", () => {
  async function fakeProc(procDir: string, availableKb: number, totalKb = 8_000_000): Promise<void> {
    await mkdir(procDir, { recursive: true });
    await writeFile(path.join(procDir, "meminfo"), `MemTotal: ${totalKb} kB\nMemAvailable: ${availableKb} kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n`);
  }

  it("só avisa ao CRUZAR o limite (nunca grava a amostra) e escreve uma linha por hora nas métricas", async () => {
    const dataDir = await tempDir();
    const procDir = path.join(dataDir, "proc");
    const { log, entries } = capture(dataDir);
    const sampler = new ResourceSampler({ activity: log, procDir, metricsDir: dataDir, pid: 999_999, processes: () => [], loadavg: () => [0, 0, 0] });
    await fakeProc(procDir, 4_000_000);
    await sampler.tick();
    await sampler.tick();
    await fakeProc(procDir, 400_000); // 5%: abaixo de 15%
    await sampler.tick();
    await sampler.tick(); // continua baixa: sem novo aviso
    await fakeProc(procDir, 4_000_000);
    await sampler.tick();
    expect(entries.map((entry) => entry.action)).toEqual(["memoria_baixa"]);
    expect(entries[0]!.summary).toMatch(/Pouca memória livre/);
    await sampler.flushMetrics();
    const files = (await readdir(dataDir)).filter((name) => name.startsWith("metrics-"));
    expect(files).toHaveLength(1);
    const rows = (await readFile(path.join(dataDir, files[0]!), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { samples: number; memAvailableMb: { min: number } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ samples: 5 });
    expect(rows[0]!.memAvailableMb.min).toBeLessThan(500);
  });
});

describe("hooks dos terminais", () => {
  it("só queda inesperada e falhas viram atividade; subir e sair normalmente, não", () => {
    const { log, entries } = capture("/nunca-grava");
    setActivityLog(log);
    try {
      const terminal = {};
      bindTerminal(terminal, { workspaceId: "principal", agentId: "eco", engine: "claude", agentName: () => "ECO" });
      trackTerminalSpawn(terminal, { agentId: "eco", pid: 4242 });
      expect(trackedProcesses().some((proc) => proc.pid === 4242 && proc.agentId === "eco")).toBe(true);
      trackTerminalExit(terminal, { code: 0, expected: true });
      expect(trackedProcesses().some((proc) => proc.pid === 4242)).toBe(false);
      expect(entries).toHaveLength(0);
      trackTerminalSpawn(terminal, { agentId: "eco", pid: 4243 });
      trackTerminalExit(terminal, { code: 1, expected: false, error: "segfault" });
      trackTerminalFailure(terminal, "gave_up", { failures: 3, error: "sem binário" });
      expect(entries.map((entry) => [entry.category, entry.action, entry.workspaceId])).toEqual([
        ["agente", "terminal_caiu", "principal"],
        ["agente", "terminal_desistiu", "principal"],
      ]);
      expect(entries[0]!.summary).toBe("O terminal de ECO caiu: segfault");
    } finally {
      setActivityLog(undefined);
    }
  });
});
