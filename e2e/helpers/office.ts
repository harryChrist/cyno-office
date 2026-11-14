import type { Task } from "@cyno/shared";
import { expect, type Page } from "@playwright/test";

/**
 * Abre a UI (o Escritório é a cena do motor `@cyno/cena`) e espera o WebSocket
 * entregar o snapshot e a cena montar.
 */
export async function openOffice(page: Page, path = "/#/office"): Promise<void> {
  await page.goto(path);
  await expect(page.getByTestId("socket-status")).toHaveAttribute("data-state", "open");
  // Anexada (não "visível"): uma segunda aba do mesmo navegador fica em segundo plano e a cena dela não conta como visível.
  await expect(page.getByTestId("cena-escritorio")).toBeAttached({ timeout: 20_000 });
  await expect.poll(() => page.evaluate(() => window.__agentOffice!.office.getState().office?.rooms.length ?? 0)).toBeGreaterThan(0);
}

/** Seleciona algo pela viewStore exposta em dev/test (o mesmo que o clique no canvas faz). */
export async function select(page: Page, selection: { kind: "agent" | "room"; id: string } | null): Promise<void> {
  await page.evaluate((value) => window.__agentOffice!.view.getState().select(value), selection);
}

/** Abre o painel de Notificações da barra lateral (se estiver fechado) e devolve o painel. */
export async function openNotifications(page: Page) {
  const panel = page.getByTestId("bell-popover");
  if (!(await panel.isVisible())) await page.getByTestId("bell").click();
  await expect(panel).toBeVisible();
  return panel;
}

/** Abre o painel "Hoje" da barra lateral (se estiver fechado), espera o dia carregar e devolve o painel. */
export async function openToday(page: Page) {
  const panel = page.getByTestId("hoje-panel");
  if (!(await panel.isVisible())) await page.getByTestId("nav-hoje").click();
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId("hoje-waiting")).toBeVisible();
  return panel;
}

export type NewTask = { room: string; team: string; prompt: string };

/**
 * Cria uma tarefa para um time (a UI não tem mais o formulário "Nova tarefa": a caixa do rodapé conversa com o Maestro;
 * quem manda tarefa direta a um time é a API) e devolve a tarefa criada (201). Quarto e time pelo nome.
 */
export async function sendTask(page: Page, { room, team, prompt }: NewTask): Promise<Task> {
  const office = await officeInBrowser(page);
  const roomId = office.rooms.find((candidate) => candidate.name === room)?.id;
  const teamId = office.teams.find((candidate) => candidate.roomId === roomId && candidate.name === team)?.id;
  expect(roomId && teamId, `quarto ${room} / time ${team} existem`).toBeTruthy();
  const response = await page.request.post("/api/w/principal/tasks", { data: { roomId, teamId, prompt } });
  expect(response.status()).toBe(201);
  return (await response.json()) as Task;
}

/** Estado do escritório no store do navegador (para conferir o que a UI recebeu via WS). */
export function officeInBrowser(page: Page) {
  return page.evaluate(() => window.__agentOffice!.office.getState().office!);
}
