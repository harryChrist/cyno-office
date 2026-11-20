import { USAGE_GUARD_PATH, USAGE_GUARD_RELEASE_PATH, USAGE_GUARD_RULE_PATH, usageGuardReleaseBodySchema, usageGuardRuleBodySchema, type ApiErrorBody, type UsageGuardResponse } from "@cyno/shared";
import type { FastifyInstance } from "fastify";
import type { UsageGuard } from "../platform/usage-guard/service";

/**
 * Pausa por limite de uso do plano:
 * - `GET /api/usage-guard`: uma linha por motor e janela (regra, uso atual, pausado ou não, hora de volta);
 * - `PATCH /api/usage-guard/rule` `{ key, enabled?, percent? }`: liga/desliga e muda o percentual de uma regra;
 * - `POST /api/usage-guard/release` `{ key? }`: libera na mão uma pausa (ou todas).
 */
export function registerUsageGuardRoutes(app: FastifyInstance, guard: UsageGuard): void {
  app.get(USAGE_GUARD_PATH, async (): Promise<UsageGuardResponse> => guard.view());
  app.patch(USAGE_GUARD_RULE_PATH, async (request, reply): Promise<UsageGuardResponse | ApiErrorBody> => {
    const body = usageGuardRuleBodySchema.parse(request.body ?? {});
    if (!guard.view().rules.some((rule) => rule.key === body.key)) return reply.code(404).send({ error: "Regra não encontrada" } satisfies ApiErrorBody);
    return guard.setRule(body);
  });
  app.post(USAGE_GUARD_RELEASE_PATH, async (request): Promise<UsageGuardResponse> => {
    const { key } = usageGuardReleaseBodySchema.parse(request.body ?? {});
    return guard.release(key);
  });
}
