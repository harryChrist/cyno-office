import { CYNO_SETTINGS_PATH, updateCynoSettingsBodySchema, type CynoSettingsResponse, JOINT_PATH, jointCancelBodySchema, type JointsResponse, type JointView, CONFIRMATIONS_PATH, PROPOSALS_PATH, type ConfirmationsResponse, type ProposalsResponse, SENT_REQUESTS_PATH, type SentRequestsResponse, CARDS_PATH, PLATFORM_REPORTS_PATH, type PlatformReport, CYNO_PATH, WAITING_PATH, updateCardSummaryBodySchema, type Card, type CardsResponse, type WaitingResponse, CYNO_WS_PATH, cynoMessageBodySchema, cynoModelBodySchema, type CynoMessageResponse, type CynoServerEvent, type CynoSnapshot, type CynoState } from "@cyno/shared";
import type { WebSocket } from "@fastify/websocket";
import type { FastifyInstance } from "fastify";
import { HttpError } from "../platform/http/errors";
import { renderPlatformReportHtml } from "../platform/reports/render-html";
import { renderPlatformReportMarkdown, renderPlatformReportText } from "../platform/reports/platform-reports";
import type { AttentionService } from "../platform/attention/service";
import type { CynoService } from "../platform/cyno/cyno-service";
import { hasPeriodFormat } from "../workspace/reports/period";

/**
 * O Cyno (o agente da plataforma, fora dos workspaces). Todas as rotas ficam atrás da senha do app
 * (o portão do `onRequest` vale também para o websocket):
 * - GET  /api/cyno                   -> CynoSnapshot (estado e as entradas recentes do chat/atividade)
 * - POST /api/cyno/messages          -> { id } (o dono fala; acorda o Cyno se ele dorme) · 409 sem motor de CLI
 * - GET/PATCH /api/cyno/settings     -> CynoSettingsResponse (minutos até dormir, teto de turnos por dia, resumo opcional; o teto vale de verdade)
 * - POST /api/cyno/new-conversation  -> CynoState (a próxima mensagem abre uma conversa limpa)
 * - PUT  /api/cyno/model             -> CynoState (motor/modelo/esforço; reinicia quando livre)
 * - GET  /api/cyno/cards            -> CardsResponse (a ficha de cada workspace, calculada por código)
 * - PUT  /api/cyno/cards/:ws         -> Card (a frase "o que este workspace faz"; só o dono grava por aqui)
 * - DELETE /api/cyno/cards/:ws/proposal -> Card (o dono ignora a sugestão de frase de uma IA)
 * - GET  /api/cyno/waiting           -> WaitingResponse (o "Esperando você" de todos os workspaces)
 * - GET  /api/cyno/requests         -> SentRequestsResponse (os pedidos que o Cyno enviou aos Maestros, com o estado de cada um, por código)
 * - GET  /api/cyno/joints             -> JointsResponse (os projetos conjuntos, com o estado de cada parte, por código)
 * - POST /api/cyno/joints/:id/cancel|pause|resume -> JointView (o dono cancela, pausa ou retoma o conjunto inteiro)
 * - POST /api/cyno/joints/:id/parts/:ref/retry -> JointView (refaz uma parte que falhou ou foi cancelada)
 * - GET  /api/cyno/confirmations    -> ConfirmationsResponse (as ações perigosas que o Cyno pediu, com a validade)
 * - POST /api/cyno/confirmations/:id/approve -> Confirmation (O OK do dono: executa SÓ os parâmetros gravados, uma vez)
 * - POST /api/cyno/confirmations/:id/reject  -> Confirmation (recusa; nada acontece e o Cyno é avisado)
 * - GET  /api/cyno/proposals         -> ProposalsResponse (as propostas de workspace)
 * - POST /api/cyno/proposals/:id/approve -> WorkspaceProposal ("Criar workspace": cria tudo por código; falhou = desfaz)
 * - POST /api/cyno/proposals/:id/reject  -> WorkspaceProposal
 * - GET  /api/cyno/ws                -> websocket: `cyno:snapshot`, depois `cyno:log` e `cyno:status` ao vivo (e os `attention:*`)
 */
export function registerCynoRoutes(app: FastifyInstance, cyno: CynoService, options: { heartbeatMs: number; attention?: AttentionService }): void {
  app.get(CYNO_PATH, async (): Promise<CynoSnapshot> => cyno.snapshot());

  app.post(`${CYNO_PATH}/messages`, async (request, reply): Promise<CynoMessageResponse> => {
    const { text } = cynoMessageBodySchema.parse(request.body ?? {});
    reply.code(202);
    return { id: cyno.send(text) };
  });

  app.get(CYNO_SETTINGS_PATH, async (): Promise<CynoSettingsResponse> => cyno.settingsView());

  app.patch(CYNO_SETTINGS_PATH, async (request): Promise<CynoSettingsResponse> => cyno.updateSettings(updateCynoSettingsBodySchema.parse(request.body ?? {})));

  app.post(`${CYNO_PATH}/new-conversation`, async (): Promise<CynoState> => cyno.newConversation());

  app.put(`${CYNO_PATH}/model`, async (request): Promise<CynoState> => {
    const { choice } = cynoModelBodySchema.parse(request.body ?? {});
    return cyno.setChoice(choice);
  });

  app.get(CARDS_PATH, async (): Promise<CardsResponse> => ({ cards: cyno.cardList() }));

  app.put(`${CARDS_PATH}/:ws`, async (request): Promise<Card> => {
    const { ws } = request.params as { ws: string };
    const { summary } = updateCardSummaryBodySchema.parse(request.body ?? {});
    await cyno.writeSummary(ws, summary, "dono");
    return cardOf(cyno, ws);
  });

  app.delete(`${CARDS_PATH}/:ws/proposal`, async (request): Promise<Card> => {
    const { ws } = request.params as { ws: string };
    await cyno.dismissSummaryProposal(ws);
    return cardOf(cyno, ws);
  });

  // A semana da plataforma (a soma dos workspaces): json, html (página isolada, sem script), md ou text. `period` = "latest" ou "2026-W46".
  app.get(`${PLATFORM_REPORTS_PATH}/week/:period`, async (request, reply) => {
    const { period } = request.params as { period: string };
    const { format = "json" } = request.query as { format?: string };
    if (!["json", "html", "md", "text"].includes(format)) throw new HttpError(400, "Formato inválido (use json, html, md ou text)");
    if (period !== "latest" && !hasPeriodFormat("week", period)) throw new HttpError(400, "Semana inválida (use latest ou algo como 2026-W46)");
    const report = await cyno.platformReport(period);
    if (!report) throw new HttpError(404, "Ainda não há semana da plataforma fechada para esse período");
    if (format === "json") return report satisfies PlatformReport;
    reply.header("x-content-type-options", "nosniff");
    if (format === "html") return reply.header("content-type", "text/html; charset=utf-8").header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox").send(renderPlatformReportHtml(report));
    if (format === "md") return reply.header("content-type", "text/markdown; charset=utf-8").send(renderPlatformReportMarkdown(report));
    return reply.header("content-type", "text/plain; charset=utf-8").send(renderPlatformReportText(report));
  });

  app.get(SENT_REQUESTS_PATH, async (): Promise<SentRequestsResponse> => ({ requests: cyno.requestViews() }));

  // Projetos que envolvem mais de um workspace: o estado de cada parte (por código) e as ações do dono sobre o conjunto.
  app.get(JOINT_PATH, async (): Promise<JointsResponse> => ({ joints: cyno.jointViews() }));
  app.post(`${JOINT_PATH}/:id/cancel`, async (request): Promise<JointView> => {
    const { reason } = jointCancelBodySchema.parse(request.body ?? {});
    const id = idOf(request.params);
    await cyno.cancelJoint(id, reason ?? "Cancelado pelo dono");
    return jointOf(cyno, id);
  });
  app.post(`${JOINT_PATH}/:id/pause`, async (request): Promise<JointView> => {
    const id = idOf(request.params);
    await cyno.setJointPaused(id, true);
    return jointOf(cyno, id);
  });
  app.post(`${JOINT_PATH}/:id/resume`, async (request): Promise<JointView> => {
    const id = idOf(request.params);
    await cyno.setJointPaused(id, false);
    return jointOf(cyno, id);
  });
  app.post(`${JOINT_PATH}/:id/parts/:ref/retry`, async (request): Promise<JointView> => {
    const params = request.params as { id: string; ref: string };
    await cyno.retryJointPart(params.id, params.ref);
    return jointOf(cyno, params.id);
  });

  // Só o dono, com a sessão (o portão de senha vale aqui; o token MCP de um agente só abre /mcp): são as únicas rotas que executam ações perigosas.
  app.get(CONFIRMATIONS_PATH, async (): Promise<ConfirmationsResponse> => ({ confirmations: cyno.confirmations() }));
  app.post(`${CONFIRMATIONS_PATH}/:id/approve`, async (request) => cyno.approveConfirmation(idOf(request.params)));
  app.post(`${CONFIRMATIONS_PATH}/:id/reject`, async (request) => cyno.rejectConfirmation(idOf(request.params)));
  app.get(PROPOSALS_PATH, async (): Promise<ProposalsResponse> => ({ proposals: cyno.proposals() }));
  app.post(`${PROPOSALS_PATH}/:id/approve`, async (request) => cyno.approveProposal(idOf(request.params)));
  app.post(`${PROPOSALS_PATH}/:id/reject`, async (request) => cyno.rejectProposal(idOf(request.params)));

  app.get(WAITING_PATH, async (): Promise<WaitingResponse> => ({ items: cyno.waiting() }));

  app.get(CYNO_WS_PATH, { websocket: true }, (socket: WebSocket) => {
    const send = (event: CynoServerEvent) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(event));
    };
    // Assina antes do snapshot: nada cai entre o retrato e o ao vivo (o cliente junta por id).
    const queued: CynoServerEvent[] = [];
    let ready = false;
    const unsubscribe = cyno.subscribe((event) => (ready ? send(event) : queued.push(event)));
    // Os alertas de atenção (`attention:*`) saem pelo mesmo socket; o estado inicial vem por GET /api/attention.
    const unsubscribeAttention = options.attention?.subscribe((event) => (ready ? send(event) : queued.push(event)));
    void cyno
      .snapshot()
      .then((snapshot) => {
        send({ type: "cyno:snapshot", ...snapshot });
        ready = true;
        for (const event of queued.splice(0)) send(event);
      })
      .catch((error: unknown) => {
        app.log.error({ err: error }, "não foi possível montar o snapshot do Cyno");
        socket.close(1011, "erro ao carregar o Cyno");
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
      unsubscribeAttention?.();
    });
    socket.on("error", (error) => app.log.debug({ err: error }, "erro no WebSocket do Cyno"));
  });
}

const idOf = (params: unknown): string => String((params as { id?: unknown }).id ?? "");

function jointOf(cyno: CynoService, id: string): JointView {
  const joint = cyno.jointViews().find((candidate) => candidate.id === id.trim().toUpperCase());
  if (!joint) throw new HttpError(404, "Projeto conjunto não encontrado");
  return joint;
}

function cardOf(cyno: CynoService, workspace: string): Card {
  const card = cyno.cards.card(workspace);
  if (!card) throw new HttpError(404, "Workspace não encontrado");
  return card;
}
