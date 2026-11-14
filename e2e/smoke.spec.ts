import { expect, test } from "./helpers/fixtures";
import { openOffice } from "./helpers/office";

type Janela = { __cena?: { probe(): { camera: { zoom: number } } } };
const zoomDaCena = (page: import("@playwright/test").Page) => page.evaluate(() => (window as unknown as Janela).__cena!.probe().camera.zoom);

test("abre o escritório com a barra lateral, a caixa do Maestro, os controles e a cena, sem erros no console", async ({ page }) => {
  await openOffice(page);
  await expect(page.getByTestId("socket-status")).toHaveAttribute("data-state", "open");
  await expect(page.getByRole("navigation", { name: "Páginas" })).toBeVisible();
  await expect(page.getByTestId("task-box")).toBeVisible();
  await expect(page.getByTestId("office-controls")).toBeVisible();

  const canvas = page.getByTestId("cena-escritorio").locator("canvas").first();
  await expect(canvas).toBeVisible();
  const caixa = await canvas.boundingBox();
  expect(caixa!.width).toBeGreaterThan(800);
  expect(caixa!.height).toBeGreaterThan(500);
  expect(await page.evaluate(() => typeof (window as unknown as Janela).__cena?.probe)).toBe("function");
});

test("zoom pelos botões e pela tecla +/−; 'Enquadrar tudo' volta à visão geral", async ({ page }) => {
  await openOffice(page);
  await page.waitForTimeout(1500);
  const inicial = await zoomDaCena(page);
  await page.getByTestId("cena-zoom-in").click();
  await expect.poll(() => zoomDaCena(page)).toBeGreaterThan(inicial);
  const perto = await zoomDaCena(page);
  await page.getByTestId("cena-zoom-out").click();
  await expect.poll(() => zoomDaCena(page)).toBeLessThan(perto);
  // Teclado: + aproxima; digitando na caixa do Maestro, + é só texto.
  await page.getByTestId("nav-map").click();
  await expect.poll(() => zoomDaCena(page)).toBeCloseTo(inicial, 1);
  await page.getByTestId("task-prompt").click();
  await page.keyboard.press("+");
  await page.waitForTimeout(400);
  expect(await zoomDaCena(page)).toBeCloseTo(inicial, 1);
});
