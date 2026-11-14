import { watchConsole } from "./helpers/console-guard";
import { expect, test } from "./helpers/fixtures";
import { officeInBrowser, openNotifications, openOffice, select, sendTask } from "./helpers/office";

// Fluxo completo do backend pela UI nova: caixa de tarefa -> orquestrador -> WebSocket -> painéis.
// Requer o server do Playwright com MOCK_MIN_MS/MOCK_MAX_MS baixos e MOCK_APPROVAL_RATE=0.
// Cada teste usa um time diferente do seed para as tarefas não disputarem o mesmo agente.

test("tarefa criada pela caixa passa por em andamento até concluída (feed e painel do agente)", async ({ page }) => {
  await openOffice(page);
  const task = await sendTask(page, { room: "ProjetoX", team: "Frontend", prompt: "Revisar a tela de login" });
  expect(task.agentId).toBeTruthy();

  // O feed registra cada transição que chegou pelo WebSocket, na ordem.
  const feed = await openNotifications(page);
  for (const kind of ["created", "started", "done"]) await expect(feed.getByTestId(`bell-${task.id}-${kind}`)).toBeAttached();
  const order = await feed.locator(`[data-testid^="bell-${task.id}-"]`).evaluateAll((items) => items.map((item) => item.getAttribute("data-kind")));
  expect(order, "o feed mostra o mais novo primeiro").toEqual(["done", "started", "created"]);

  await select(page, { kind: "agent", id: task.agentId! });
  const panel = page.getByTestId("agent-panel");
  await expect(panel).toHaveAttribute("data-agent-id", task.agentId!);
  const item = panel.getByTestId(`history-task-${task.id}`);
  await expect(item).toHaveAttribute("data-status", "done");
  await expect(item.getByTestId("history-status")).toHaveText("concluída");
  await item.getByText("Resultado", { exact: true }).click();
  await expect(item.getByTestId("history-result")).not.toBeEmpty();
});

test("recusar a aprovação faz a tarefa falhar com o resultado de recusa", async ({ page }) => {
  await openOffice(page);
  const task = await sendTask(page, { room: "ProjetoY", team: "Pesquisa", prompt: "Apagar rascunhos [aprovar]" });
  await select(page, { kind: "agent", id: task.agentId! });

  const current = page.getByTestId("agent-current-task");
  await expect(current).toHaveAttribute("data-status", "waiting_approval");
  await current.getByRole("button", { name: "Recusar" }).click();

  const item = page.getByTestId(`history-task-${task.id}`);
  await expect(item).toHaveAttribute("data-status", "failed");
  await expect(item.getByTestId("history-status")).toHaveText("falhou");
  await item.getByText("Resultado", { exact: true }).click();
  await expect(item.getByTestId("history-result")).toContainText("Recusado pelo usuário");
  await openNotifications(page);
  await expect(page.getByTestId(`bell-${task.id}-failed`)).toBeAttached();
});

test("o Cérebro compartilhado muda pelo painel do quarto e chega a outra aba via WebSocket", async ({ page, context }) => {
  // Duas abas carregando o app de desenvolvimento (a segunda compila o pedaço da cena): passa dos 30 s padrão.
  test.setTimeout(90_000);
  // Uma segunda aba só observa: o que ela mostra só pode ter chegado pelo WebSocket.
  const observer = await context.newPage();
  const observerGuard = watchConsole(observer);
  await openOffice(page);
  await openOffice(observer);
  await select(page, { kind: "room", id: "projetox" });
  await select(observer, { kind: "room", id: "projetoy" });

  const door = page.getByTestId("brain-global");
  const link = page.getByTestId("brain-reads-projetoy");
  const observerLink = observer.getByTestId("brain-reads-projetox");

  await expect(door).toBeChecked();
  await door.click();
  await expect(door).not.toBeChecked();
  await expect.poll(async () => (await officeInBrowser(observer)).rooms.find((w) => w.id === "projetox")?.readsGlobalBrain).toBe(false);
  await door.click();
  await expect(door).toBeChecked();
  await expect.poll(async () => (await officeInBrowser(observer)).rooms.find((w) => w.id === "projetox")?.readsGlobalBrain).toBe(true);

  // ProjetoX passa a ler o ProjetoY: não é simétrico (o ProjetoY, aberto na outra aba, continua sem ler o ProjetoX).
  await expect(link).not.toBeChecked();
  await link.click();
  await expect.poll(async () => (await officeInBrowser(observer)).rooms.find((w) => w.id === "projetox")?.readsBrainsOf).toEqual(["projetoy"]);
  await expect(observerLink).not.toBeChecked();
  await expect(observer.getByTestId("brain-hidden-projetox")).toBeVisible();
  await link.click();
  await expect(link).not.toBeChecked();
  await expect.poll(async () => (await officeInBrowser(observer)).rooms.find((w) => w.id === "projetox")?.readsBrainsOf).toEqual([]);

  await observer.close();
  expect(observerGuard.problems, "a segunda aba não pode emitir erros nem avisos").toEqual([]);
});
