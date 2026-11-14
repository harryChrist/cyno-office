import { RETRO_PERIOD_PATTERN, WORKSPACE_RETRO_ASK_PATH, WORKSPACE_RETRO_GENERATE_PATH, WORKSPACE_RETRO_PATH, type RetroAskResult, type RetroGenerateResult, type RetroView } from "@cyno/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { HttpError } from "../platform/http/errors";
import { renderRetroHtml, renderRetroMarkdown, renderRetroText } from "../workspace/retro/render";
import type { WorkspaceRuntime } from "../workspace/runtime";

const askBodySchema = z.strictObject({ groupIds: z.array(z.string().max(40)).max(20).optional() });

/**
 * A retrospectiva da Gestão ("O que aprendemos"), dentro de /api/w/:ws. Só código, exceto `/retro/maestro`, que o dono clica:
 * - GET  /retro                  -> `RetroView` (os padrões que esperam texto, as regras e o estado delas, o custo do botão)
 * - POST /retro/generate         -> `RetroGenerateResult` (monta e guarda a retrospectiva de agora e abre os cartões por molde)
 * - POST /retro/maestro { groupIds? } -> `RetroAskResult` (UMA mensagem ao Maestro; ele devolve `propose_rule` por grupo)
 * - GET  /retro/:semana[?format=json|html|md|text] -> a retrospectiva guardada ("latest" = a mais nova)
 * Aprovar, editar e recusar a regra é pelo `POST /for-you/:id/decision` (o cartão é um item do Para você, `kind: "regra"`).
 */
export function registerWorkspaceRetroRoutes(scope: FastifyInstance, runtimeOf: (request: FastifyRequest) => WorkspaceRuntime): void {
  scope.get(WORKSPACE_RETRO_PATH, async (request): Promise<RetroView> => runtimeOf(request).retro.view());

  scope.post(WORKSPACE_RETRO_GENERATE_PATH, async (request): Promise<RetroGenerateResult> => {
    const retro = runtimeOf(request).retro;
    const { opened } = await retro.generate("manual");
    return { view: await retro.view(), opened };
  });

  scope.post(WORKSPACE_RETRO_ASK_PATH, async (request): Promise<RetroAskResult> => {
    const body = askBodySchema.parse(request.body ?? {});
    const retro = runtimeOf(request).retro;
    const { asked, taskId } = await retro.ask(body.groupIds);
    return { view: await retro.view(), asked, taskId };
  });

  scope.get(`${WORKSPACE_RETRO_PATH}/:period`, async (request, reply) => {
    const { period } = request.params as { period: string };
    const { format = "json" } = request.query as { format?: string };
    if (!["json", "html", "md", "text"].includes(format)) throw new HttpError(400, "Formato inválido (use json, html, md ou text)");
    if (period !== "latest" && !RETRO_PERIOD_PATTERN.test(period)) throw new HttpError(400, "Semana inválida (use latest ou algo como 2026-W46)");
    const report = await runtimeOf(request).retro.ensure(period);
    if (!report) throw new HttpError(404, `Não há retrospectiva de ${period}`);
    if (format === "json") return report;
    reply.header("x-content-type-options", "nosniff");
    if (format === "html") return reply.header("content-type", "text/html; charset=utf-8").header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox").send(renderRetroHtml(report));
    if (format === "md") return reply.header("content-type", "text/markdown; charset=utf-8").send(renderRetroMarkdown(report));
    return reply.header("content-type", "text/plain; charset=utf-8").send(renderRetroText(report));
  });
}
