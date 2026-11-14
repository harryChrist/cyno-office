import type { ApiErrorBody } from "@cyno/shared";
import { ApiRequestError } from "../../api/client";
import { useAuthStore } from "../../auth/authStore";

/** A página (HTML) da semana da plataforma: `/api/cyno/reports/week/<período>?format=html`. Sessão caída volta para o login. */
export async function fetchReportHtml(path: string): Promise<string> {
  const response = await fetch(`${path}?format=html`, { headers: { accept: "text/html" } });
  if (!response.ok) {
    if (response.status === 401) useAuthStore.getState().expire();
    const body = (await response.json().catch(() => undefined)) as ApiErrorBody | undefined;
    throw new ApiRequestError(response.status, body?.error ?? `Erro HTTP ${response.status}`);
  }
  return response.text();
}
