import type { HealthResponse } from "@cyno/shared";
import type { FastifyInstance } from "fastify";

export function registerHealthRoutes(app: FastifyInstance): void {
  app.get("/api/health", async (): Promise<HealthResponse> => ({ ok: true }));
}
