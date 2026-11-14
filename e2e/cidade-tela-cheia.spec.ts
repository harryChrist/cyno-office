import { expect, test } from "./helpers/fixtures";

// A cidade em tela cheia (botão da faixa, Esc, clique num prédio). Com o gancho de desenvolvimento `window.__cidade`
// (a vista da cidade) para achar o prédio na tela; nada de olhar pixels.

type Vista = { telaDoPredio(id: string): { x: number; y: number; w: number; h: number } | null; estado: { buildings: Map<string, unknown> }; camera: { zoom: number } };
type Janela = { __cidade?: Vista };

async function abrirCidade(page: import("@playwright/test").Page) {
  await page.goto("/#/cyno");
  await expect(page.getByTestId("socket-status")).toHaveAttribute("data-state", "open");
  await expect(page.getByTestId("cidade-canvas")).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => page.evaluate(() => (window as unknown as Janela).__cidade?.estado.buildings.size ?? 0), { timeout: 20_000 }).toBeGreaterThan(0);
}

test("a cidade entra e sai da tela cheia pelo botão e pelo Esc, e o foco volta ao botão", async ({ page }) => {
  await abrirCidade(page);
  const corpo = page.getByTestId("cidade-corpo");
  const botao = page.getByTestId("cidade-tela-cheia");
  const faixa = await corpo.boundingBox();
  await expect(botao).toHaveAttribute("aria-pressed", "false");

  await botao.click();
  await expect(corpo).toHaveAttribute("data-tela-cheia", "true");
  await expect(page.getByTestId("cidade-tela-cheia")).toHaveAttribute("aria-pressed", "true");
  const janela = page.viewportSize()!;
  await expect.poll(async () => (await corpo.boundingBox())?.width).toBe(janela.width);
  expect((await corpo.boundingBox())?.height).toBe(janela.height);

  // Sair pelo botão claro.
  await page.getByTestId("cidade-sair-tela-cheia").click();
  await expect(corpo).not.toHaveAttribute("data-tela-cheia", "true");
  await expect(botao).toBeFocused();
  expect((await corpo.boundingBox())?.height).toBe(faixa?.height);

  // Sair pelo Esc.
  await botao.click();
  await expect(corpo).toHaveAttribute("data-tela-cheia", "true");
  await page.keyboard.press("Escape");
  await expect(corpo).not.toHaveAttribute("data-tela-cheia", "true");
  await expect(botao).toBeFocused();
});

test("em tela cheia dá para clicar num prédio e abrir o cartão", async ({ page }) => {
  await abrirCidade(page);
  await page.getByTestId("cidade-tela-cheia").click();
  await expect(page.getByTestId("cidade-corpo")).toHaveAttribute("data-tela-cheia", "true");
  // Espera o reenquadramento para o espaço novo assentar e acha um prédio na tela.
  await expect
    .poll(
      async () => {
        const alvo = await page.evaluate(() => {
          const vista = (window as unknown as Janela).__cidade!;
          const id = [...vista.estado.buildings.keys()][0]!;
          const retangulo = vista.telaDoPredio(id);
          return retangulo ? { x: retangulo.x + retangulo.w / 2, y: retangulo.y + retangulo.h / 2 } : null;
        });
        if (!alvo) return false;
        const caixa = (await page.getByTestId("cidade-canvas").boundingBox())!;
        await page.mouse.click(caixa.x + alvo.x, caixa.y + alvo.y);
        return page.getByTestId("cidade-cartao").isVisible();
      },
      { timeout: 15_000, intervals: [400, 800] },
    )
    .toBe(true);
  await expect(page.getByTestId("cidade-espiar")).toBeVisible();
});

// O caminho SEM a tela cheia nativa (iPhone, navegador que nega): o mesmo botão cai para a camada fixa que cobre a janela.
// Simulado no próprio navegador: sem `requestFullscreen` (API ausente) ou com ele recusando (API que nega).
const SEM_API = () => {
  Object.defineProperty(Document.prototype, "fullscreenEnabled", { configurable: true, get: () => false });
  Object.defineProperty(Element.prototype, "requestFullscreen", { configurable: true, value: undefined });
};
const API_NEGA = () => {
  Object.defineProperty(Element.prototype, "requestFullscreen", { configurable: true, value: () => Promise.reject(new DOMException("negado", "NotAllowedError")) });
};

for (const [nome, script] of [["API ausente", SEM_API], ["API que nega", API_NEGA]] as const) {
  test(`cidade: ${nome} cai para a camada, o Esc sai e o foco volta ao botão`, async ({ page }) => {
    await page.addInitScript(script);
    await abrirCidade(page);
    const corpo = page.getByTestId("cidade-corpo");
    await page.getByTestId("cidade-tela-cheia").click();
    await expect(corpo).toHaveAttribute("data-tela-cheia", "true");
    const janela = page.viewportSize()!;
    await expect.poll(async () => (await corpo.boundingBox())?.width).toBe(janela.width);
    expect(await page.evaluate(() => document.fullscreenElement === null)).toBe(true);
    await page.keyboard.press("Escape");
    await expect(corpo).not.toHaveAttribute("data-tela-cheia", "true");
    await expect(page.getByTestId("cidade-tela-cheia")).toBeFocused();
  });

  test(`escritório: ${nome} cai para a camada e o Esc sai`, async ({ page }) => {
    await page.addInitScript(script);
    await page.goto("/#/office");
    await expect(page.getByTestId("socket-status")).toHaveAttribute("data-state", "open");
    await expect(page.getByTestId("cena-escritorio")).toBeAttached({ timeout: 20_000 });
    const botao = page.getByTestId("office-tela-cheia");
    await expect(botao).toBeEnabled({ timeout: 20_000 });
    await botao.click();
    await expect(botao).toHaveAttribute("aria-pressed", "true");
    expect(await page.evaluate(() => document.fullscreenElement === null)).toBe(true);
    await page.keyboard.press("Escape");
    await expect(botao).toHaveAttribute("aria-pressed", "false");
  });
}
