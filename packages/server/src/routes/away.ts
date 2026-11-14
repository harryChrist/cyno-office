import { AWAY_PATH, AWAY_SEEN_PATH, PRESENCE_PATH, type AwayResponse, type PresenceResponse } from "@cyno/shared";
import type { FastifyInstance } from "fastify";
import type { AwayService } from "../platform/owner/away-service";
import type { OwnerStore } from "../platform/owner/owner-store";

/**
 * A presença do dono e o "enquanto você estava fora", atrás da senha:
 * - POST /api/presence -> PresenceResponse: o navegador diz que o dono está aqui (a cada 60 s, só com a aba visível e
 *   entrada recente). Depois de 30 minutos ou mais sem presença, abre uma ausência; `awayPending` diz se há uma sem "Ok, vi";
 * - GET /api/away -> AwayResponse: o resumo da ausência pendente (montado por código; sem novidades, `pending: false`);
 * - POST /api/away/seen -> 204: "Ok, vi" (vale para todos os navegadores do dono).
 */
export function registerAwayRoutes(app: FastifyInstance, owner: Pick<OwnerStore, "presence" | "markSeen">, away: Pick<AwayService, "pending">, now: () => Date): void {
  app.post(PRESENCE_PATH, async (): Promise<PresenceResponse> => ({ awayPending: owner.presence(now().getTime()) }));
  app.get(AWAY_PATH, async (): Promise<AwayResponse> => away.pending());
  app.post(AWAY_SEEN_PATH, async (_request, reply) => {
    owner.markSeen(now().getTime());
    return reply.code(204).send();
  });
}
