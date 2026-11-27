import {
  GIT_CLONE_PATH,
  GIT_CREDENTIALS_PATH,
  createGitCredentialSchema,
  gitCloneBodySchema,
  gitCloneIdSchema,
  gitCredentialIdSchema,
  type ApiErrorBody,
  type GitCloneJobResponse,
  type GitCredentialResponse,
  type GitCredentialsResponse,
} from "@cyno/shared";
import type { FastifyInstance } from "fastify";
import type { GitCloneService } from "../platform/git/clone";
import type { GitCredentialStore } from "../platform/git/credentials";

export type GitRoutesDeps = {
  credentials: GitCredentialStore;
  clone: GitCloneService;
  record?: (action: string, summary: string, data?: Record<string, unknown>) => void;
};

/**
 * Rotas do cofre de credenciais e clone de repositórios git:
 * - `GET /api/git/credentials`: lista credenciais (apenas `hasSecret: true`, nunca o segredo);
 * - `POST /api/git/credentials`: cadastra credencial (201, nunca devolve o segredo);
 * - `DELETE /api/git/credentials/:id`: remove credencial e o arquivo do segredo (204);
 * - `POST /api/git/clone`: inicia/enfileira um clone (202, devolve o job);
 * - `GET /api/git/clone/:id`: consulta estado, progresso e resultado do clone.
 * Todas ficam atrás do portão de autenticação de `registerAuth`.
 */
export function registerGitRoutes(app: FastifyInstance, deps: GitRoutesDeps): void {
  app.get(GIT_CREDENTIALS_PATH, async (): Promise<GitCredentialsResponse> => ({
    credentials: deps.credentials.list(),
  }));

  app.post(GIT_CREDENTIALS_PATH, async (request, reply): Promise<GitCredentialResponse> => {
    const body = createGitCredentialSchema.parse(request.body ?? {});
    const credential = await deps.credentials.create(body);
    deps.record?.("git_credencial_criada", `Você cadastrou a credencial do git "${credential.label}" (${credential.host})`, {
      credentialId: credential.id,
      label: credential.label,
      host: credential.host,
      kind: credential.kind,
    });
    return reply.code(201).send({ credential });
  });

  app.delete<{ Params: { id: string } }>(`${GIT_CREDENTIALS_PATH}/:id`, async (request, reply) => {
    const { id } = request.params;
    if (!gitCredentialIdSchema.safeParse(id).success) {
      return reply.code(404).send({ error: "Credencial não encontrada." } satisfies ApiErrorBody);
    }
    const removed = await deps.credentials.remove(id);
    deps.record?.("git_credencial_removida", `Você removeu a credencial do git "${removed.label}" (${removed.host})`, {
      credentialId: removed.id,
      label: removed.label,
      host: removed.host,
      kind: removed.kind,
    });
    return reply.code(204).send();
  });

  app.post(GIT_CLONE_PATH, async (request, reply): Promise<GitCloneJobResponse> => {
    const body = gitCloneBodySchema.parse(request.body ?? {});
    const job = await deps.clone.start(body);
    deps.record?.("git_clone_iniciado", `Você iniciou o clone de "${job.name}"`, {
      jobId: job.id,
      name: job.name,
      url: job.url,
    });
    return reply.code(202).send({ job });
  });

  app.get<{ Params: { id: string } }>(`${GIT_CLONE_PATH}/:id`, async (request, reply): Promise<GitCloneJobResponse | ApiErrorBody> => {
    const { id } = request.params;
    if (!gitCloneIdSchema.safeParse(id).success) {
      return reply.code(404).send({ error: "Clone não encontrado." } satisfies ApiErrorBody);
    }
    const job = deps.clone.get(id);
    if (!job) {
      return reply.code(404).send({ error: "Clone não encontrado." } satisfies ApiErrorBody);
    }
    return { job };
  });
}
