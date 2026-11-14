import {
  SPEND_SETTINGS_PATH,
  type SpendSettingsResponse,
  type UsageHistoryGroupBy,
  type UsageHistoryResponse,
  type UsageTaskHistoryResponse,
} from "@cyno/shared";
import { ApiRequestError, requestJson } from "../../api/client";
import { useNavStore } from "../../store/navStore";

/** Rotas da página Gastos (o histórico é do workspace atual; a cotação é da instalação). */

function workspacePath(): string {
  const id = useNavStore.getState().workspaceId;
  if (!id) throw new ApiRequestError(0, "Nenhum workspace selecionado");
  return `/api/w/${encodeURIComponent(id)}`;
}

export type HistoryParams = { from: string; to: string; groupBy: UsageHistoryGroupBy; stackBy?: "agent" | "model" };

export const spendApi = {
  history: ({ from, to, groupBy, stackBy }: HistoryParams) =>
    requestJson<UsageHistoryResponse>(`${workspacePath()}/usage/history?${new URLSearchParams({ from, to, groupBy, ...(stackBy ? { stackBy } : {}) }).toString()}`),
  task: (taskId: string) => requestJson<UsageTaskHistoryResponse>(`${workspacePath()}/usage/history/task/${encodeURIComponent(taskId)}`),
  settings: () => requestJson<SpendSettingsResponse>(SPEND_SETTINGS_PATH),
  setRate: (usdBrl: number) => requestJson<SpendSettingsResponse>(SPEND_SETTINGS_PATH, { method: "PUT", body: { usdBrl } }),
};
