import { boardExportQuerySchema, boardFileName, boardParamsSchema, buildBoardDocument, BOARD_CSP_HEADER, publicBoardMeta, setBoardShareBodySchema, type BoardShare } from "@cyno/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { clientIp } from "../platform/auth/routes";
import { HttpError } from "../platform/http/errors";
import type { WorkspaceManager } from "../platform/workspaces/manager";
import type { BoardShareStore } from "../workspace/board/share-store";
import { BoardPdfTimeoutError, renderBoardPdf } from "../workspace/browser/render-board";
import type { WorkspaceRuntime } from "../workspace/runtime";
import type { RuntimeOf } from "./media";

/** Teto dos dados de um quadro aberto por link (acima disso, só pelo app). */
export const PUBLIC_BOARD_MAX_DATA_BYTES = 8 * 1024 * 1024;
/** Pedidos por IP e por minuto na rota pública. */
export const PUBLIC_BOARD_RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60_000;

/** Nome para o Content-Disposition: ASCII de reserva e o nome real em UTF-8 (RFC 5987). */
function attachment(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

/** O documento HTML de um quadro (página + dados do disco, meta pública), como o link e o PDF mostram. */
async function boardDocument(runtime: WorkspaceRuntime, id: string): Promise<{ html: string; title: string }> {
  const board = runtime.boards.get(id);
  const [html, dataText] = await Promise.all([runtime.boards.readPage(id), runtime.boards.readData(id)]);
  const data = ((): unknown => {
    try {
      return JSON.parse(dataText);
    } catch {
      return {};
    }
  })();
  return { html: buildBoardDocument({ html, data, meta: publicBoardMeta(board) }), title: board.title };
}

/**
 * Rotas do DONO dentro de /api/w/:ws (autenticadas):
 * - GET/PUT/DELETE /boards/:id/share   -> estado, liga ou troca a validade, desliga
 * - POST           /boards/:id/share/rotate -> token novo (409 se não está compartilhado)
 * - GET            /boards/:id/export?format=pdf -> o PDF do quadro (gerado num navegador isolado)
 */
export function registerBoardShareRoutes(scope: FastifyInstance, runtimeOf: RuntimeOf, shares: () => BoardShareStore): void {
  const wsOf = (request: FastifyRequest) => (request.params as { ws: string }).ws;

  scope.get("/boards/:id/share", async (request): Promise<BoardShare> => {
    const { id } = boardParamsSchema.parse(request.params);
    runtimeOf(request).boards.get(id);
    return shares().get(wsOf(request), id);
  });

  scope.put("/boards/:id/share", async (request): Promise<BoardShare> => {
    const { id } = boardParamsSchema.parse(request.params);
    runtimeOf(request).boards.get(id);
    const body = setBoardShareBodySchema.parse(request.body ?? {});
    return shares().set(wsOf(request), id, body.expiresInDays);
  });

  scope.post("/boards/:id/share/rotate", async (request): Promise<BoardShare> => {
    const { id } = boardParamsSchema.parse(request.params);
    runtimeOf(request).boards.get(id);
    const rotated = await shares().rotate(wsOf(request), id);
    if (!rotated) throw new HttpError(409, "Este quadro não está compartilhado. Ligue o link antes de trocá-lo.");
    return rotated;
  });

  scope.delete("/boards/:id/share", async (request, reply) => {
    const { id } = boardParamsSchema.parse(request.params);
    runtimeOf(request).boards.get(id);
    await shares().remove(wsOf(request), id);
    return reply.code(204).send();
  });

  scope.get("/boards/:id/export", async (request, reply) => {
    const { id } = boardParamsSchema.parse(request.params);
    boardExportQuerySchema.parse(request.query ?? {});
    // O PDF não usa o navegador dos agentes do workspace: abre um Chromium próprio, sem rede, só com o documento do quadro.
    const { html, title } = await boardDocument(runtimeOf(request), id);
    let pdf: Buffer;
    try {
      pdf = await renderBoardPdf(html);
    } catch (error) {
      if (error instanceof BoardPdfTimeoutError || (error instanceof Error && error.name === "BoardPdfTimeoutError")) return reply.code(504).send({ error: "O PDF demorou demais para ficar pronto. Tente de novo ou use um quadro menor." });
      const reason = error instanceof Error ? (error.message.split("\n")[0] ?? "") : String(error);
      // Sem Chromium instalado na máquina do servidor, o Playwright diz que o executável não existe.
      const missing = /executable doesn't exist|chromium.*not found|browserType\.launch/i.test(reason);
      return reply.code(502).send({ error: missing ? "O servidor não achou o Chromium para gerar o PDF. Baixe a Página (HTML) e imprima pelo seu navegador." : `Não foi possível gerar o PDF: ${reason}` });
    }
    return reply
      .header("Content-Type", "application/pdf")
      .header("Content-Disposition", attachment(boardFileName(title, "pdf")))
      .header("Cache-Control", "private, no-store")
      .header("X-Content-Type-Options", "nosniff")
      .send(pdf);
  });
}

// ---------- Rota pública ----------

const page = (message: string) =>
  `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${message}</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:system-ui,sans-serif;background:#111;color:#ddd}p{font-size:1.1rem;padding:1rem;text-align:center}</style></head><body><p>${message}</p></body></html>`;

const GONE_PAGE = page("Este link não está mais disponível.");
const TOO_BIG_PAGE = page("Este quadro é grande demais para abrir por link.");
const BUSY_PAGE = page("Muitos pedidos. Tente de novo em instantes.");

/** Cabeçalhos de toda resposta da rota pública (a CSP com sandbox só vale para a página; as de erro não têm script). */
function sealed(reply: FastifyReply, csp: string): FastifyReply {
  return reply
    .header("Content-Type", "text/html; charset=utf-8")
    .header("Content-Security-Policy", csp)
    .header("Referrer-Policy", "no-referrer")
    .header("X-Content-Type-Options", "nosniff")
    .header("Cache-Control", "no-store")
    .header("X-Robots-Tag", "noindex, nofollow");
}

export type PublicBoardRouteOptions = { now?: () => number };

/**
 * GET /api/share/:token (e HEAD), FORA do escopo do workspace e aberta no portão da senha (veja `isAuthExempt`).
 * O token é validado aqui dentro: malformado, desconhecido, revogado, vencido e quadro apagado dão a MESMA resposta
 * (404, mesmo corpo e mesmos cabeçalhos). A rota não lê cookie, não manda cookie e não registra o token no log
 * (`logLevel: "silent"` desliga o log de requisição dela, que traria a URL).
 */
export function registerPublicBoardRoute(app: FastifyInstance, manager: WorkspaceManager, shares: () => BoardShareStore, options: PublicBoardRouteOptions = {}): void {
  const now = options.now ?? Date.now;
  const hits = new Map<string, { count: number; resetAt: number }>();

  const limited = (ip: string): boolean => {
    const at = now();
    if (hits.size > 2000) for (const [key, slot] of hits) if (slot.resetAt <= at) hits.delete(key);
    let slot = hits.get(ip);
    if (!slot || slot.resetAt <= at) {
      slot = { count: 0, resetAt: at + RATE_WINDOW_MS };
      hits.set(ip, slot);
    }
    slot.count++;
    return slot.count > PUBLIC_BOARD_RATE_LIMIT;
  };

  // Curinga em vez de :token: um parâmetro comprido demais viraria 414 do Fastify, uma resposta diferente das demais.
  app.get("/api/share/*", { logLevel: "silent" }, async (request, reply) => {
    if (limited(clientIp(request))) return sealed(reply, "default-src 'none'; style-src 'unsafe-inline'").code(429).header("Retry-After", "60").send(BUSY_PAGE);
    const gone = () => sealed(reply, "default-src 'none'; style-src 'unsafe-inline'").code(404).send(GONE_PAGE);
    const token = (request.params as { "*": string })["*"] ?? "";
    const found = await shares().find(token);
    if (!found) return gone();
    const runtime = manager.find(found.ws);
    const board = runtime?.boards.find(found.boardId);
    if (!runtime || !board) {
      // Quadro apagado (ou workspace removido): o link morre junto.
      await shares().remove(found.ws, found.boardId).catch(() => undefined);
      return gone();
    }
    if (board.dataBytes > PUBLIC_BOARD_MAX_DATA_BYTES) return sealed(reply, "default-src 'none'; style-src 'unsafe-inline'").code(413).send(TOO_BIG_PAGE);
    const dataText = await runtime.boards.readData(board.id);
    if (Buffer.byteLength(dataText) > PUBLIC_BOARD_MAX_DATA_BYTES) return sealed(reply, "default-src 'none'; style-src 'unsafe-inline'").code(413).send(TOO_BIG_PAGE);
    const { html } = await boardDocument(runtime, board.id);
    return sealed(reply, BOARD_CSP_HEADER).code(200).send(html);
  });
}
