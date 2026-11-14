import { z } from "zod";

/**
 * O aviso com o site fechado (Junção V2, J2-17): o servidor manda um Web Push para os aparelhos que o dono
 * inscreveu, quando nasce um alerta que espera por ele e ele não está com o site aberto e visível.
 * Aqui ficam os caminhos, as formas das mensagens e as regras puras (quem recebe, texto do aviso).
 */

export const PUSH_PATH = "/api/attention/push";
export const PUSH_KEY_PATH = `${PUSH_PATH}/key`;
export const PUSH_SUBSCRIBE_PATH = `${PUSH_PATH}/subscribe`;
export const PUSH_UNSUBSCRIBE_PATH = `${PUSH_PATH}/unsubscribe`;
export const PUSH_DEVICES_PATH = `${PUSH_PATH}/devices`;
export const PUSH_TEST_PATH = `${PUSH_PATH}/test`;

/** Mais de um aparelho por dono é normal (celular, notebook), mas não infinito. */
export const PUSH_MAX_DEVICES = 20;
/** O dono com o site aberto e visível manda a presença a cada 60 s; passado 1,5 intervalo ele não está mais olhando. */
export const PUSH_OWNER_PRESENT_MS = 90_000;
/** Quanto o servidor espera antes de mandar, para juntar uma rajada num aviso só. */
export const PUSH_BATCH_MS = 3_000;
/** Tamanho do texto que vai no aviso (uma linha curta, sem o texto inteiro da tarefa). */
export const PUSH_BODY_MAX = 110;
/** Quanto o serviço de push guarda o aviso se o aparelho estiver sem rede (segundos). */
export const PUSH_TTL_S = 3_600;

export const pushSubscriptionSchema = z.strictObject({
  endpoint: z
    .string()
    .max(2048)
    .refine((value) => /^https:\/\/[^\s/?#]+\S*$/.test(value), "O endereço do push precisa ser https"),
  keys: z.strictObject({ p256dh: z.string().min(1).max(256), auth: z.string().min(1).max(128) }),
});
// Alguns navegadores mandam `expirationTime`: aceita e ignora.
const browserSubscriptionSchema = pushSubscriptionSchema.extend({ expirationTime: z.number().nullable().optional() });

/** POST /api/attention/push/subscribe */
export const pushSubscribeBodySchema = z.strictObject({
  subscription: browserSubscriptionSchema,
  /** Como o dono reconhece o aparelho ("Chrome no Android"). */
  name: z.string().trim().min(1).max(60).optional(),
});
export type PushSubscribeBody = z.input<typeof pushSubscribeBodySchema>;

/** POST /api/attention/push/unsubscribe e /test */
export const pushEndpointBodySchema = z.strictObject({ endpoint: z.string().max(2048) });
export const pushTestBodySchema = z.strictObject({ endpoint: z.string().max(2048).optional() });

/** GET /api/attention/push/key: só a chave PÚBLICA. */
export type PushKeyResponse = { publicKey: string };

/** Um aparelho inscrito, como a tela vê (nunca devolve as chaves nem o endereço inteiro). */
export type PushDevice = { id: string; name: string; createdAt: string; host: string };
export type PushDevicesResponse = { devices: PushDevice[] };
export type PushSubscribeResponse = { device: PushDevice };
export type PushTestResponse = { sent: number; removed: number; failed: number };

/** O que o servidor manda (JSON no corpo do push) e o service worker lê. */
export type PushPayload = {
  title: string;
  body: string;
  /** Um aviso novo do mesmo `tag` substitui o anterior no aparelho. */
  tag: string;
  /** A chave do alerta (ou "cyno-lote" / "cyno-teste"). */
  key: string;
  /** Para onde o clique leva: `/?alert=<chave>`. */
  url: string;
  kind: "alert" | "batch" | "test";
};

export const PUSH_BATCH_KEY = "cyno-lote";
export const PUSH_TEST_KEY = "cyno-teste";

/** O destino do clique: a página lê `?alert=` ao abrir e leva ao alerta. */
export function pushUrlFor(key: string): string {
  return `/?alert=${encodeURIComponent(key)}`;
}

const firstLine = (text: string): string => text.split(/\r?\n/, 1)[0] ?? "";
function cut(text: string, max: number): string {
  const clean = firstLine(text).replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** O aviso de um alerta: título fixo, uma linha e o workspace. `mask` tira segredos (o servidor passa `maskSecrets`). */
export function pushPayloadForAlert(alert: { key: string; text: string; workspaceName?: string }, mask: (text: string) => string): PushPayload {
  const text = cut(mask(alert.text), PUSH_BODY_MAX);
  const workspace = alert.workspaceName ? cut(mask(alert.workspaceName), 40) : "";
  return { title: "Cyno · precisa de você", body: workspace ? `${text} · ${workspace}` : text, tag: alert.key, key: alert.key, url: pushUrlFor(alert.key), kind: "alert" };
}

/** Vários alertas juntos: um aviso só ("3 coisas esperando você"). */
export function pushPayloadForBatch(alerts: readonly { count: number; workspaceName?: string }[]): PushPayload {
  const total = alerts.reduce((sum, alert) => sum + Math.max(1, Math.round(alert.count) || 1), 0);
  const names = [...new Set(alerts.map((alert) => alert.workspaceName).filter((name): name is string => Boolean(name)))];
  const where = names.length === 0 ? "" : names.length === 1 ? ` · ${cut(names[0]!, 40)}` : ` · ${names.length} workspaces`;
  return { title: "Cyno · precisa de você", body: `${total} ${total === 1 ? "coisa esperando" : "coisas esperando"} você${where}`, tag: PUSH_BATCH_KEY, key: PUSH_BATCH_KEY, url: pushUrlFor(PUSH_BATCH_KEY), kind: "batch" };
}

export const PUSH_TEST_PAYLOAD: PushPayload = {
  title: "Cyno · aviso de teste",
  body: "Se você está lendo isto, o aviso com o site fechado funciona neste aparelho.",
  tag: PUSH_TEST_KEY,
  key: PUSH_TEST_KEY,
  url: pushUrlFor(PUSH_TEST_KEY),
  kind: "test",
};
