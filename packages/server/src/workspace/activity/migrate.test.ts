import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ActivityEntry } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { createTask, soloTeam, wsApi } from "../../dev/test-api";
import { useTestApp } from "../../dev/test-app";
import { MIGRATION_MARKER, migrateActivity } from "./migrate";
import { queryActivity } from "./query";
import { activityQuerySchema } from "@cyno/shared";
import { systemActivityDir, workspaceActivityDir } from "./log";

const setupApp = useTestApp();

const readAll = async (dir: string): Promise<ActivityEntry[]> => (await queryActivity(dir, activityQuerySchema.parse({ limit: 500 }))).entries;

describe("migrateActivity", () => {
  it("converte o diário antigo, preenche do estado, apaga o antigo e não roda duas vezes", async () => {
    const { app, dataDir, log, store } = await setupApp();
    const { room, team, agent } = await soloTeam(app);
    const task = await createTask(app, room.id, team.id, "Escrever o post de segunda");
    await log.waitForTask(task.id, "done");
    await store.flush();

    // Diário antigo: UTC, um arquivo global, quase tudo ruído.
    const oldDir = path.join(dataDir, "logs", "system");
    await mkdir(oldDir, { recursive: true });
    const now = Date.now();
    const old = (type: string, category: string, extra: object = {}) => JSON.stringify({ at: new Date(now - 3_600_000).toISOString(), level: "info", category, type, ...extra });
    await writeFile(
      path.join(oldDir, "2026-11-09.jsonl"),
      [
        ...Array.from({ length: 50 }, () => old("sample", "resources", { data: { memAvailableMb: 4000 } })),
        old("tool_call", "mcp", { workspaceId: "principal", agentId: agent.id, data: { tool: "x" } }),
        old("spawn", "terminal", { workspaceId: "principal" }),
        old("finished", "task", { workspaceId: "principal", agentId: agent.id, taskId: task.id, durationMs: 125_000 }),
        old("decided", "approval", { workspaceId: "principal", agentId: agent.id, data: { item: "A-0099", status: "aprovado", type: "post" } }),
        old("start", "server", { data: { previousStop: "crash_or_kill", oomKills: 1, pid: 1 } }),
        old("shutdown", "server", { durationMs: 7_200_000, data: { signal: "SIGTERM" } }),
        "linha quebrada",
      ].join("\n"),
    );
    await writeFile(path.join(oldDir, "heartbeat.json"), "{}");

    const first = await migrateActivity({ dataDir });
    expect(first).toMatchObject({ ran: true, removedFiles: 2 });
    expect(first.migrated).toBe(4);
    expect((await readdir(path.join(dataDir, "logs")).catch(() => [])).length).toBe(0);

    const ws = await readAll(workspaceActivityDir(dataDir, "principal"));
    // A tarefa concluída veio do diário antigo (com duração) e NÃO foi preenchida de novo do estado.
    const finished = ws.filter((entry) => entry.action === "concluida" && entry.refs?.taskId === task.id);
    expect(finished).toHaveLength(1);
    expect(finished[0]).toMatchObject({ data: { migrated: true, durationMs: 125000 } });
    expect(finished[0]!.summary).toMatch(/concluiu .* em 2 min/);
    // A criação não estava no diário: veio do estado, marcada como preenchida.
    expect(ws.find((entry) => entry.action === "criada" && entry.refs?.taskId === task.id)).toMatchObject({ actor: "usuario", data: { backfill: true } });
    expect(ws.find((entry) => entry.action === "aprovada")).toMatchObject({ refs: { forYouId: "A-0099" } });
    expect(ws.some((entry) => /tool_call|sample/.test(entry.summary))).toBe(false);

    const system = await readAll(systemActivityDir(dataDir));
    expect(system.map((entry) => entry.action).sort()).toEqual(["desligado", "iniciado"]);
    expect(system.find((entry) => entry.action === "iniciado")!.summary).toMatch(/sem aviso.*1 processo/);
    expect(await readFile(path.join(systemActivityDir(dataDir), MIGRATION_MARKER), "utf8")).toContain("\"version\": 1");

    // Segunda rodada: marcador presente, nada muda.
    const before = (await readAll(workspaceActivityDir(dataDir, "principal"))).length;
    expect(await migrateActivity({ dataDir })).toMatchObject({ ran: false });
    expect((await readAll(workspaceActivityDir(dataDir, "principal"))).length).toBe(before);
  });

  it("rodada interrompida (sem marcador) é refeita sem duplicar", async () => {
    const { app, dataDir, log, store } = await setupApp();
    const { room, team } = await soloTeam(app);
    const task = await createTask(app, room.id, team.id, "Revisar o texto");
    await log.waitForTask(task.id, "done");
    await store.flush();
    await migrateActivity({ dataDir });
    const dir = workspaceActivityDir(dataDir, "principal");
    const count = (await readAll(dir)).length;
    expect(count).toBeGreaterThan(1);
    await (await import("node:fs/promises")).rm(path.join(systemActivityDir(dataDir), MIGRATION_MARKER));
    await migrateActivity({ dataDir });
    expect((await readAll(dir)).length).toBe(count);
    expect(wsApi()).toBe("/api/w/principal");
  });

  it("DATA_DIR copiado sem o marcador: o que já foi gravado ao vivo não é recuperado de novo (rodar duas vezes dá o mesmo resultado)", async () => {
    const { app, dataDir, log, store } = await setupApp();
    const { room, team } = await soloTeam(app);
    const task = await createTask(app, room.id, team.id, "Fazer a arte do post");
    await log.waitForTask(task.id, "done");
    await store.flush();
    const dir = workspaceActivityDir(dataDir, "principal");
    const fs = await import("node:fs/promises");
    await migrateActivity({ dataDir });
    // Simula o gravador ao vivo: as mesmas entradas, mas sem a etiqueta de "recuperado do histórico".
    for (const name of await readdir(dir)) {
      const text = await readFile(path.join(dir, name), "utf8");
      const live = text
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const entry = JSON.parse(line) as ActivityEntry;
          delete entry.data?.backfill;
          delete entry.data?.migrated;
          return JSON.stringify(entry);
        });
      await writeFile(path.join(dir, name), `${live.join("\n")}\n`, "utf8");
    }
    const count = (await readAll(dir)).length;
    expect(count).toBeGreaterThan(1);
    await fs.rm(path.join(systemActivityDir(dataDir), MIGRATION_MARKER));
    await migrateActivity({ dataDir });
    expect((await readAll(dir)).length).toBe(count);
    await fs.rm(path.join(systemActivityDir(dataDir), MIGRATION_MARKER));
    await migrateActivity({ dataDir });
    expect((await readAll(dir)).length).toBe(count);
  });
});
