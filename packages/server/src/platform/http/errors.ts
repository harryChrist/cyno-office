import { toValidationIssues, type ApiErrorBody } from "@cyno/shared";
import type { FastifyInstance } from "fastify";
import { ZodError } from "zod";

/** Erro de regra de negócio com status HTTP (404, 409, 422...). */
export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

function clientStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("statusCode" in error)) return undefined;
  const { statusCode } = error;
  return typeof statusCode === "number" && statusCode >= 400 && statusCode < 500 ? statusCode : undefined;
}

/** Respostas de erro no formato { error, details? } da API. */
export function installErrorHandlers(app: FastifyInstance): void {
  app.setNotFoundHandler((_request, reply) => {
    const body: ApiErrorBody = { error: "Rota não encontrada" };
    return reply.code(404).send(body);
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      const body: ApiErrorBody = { error: "Dados inválidos", details: toValidationIssues(error) };
      return reply.code(400).send(body);
    }
    const status = clientStatus(error);
    if (status !== undefined) {
      const message = error instanceof Error ? error.message : "Requisição inválida";
      return reply.code(status).send({ error: message } satisfies ApiErrorBody);
    }
    request.log.error({ err: error }, "erro inesperado");
    return reply.code(500).send({ error: "Erro interno do servidor" } satisfies ApiErrorBody);
  });
}
