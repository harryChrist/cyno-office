import type { HealthResponse } from "@cyno/shared";
import type { FastifyInstance } from "fastify";

/** `sceneLive`: a cena ao vivo está ligada (`CYNO_SCENE_LIVE`); a tela só abre o WebSocket dela quando o /api/health avisa, sem gerar erro de rede à toa. */
export function registerHealthRoutes(app: FastifyInstance, options: { sceneLive?: boolean } = {}): void {
  app.get("/api/health", async (): Promise<HealthResponse> => (options.sceneLive ? { ok: true, sceneLive: true } : { ok: true }));
}
