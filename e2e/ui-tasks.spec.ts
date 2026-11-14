import { expect, test } from "./helpers/fixtures";
import { openNotifications, openToday, openOffice, select, sendTask } from "./helpers/office";

// Etapa 5: caixa de tarefa + painel do agente (status, progresso, aprovação) e atalhos de teclado.

test("tarefa com [aprovar]: o painel do agente mostra progresso e pergunta, e aprovar pela UI conclui", async ({ page }) => {
  await openOffice(page);
  // Outros testes podem ter deixado coisas esperando você: o contador (a conta única de "Esperando você") é relativo.
  const today = await openToday(page);
  const waitingBefore = Number(await today.getByTestId("hoje-waiting").getAttribute("data-count"));
  const prompt = "Publicar a nova rota de pedidos com paginação, filtros por status e ordenação por data [aprovar]";
  const task = await sendTask(page, { room: "ProjetoX", team: "Backend", prompt });

  // O painel do agente a quem a tarefa foi atribuída.
  await select(page, { kind: "agent", id: task.agentId! });

  const panel = page.getByTestId("agent-panel");
  await expect(panel).toHaveAttribute("data-agent-id", task.agentId!);
  await expect(page.getByTestId("agent-status")).toHaveText("aguardando aprovação");
  const current = page.getByTestId("agent-current-task");
  await expect(current).toHaveAttribute("data-task-id", task.id);
  await expect(current).toHaveAttribute("data-status", "waiting_approval");
  await expect(page.getByTestId("agent-progress-message")).toContainText("quer sua aprovação");
  const value = Number(await page.getByTestId("agent-progress").getAttribute("aria-valuenow"));
  expect(value).toBeGreaterThan(0);
  await openToday(page);
  await expect(page.getByTestId("hoje-waiting")).toHaveAttribute("data-count", String(waitingBefore + 1));

  await current.getByRole("button", { name: "Aprovar" }).click();
  await expect(page.getByTestId(`history-task-${task.id}`)).toHaveAttribute("data-status", "done");
  await expect(page.getByTestId("agent-current-task")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Aprovar" })).toHaveCount(0);
  await openToday(page);
  await expect(page.getByTestId("hoje-waiting")).toHaveAttribute("data-count", String(waitingBefore));
});

test("recarregar a página com tarefa esperando aprovação: a pergunta, a barra e o feed continuam", async ({ page }) => {
  await openOffice(page);
  const task = await sendTask(page, { room: "ProjetoY", team: "Conteúdo", prompt: "Publicar o post do blog sobre o lançamento [aprovar]" });
  await select(page, { kind: "agent", id: task.agentId! });
  await expect(page.getByTestId("agent-current-task")).toHaveAttribute("data-status", "waiting_approval");
  const question = (await page.getByTestId("agent-progress-message").textContent())!;
  const before = await page.getByTestId("agent-progress").getAttribute("aria-valuenow");

  // Recarrega (nova navegação para a mesma página): o progresso vem no office:snapshot e o feed
  // é reconstruído das tarefas.
  await openOffice(page);
  await select(page, { kind: "agent", id: task.agentId! });
  const current = page.getByTestId("agent-current-task");
  await expect(current).toHaveAttribute("data-status", "waiting_approval");
  await expect(page.getByTestId("agent-progress-message")).toHaveText(question);
  await expect(page.getByTestId("agent-progress-message")).toContainText("quer sua aprovação");
  await expect(page.getByTestId("agent-progress")).toHaveAttribute("aria-valuenow", before!);
  expect(Number(before)).toBeGreaterThan(0);
  // O feed vive no sino de Notificações (reconstruído das tarefas ao recarregar).
  const feed = await openNotifications(page);
  await expect(feed.getByTestId(`bell-${task.id}-waiting_approval`)).toBeAttached();
  await expect(feed.getByTestId(`bell-${task.id}-created`)).toBeAttached();
  await page.keyboard.press("Escape");

  await current.getByRole("button", { name: "Aprovar" }).click();
  await expect(page.getByTestId(`history-task-${task.id}`)).toHaveAttribute("data-status", "done");
});

