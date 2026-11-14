import type { ActivityResponse, ActivitySummary, ActivitySystemResponse } from "@cyno/shared";
import { afterEach, describe, expect, it } from "vitest";
import { ActivityLog, activeActivity, setActivityLog } from "../workspace/activity/log";
import { seedDataDir } from "../workspace/office/seed";
import { call, createTask, soloTeam, wsApi } from "../dev/test-api";
import { useTestApp } from "../dev/test-app";
import { useTempDirs } from "../dev/test-utils";

// Ordem dos ganchos (pilha): fecha o app, depois a Atividade e só então apaga a pasta temporária.
const tempDir = useTempDirs();
afterEach(async () => {
  await activeActivity()?.close();
  setActivityLog(undefined);
});
const setupApp = useTestApp();

async function appWithActivity() {
  const dataDir = await tempDir();
  await seedDataDir(dataDir);
  const activity = new ActivityLog({ dataDir });
  setActivityLog(activity);
  const test = await setupApp({ dataDir });
  return { ...test, activity };
}

describe("API: atividade", () => {
  it("o que acontece no workspace vira entrada (lista, filtros, resumo) e vai ao vivo pelo hub", async () => {
    const { app, log, activity } = await appWithActivity();
    const { room, team } = await soloTeam(app);
    const task = await createTask(app, room.id, team.id, "Escrever o post de segunda");
    await log.waitForTask(task.id, "done");
    const live = await log.waitFor((event) => event.type === "activity:appended" && event.entry.action === "concluida");
    expect(live).toMatchObject({ type: "activity:appended", entry: { workspaceId: "principal", category: "tarefa" } });

    const all = await call<ActivityResponse>(app, "GET", `${wsApi()}/activity`);
    const actions = all.entries.map((entry) => `${entry.category}.${entry.action}`);
    expect(actions).toEqual(expect.arrayContaining(["agente.criado", "tarefa.criada", "tarefa.iniciada", "tarefa.concluida"]));
    expect(all.entries[0]!.at).toMatch(/-03:00$/);

    const onlyTasks = await call<ActivityResponse>(app, "GET", `${wsApi()}/activity?category=tarefa&q=post`);
    expect(onlyTasks.entries.length).toBeGreaterThan(0);
    expect(onlyTasks.entries.every((entry) => entry.category === "tarefa")).toBe(true);
    expect((await call<ActivityResponse>(app, "GET", `${wsApi()}/activity?category=plano`)).entries).toEqual([]);

    const summary = await call<ActivitySummary>(app, "GET", `${wsApi()}/activity/summary`);
    expect(summary).toMatchObject({ tasksDone: 1, tasksFailed: 0 });
    expect(summary.byCategory.tarefa).toBeGreaterThanOrEqual(3);
    expect((await app.inject({ method: "GET", url: `${wsApi()}/activity/summary?from=2026-11-10&to=2026-11-01` })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: `${wsApi()}/activity?category=inventada` })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/w/nao-existe/activity" })).statusCode).toBe(404);
    await activity.flush();
  });

  it("apagar um workspace não deixa a pasta de Atividade ressurgir, e o id volta a ser livre", async () => {
    const { app, activity, dataDir } = await appWithActivity();
    const created = await call<{ id: string }>(app, "POST", "/api/workspaces", { name: "Efemero" });
    activity.record({ workspaceId: created.id, category: "sistema", action: "teste", actor: "sistema", summary: "Algo na fila" });
    await call(app, "DELETE", `/api/workspaces/${created.id}`);
    activity.record({ workspaceId: created.id, category: "sistema", action: "tarde", actor: "sistema", summary: "Depois de apagar" });
    await activity.flush();
    const { existsSync } = await import("node:fs");
    expect(existsSync(`${dataDir}/workspaces/${created.id}`)).toBe(false);
    const again = await call<{ id: string }>(app, "POST", "/api/workspaces", { name: "Efemero" });
    expect(again.id).toBe(created.id);
    activity.record({ workspaceId: again.id, category: "sistema", action: "novo", actor: "sistema", summary: "No workspace novo" });
    await activity.flush();
    expect(existsSync(`${dataDir}/workspaces/${again.id}/activity`)).toBe(true);
  });

  it("rotinas: ajustar (inclusive o tracking), apagar e reabrir item aparecem na Atividade", async () => {
    const { app, activity, workspaces } = await appWithActivity();
    const { agent } = await soloTeam(app);
    const schedules = [{ label: "Madrugada", days: { kind: "todo_dia" }, times: ["00:00"], action: "Leia os e-mails" }];
    const tracking = { fields: [{ key: "empresa", label: "Empresa", type: "texto", required: true }], statuses: [{ name: "Inscrito" }, { name: "Recusado", terminal: true }], lifespan: { days: 15, untilTerminal: true } };
    await call(app, "POST", `${wsApi()}/routines`, { type: "acompanhamento", title: "Inscrições", agentId: agent.id, schedules, tracking });
    await call(app, "PATCH", `${wsApi()}/routines/R-0001`, { tracking: { ...tracking, lifespan: { days: 30, untilTerminal: true } } });
    const runtime = workspaces.get("principal");
    runtime.tracking.add("R-0001", { values: { empresa: "Acme" }, sourceKey: "m1" });
    await call(app, "POST", `${wsApi()}/routines/R-0001/items/I-0001/stop`, {}, 200);
    await call(app, "POST", `${wsApi()}/routines/R-0001/items/I-0001/reopen`, undefined, 200);
    await call(app, "PATCH", `${wsApi()}/routines/R-0001`, { status: "arquivada" });
    await call(app, "DELETE", `${wsApi()}/routines/R-0001`, undefined, 200);
    await activity.flush();
    const all = await call<ActivityResponse>(app, "GET", `${wsApi()}/activity?category=rotina`);
    const actions = all.entries.map((entry) => entry.action);
    expect(actions).toEqual(expect.arrayContaining(["criada", "ajustada", "item-parado", "item-reaberto", "encerrada", "apagada"]));
    expect(all.entries.find((entry) => entry.action === "ajustada")!.summary).toContain("esquema dos itens acompanhados");
  });

  it("a rota do servidor lista só o que não é de workspace e traz o batimento", async () => {
    const { app, activity, dataDir } = await appWithActivity();
    activity.record({ category: "sistema", action: "iniciado", actor: "sistema", summary: "Servidor iniciado" });
    await (await import("node:fs/promises")).mkdir(`${dataDir}/activity`, { recursive: true });
    await (await import("node:fs/promises")).writeFile(`${dataDir}/activity/heartbeat.json`, JSON.stringify({ pid: 1, startedAt: "2026-11-10T10:00:00Z", at: "2026-11-10T10:01:00Z", lastSample: { memAvailableMb: 3000, memAvailablePct: 40, swapUsedMb: 10, serverRssMb: 200, terminalsRssMb: 100, browserRssMb: 0 } }));
    const system = await call<ActivitySystemResponse>(app, "GET", "/api/activity/system");
    expect(system.entries.map((entry) => entry.action)).toEqual(["iniciado"]);
    expect(system.server).toMatchObject({ pid: 1, memAvailableMb: 3000, serverRssMb: 200 });
    expect((await call<ActivityResponse>(app, "GET", `${wsApi()}/activity`)).entries.every((entry) => entry.workspaceId === "principal")).toBe(true);
  });
});
