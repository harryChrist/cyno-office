import { SCENE_LIVE_PATH, WS_CLOSE_WORKSPACE_NOT_FOUND, WS_WORKSPACE_PARAM } from "@cyno/shared";
import type { FastifyInstance } from "fastify";
import type { WorkspaceManager } from "../platform/workspaces/manager";

export type SceneLiveRouteOptions = {
  /** Intervalo do ping; quem não responder com pong até o próximo ping é desconectado. */
  heartbeatMs: number;
  /** `CYNO_SCENE_LIVE`: com a chave desligada a rota recusa a conexão (404) e nada do serviço roda. */
  enabled: boolean;
};

/**
 * WebSocket da cena ao vivo: `/ws/scene?workspace=<id>` (só servidor -> cliente; protocolo em `shared/scene-live.ts`).
 * A conexão aberta é o "estou olhando": a primeira liga a simulação do workspace e a última, depois da folga, desliga.
 *
 * - Autenticação: a mesma do `/ws` (o portão `onRequest` da senha barra tudo, inclusive o upgrade).
 * - Chave `CYNO_SCENE_LIVE` desligada: 404 antes do upgrade.
 * - Workspace inexistente (ou sem `?workspace=` e sem nenhum workspace): fecha com o código 4404, como o `/ws`.
 * - Heartbeat (ping/pong) como o `/ws`: socket morto é derrubado (e a assinatura sai).
 */
export function registerSceneLiveRoute(app: FastifyInstance, manager: WorkspaceManager, options: SceneLiveRouteOptions): void {
  app.get(
    SCENE_LIVE_PATH,
    {
      websocket: true,
      preValidation: async (_request, reply) => {
        if (!options.enabled) return reply.code(404).send({ error: "A cena ao vivo está desligada (CYNO_SCENE_LIVE)." });
        return undefined;
      },
    },
    (socket, request) => {
      const query = request.query as Record<string, string | undefined>;
      const requested = query[WS_WORKSPACE_PARAM] || manager.list()[0]?.id || "";
      const live = requested ? manager.find(requested)?.sceneLive : undefined;
      if (!live) {
        socket.close(WS_CLOSE_WORKSPACE_NOT_FOUND, "workspace não encontrado");
        return;
      }
      const unsubscribe = live.subscribe((wire) => {
        if (socket.readyState === socket.OPEN) socket.send(wire);
      });
      let alive = true;
      socket.on("pong", () => {
        alive = true;
      });
      const heartbeat = setInterval(() => {
        if (!alive) {
          socket.terminate();
          return;
        }
        alive = false;
        socket.ping();
      }, options.heartbeatMs);
      heartbeat.unref();
      socket.on("close", () => {
        clearInterval(heartbeat);
        unsubscribe();
      });
      socket.on("error", (error) => app.log.debug({ err: error }, "erro no WebSocket da cena ao vivo"));
    },
  );
}
