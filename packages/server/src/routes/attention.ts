import { ATTENTION_PATH, ATTENTION_PREFS_PATH, attentionPrefsBodySchema, type AttentionPrefs, type AttentionResponse } from "@cyno/shared";
import type { FastifyInstance } from "fastify";
import type { AttentionService } from "../platform/attention/service";
import { HttpError } from "../platform/http/errors";

/**
 * A cadeia de atenção (atrás da senha):
 * - GET  /api/attention             -> { open, serverTime } (o estado inicial e a ressincronização; depois só `attention:*` no socket da plataforma)
 * - POST /api/attention/:key/seen   -> 204 (o dono viu um alerta que não se resolve sozinho: tarefa que falhou, aviso); o que espera o dono dá 409
 * - GET  /api/attention/prefs       -> AttentionPrefs (tipos ligados, workspaces silenciados, "não perturbe")
 * - PUT  /api/attention/prefs       -> AttentionPrefs (troca só o que veio; `dndUntil: null` tira o "não perturbe")
 */
export function registerAttentionRoutes(app: FastifyInstance, attention: AttentionService, now: () => Date): void {
  app.get(ATTENTION_PATH, async (): Promise<AttentionResponse> => ({ open: attention.list(), serverTime: now().toISOString() }));

  app.post(`${ATTENTION_PATH}/:key/seen`, async (request, reply) => {
    const { key } = request.params as { key: string };
    const result = attention.markSeen(key);
    if (result === "not-found") throw new HttpError(404, "Esse alerta já saiu da lista");
    if (result === "not-allowed") throw new HttpError(409, "Esse alerta sai sozinho quando a causa some (ou quando você decide): não dá para marcar como visto");
    return reply.code(204).send();
  });

  app.get(ATTENTION_PREFS_PATH, async (): Promise<AttentionPrefs> => attention.prefs());

  app.put(ATTENTION_PREFS_PATH, async (request): Promise<AttentionPrefs> => attention.updatePrefs(attentionPrefsBodySchema.parse(request.body ?? {})));
}
