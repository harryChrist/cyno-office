import {
  DEFAULT_ACCOUNT_ID,
  ENGINE_ACCOUNTS_PATH,
  ENGINE_LABELS,
  createEngineAccountSchema,
  engineAccountIdSchema,
  patchEngineAccountSchema,
  type ApiErrorBody,
  type EngineAccount,
  type EngineAccountResponse,
  type EngineAccountsResponse,
} from "@cyno/shared";
import type { FastifyInstance } from "fastify";
import type { EngineAccountStore } from "../engines/accounts/account-store";
import type { AccountLoginChecker } from "../engines/accounts/login-status";

export type EngineAccountRoutesDeps = {
  store: EngineAccountStore;
  loginChecker: AccountLoginChecker;
  onCreated?: (account: EngineAccount) => void;
  onRemoved?: (account: EngineAccount) => Promise<void> | void;
  record?: (action: string, summary: string, data?: Record<string, unknown>) => void;
};

/**
 * Rotas das contas por motor (`/api/engines/accounts`):
 * - `GET /api/engines/accounts`: lista as contas padrão sintéticas (`id: "padrao"`, `isDefault: true`) e
 *   as contas extras, todas com `loggedIn: boolean` (cache curto de 10 s; sem caminhos em disco);
 * - `POST /api/engines/accounts`: cria conta (`201`, teto técnico de 100 por motor, `409` em rótulo repetido);
 * - `PATCH /api/engines/accounts/:id`: renomeia (`400` para `padrao`, `404` em id desconhecido, `409` em rótulo repetido);
 * - `DELETE /api/engines/accounts/:id`: para o poller, apaga a pasta isolada e remove da lista (`204`, `400` para `padrao`).
 * Tudo fica atrás do portão de autenticação de `registerAuth`.
 */
export function registerEngineAccountRoutes(app: FastifyInstance, deps: EngineAccountRoutesDeps): void {
  app.get(ENGINE_ACCOUNTS_PATH, async (): Promise<EngineAccountsResponse> => ({
    accounts: await deps.loginChecker.listWithStatus(),
  }));

  app.post(ENGINE_ACCOUNTS_PATH, async (request, reply): Promise<EngineAccountResponse> => {
    const { engine, label } = createEngineAccountSchema.parse(request.body ?? {});
    const account = await deps.store.create(engine, label);
    deps.loginChecker.setCached(account.engine, account.id, false);
    deps.onCreated?.(account);
    deps.record?.("conta_motor_criada", `Você criou a conta "${account.label}" do ${ENGINE_LABELS[account.engine]}`, {
      accountId: account.id,
      engine: account.engine,
      label: account.label,
    });
    return reply.code(201).send({ account: { ...account, loggedIn: false } });
  });

  app.patch<{ Params: { id: string } }>(`${ENGINE_ACCOUNTS_PATH}/:id`, async (request, reply): Promise<EngineAccountResponse | ApiErrorBody> => {
    const id = request.params.id;
    if (id === DEFAULT_ACCOUNT_ID) {
      return reply.code(400).send({ error: "A conta padrão não pode ser renomeada." } satisfies ApiErrorBody);
    }
    if (!engineAccountIdSchema.safeParse(id).success) {
      return reply.code(404).send({ error: `Conta "${id}" não encontrada.` } satisfies ApiErrorBody);
    }
    const before = deps.store.get(id);
    if (!before) return reply.code(404).send({ error: `Conta "${id}" não encontrada.` } satisfies ApiErrorBody);
    const { label } = patchEngineAccountSchema.parse(request.body ?? {});
    const account = await deps.store.rename(id, label);
    deps.record?.("conta_motor_renomeada", `Você renomeou a conta do ${ENGINE_LABELS[account.engine]} de "${before.label}" para "${account.label}"`, {
      accountId: account.id,
      engine: account.engine,
      before: before.label,
      label: account.label,
    });
    return { account: await deps.loginChecker.viewOf(account) };
  });

  app.delete<{ Params: { id: string } }>(`${ENGINE_ACCOUNTS_PATH}/:id`, async (request, reply) => {
    const id = request.params.id;
    if (id === DEFAULT_ACCOUNT_ID) {
      return reply.code(400).send({ error: "A conta padrão não pode ser removida." } satisfies ApiErrorBody);
    }
    if (!engineAccountIdSchema.safeParse(id).success) {
      return reply.code(404).send({ error: `Conta "${id}" não encontrada.` } satisfies ApiErrorBody);
    }
    const existing = deps.store.get(id);
    if (!existing) return reply.code(404).send({ error: `Conta "${id}" não encontrada.` } satisfies ApiErrorBody);
    // Para o poller antes de apagar a pasta de perfil para não correr contra uma consulta em curso.
    await deps.onRemoved?.(existing);
    const removed = await deps.store.remove(id);
    deps.loginChecker.invalidate(removed.engine, removed.id);
    deps.record?.("conta_motor_removida", `Você removeu a conta "${removed.label}" do ${ENGINE_LABELS[removed.engine]}`, {
      accountId: removed.id,
      engine: removed.engine,
      label: removed.label,
    });
    return reply.code(204).send();
  });
}
