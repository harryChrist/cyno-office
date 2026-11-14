import {
  DEFAULT_USD_BRL,
  SPEND_SETTINGS_PATH,
  updateSpendSettingsBodySchema,
  usageHistoryQuerySchema,
  type ApiErrorBody,
  type OfficeState,
  USAGE_TASK_COSTS_PATH,
  type SpendSettingsResponse,
  type UsageHistoryResponse,
  type UsageTaskCostsResponse,
  type UsageTaskHistoryResponse,
} from "@cyno/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { taskCostsOf } from "../workspace/activity/cost";
import type { SpendSettingsStore } from "../engines/usage/spend-settings";
import { aggregateHistory, aggregateTask, rangeMs } from "../engines/usage/usage-aggregate";
import type { UsageHistory } from "../engines/usage/usage-history";
import { addDays, dayKeyOf } from "../engines/usage/usage-time";

declare module "fastify" {
  interface FastifyInstance {
    /** Cotação USD→BRL dos gastos (DATA_DIR/spend.json). */
    spendSettings?: SpendSettingsStore;
  }
}

/** Intervalo máximo de uma consulta (dias). */
const MAX_DAYS = 3700;

/**
 * Histórico de gastos do workspace ("quanto custaria na API"; as assinaturas não cobram por token):
 * - GET /api/w/:ws/usage/history?from&to&groupBy=day|week|month|agent|model|task|provider&stackBy=agent|model&agentId&provider
 *   -> UsageHistoryResponse (dias no fuso de São Paulo, semanas começando na segunda; padrão: últimos 30 dias por dia);
 * - GET /api/w/:ws/usage/task-costs -> UsageTaskCostsResponse (o que cada tarefa custou; alimenta o cartão da tarefa e o painel do agente);
 * - GET /api/w/:ws/usage/history/task/:taskId -> UsageTaskHistoryResponse (o pedido, as subtarefas, agentes e turnos; 404 sem nada).
 */
export function registerUsageHistoryRoutes(
  scope: FastifyInstance,
  historyOf: (request: FastifyRequest) => Pick<UsageHistory, "read">,
  officeOf: (request: FastifyRequest) => Pick<OfficeState, "agents" | "tasks">,
): void {
  const usdBrl = (request: FastifyRequest) => request.server.spendSettings?.usdBrl() ?? DEFAULT_USD_BRL;

  scope.get("/usage/history", async (request, reply): Promise<UsageHistoryResponse | ApiErrorBody> => {
    const query = usageHistoryQuerySchema.parse(request.query);
    const today = dayKeyOf(Date.now());
    const toDay = query.to ?? today;
    const fromDay = query.from ?? addDays(toDay, -29);
    if (fromDay > toDay) return reply.code(400).send({ error: "`from` depois de `to`" } satisfies ApiErrorBody);
    if (addDays(fromDay, MAX_DAYS) < toDay) return reply.code(400).send({ error: `Intervalo grande demais (máximo ${MAX_DAYS} dias)` } satisfies ApiErrorBody);
    const { fromMs, toMs } = rangeMs(fromDay, toDay);
    const records = await historyOf(request).read(fromMs, toMs);
    return aggregateHistory(
      records,
      { fromDay, toDay, groupBy: query.groupBy, stackBy: query.stackBy, agentId: query.agentId, provider: query.provider, usdBrl: usdBrl(request) },
      officeOf(request),
    );
  });

  scope.get(USAGE_TASK_COSTS_PATH, async (request): Promise<UsageTaskCostsResponse> => {
    const history = historyOf(request);
    return { tasks: Object.fromEntries(taskCostsOf(await history.read())) };
  });

  scope.get("/usage/history/task/:taskId", async (request, reply): Promise<UsageTaskHistoryResponse | ApiErrorBody> => {
    const { taskId } = request.params as { taskId: string };
    const records = await historyOf(request).read();
    const result = aggregateTask(records, taskId, usdBrl(request), officeOf(request));
    if (!result) return reply.code(404).send({ error: "Nenhum gasto registrado para esta tarefa" } satisfies ApiErrorBody);
    return result;
  });
}

/**
 * Cotação dos gastos (da instalação):
 * - GET /api/settings/spend -> SpendSettingsResponse;
 * - PUT /api/settings/spend { usdBrl } -> SpendSettingsResponse (400 fora de 0,01–1000).
 */
export function registerSpendSettingsRoutes(app: FastifyInstance, store: SpendSettingsStore, now: () => Date): void {
  app.get(SPEND_SETTINGS_PATH, async (): Promise<SpendSettingsResponse> => store.snapshot());
  app.put(SPEND_SETTINGS_PATH, async (request): Promise<SpendSettingsResponse> => {
    const { usdBrl } = updateSpendSettingsBodySchema.parse(request.body ?? {});
    return store.setUsdBrl(usdBrl, now());
  });
}
