import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect, test } from "./helpers/fixtures";
import { openNotifications, openOffice, select, sendTask } from "./helpers/office";

// Acessibilidade da UI (axe-core, regras WCAG 2.1 A/AA). O canvas é desenho puro e fica de fora.

async function audit(page: Page, label: string): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .exclude("canvas")
    .analyze();
  const problems = results.violations.map((violation) => `${violation.id} (${violation.impact}): ${violation.nodes.map((node) => node.target.join(" ")).join(", ")}`);
  expect(problems, `violações de acessibilidade em: ${label}`).toEqual([]);
}

test("axe: barra, caixa de tarefa, feed, painéis e janelas sem violações WCAG A/AA", async ({ page }) => {
  await openOffice(page);
  // O feed precisa ter itens (cada tipo tem a sua cor) para o contraste ser conferido.
  const task = await sendTask(page, { room: "ProjetoY", team: "Pesquisa", prompt: "Resumir as notas da semana" });
  await openNotifications(page);
  await expect(page.getByTestId(`bell-${task.id}-done`)).toBeAttached();
  await audit(page, "mapa com o feed aberto");

  await select(page, { kind: "room", id: "projetox" });
  await expect(page.getByTestId("brain-preview")).toHaveAttribute("data-loading", "false");
  await audit(page, "painel do quarto");

  await page.getByTestId("team-edit-projetox-frontend").click();
  await audit(page, "editar time");
  await page.getByTestId("team-edit-form-projetox-frontend").getByRole("button", { name: "Cancelar" }).click();

  await page.getByTestId("team-delete-projetox-frontend").click();
  await expect(page.getByTestId("confirm-delete-team")).toBeVisible();
  await audit(page, "confirmar exclusão de time");
  await page.getByTestId("confirm-delete-team").getByRole("button", { name: "Cancelar" }).click();

  await select(page, { kind: "agent", id: "lia" });
  await audit(page, "painel do agente");
  await page.getByTestId("agent-edit").click();
  await audit(page, "editar agente");
  await page.getByTestId("agent-edit-form").getByRole("button", { name: "Cancelar" }).click();

  // Painel com aprovação pendente (selo "aguardando", barra, pergunta e botões); depois, feed com falha.
  const waiting = await sendTask(page, { room: "ProjetoX", team: "Backend", prompt: "Trocar a senha do banco [aprovar]" });
  await select(page, { kind: "agent", id: waiting.agentId! });
  await expect(page.getByTestId("agent-current-task")).toHaveAttribute("data-status", "waiting_approval");
  await audit(page, "painel do agente aguardando aprovação");
  await page.getByTestId("agent-current-task").getByRole("button", { name: "Recusar" }).click();
  await openNotifications(page);
  await expect(page.getByTestId(`bell-${waiting.id}-failed`)).toBeAttached();
  await audit(page, "histórico e feed com tarefa recusada");

  await select(page, { kind: "room", id: "lobby" });
  await audit(page, "painel do lobby");

  await page.getByTestId("add-room").click();
  await expect(page.getByTestId("create-room-dialog")).toBeVisible();
  await audit(page, "novo quarto");
  await page.keyboard.press("Escape");
});
