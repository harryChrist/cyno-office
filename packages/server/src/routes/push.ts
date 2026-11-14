import {
  PUSH_DEVICES_PATH,
  PUSH_KEY_PATH,
  PUSH_SUBSCRIBE_PATH,
  PUSH_TEST_PATH,
  PUSH_UNSUBSCRIBE_PATH,
  pushEndpointBodySchema,
  pushSubscribeBodySchema,
  pushTestBodySchema,
  type PushDevicesResponse,
  type PushKeyResponse,
  type PushSubscribeResponse,
  type PushTestResponse,
} from "@cyno/shared";
import type { FastifyInstance } from "fastify";
import { HttpError } from "../platform/http/errors";
import type { PushService, PushStore } from "../platform/attention/push";

/**
 * O aviso com o site fechado (atrás da senha). Nenhuma rota devolve a chave privada, as chaves de criptografia dos
 * aparelhos nem o endereço inteiro de cada inscrição:
 * - GET    /api/attention/push/key            -> { publicKey } (a chave pública VAPID, para o navegador se inscrever)
 * - POST   /api/attention/push/subscribe      -> { device } (inscreve este aparelho; repetir o mesmo endereço só atualiza)
 * - POST   /api/attention/push/unsubscribe    -> 204 (tira a inscrição pelo endereço dela)
 * - GET    /api/attention/push/devices        -> { devices } (id, nome, data, servidor do push)
 * - DELETE /api/attention/push/devices/:id    -> 204 (remove um aparelho da lista)
 * - POST   /api/attention/push/test           -> { sent, removed, failed } (um aviso de teste; `endpoint` limita a um aparelho)
 */
export function registerPushRoutes(app: FastifyInstance, store: PushStore, push: Pick<PushService, "sendTest">, now: () => Date): void {
  app.get(PUSH_KEY_PATH, async (): Promise<PushKeyResponse> => ({ publicKey: store.publicKey() }));

  app.post(PUSH_SUBSCRIBE_PATH, async (request): Promise<PushSubscribeResponse> => {
    const body = pushSubscribeBodySchema.parse(request.body ?? {});
    const { endpoint, keys } = body.subscription;
    return { device: store.add({ endpoint, keys, name: body.name ?? "Aparelho sem nome" }, now().toISOString()) };
  });

  app.post(PUSH_UNSUBSCRIBE_PATH, async (request, reply) => {
    const { endpoint } = pushEndpointBodySchema.parse(request.body ?? {});
    store.removeByEndpoint(endpoint);
    return reply.code(204).send();
  });

  app.get(PUSH_DEVICES_PATH, async (): Promise<PushDevicesResponse> => ({ devices: store.devices() }));

  app.delete(`${PUSH_DEVICES_PATH}/:id`, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!store.removeById(id)) throw new HttpError(404, "Esse aparelho já saiu da lista");
    return reply.code(204).send();
  });

  app.post(PUSH_TEST_PATH, async (request): Promise<PushTestResponse> => {
    const { endpoint } = pushTestBodySchema.parse(request.body ?? {});
    if (store.list().length === 0) throw new HttpError(409, "Nenhum aparelho inscrito para receber o aviso");
    return push.sendTest(endpoint);
  });
}
