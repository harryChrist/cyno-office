import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  PRESENCE_PATH,
  PUSH_DEVICES_PATH,
  PUSH_KEY_PATH,
  PUSH_SUBSCRIBE_PATH,
  PUSH_TEST_PATH,
  PUSH_UNSUBSCRIBE_PATH,
  type PushDevicesResponse,
  type PushKeyResponse,
  type PushPayload,
  type PushSubscribeResponse,
  type PushTestResponse,
} from "@cyno/shared";
import { describe, expect, it, vi } from "vitest";
import { call, createTask, soloTeam } from "../dev/test-api";
import { useTestApp } from "../dev/test-app";
import type { PushSender } from "../platform/attention/push";

const setupApp = useTestApp();

const subscription = (n: number) => ({ endpoint: `https://push.example.test/send/${n}`, keys: { p256dh: `P256DH-SEGREDO-${n}`, auth: `AUTH-SEGREDO-${n}` } });

function fakeSender() {
  const sent: { endpoint: string; payload: PushPayload }[] = [];
  const dead = new Set<string>();
  const send: PushSender = async (device, payload) => {
    if (dead.has(device.endpoint)) throw Object.assign(new Error("Gone"), { statusCode: 410 });
    sent.push({ endpoint: device.endpoint, payload: JSON.parse(payload) as PushPayload });
  };
  return { sent, dead, send };
}

describe("API: aviso com o site fechado (Web Push)", () => {
  it("devolve só a chave pública; a privada fica em push.json (0600) e nunca sai por rota", async () => {
    const { app, dataDir } = await setupApp();
    const { publicKey } = await call<PushKeyResponse>(app, "GET", PUSH_KEY_PATH);
    expect(publicKey.length).toBeGreaterThan(40);
    const file = path.join(dataDir, "platform", "push.json");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const saved = JSON.parse(await readFile(file, "utf8")) as { vapid: { publicKey: string; privateKey: string } };
    expect(saved.vapid.publicKey).toBe(publicKey);
    for (const url of [PUSH_KEY_PATH, PUSH_DEVICES_PATH]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.body).not.toContain(saved.vapid.privateKey);
    }
  });

  it("inscreve, lista, repete sem duplicar, remove por endereço e por id", async () => {
    const { app } = await setupApp();
    expect((await call<PushDevicesResponse>(app, "GET", PUSH_DEVICES_PATH)).devices).toEqual([]);
    const first = await call<PushSubscribeResponse>(app, "POST", PUSH_SUBSCRIBE_PATH, { subscription: subscription(1), name: "Chrome no Android" }, 200);
    expect(first.device).toMatchObject({ name: "Chrome no Android", host: "push.example.test" });
    await call(app, "POST", PUSH_SUBSCRIBE_PATH, { subscription: { ...subscription(1), expirationTime: null }, name: "Chrome no Android" }, 200);
    const second = await call<PushSubscribeResponse>(app, "POST", PUSH_SUBSCRIBE_PATH, { subscription: subscription(2) }, 200);
    expect(second.device.name).toBe("Aparelho sem nome");
    const listed = await call<PushDevicesResponse>(app, "GET", PUSH_DEVICES_PATH);
    expect(listed.devices).toHaveLength(2);
    // A tela nunca recebe as chaves de criptografia nem o endereço inteiro.
    expect(JSON.stringify(listed)).not.toContain("SEGREDO");
    expect(JSON.stringify(listed)).not.toContain("/send/1");

    await call(app, "POST", PUSH_UNSUBSCRIBE_PATH, { endpoint: subscription(1).endpoint }, 204);
    expect((await call<PushDevicesResponse>(app, "GET", PUSH_DEVICES_PATH)).devices.map((d) => d.id)).toEqual([second.device.id]);
    await call(app, "DELETE", `${PUSH_DEVICES_PATH}/${second.device.id}`, undefined, 204);
    await call(app, "DELETE", `${PUSH_DEVICES_PATH}/${second.device.id}`, undefined, 404);
  });

  it("valida o corpo: endereço http, chaves faltando e campos extras são recusados", async () => {
    const { app } = await setupApp();
    await call(app, "POST", PUSH_SUBSCRIBE_PATH, { subscription: { endpoint: "http://push.example.test/x", keys: { p256dh: "p", auth: "a" } } }, 400);
    await call(app, "POST", PUSH_SUBSCRIBE_PATH, { subscription: { endpoint: "https://push.example.test/x", keys: { p256dh: "p" } } }, 400);
    await call(app, "POST", PUSH_SUBSCRIBE_PATH, { subscription: subscription(1), extra: 1 }, 400);
    await call(app, "POST", PUSH_UNSUBSCRIBE_PATH, {}, 400);
  });

  it("o teste manda para o aparelho pedido; sem aparelho dá 409; inscrição morta no teste é removida", async () => {
    const fake = fakeSender();
    const { app } = await setupApp({ pushSender: fake.send });
    await call(app, "POST", PUSH_TEST_PATH, {}, 409);
    await call(app, "POST", PUSH_SUBSCRIBE_PATH, { subscription: subscription(1) }, 200);
    await call(app, "POST", PUSH_SUBSCRIBE_PATH, { subscription: subscription(2) }, 200);
    expect(await call<PushTestResponse>(app, "POST", PUSH_TEST_PATH, { endpoint: subscription(2).endpoint }, 200)).toEqual({ sent: 1, removed: 0, failed: 0 });
    expect(fake.sent.map((s) => s.endpoint)).toEqual([subscription(2).endpoint]);
    expect(fake.sent[0]!.payload).toMatchObject({ kind: "test" });
    fake.dead.add(subscription(1).endpoint);
    expect(await call<PushTestResponse>(app, "POST", PUSH_TEST_PATH, {}, 200)).toEqual({ sent: 1, removed: 1, failed: 0 });
    expect((await call<PushDevicesResponse>(app, "GET", PUSH_DEVICES_PATH)).devices).toHaveLength(1);
  });

  it("de ponta a ponta no servidor: aprovação nasce, o dono fora recebe; olhando a tela, não recebe", async () => {
    const fake = fakeSender();
    let nowMs = Date.parse("2026-11-12T10:00:00.000Z");
    const { app, log } = await setupApp({ pushSender: fake.send, pushBatchMs: 5, now: () => new Date(nowMs) });
    await call(app, "POST", PUSH_SUBSCRIBE_PATH, { subscription: subscription(1) }, 200);
    const solo = await soloTeam(app);

    // O dono está olhando (a presença chegou agora): nada de push.
    await call(app, "POST", PRESENCE_PATH, undefined, 200);
    const looking = await createTask(app, solo.room.id, solo.team.id, "Publicar o post [aprovar]");
    await log.waitForTask(looking.id, "waiting_approval");
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(fake.sent).toEqual([]);

    // Dois minutos depois sem presença: o próximo alerta chega como push.
    nowMs += 120_000;
    const away = await createTask(app, solo.room.id, solo.team.id, "Subir a página [aprovar]");
    await log.waitForTask(away.id, "waiting_approval");
    await vi.waitFor(() => expect(fake.sent.length).toBeGreaterThan(0));
    expect(fake.sent.at(-1)!.payload).toMatchObject({ kind: expect.stringMatching(/alert|batch/), title: "Cyno · precisa de você" });
  });
});
