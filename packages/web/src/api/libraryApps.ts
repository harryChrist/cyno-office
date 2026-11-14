import type { AppsListing, InstallAppBody, InstallJob, InstallPlan, LibraryApp } from "@cyno/shared";
import { requestJson } from "./client";

const segment = encodeURIComponent;
const APPS = "/api/library/apps";

/** Rotas da aba Apps da Biblioteca (a instalação só começa por aqui: o clique em "Instalar" é o OK do dono). */
export const appsApi = {
  list: () => requestJson<AppsListing>(APPS),
  plan: (appId: string) => requestJson<InstallPlan>(`${APPS}/${segment(appId)}/plan`),
  install: (appId: string, body: InstallAppBody = {}) => requestJson<{ app: LibraryApp; job: InstallJob }>(`${APPS}/${segment(appId)}/install`, { method: "POST", body }),
  /** "Já rodei, continuar" e "Tentar de novo". */
  resume: (appId: string) => requestJson<{ app: LibraryApp; job: InstallJob }>(`${APPS}/${segment(appId)}/resume`, { method: "POST", body: {} }),
  cancel: (appId: string) => requestJson<void>(`${APPS}/${segment(appId)}/cancel`, { method: "POST", body: {} }),
  update: (appId: string) => requestJson<{ app: LibraryApp; job: InstallJob }>(`${APPS}/${segment(appId)}/update`, { method: "POST", body: {} }),
  test: (appId: string) => requestJson<LibraryApp>(`${APPS}/${segment(appId)}/test`, { method: "POST", body: {} }),
  uninstall: (appId: string) => requestJson<void>(`${APPS}/${segment(appId)}`, { method: "DELETE" }),
  /** Cancela uma execução de ferramenta (na fila ou rodando). */
  cancelRun: (runId: string) => requestJson<void>(`${APPS}/runs/${segment(runId)}/cancel`, { method: "POST", body: {} }),
  cleanRuntimes: () => requestJson<{ removed: string[] }>("/api/library/runtimes/clean", { method: "POST", body: {} }),
  /** O log do job inteiro (as linhas novas chegam pelo socket). */
  async log(jobId: string): Promise<string> {
    const response = await fetch(`${APPS}/jobs/${segment(jobId)}/log`);
    if (!response.ok) return "";
    return response.text();
  },
};
