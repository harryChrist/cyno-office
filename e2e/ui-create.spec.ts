import { expect, test } from "./helpers/fixtures";
import { officeInBrowser, openOffice } from "./helpers/office";

// Etapa 5: criar quarto + time + agente pela UI (com o editor de avatar), editar e excluir.

test("cria quarto, time e agente pela UI, edita o avatar e exclui tudo com confirmação", async ({ page }) => {
  // A cena nova desenha o prédio inteiro a cada quadro: com o WebGL por software (SwiftShader) do e2e cada passo demora segundos.
  test.setTimeout(180_000);
  await openOffice(page);
  // O seed muda com o tempo (a Sala do Maestro entrou na conta): as contagens são relativas ao que o escritório tinha ao abrir.
  const base = await page.evaluate(() => {
    const o = window.__agentOffice!.office.getState().office!;
    return { rooms: o.rooms.length, teams: o.teams.length, agents: o.agents.length };
  });

  // Quarto: nome vazio não chega à API (erro amigável no campo).
  await page.getByTestId("add-room").click();
  const roomDialog = page.getByTestId("create-room-dialog");
  await roomDialog.getByTestId("create-room-submit").click();
  await expect(roomDialog.getByText("Dê um nome à sala.")).toBeVisible();
  await expect(roomDialog.getByLabel("Nome")).toHaveAttribute("aria-invalid", "true");
  await roomDialog.getByLabel("Nome").fill("Laboratório");
  await roomDialog.getByRole("radio", { name: "Azul-gelo" }).check();
  await roomDialog.getByTestId("create-room-submit").click();
  await expect(roomDialog).toHaveCount(0);

  const room = page.getByTestId("room-panel");
  await expect(page.getByTestId("room-name")).toHaveText("Laboratório");
  await expect(page.getByTestId("hud-rooms")).toHaveText(`${base.rooms + 1} salas`);
  await expect(page.getByTestId("cena-escritorio")).toBeVisible();
  await expect(room.getByTestId("brain-hidden-lobby")).toBeVisible();

  // Time
  await room.getByTestId("add-team").click();
  const teamDialog = page.getByTestId("create-team-dialog");
  await teamDialog.getByLabel("Nome").fill("Design");
  await teamDialog.getByLabel("Foco").fill("identidade visual");
  await teamDialog.getByTestId("create-team-submit").click();
  await expect(room.getByTestId("room-team-laboratorio-design")).toContainText("identidade visual");
  await expect(page.getByTestId("hud-teams")).toHaveText(`${base.teams + 1} times`);

  // Agente com o editor de avatar (preview ao vivo).
  await room.getByTestId("add-agent-laboratorio-design").click();
  const agentDialog = page.getByTestId("create-agent-dialog");
  const preview = agentDialog.getByTestId("avatar-preview");
  await agentDialog.getByLabel("Nome").fill("Zoe");
  await agentDialog.getByLabel("Papel").fill("Ilustradora");
  await agentDialog.getByLabel("Instruções").fill("Desenhe em pixel art.");
  const before = await preview.getAttribute("data-avatar");
  await agentDialog.getByTestId("avatar-random").click();
  await agentDialog.getByTestId("avatar-skin").getByRole("radio", { name: "Tom 4" }).check();
  await agentDialog.getByTestId("avatar-hair").selectOption("bun");
  await agentDialog.getByTestId("avatar-hairColor").getByRole("radio", { name: "Ruivo" }).check();
  await agentDialog.getByTestId("avatar-shirt").getByRole("radio", { name: "Mostarda" }).check();
  await agentDialog.getByTestId("avatar-pants").getByRole("radio", { name: "Marinho" }).check();
  await agentDialog.getByTestId("avatar-accessory").selectOption("glasses");
  await expect(preview).toHaveAttribute("data-avatar", "tone4|bun|terracotta|mustard|navy|glasses");
  expect(before).not.toBe("tone4|bun|terracotta|mustard|navy|glasses");
  await agentDialog.getByTestId("create-agent-submit").click();
  await expect(agentDialog).toHaveCount(0);

  const panel = page.getByTestId("agent-panel");
  await expect(page.getByTestId("agent-name")).toHaveText("Zoe");
  await expect(page.getByTestId("agent-role")).toHaveText("Ilustradora");
  await expect(page.getByTestId("agent-team")).toHaveText("Design");
  await expect(page.getByTestId("agent-instructions")).toHaveText("Desenhe em pixel art.");
  await expect(page.getByTestId("agent-avatar")).toHaveAttribute("data-avatar", "tone4|bun|terracotta|mustard|navy|glasses");
  await expect(page.getByTestId("hud-agents")).toHaveText(`${base.agents + 1} agentes`);
  const agentId = await panel.getAttribute("data-agent-id");

  // Editar: nome e avatar (PATCH) e o painel atualiza via WebSocket.
  await page.getByTestId("agent-edit").click();
  const edit = page.getByTestId("agent-edit-form");
  await edit.getByLabel("Nome").fill("Zoé");
  await edit.getByTestId("avatar-shirt").getByRole("radio", { name: "Menta" }).check();
  await edit.getByTestId("avatar-accessory").selectOption("none");
  await edit.getByTestId("agent-edit-save").click();
  await expect(edit).toHaveCount(0);
  await expect(page.getByTestId("agent-name")).toHaveText("Zoé");
  await expect(page.getByTestId("agent-avatar")).toHaveAttribute("data-avatar", "tone4|bun|terracotta|mint|navy|-");
  const saved = (await officeInBrowser(page)).agents.find((agent) => agent.id === agentId);
  // O formato antigo segue coerente (sem acessório) e as peças do motor ficam no campo opcional `cena`.
  expect(saved?.avatar).toMatchObject({ skin: "tone4", hair: "bun", hairColor: "terracotta", shirt: "mint", pants: "navy", cena: { hairStyle: "bun", accessory: "none" } });
  expect(saved?.avatar.accessory).toBeUndefined();

  // Excluir o agente: cancelar não exclui; confirmar exclui e fecha o painel.
  await page.getByTestId("agent-delete").click();
  const confirmAgent = page.getByTestId("confirm-delete-agent");
  await expect(confirmAgent).toContainText("Zoé");
  await confirmAgent.getByRole("button", { name: "Cancelar" }).click();
  await expect(panel).toBeVisible();
  await page.getByTestId("agent-delete").click();
  await confirmAgent.getByRole("button", { name: "Excluir agente" }).click();
  await expect(panel).toHaveCount(0);
  await expect(page.getByTestId("hud-agents")).toHaveText(`${base.agents} agentes`);

  // Excluir o quarto (em cascata) devolve o escritório ao seed.
  await page.evaluate(() => window.__agentOffice!.view.getState().select({ kind: "room", id: "laboratorio" }));
  await page.getByTestId("room-delete").click();
  const confirmRoom = page.getByTestId("confirm-delete-room");
  await expect(confirmRoom).toContainText("1 time");
  await confirmRoom.getByRole("button", { name: "Excluir sala" }).click();
  await expect(page.getByTestId("side-panel")).toHaveCount(0);
  await expect(page.getByTestId("hud-rooms")).toHaveText(`${base.rooms} salas`);
  await expect.poll(() => page.evaluate(() => window.__agentOffice!.office.getState().office!.rooms.some((r) => r.id === "laboratorio"))).toBe(false);
});

test("editar o quarto muda nome e tema; Esc numa janela modal fecha só a janela", async ({ page }) => {
  test.setTimeout(180_000);
  await openOffice(page);
  await page.evaluate(() => window.__agentOffice!.view.getState().select({ kind: "room", id: "projetoy" }));
  await page.getByTestId("room-edit").click();
  const form = page.getByTestId("room-edit-form");
  await form.getByLabel("Nome").fill("ProjetoY2");
  await form.getByRole("radio", { name: "Areia" }).check();
  await form.getByTestId("room-edit-save").click();
  await expect(page.getByTestId("room-name")).toHaveText("ProjetoY2");
  expect((await page.evaluate(() => window.__agentOffice!.office.getState().office!.rooms.find((w) => w.id === "projetoy")))?.theme).toBe("sand");

  // Volta ao original para não afetar os outros testes.
  await page.getByTestId("room-edit").click();
  await form.getByLabel("Nome").fill("ProjetoY");
  await form.getByRole("radio", { name: "Lilás" }).check();
  await form.getByTestId("room-edit-save").click();
  await expect(page.getByTestId("room-name")).toHaveText("ProjetoY");

  await page.getByTestId("add-team").click();
  await expect(page.getByTestId("create-team-dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("create-team-dialog")).toHaveCount(0);
  await expect(page.getByTestId("room-panel")).toBeVisible();
});
