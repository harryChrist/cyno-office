import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DEFAULT_ATTENTION_PREFS, type AttentionAlert, type AttentionPrefs, type AttentionServerEvent, type PushPayload } from "@cyno/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PushService, PushStore, type PushSender } from "./push";

const sub = (n: number) => ({ endpoint: `https://push.example.test/send/${n}`, keys: { p256dh: `P256DH-SEGREDO-${n}`, auth: `AUTH-SEGREDO-${n}` }, name: `Aparelho ${n}` });

const alertOf = (key: string, patch: Partial<AttentionAlert> = {}): AttentionAlert => ({
  id: `al-${key}`,
  key,
  kind: "approval",
  level: "alert",
  needsOwner: true,
  workspaceId: "principal",
  workspaceName: "Principal",
  text: "Eco pediu o seu OK",
  count: 1,
  at: "2026-11-12T10:00:00.000Z",
  updatedAt: "2026-11-12T10:00:00.000Z",
  target: { page: "para-voce", workspaceId: "principal", ref: key },
  ...patch,
});

let dir: string;
/** Os `PushStore` abertos pelo teste: cada `add` grava em fila (sem ninguém esperar); o `afterEach` espera antes de apagar a pasta. */
let opened: PushStore[] = [];
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "cyno-push-test-"));
});
afterEach(async () => {
  // Sem esperar a fila de gravação, a gravação em curso recria o arquivo no meio do `rm` e ele falha com ENOTEMPTY.
  await Promise.all(opened.map((store) => store.flush()));
  opened = [];
  await rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 60 });
});

async function openStore(file: string): Promise<PushStore> {
  const store = await PushStore.open(file, { warn: () => undefined });
  opened.push(store);
  return store;
}

async function setup(options: { looking?: boolean; prefs?: AttentionPrefs; devices?: number; fail?: (endpoint: string) => unknown } = {}) {
  const store = await openStore(path.join(dir, "push.json"));
  for (let n = 1; n <= (options.devices ?? 1); n += 1) store.add(sub(n), "2026-11-12T09:00:00.000Z");
  const open = new Map<string, AttentionAlert>();
  const listeners = new Set<(event: AttentionServerEvent) => void>();
  const sent: { endpoint: string; payload: PushPayload; topic: string }[] = [];
  const warnings: unknown[] = [];
  let looking = options.looking ?? false;
  let prefs = options.prefs ?? structuredClone(DEFAULT_ATTENTION_PREFS);
  const send: PushSender = async (device, payload, _vapid, opts) => {
    const failure = options.fail?.(device.endpoint);
    if (failure) throw failure;
    sent.push({ endpoint: device.endpoint, payload: JSON.parse(payload) as PushPayload, topic: opts.topic });
  };
  const push = new PushService({
    store,
    attention: {
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      list: () => [...open.values()],
      prefs: () => prefs,
    },
    ownerLooking: () => looking,
    send,
    now: () => new Date("2026-11-12T10:00:05.000Z"),
    log: { warn: (obj) => warnings.push(obj) },
    batchMs: 1_000_000,
  });
  push.start();
  const emit = (event: AttentionServerEvent) => {
    if (event.type === "attention:raised" || event.type === "attention:updated") open.set(event.alert.key, event.alert);
    if (event.type === "attention:cleared") open.delete(event.key);
    for (const listener of listeners) listener(event);
  };
  return {
    store,
    push,
    emit,
    sent,
    warnings,
    setLooking: (value: boolean) => {
      looking = value;
    },
    setPrefs: (value: AttentionPrefs) => {
      prefs = value;
    },
  };
}

describe("PushStore: chaves e aparelhos", () => {
  it("gera as chaves VAPID uma vez, guarda com modo 0600 e reaproveita no próximo boot", async () => {
    const file = path.join(dir, "push.json");
    const first = await openStore(file);
    expect(first.publicKey().length).toBeGreaterThan(40);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    first.add(sub(1), "2026-11-12T09:00:00.000Z");
    await first.flush();
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const second = await openStore(file);
    expect(second.publicKey()).toBe(first.publicKey());
    expect(second.list()).toHaveLength(1);
    // A privada só existe no arquivo; a lista que a tela vê não tem chaves nem o endereço inteiro.
    const raw = JSON.parse(await readFile(file, "utf8")) as { vapid: { privateKey: string } };
    expect(JSON.stringify(second.devices())).not.toContain(raw.vapid.privateKey);
    expect(second.devices()[0]).toEqual({ id: expect.any(String), name: "Aparelho 1", createdAt: "2026-11-12T09:00:00.000Z", host: "push.example.test" });
  });

  it("inscrever o mesmo endereço de novo só atualiza; passado do limite o mais antigo sai", async () => {
    const store = await openStore(path.join(dir, "push.json"));
    store.add(sub(1), "2026-11-12T09:00:00.000Z");
    store.add({ ...sub(1), name: "Novo nome" }, "2026-11-12T09:30:00.000Z");
    expect(store.devices()).toHaveLength(1);
    expect(store.devices()[0]).toMatchObject({ name: "Novo nome", createdAt: "2026-11-12T09:00:00.000Z" });
    for (let n = 2; n <= 25; n += 1) store.add(sub(n), "2026-11-12T09:00:00.000Z");
    expect(store.devices()).toHaveLength(20);
    expect(store.list().some((device) => device.endpoint.endsWith("/1"))).toBe(false);
  });
});

describe("PushService: quem recebe e quando", () => {
  it("alerta que espera o dono, com o site fechado: um aviso por aparelho, curto, com tag e destino", async () => {
    const { push, emit, sent } = await setup({ devices: 2 });
    emit({ type: "attention:raised", alert: alertOf("approval:principal:it-1") });
    await push.flushNow();
    expect(sent.map((s) => s.endpoint).sort()).toEqual(["https://push.example.test/send/1", "https://push.example.test/send/2"]);
    expect(sent[0]!.payload).toEqual({
      title: "Cyno · precisa de você",
      body: "Eco pediu o seu OK · Principal",
      tag: "approval:principal:it-1",
      key: "approval:principal:it-1",
      url: "/?alert=approval%3Aprincipal%3Ait-1",
      kind: "alert",
    });
    expect(sent[0]!.topic).toMatch(/^[A-Za-z0-9_-]{1,32}$/);
  });

  it("com o site aberto e visível não manda (vale o aviso na tela)", async () => {
    const { push, emit, sent, setLooking } = await setup({ looking: true });
    emit({ type: "attention:raised", alert: alertOf("k1") });
    await push.flushNow();
    expect(sent).toEqual([]);
    // Escondido ou fechado: manda.
    setLooking(false);
    emit({ type: "attention:raised", alert: alertOf("k2") });
    await push.flushNow();
    expect(sent).toHaveLength(1);
  });

  it("o dono voltar a olhar durante a espera da rajada cancela o envio", async () => {
    const { push, emit, sent, setLooking } = await setup();
    emit({ type: "attention:raised", alert: alertOf("k1") });
    setLooking(true);
    await push.flushNow();
    expect(sent).toEqual([]);
  });

  it("não manda o que não espera o dono, o que veio de replay e o que os filtros de Avisos silenciam", async () => {
    const prefs: AttentionPrefs = { mutedWorkspaces: { mudo: {} }, kinds: { question: false } };
    const { push, emit, sent, setPrefs } = await setup({ prefs });
    emit({ type: "attention:raised", alert: alertOf("a", { kind: "failed", level: "warn", needsOwner: false }) });
    emit({ type: "attention:raised", alert: alertOf("b", { replay: true }) });
    emit({ type: "attention:raised", alert: alertOf("c", { kind: "question" }) });
    emit({ type: "attention:raised", alert: alertOf("d", { workspaceId: "mudo" }) });
    await push.flushNow();
    expect(sent).toEqual([]);
    // "Não perturbe" também vale, inclusive se ligado durante a espera.
    emit({ type: "attention:raised", alert: alertOf("e") });
    setPrefs({ ...prefs, dndUntil: "2026-11-12T12:00:00.000Z" });
    await push.flushNow();
    expect(sent).toEqual([]);
  });

  it("um lote de alertas na mesma janela vira um aviso só; atualização muda o texto, não gera outro", async () => {
    const { push, emit, sent } = await setup();
    emit({ type: "attention:raised", alert: alertOf("k1", { count: 1 }) });
    emit({ type: "attention:raised", alert: alertOf("k2", { count: 2, workspaceName: "Principal" }) });
    emit({ type: "attention:raised", alert: alertOf("k3", { count: 1, workspaceName: "Loja" }) });
    await push.flushNow();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.payload).toMatchObject({ kind: "batch", tag: "cyno-lote", body: "4 coisas esperando você · 2 workspaces" });
    sent.length = 0;
    emit({ type: "attention:raised", alert: alertOf("k4", { text: "um" }) });
    emit({ type: "attention:updated", alert: alertOf("k4", { text: "dois itens", count: 2 }) });
    await push.flushNow();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.payload.body).toBe("dois itens · Principal");
  });

  it("alerta que já saiu da lista antes do envio não é mandado", async () => {
    const { push, emit, sent } = await setup();
    emit({ type: "attention:raised", alert: alertOf("k1") });
    emit({ type: "attention:cleared", key: "k1", reason: "decided" });
    await push.flushNow();
    expect(sent).toEqual([]);
  });

  it("o conteúdo é mascarado, de uma linha e curto", async () => {
    const { push, emit, sent } = await setup();
    const secret = `ghp_${"a".repeat(36)}`;
    emit({ type: "attention:raised", alert: alertOf("k1", { text: `Usar o token ${secret} no deploy\nsegunda linha que não vai ${"x".repeat(300)}` }) });
    await push.flushNow();
    const body = sent[0]!.payload.body;
    expect(body).not.toContain(secret);
    expect(body).not.toContain("segunda linha");
    expect(body.length).toBeLessThanOrEqual(160);
  });

  it("inscrição que responde 404 ou 410 é removida; falha de rede não derruba nada nem remove", async () => {
    const { push, emit, sent, store, warnings } = await setup({
      devices: 4,
      fail: (endpoint) => (endpoint.endsWith("/1") ? { statusCode: 410 } : endpoint.endsWith("/2") ? { statusCode: 404 } : endpoint.endsWith("/3") ? new Error("ECONNRESET") : undefined),
    });
    emit({ type: "attention:raised", alert: alertOf("k1") });
    await push.flushNow();
    expect(sent.map((s) => s.endpoint)).toEqual(["https://push.example.test/send/4"]);
    expect(store.list().map((device) => device.endpoint.slice(-1)).sort()).toEqual(["3", "4"]);
    expect(warnings).toHaveLength(1);
    // O log leva só o código, o servidor do push e o id do aparelho: nada das chaves nem do endereço inteiro. (Os segredos de
    // teste são em maiúsculas e o id do aparelho é hexadecimal minúsculo: um "a3" ao acaso no id não confunde a conferência.)
    expect(JSON.stringify(warnings)).not.toContain("SEGREDO");
    expect(JSON.stringify(warnings)).not.toContain("/send/");
    await push.close();
  });

  it("o aviso de teste ignora presença e filtros; sem aparelho não há o que mandar", async () => {
    const { push, sent, store } = await setup({ devices: 2, looking: true });
    expect(await push.sendTest("https://push.example.test/send/2")).toEqual({ sent: 1, removed: 0, failed: 0 });
    expect(sent.map((s) => s.endpoint)).toEqual(["https://push.example.test/send/2"]);
    expect(sent[0]!.payload).toMatchObject({ kind: "test", tag: "cyno-teste" });
    store.removeById(store.devices()[0]!.id);
    store.removeById(store.devices()[0]!.id);
    expect(await push.sendTest()).toEqual({ sent: 0, removed: 0, failed: 0 });
  });
});
