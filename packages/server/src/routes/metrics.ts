import { METRICS_GROUP_BY, MODEL_SAVING_PATH, WORKSPACE_METRICS_PATH, type ApiErrorBody, type MetricsGroupBy, type MetricsReport, type ModelSaving } from "@cyno/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { pickGroups } from "../workspace/metrics/compute";
import { windowFromDays } from "../workspace/metrics/window";
import type { WorkspaceRuntime } from "../workspace/runtime";

/**
 * Métricas da Gestão (por código, só leitura), atrás da senha:
 * `GET /api/w/:ws/metrics?from=AAAA-MM-DD&to=AAAA-MM-DD&group_by=agent|project|routine|type|none` -> `MetricsReport`.
 * Sem `from`/`to`: 7 dias (taxas e contagens) e 28 (medianas). Sem `group_by`: todos os grupos.
 * Dia mal escrito, no futuro ou janela de mais de 60 dias: 400 (o máximo da janela é 60 dias); dia além dos 90 dias guardados (retenção do dia): 404.
 */
export function registerWorkspaceMetricsRoute(scope: FastifyInstance, runtimeOf: (request: FastifyRequest) => WorkspaceRuntime, now: () => Date): void {
  const fail = (reply: FastifyReply, status: number, error: string) => reply.code(status).send({ error } satisfies ApiErrorBody);

  scope.get(WORKSPACE_METRICS_PATH, async (request, reply): Promise<MetricsReport | ApiErrorBody> => {
    const query = request.query as { from?: string; to?: string; group_by?: string };
    const window = windowFromDays(query, now().getTime());
    if (!window.ok) return fail(reply, window.status, window.error);
    if (query.group_by !== undefined && !(METRICS_GROUP_BY as readonly string[]).includes(query.group_by)) return fail(reply, 400, `group_by inválido (use ${METRICS_GROUP_BY.join(", ")})`);
    const report = await runtimeOf(request).metrics(window.window);
    return pickGroups(report, query.group_by as MetricsGroupBy | undefined);
  });

  // Quanto o agente economizaria (ou gastaria a mais) com outro modelo: só estima, quem troca é o dono (PATCH /agents/:id).
  scope.get(MODEL_SAVING_PATH, async (request, reply): Promise<ModelSaving | ApiErrorBody> => {
    const query = request.query as { agentId?: string; model?: string };
    const agentId = typeof query.agentId === "string" ? query.agentId.trim() : "";
    const model = typeof query.model === "string" ? query.model.trim() : "";
    if (!agentId) return fail(reply, 400, "Informe o agente (agentId)");
    if (!model || model.length > 100) return fail(reply, 400, "Informe o modelo novo (model, até 100 caracteres)");
    return runtimeOf(request).modelSaving(agentId, model);
  });
}
