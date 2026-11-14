import { WORKSPACE_REPORTS_GENERATE_PATH, WORKSPACE_REPORTS_PATH, type ApiErrorBody, type GenerateReportResult, type MediaItem, type ReportKind, type ReportList } from "@cyno/shared";
import { ApiRequestError, requestJson } from "../../../api/client";
import { useAuthStore } from "../../../auth/authStore";

const seg = encodeURIComponent;
const base = (workspace: string): string => `/api/w/${seg(workspace)}${WORKSPACE_REPORTS_PATH}`;

/** Texto cru (HTML ou Markdown do relatório). Sessão caída volta para o login, como o resto das chamadas. */
async function requestText(path: string): Promise<string> {
  const response = await fetch(path, { headers: { accept: "text/html, text/markdown, text/plain" } });
  if (!response.ok) {
    if (response.status === 401) useAuthStore.getState().expire();
    const body = (await response.json().catch(() => undefined)) as ApiErrorBody | undefined;
    throw new ApiRequestError(response.status, body?.error ?? `Erro HTTP ${response.status}`);
  }
  return response.text();
}

/** Os relatórios da Gestão do workspace: a lista, o relatório aberto (HTML da página ou Markdown), "Gerar agora" e a imagem (PNG na Biblioteca). */
export const reportsApi = {
  list: (workspace: string) => requestJson<ReportList>(base(workspace)),
  /** `origin` (a origem do app) faz os links do relatório virarem links de verdade; sem ele aparecem como texto. */
  html: (workspace: string, kind: ReportKind, period: string, origin: string) => requestText(`${base(workspace)}/${kind}/${seg(period)}?format=html&base=${seg(origin)}`),
  markdown: (workspace: string, kind: ReportKind, period: string) => requestText(`${base(workspace)}/${kind}/${seg(period)}?format=md`),
  generate: (workspace: string, kind: ReportKind, period?: string) =>
    requestJson<GenerateReportResult>(`/api/w/${seg(workspace)}${WORKSPACE_REPORTS_GENERATE_PATH}`, { method: "POST", body: { kind, ...(period ? { period } : {}) } }),
  image: (workspace: string, kind: ReportKind, period: string) => requestJson<MediaItem>(`${base(workspace)}/${kind}/${seg(period)}/image`, { method: "POST" }),
};
