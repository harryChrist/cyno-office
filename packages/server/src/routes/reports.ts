import { generateReportBodySchema, MEDIA_USER_CREATOR, REPORT_KINDS, WORKSPACE_REPORTS_GENERATE_PATH, WORKSPACE_REPORTS_PATH, type GenerateReportResult, type MediaItem, type ReportKind, type ReportList, type StoredReport } from "@cyno/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { HttpError } from "../platform/http/errors";
import { hasPeriodFormat } from "../workspace/reports/period";
import { renderReportHtml } from "../workspace/reports/render-html";
import { renderReportMarkdown } from "../workspace/reports/render-md";
import { renderReportText } from "../workspace/reports/render-text";
import type { WorkspaceRuntime } from "../workspace/runtime";

/** Largura da página do relatório na imagem (px; a imagem sai com o dobro de pixels). */
export const REPORT_IMAGE_WIDTH = 980;
export const NO_BROWSER_MESSAGE = "Ligue o navegador do workspace para gerar a imagem (Configurações > Acesso). O PDF e o Markdown continuam funcionando.";

const FORMATS = ["json", "html", "md", "text"] as const;
type Format = (typeof FORMATS)[number];

function kindOf(value: unknown): ReportKind {
  if (typeof value !== "string" || !(REPORT_KINDS as readonly string[]).includes(value)) throw new HttpError(400, `Tipo de relatório inválido (use ${REPORT_KINDS.join(", ")})`);
  return value as ReportKind;
}

/**
 * Relatórios da Gestão, dentro de /api/w/:ws (só código; nenhuma rota acorda o Maestro):
 * - GET  /reports                              -> `ReportList` (os guardados, mais novos primeiro; `imageAvailable` = navegador ligado)
 * - GET  /reports/:kind/:period[?format=json|html|md|text&base=<origem do app>] -> o relatório guardado (`period` = "latest" gera o último fechado, se faltar);
 *        o HTML sai com CSP sem script nenhum e `sandbox` (abrir direto pelo endereço também é seguro)
 * - POST /reports/generate { kind, period? }   -> `GenerateReportResult` ("Gerar agora": sem `period` = o de agora, parcial; um final guardado não muda)
 * - POST /reports/:kind/:period/image          -> 201 `MediaItem` (PNG na Biblioteca; 409 se o navegador do workspace está desligado)
 */
export function registerWorkspaceReportRoutes(scope: FastifyInstance, runtimeOf: (request: FastifyRequest) => WorkspaceRuntime): void {
  scope.get(WORKSPACE_REPORTS_PATH, async (request): Promise<ReportList> => {
    const runtime = runtimeOf(request);
    const settings = runtime.reports.settings();
    const items = (await runtime.reports.list()).sort((a, b) => b.period.localeCompare(a.period));
    return { items, imageAvailable: runtime.browser !== undefined, settings: { dailyAt: settings.dailyAt, weekly: settings.weekly }, now: runtime.now().toISOString() };
  });

  async function load(runtime: WorkspaceRuntime, kind: ReportKind, period: string): Promise<StoredReport> {
    if (period !== "latest" && !hasPeriodFormat(kind, period)) throw new HttpError(400, `Período inválido para ${kind} (use latest ou ${{ day: "2026-11-10", week: "2026-W46", month: "2026-11" }[kind]})`);
    const report = period === "latest" ? await runtime.reports.ensure(kind, "latest", "mcp") : await runtime.reports.read(kind, period);
    if (!report) throw new HttpError(404, `Não há relatório ${kind} de ${period}`);
    return report;
  }

  function send(reply: FastifyReply, format: Format, report: StoredReport, base: string | undefined): StoredReport | string {
    if (format === "json") return report;
    if (format === "html") {
      reply.header("content-type", "text/html; charset=utf-8").header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox").header("x-content-type-options", "nosniff");
      return renderReportHtml(report, base ? { linkBase: base } : {});
    }
    reply.header("x-content-type-options", "nosniff");
    if (format === "md") {
      reply.header("content-type", "text/markdown; charset=utf-8");
      return renderReportMarkdown(report);
    }
    reply.header("content-type", "text/plain; charset=utf-8");
    return renderReportText(report);
  }

  scope.get(`${WORKSPACE_REPORTS_PATH}/:kind/:period`, async (request, reply) => {
    const params = request.params as { kind: string; period: string };
    const query = request.query as { format?: string; base?: string };
    const format = query.format ?? "json";
    if (!(FORMATS as readonly string[]).includes(format)) throw new HttpError(400, `Formato inválido (use ${FORMATS.join(", ")})`);
    const report = await load(runtimeOf(request), kindOf(params.kind), params.period);
    return send(reply, format as Format, report, query.base);
  });

  scope.post(WORKSPACE_REPORTS_GENERATE_PATH, async (request): Promise<GenerateReportResult> => {
    const body = generateReportBodySchema.parse(request.body ?? {});
    try {
      return await runtimeOf(request).reports.generate(body.kind, body.period, { trigger: "manual" });
    } catch (error) {
      if (error instanceof RangeError) throw new HttpError(400, error.message);
      throw error;
    }
  });

  scope.post(`${WORKSPACE_REPORTS_PATH}/:kind/:period/image`, async (request, reply): Promise<MediaItem> => {
    const runtime = runtimeOf(request);
    const params = request.params as { kind: string; period: string };
    const browser = runtime.browser;
    if (!browser) throw new HttpError(409, NO_BROWSER_MESSAGE);
    const report = await load(runtime, kindOf(params.kind), params.period);
    let image: Buffer;
    try {
      image = await browser.renderHtml({ html: renderReportHtml(report), width: REPORT_IMAGE_WIDTH, height: 1200, format: "png", scale: 2, fullPage: true });
    } catch (error) {
      throw new HttpError(502, `Não foi possível gerar a imagem: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
    }
    const title = `${{ day: "Resumo do dia", week: "Revisão da semana", month: "Resumo do mês" }[report.kind]} ${report.period}`;
    const item = await runtime.media.addBuffer(image, "image/png", { title, createdBy: MEDIA_USER_CREATOR, origin: "html", fileName: `relatorio-${report.kind}-${report.period}.png`, note: `${report.workspaceName}: relatório gerado por código` });
    return reply.code(201).send(item) as unknown as MediaItem;
  });
}
