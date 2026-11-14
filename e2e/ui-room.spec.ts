import { expect, test } from "./helpers/fixtures";
import { openOffice, select } from "./helpers/office";

// Painel do quarto (times, o que o Cérebro lê e enxerga) e painel do lobby. Portas são automáticas.

test("painel do quarto: times e agentes; \"Lê o Cérebro global\" e \"Lê também\" mudam o que o Cérebro enxerga", async ({ page }) => {
  await openOffice(page);
  await select(page, { kind: "room", id: "projetox" });
  const panel = page.getByTestId("room-panel");
  await expect(page.getByTestId("room-name")).toHaveText("ProjetoX");
  await expect(panel.getByTestId("room-team-projetox-frontend")).toContainText("Frontend");
  await expect(panel.getByTestId("room-agent-lia")).toContainText("Lia");

  const brain = page.getByTestId("brain-preview");
  await expect(brain).toHaveAttribute("data-loading", "false");
  await expect(brain.getByTestId("brain-source-self-projetox")).toBeVisible();
  await expect(brain.getByTestId("brain-source-lobby-global")).toBeVisible();
  await expect(brain.getByTestId("brain-hidden-projetoy")).toContainText("fora da lista de Cérebros lidos");

  // Deixa de ler o Cérebro global: ele sai do contexto (as portas não mudam: são automáticas).
  const door = page.getByTestId("brain-global");
  await door.click();
  await expect(door).not.toBeChecked();
  await expect(brain.getByTestId("brain-source-lobby-global")).toHaveCount(0);
  await expect(brain.getByTestId("brain-hidden-lobby")).toContainText("não lê o Cérebro global");
  await door.click();
  await expect(door).toBeChecked();
  await expect(brain.getByTestId("brain-source-lobby-global")).toBeVisible();

  // Passa a ler o Cérebro do ProjetoY: as notas dele entram no contexto.
  const link = page.getByTestId("brain-reads-projetoy");
  await link.click();
  await expect(link).toBeChecked();
  await expect(brain.getByTestId("brain-source-connected-projetoy")).toBeVisible();
  await expect(brain.getByTestId("brain-hidden-projetoy")).toHaveCount(0);
  await link.click();
  await expect(link).not.toBeChecked();
  // A prévia recarrega o Cérebro depois de salvar: no servidor de teste isso passa dos 5 s padrão.
  await expect(brain.getByTestId("brain-hidden-projetoy")).toBeVisible({ timeout: 20_000 });

  // Clicar num agente da lista abre o painel dele.
  await panel.getByTestId("room-agent-davi").click();
  await expect(page.getByTestId("agent-panel")).toHaveAttribute("data-agent-id", "davi");
});

test("painel do lobby controla quais quartos leem o Cérebro global", async ({ page }) => {
  await openOffice(page);
  await select(page, { kind: "room", id: "lobby" });
  const panel = page.getByTestId("lobby-panel");
  await expect(panel).toBeVisible();
  const door = panel.getByTestId("lobby-brain-projetoy");
  const initial = await door.isChecked();
  await door.click();
  await expect(door).toBeChecked({ checked: !initial });
  await door.click();
  await expect(door).toBeChecked({ checked: initial });
});
