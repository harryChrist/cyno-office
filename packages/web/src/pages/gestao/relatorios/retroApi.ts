import { WORKSPACE_RETRO_ASK_PATH, WORKSPACE_RETRO_GENERATE_PATH, WORKSPACE_RETRO_PATH, type ApiErrorBody, type RetroAskResult, type RetroGenerateResult, type RetroView } from "@cyno/shared";
import { ApiRequestError, requestJson } from "../../../api/client";
import { useAuthStore } from "../../../auth/authStore";

const seg = encodeURIComponent;
const base = (workspace: string): string => `/api/w/${seg(workspace)}${WORKSPACE_RETRO_PATH}`;

/** A página (HTML) da retrospectiva guardada. Sessão caída volta para o login, como o resto das chamadas. */
async function requestHtml(path: string): Promise<string> {
  const response = await fetch(path, { headers: { accept: "text/html" } });
  if (!response.ok) {
    if (response.status === 401) useAuthStore.getState().expire();
    const body = (await response.json().catch(() => undefined)) as ApiErrorBody | undefined;
    throw new ApiRequestError(response.status, body?.error ?? `Erro HTTP ${response.status}`);
  }
  return response.text();
}

/** A retrospectiva da Gestão ("O que aprendemos"): o quadro, "procurar padrões" (código), o pedido ao Maestro (o dono clica) e o relatório. */
export const retroApi = {
  view: (workspace: string) => requestJson<RetroView>(base(workspace)),
  generate: (workspace: string) => requestJson<RetroGenerateResult>(`/api/w/${seg(workspace)}${WORKSPACE_RETRO_GENERATE_PATH}`, { method: "POST", body: {} }),
  ask: (workspace: string, groupIds?: string[]) => requestJson<RetroAskResult>(`/api/w/${seg(workspace)}${WORKSPACE_RETRO_ASK_PATH}`, { method: "POST", body: groupIds ? { groupIds } : {} }),
  html: (workspace: string, period: string) => requestHtml(`${base(workspace)}/${seg(period)}?format=html`),
};
