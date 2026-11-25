import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "./helpers/fixtures";

test("escolhe uma pasta de trabalho pelo seletor em Configurações > Pastas de trabalho", async ({ page }) => {
  // Prefixo "00-" garante que a pasta apareça logo no início de /tmp mesmo com muitas pastas temporárias.
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "00-cyno-picker-"));
  const projectDir = path.join(tempRoot, "meu-projeto");
  await mkdir(path.join(projectDir, ".git"), { recursive: true });
  await writeFile(path.join(projectDir, "leia-me.md"), "# teste");

  try {
    await page.goto("/#/principal/configuracoes/pastas");
    await expect(page.getByTestId("settings-folders")).toBeVisible();

    await page.getByTestId("settings-folder-add-toggle").click();
    await expect(page.getByTestId("settings-folder-add")).toBeVisible();

    // Abre o seletor interno, navega até a pasta temporária e confirma.
    await page.getByTestId("settings-folder-browse").click();
    const picker = page.getByTestId("folder-picker");
    await expect(picker).toBeVisible();

    // Esc fecha apenas o seletor (mantendo o formulário aberto).
    await page.keyboard.press("Escape");
    await expect(picker).toHaveCount(0);
    await expect(page.getByTestId("settings-folder-add")).toBeVisible();

    // Reabre, vai até /tmp e entra na pasta criada.
    await page.getByTestId("settings-folder-browse").click();
    await expect(picker).toBeVisible();
    await picker.getByTestId("folder-picker-roots").click();
    await picker.getByRole("button", { name: "tmp", exact: true }).click();
    await picker.getByRole("button", { name: path.basename(tempRoot), exact: true }).click();

    const projectEntry = picker.locator('[data-testid="folder-picker-entry"]', { hasText: "meu-projeto" });
    await expect(projectEntry).toBeVisible();
    await expect(projectEntry).toHaveAttribute("data-git", "true");
    await projectEntry.click();

    // Arquivos nunca aparecem no seletor.
    await expect(picker.getByText("leia-me.md")).toHaveCount(0);
    await expect(picker.getByTestId("folder-picker-current")).toContainText(projectDir);

    await picker.getByTestId("folder-picker-confirm").click();
    await expect(picker).toHaveCount(0);

    // Preencheu caminho e sugeriu o nome da pasta.
    await expect(page.getByTestId("settings-folder-add-path")).toHaveValue(projectDir);
    await expect(page.getByTestId("settings-folder-add-name")).toHaveValue("meu-projeto");

    await page.getByTestId("settings-folder-add-submit").click();
    await expect(page.getByTestId("settings-folder-add")).toHaveCount(0);

    const addedRow = page.locator('[data-testid="settings-folder"]', { hasText: projectDir });
    await expect(addedRow).toBeVisible();

    // Limpeza para não interferir nos outros testes.
    await addedRow.getByTestId("settings-folder-remove").click();
    await expect(addedRow).toHaveCount(0);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
