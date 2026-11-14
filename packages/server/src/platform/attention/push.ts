import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  maskSecrets,
  PUSH_BATCH_MS,
  PUSH_MAX_DEVICES,
  PUSH_TEST_PAYLOAD,
  PUSH_TTL_S,
  pushPayloadForAlert,
  pushPayloadForBatch,
  silenceReason,
  type AttentionAlert,
  type AttentionPrefs,
  type AttentionServerEvent,
  type PushDevice,
  type PushPayload,
  type PushTestResponse,
} from "@cyno/shared";
import { generateVAPIDKeys, sendNotification } from "web-push";
import { writeJsonAtomic } from "../../store/atomic-write";
import { WriteQueue } from "../../store/write-queue";

/** Um aparelho inscrito como o servidor guarda (com as chaves de criptografia do push). */
export type StoredDevice = { id: string; name: string; endpoint: string; keys: { p256dh: string; auth: string }; createdAt: string };
type VapidKeys = { publicKey: string; privateKey: string; subject: string };
type PushFile = { version: 1; vapid: VapidKeys; devices: StoredDevice[] };

/** Quem fala com o serviço de push do navegador (o padrão usa `web-push`; os testes trocam por um falso). */
export type PushSender = (device: Pick<StoredDevice, "endpoint" | "keys">, payload: string, vapid: VapidKeys, options: { ttl: number; topic: string }) => Promise<void>;

/** Contato exigido pelo protocolo VAPID; troque com CYNO_PUSH_SUBJECT (um `mailto:` ou um endereço https). */
const DEFAULT_SUBJECT = "mailto:cyno@example.com";

export const webPushSender: PushSender = async (device, payload, vapid, options) => {
  await sendNotification({ endpoint: device.endpoint, keys: device.keys }, payload, {
    vapidDetails: { subject: vapid.subject, publicKey: vapid.publicKey, privateKey: vapid.privateKey },
    TTL: options.ttl,
    topic: options.topic,
    urgency: "high",
    timeout: 15_000,
  });
};

/** O código de status de uma falha do envio (404 e 410: a inscrição morreu). */
export function failureStatus(error: unknown): number | undefined {
  const status = (error as { statusCode?: unknown } | null)?.statusCode;
  return typeof status === "number" ? status : undefined;
}

const isDeadStatus = (status: number | undefined) => status === 404 || status === 410;

/** O `topic` do push só aceita até 32 letras/números/-/_: uma impressão da chave do alerta. */
const topicOf = (key: string): string => createHash("sha256").update(key).digest("base64url").slice(0, 32);

const hostOf = (endpoint: string): string => {
  try {
    return new URL(endpoint).host;
  } catch {
    return "";
  }
};

const publicDevice = (device: StoredDevice): PushDevice => ({ id: device.id, name: device.name, createdAt: device.createdAt, host: hostOf(device.endpoint) });

/**
 * O que o servidor guarda do aviso com o site fechado, em `data/platform/push.json` (modo 0600): as chaves VAPID (geradas
 * uma vez; a privada nunca sai) e os aparelhos inscritos. Escrita atômica e em fila.
 */
export class PushStore {
  private readonly queue = new WriteQueue();

  private constructor(
    private readonly file: string,
    private state: PushFile,
  ) {}

  static async open(file: string, log: { warn: (obj: unknown, message?: string) => void }): Promise<PushStore> {
    let existing: PushFile | undefined;
    try {
      const parsed = JSON.parse(await readFile(file, "utf8")) as Partial<PushFile>;
      const vapid = parsed.vapid;
      if (vapid && typeof vapid.publicKey === "string" && typeof vapid.privateKey === "string") {
        const devices = Array.isArray(parsed.devices) ? parsed.devices.filter((device): device is StoredDevice => Boolean(device && typeof device.id === "string" && typeof device.endpoint === "string" && device.keys)) : [];
        existing = { version: 1, vapid: { publicKey: vapid.publicKey, privateKey: vapid.privateKey, subject: typeof vapid.subject === "string" ? vapid.subject : DEFAULT_SUBJECT }, devices };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") log.warn({ err: error }, "push.json ilegível: as chaves do aviso serão refeitas e os aparelhos precisam ser inscritos de novo");
    }
    if (existing) return new PushStore(file, existing);
    const keys = generateVAPIDKeys();
    const store = new PushStore(file, { version: 1, vapid: { ...keys, subject: process.env.CYNO_PUSH_SUBJECT?.trim() || DEFAULT_SUBJECT }, devices: [] });
    store.persist();
    await store.flush();
    return store;
  }

  publicKey(): string {
    return this.state.vapid.publicKey;
  }

  vapid(): VapidKeys {
    return { ...this.state.vapid };
  }

  list(): StoredDevice[] {
    return this.state.devices.map((device) => ({ ...device, keys: { ...device.keys } }));
  }

  devices(): PushDevice[] {
    return this.state.devices.map(publicDevice);
  }

  /** Inscreve (ou atualiza, se o endereço já existe). Passando do limite, o mais antigo sai. */
  add(input: { endpoint: string; keys: { p256dh: string; auth: string }; name: string }, nowIso: string): PushDevice {
    const current = this.state.devices.find((device) => device.endpoint === input.endpoint);
    if (current) {
      current.keys = { ...input.keys };
      current.name = input.name;
      this.persist();
      return publicDevice(current);
    }
    const device: StoredDevice = { id: `pd-${randomUUID().slice(0, 8)}`, name: input.name, endpoint: input.endpoint, keys: { ...input.keys }, createdAt: nowIso };
    this.state.devices.push(device);
    while (this.state.devices.length > PUSH_MAX_DEVICES) this.state.devices.shift();
    this.persist();
    return publicDevice(device);
  }

  removeById(id: string): boolean {
    return this.removeWhere((device) => device.id === id);
  }

  removeByEndpoint(endpoint: string): boolean {
    return this.removeWhere((device) => device.endpoint === endpoint);
  }

  private removeWhere(match: (device: StoredDevice) => boolean): boolean {
    const before = this.state.devices.length;
    this.state.devices = this.state.devices.filter((device) => !match(device));
    if (this.state.devices.length === before) return false;
    this.persist();
    return true;
  }

  /** Espera as gravações pendentes. Não regrava: cada mudança já grava, e o fechamento do servidor não pode demorar à toa. */
  flush(): Promise<void> {
    return this.queue.idle();
  }

  private persist(): void {
    const snapshot = structuredClone(this.state);
    void this.queue
      .enqueue(async () => {
        await mkdir(path.dirname(this.file), { recursive: true });
        await writeJsonAtomic(this.file, snapshot, 0o600);
      })
      .catch(() => undefined);
  }
}

export type PushDeps = {
  store: PushStore;
  /** Os alertas abertos e as preferências (silêncio por tipo, workspace e "não perturbe"). */
  attention: { subscribe: (listener: (event: AttentionServerEvent) => void) => () => void; list: () => AttentionAlert[]; prefs: () => AttentionPrefs };
  /** O dono está com o site aberto e visível agora? Então não manda: valem o aviso na tela e o som. */
  ownerLooking: () => boolean;
  send: PushSender;
  now: () => Date;
  log: { warn: (obj: unknown, message?: string) => void };
  /** Espera para juntar uma rajada (padrão `PUSH_BATCH_MS`). */
  batchMs?: number;
};

/**
 * Manda o aviso com o site fechado. Escuta a cadeia de atenção: quando nasce um alerta que espera o dono (e que já
 * passaria pelos filtros de Avisos), espera uma janela curta para juntar a rajada, confere de novo (o alerta ainda
 * está aberto? o dono não voltou a olhar?) e manda um aviso por aparelho. Vários alertas na mesma janela viram um
 * aviso só ("3 coisas esperando você"). Inscrição que responde 404/410 sai da lista; falha de rede só vai para o
 * log e nunca atrapalha o alerta.
 */
export class PushService {
  private readonly pending = new Map<string, AttentionAlert>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private off: (() => void) | undefined;
  private inFlight = new Set<Promise<unknown>>();
  private closed = false;

  constructor(private readonly deps: PushDeps) {}

  start(): void {
    if (this.off) return;
    this.off = this.deps.attention.subscribe((event) => this.onEvent(event));
  }

  async close(): Promise<void> {
    this.closed = true;
    this.off?.();
    this.off = undefined;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.pending.clear();
    await this.idle();
    await this.deps.store.flush();
  }

  /** Espera os envios em andamento (testes). */
  async idle(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight]);
  }

  /** Manda o que está na janela agora (testes e fechamento). */
  async flushNow(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.flush();
  }

  private onEvent(event: AttentionServerEvent): void {
    if (this.closed) return;
    if (event.type === "attention:cleared") {
      this.pending.delete(event.key);
      return;
    }
    const { alert } = event;
    if (event.type === "attention:updated") {
      if (this.pending.has(alert.key)) this.pending.set(alert.key, { ...alert });
      return;
    }
    if (!alert.needsOwner || alert.replay) return;
    if (this.deps.store.list().length === 0) return;
    if (silenceReason(this.deps.attention.prefs(), alert, this.deps.now().getTime())) return;
    this.pending.set(alert.key, { ...alert });
    this.timer ??= setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, this.deps.batchMs ?? PUSH_BATCH_MS);
    this.timer.unref?.();
  }

  private async flush(): Promise<void> {
    const queued = [...this.pending.values()];
    this.pending.clear();
    if (queued.length === 0 || this.closed) return;
    // Confere de novo na hora de mandar: o alerta ainda espera o dono, os filtros ainda deixam, ele não está olhando.
    const nowMs = this.deps.now().getTime();
    const open = new Map(this.deps.attention.list().map((alert) => [alert.key, alert] as const));
    const prefs = this.deps.attention.prefs();
    const alerts = queued.flatMap((alert) => {
      const live = open.get(alert.key);
      return live && live.needsOwner && !silenceReason(prefs, live, nowMs) ? [live] : [];
    });
    if (alerts.length === 0 || this.deps.ownerLooking()) return;
    const payload = alerts.length === 1 ? pushPayloadForAlert(alerts[0]!, maskSecrets) : pushPayloadForBatch(alerts);
    await this.sendAll(payload, this.deps.store.list());
  }

  /** O aviso de teste (o botão "Mandar um aviso de teste"): ignora presença e filtros. `endpoint` limita a um aparelho. */
  async sendTest(endpoint?: string): Promise<PushTestResponse> {
    const devices = this.deps.store.list().filter((device) => !endpoint || device.endpoint === endpoint);
    return this.sendAll(PUSH_TEST_PAYLOAD, devices);
  }

  private sendAll(payload: PushPayload, devices: StoredDevice[]): Promise<PushTestResponse> {
    const work = (async () => {
      const result: PushTestResponse = { sent: 0, removed: 0, failed: 0 };
      const vapid = this.deps.store.vapid();
      const body = JSON.stringify(payload);
      await Promise.all(
        devices.map(async (device) => {
          try {
            await this.deps.send(device, body, vapid, { ttl: PUSH_TTL_S, topic: topicOf(payload.tag) });
            result.sent += 1;
          } catch (error) {
            const status = failureStatus(error);
            if (isDeadStatus(status)) {
              this.deps.store.removeByEndpoint(device.endpoint);
              result.removed += 1;
            } else {
              result.failed += 1;
              // Só o código e o servidor do push: nada do endereço inteiro nem das chaves.
              this.deps.log.warn({ status, host: hostOf(device.endpoint), device: device.id }, "não foi possível mandar o aviso com o site fechado");
            }
          }
        }),
      );
      return result;
    })();
    this.inFlight.add(work);
    void work.finally(() => this.inFlight.delete(work));
    return work;
  }
}
