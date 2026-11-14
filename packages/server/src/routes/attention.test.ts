import type { AddressInfo } from "node:net";
import { ATTENTION_PATH, ATTENTION_PREFS_PATH, parseCynoEvent, type AttentionPrefs, type AttentionResponse, type CynoServerEvent } from "@cyno/shared";
import { describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { API, useTestApp } from "../dev/test-app";
import { call, createTask, soloTeam } from "../dev/test-api";

const setupApp = useTestApp();

const openAlerts = async (app: Awaited<ReturnType<typeof setupApp>>["app"]) => (await call<AttentionResponse>(app, "GET", ATTENTION_PATH)).open;

describe("API: a cadeia de atenção", () => {
  it("o pedido de aprovação de um agente vira alerta; decidir o item limpa; chega pelo socket da plataforma", async () => {
    const { app, log } = await setupApp();
    await app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = app.server.address() as AddressInfo;
    const events: CynoServerEvent[] = [];
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/cyno/ws`);
    socket.on("message", (data) => {
      const event = parseCynoEvent(JSON.parse(String(data)));
      if (event) events.push(event);
    });
    await new Promise<void>((resolve) => socket.once("open", () => resolve()));
    expect(await openAlerts(app)).toEqual([]);

    const solo = await soloTeam(app);
    const task = await createTask(app, solo.room.id, solo.team.id, "Publicar o post [aprovar]");
    await log.waitForTask(task.id, "waiting_approval");
    await vi.waitFor(async () => expect((await openAlerts(app)).map((alert) => alert.kind)).toEqual(["approval"]));
    const [alert] = await openAlerts(app);
    expect(alert).toMatchObject({ workspaceId: "principal", needsOwner: true, agentName: "Agente Solo", count: 1, target: { page: "para-voce", workspaceId: "principal" } });
    expect(alert!.replay).toBeUndefined();
    await vi.waitFor(() => expect(events.some((event) => event.type === "attention:raised" && event.alert.key === alert!.key)).toBe(true));

    // O que espera o dono não aceita "Visto".
    const refused = await app.inject({ method: "POST", url: `${ATTENTION_PATH}/${encodeURIComponent(alert!.key)}/seen` });
    expect(refused.statusCode).toBe(409);

    await call(app, "POST", `${API}/for-you/${alert!.forYouId}/decision`, { status: "aprovado" }, 200);
    await vi.waitFor(async () => expect(await openAlerts(app)).toEqual([]));
    await vi.waitFor(() => expect(events.some((event) => event.type === "attention:cleared" && event.key === alert!.key && event.reason === "decided")).toBe(true));
    socket.close();
  });

  it("tarefa que falhou: alerta de aviso, que o dono marca como visto pela rota", async () => {
    const { app, log } = await setupApp();
    const solo = await soloTeam(app);
    const task = await createTask(app, solo.room.id, solo.team.id, "Subir o site [falhar]");
    await log.waitForTask(task.id, "failed");
    await vi.waitFor(async () => expect((await openAlerts(app)).map((alert) => alert.kind)).toEqual(["failed"]));
    const [alert] = await openAlerts(app);
    expect(alert).toMatchObject({ level: "warn", needsOwner: false, taskId: task.id, target: { page: "trabalho", ref: task.id } });
    expect((await app.inject({ method: "POST", url: `${ATTENTION_PATH}/${encodeURIComponent(alert!.key)}/seen` })).statusCode).toBe(204);
    expect(await openAlerts(app)).toEqual([]);
    expect((await app.inject({ method: "POST", url: `${ATTENTION_PATH}/${encodeURIComponent(alert!.key)}/seen` })).statusCode).toBe(404);
  });

  it("preferências da conta: lê o padrão, troca só o que veio, valida o corpo", async () => {
    const { app } = await setupApp();
    expect(await call<AttentionPrefs>(app, "GET", ATTENTION_PREFS_PATH)).toEqual({ mutedWorkspaces: {}, kinds: {} });
    const saved = await call<AttentionPrefs>(app, "PUT", ATTENTION_PREFS_PATH, { kinds: { failed: false }, mutedWorkspaces: { principal: { until: "2026-11-12T20:00:00.000Z" } } }, 200);
    expect(saved).toEqual({ mutedWorkspaces: { principal: { until: "2026-11-12T20:00:00.000Z" } }, kinds: { failed: false } });
    const dnd = await call<AttentionPrefs>(app, "PUT", ATTENTION_PREFS_PATH, { dndUntil: "2026-11-12T20:00:00.000Z" }, 200);
    expect(dnd.kinds).toEqual({ failed: false });
    expect(dnd.dndUntil).toBe("2026-11-12T20:00:00.000Z");
    expect((await call<AttentionPrefs>(app, "PUT", ATTENTION_PREFS_PATH, { dndUntil: null }, 200)).dndUntil).toBeUndefined();
    expect((await app.inject({ method: "PUT", url: ATTENTION_PREFS_PATH, payload: { kinds: { inventado: true } } })).statusCode).toBe(400);
    expect((await app.inject({ method: "PUT", url: ATTENTION_PREFS_PATH, payload: { mutedWorkspaces: { "../x": {} } } })).statusCode).toBe(400);
    expect((await app.inject({ method: "PUT", url: ATTENTION_PREFS_PATH, payload: { cor: "azul" } })).statusCode).toBe(400);
  });
});
