import { mkdirSync } from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "./helpers/fixtures";
import { openNotifications, openOffice, select, sendTask } from "./helpers/office";

// Etapa 5: screenshots da UI para o QA (conferidos visualmente) em 1280x800 e 1920x1080.
const OUT = path.join("qa", "screenshots", "etapa-5", "ui");
mkdirSync(OUT, { recursive: true });

/** Espera as animações de layout assentarem (câmera e painéis) antes da foto. */
async function settle(page: Page): Promise<void> {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.waitForTimeout(250);
}

/** Nada da UI pode sair da tela: cada painel cabe inteiro na janela. */
async function expectInsideViewport(page: Page, testIds: string[]): Promise<void> {
  const size = page.viewportSize()!;
  for (const id of testIds) {
    const box = await page.getByTestId(id).boundingBox();
    expect(box, id).not.toBeNull();
    expect(box!.x, `${id} (esquerda)`).toBeGreaterThanOrEqual(0);
    expect(box!.y, `${id} (topo)`).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width, `${id} (direita)`).toBeLessThanOrEqual(size.width);
    expect(box!.y + box!.height, `${id} (base)`).toBeLessThanOrEqual(size.height);
  }
}

for (const [width, height] of [
  [1280, 800],
  [1920, 1080],
] as const) {
  const tag = `${width}x${height}`;
  const shot = (name: string) => path.join(OUT, `${name}-${tag}.png`);

  test(`screenshots da UI em ${tag}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await openOffice(page);

    // Caixa de tarefa preenchida (antes de enviar).
    await page.getByRole("form", { name: "Nova tarefa" }).getByLabel("Pedido", { exact: true }).fill("Criar a página de checkout com resumo do pedido");
    await settle(page);
    await expectInsideViewport(page, ["hud", "task-box"]);
    await page.screenshot({ path: shot("caixa-de-tarefa") });

    // Painel do agente esperando aprovação (progresso + pergunta + botões).
    const task = await sendTask(page, { room: "ProjetoX", team: "Frontend", prompt: "Publicar a nova home [aprovar]" });
    await select(page, { kind: "agent", id: task.agentId! });
    await expect(page.getByTestId("agent-current-task")).toHaveAttribute("data-status", "waiting_approval");
    await settle(page);
    await expectInsideViewport(page, ["hud", "task-box", "side-panel"]);
    await page.screenshot({ path: shot("painel-agente") });
    await page.getByTestId("agent-current-task").getByRole("button", { name: "Aprovar" }).click();
    await expect(page.getByTestId(`history-task-${task.id}`)).toHaveAttribute("data-status", "done");

    // Painel do quarto com portas e o preview do Cérebro.
    await select(page, { kind: "room", id: "projetox" });
    await expect(page.getByTestId("brain-preview")).toHaveAttribute("data-loading", "false");
    await settle(page);
    await page.screenshot({ path: shot("painel-quarto") });
    await page.getByTestId("brain-preview").scrollIntoViewIfNeeded();
    await settle(page);
    await page.screenshot({ path: shot("painel-quarto-cerebro") });

    // Confirmação de excluir time (lista os agentes que saem junto); cancelada em seguida.
    await page.getByTestId("team-delete-projetox-frontend").click();
    await expect(page.getByTestId("confirm-delete-team-agents")).toContainText("Saem junto");
    await settle(page);
    await expectInsideViewport(page, ["confirm-delete-team"]);
    await page.screenshot({ path: shot("excluir-time") });
    await page.getByTestId("confirm-delete-team").getByRole("button", { name: "Cancelar" }).click();
    await expect(page.getByTestId("confirm-delete-team")).toHaveCount(0);

    // Editar agente: o seletor de time agrupa os times por quarto.
    await select(page, { kind: "agent", id: "lia" });
    await page.getByTestId("agent-edit").click();
    await expect(page.getByTestId("agent-edit-team")).toBeEnabled();
    await settle(page);
    await page.screenshot({ path: shot("editar-agente-time") });
    await page.getByTestId("agent-edit-form").getByRole("button", { name: "Cancelar" }).click();
    await select(page, { kind: "room", id: "projetox" });

    // Criação de agente com o editor de avatar.
    await page.getByTestId("add-agent-projetox-frontend").click();
    const dialog = page.getByTestId("create-agent-dialog");
    await dialog.getByLabel("Nome").fill("Zoe");
    await dialog.getByLabel("Papel").fill("Ilustradora");
    await dialog.getByTestId("avatar-skin").getByRole("radio", { name: "Tom 3" }).check();
    await dialog.getByTestId("avatar-hair").selectOption("ponytail");
    await dialog.getByTestId("avatar-hairColor").getByRole("radio", { name: "Rosa" }).check();
    await dialog.getByTestId("avatar-shirt").getByRole("radio", { name: "Jeans" }).check();
    await dialog.getByTestId("avatar-pants").getByRole("radio", { name: "Musgo" }).check();
    await dialog.getByTestId("avatar-accessory").selectOption("headphones");
    await settle(page);
    await expectInsideViewport(page, ["create-agent-dialog"]);
    await page.screenshot({ path: shot("criar-agente") });
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);

    // Feed de atividade aberto.
    await openNotifications(page);
    await select(page, null);
    await settle(page);
    await page.screenshot({ path: shot("feed-atividade") });
  });
}
