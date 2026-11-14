import type { Agent, Team, Room } from "@cyno/shared";
import type { APIRequestContext } from "@playwright/test";
import { expect, test } from "./helpers/fixtures";
import { openOffice, select } from "./helpers/office";

// Polimento: editar e excluir time pelo painel do quarto e mover agente de time pelo painel do agente.
// Cada teste cria (e apaga no fim) o próprio quarto, para não mexer no seed dos outros testes.

const AVATAR = { skin: "tone2", hair: "short", hairColor: "ink", shirt: "mint", pants: "denim" };

async function post<T>(request: APIRequestContext, url: string, data: object): Promise<T> {
  const response = await request.post(url, { data });
  expect(response.status(), `POST ${url}: ${await response.text()}`).toBe(201);
  return (await response.json()) as T;
}

async function roomWithTeam(request: APIRequestContext, roomName: string, team: string, agents: string[]) {
  const room = await post<Room>(request, "/api/w/principal/rooms", { name: roomName, theme: "ocean" });
  const created = await post<Team>(request, "/api/w/principal/teams", { roomId: room.id, name: team, focus: "testes" });
  const members: Agent[] = [];
  for (const name of agents) {
    members.push(await post<Agent>(request, "/api/w/principal/agents", { teamId: created.id, name, role: "Dev", instructions: "", avatar: AVATAR }));
  }
  return { room, team: created, agents: members };
}

test("time: editar nome e foco e excluir com confirmação que lista agentes e tarefas", async ({ page }) => {
  await openOffice(page);
  const { room, team } = await roomWithTeam(page.request, "Oficina", "Ferramentas", ["Quim", "Raul"]);
  await select(page, { kind: "room", id: room.id });
  const block = page.getByTestId(`room-team-${team.id}`);
  await expect(block).toContainText("Ferramentas");

  // Editar: nome vazio não chega à API; salvar atualiza via WebSocket.
  await block.getByRole("button", { name: "Editar o time Ferramentas" }).click();
  const form = page.getByTestId(`team-edit-form-${team.id}`);
  await expect(form.getByLabel("Nome do time")).toBeFocused();
  await form.getByLabel("Nome do time").fill("  ");
  await form.getByTestId(`team-edit-save-${team.id}`).click();
  await expect(form.getByText("Dê um nome ao time.")).toBeVisible();
  await form.getByLabel("Nome do time").fill("Ferramentaria");
  await form.getByLabel("Foco").fill("scripts e automação");
  await form.getByTestId(`team-edit-save-${team.id}`).click();
  await expect(form).toHaveCount(0);
  await expect(block.locator(".team-block__name")).toHaveText("Ferramentaria");
  await expect(block).toContainText("scripts e automação");
  // A caixa de tarefa já usa o nome novo.
  await expect(page.getByRole("form", { name: "Nova tarefa" }).getByLabel("Time", { exact: true }).locator("option", { hasText: "Ferramentaria" })).toHaveCount(1);

  // Excluir: a confirmação diz quem sai junto; cancelar não exclui.
  const agentsBefore = await page.getByTestId("hud-agents").textContent();
  await block.getByRole("button", { name: "Excluir o time Ferramentaria" }).click();
  const confirm = page.getByTestId("confirm-delete-team");
  await expect(confirm.getByTestId("confirm-delete-team-agents")).toHaveText("Saem junto 2 agentes: Quim e Raul.");
  await expect(confirm.getByTestId("confirm-delete-team-tasks")).toHaveCount(0);
  await confirm.getByRole("button", { name: "Cancelar" }).click();
  await expect(block).toBeVisible();
  await block.getByRole("button", { name: "Excluir o time Ferramentaria" }).click();
  await confirm.getByRole("button", { name: "Excluir time" }).click();
  await expect(confirm).toHaveCount(0);
  await expect(block).toHaveCount(0);
  await expect(page.getByTestId("room-panel")).toContainText("Nenhum time ainda");
  expect(Number.parseInt(agentsBefore!, 10) - 2).toBe(Number.parseInt((await page.getByTestId("hud-agents").textContent())!, 10));

  await page.request.delete(`/api/w/principal/rooms/${room.id}`);
});

test("agente: mudar de time (para outro quarto) pelo editar; travado enquanto tem tarefa ativa", async ({ page }) => {
  await openOffice(page);
  const origin = await roomWithTeam(page.request, "Ateliê", "Arte", ["Quim"]);
  const target = await roomWithTeam(page.request, "Estúdio", "Som", []);
  const agent = origin.agents[0]!;

  // Com uma tarefa esperando aprovação, o time não pode mudar (o server daria 409).
  const task = await post<{ id: string }>(page.request, "/api/w/principal/tasks", { roomId: origin.room.id, teamId: origin.team.id, prompt: "Pintar o mural [aprovar]" });
  await select(page, { kind: "agent", id: agent.id });
  await expect(page.getByTestId("agent-current-task")).toHaveAttribute("data-status", "waiting_approval");
  await page.getByTestId("agent-edit").click();
  const form = page.getByTestId("agent-edit-form");
  const teamSelect = form.getByLabel("Time", { exact: true });
  await expect(teamSelect).toBeDisabled();
  await expect(form).toContainText("Espere as tarefas ativas terminarem para mudar de time.");
  await form.getByRole("button", { name: "Cancelar" }).click();
  await page.getByTestId("agent-current-task").getByRole("button", { name: "Recusar" }).click();
  await expect(page.getByTestId(`history-task-${task.id}`)).toHaveAttribute("data-status", "failed");

  // Livre: muda para o time do outro quarto.
  await page.getByTestId("agent-edit").click();
  await expect(teamSelect).toBeEnabled();
  await expect(teamSelect).toHaveValue(origin.team.id);
  await teamSelect.selectOption({ label: "Som (Estúdio)" });
  await form.getByTestId("agent-edit-save").click();
  await expect(form).toHaveCount(0);
  await expect(page.getByTestId("agent-team")).toHaveText("Som");
  await expect(page.getByTestId("agent-room")).toHaveText("Estúdio");
  // O histórico vai junto com o agente.
  await expect(page.getByTestId(`history-task-${task.id}`)).toBeVisible();

  // O painel do quarto novo lista o agente; o antigo ficou sem ninguém no time.
  await page.getByTestId("agent-room").click();
  await expect(page.getByTestId(`room-team-${target.team.id}`).getByTestId(`room-agent-${agent.id}`)).toBeVisible();
  await select(page, { kind: "room", id: origin.room.id });
  await expect(page.getByTestId(`room-team-${origin.team.id}`)).toContainText("Sem agentes.");

  await select(page, null);
  await page.request.delete(`/api/w/principal/rooms/${origin.room.id}`);
  await page.request.delete(`/api/w/principal/rooms/${target.room.id}`);
});
