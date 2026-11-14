import { crc32, deflateSync } from "node:zlib";
import type { MediaItem } from "@cyno/shared";
import type { Page } from "@playwright/test";
import { expect, test } from "./helpers/fixtures";

// Mídia (Biblioteca): troca de escopo sem esvaziar a lista e a gaveta de detalhe à direita.

/** Um PNG válido de uma cor só (o servidor lê as dimensões do cabeçalho). */
function png(width: number, height: number, rgb: [number, number, number]): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => rgb).flat())]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

async function upload(page: Page, ws: string, title: string, size: [number, number], color: [number, number, number]): Promise<MediaItem> {
  const response = await page.request.post(`/api/w/${ws}/media?fileName=${encodeURIComponent(`${title}.png`)}&title=${encodeURIComponent(title)}`, { data: png(size[0], size[1], color), headers: { "content-type": "image/png" } });
  expect(response.status()).toBe(201);
  return (await response.json()) as MediaItem;
}

let counter = 0;

/** Cria dois workspaces só para o teste e deixa mídia neles (os itens do primeiro vêm do mais novo para o mais velho). */
async function seed(page: Page): Promise<{ ws: string; own: MediaItem[]; other: string }> {
  counter += 1;
  const make = async (name: string) => {
    const created = await page.request.post("/api/workspaces", { data: { name: `${name} ${Date.now()}-${counter}` } });
    expect(created.status()).toBe(201);
    return ((await created.json()) as { id: string }).id;
  };
  const ws = await make("Midia A");
  const other = await make("Midia B");
  const own: MediaItem[] = [];
  own.push(await upload(page, ws, "Paisagem azul", [160, 90], [40, 90, 200]));
  own.push(await upload(page, ws, "Retrato verde", [90, 160], [40, 170, 90]));
  own.push(await upload(page, ws, "Quadrada rosa", [100, 100], [220, 80, 150]));
  await upload(page, other, "Outra um", [120, 80], [200, 160, 40]);
  await upload(page, other, "Outra dois", [80, 120], [120, 60, 190]);
  return { ws, own: own.reverse(), other };
}

/** Quantas mídias existem em todos os workspaces (é o que o escopo "Todos" mostra). */
async function totalMedia(page: Page): Promise<number> {
  const list = (await (await page.request.get("/api/workspaces")).json()) as { id: string }[];
  let total = 0;
  for (const workspace of list) total += ((await (await page.request.get(`/api/w/${workspace.id}/media`)).json()) as unknown[]).length;
  return total;
}

const openMedia = async (page: Page, ws: string) => {
  await page.goto(`/#/biblioteca/midia/${ws}`);
  await expect(page.getByTestId("media-grid").first()).toBeVisible();
};

test("trocar de escopo não esvazia a lista: a anterior fica (esmaecida) até a nova chegar, e a volta é instantânea", async ({ page }) => {
  const { ws, other } = await seed(page);
  const total = await totalMedia(page);
  await page.addInitScript(() => localStorage.setItem("cyno.media.scope", "este"));
  // A resposta do outro workspace demora, para dar tempo de ver a lista segurada.
  await page.route(`**/api/w/${other}/media`, async (route) => {
    await new Promise((done) => setTimeout(done, 700));
    await route.continue();
  });
  await openMedia(page, ws);
  await expect(page.locator('[data-testid^="media-card-"]')).toHaveCount(3);

  const sample = (ms: number) =>
    page.evaluate(
      (duration) =>
        new Promise<{ min: number; end: number; sawSwitching: boolean; sawSkeleton: boolean }>((resolve) => {
          const t0 = performance.now();
          let min = Infinity;
          let sawSwitching = false;
          let sawSkeleton = false;
          const tick = () => {
            const count = document.querySelectorAll('[data-testid^="media-card-"]').length;
            min = Math.min(min, count);
            if (document.querySelector('[data-testid="media-switching"]')) sawSwitching = true;
            if (document.querySelector('[data-testid="media-skeleton"]')) sawSkeleton = true;
            if (performance.now() - t0 < duration) requestAnimationFrame(tick);
            else resolve({ min, end: count, sawSwitching, sawSkeleton });
          };
          requestAnimationFrame(tick);
        }),
      ms,
    );

  const pending = sample(1500);
  await page.getByTestId("media-scope-todos").click();
  // O botão responde na hora (estado otimista), antes de a lista nova chegar.
  await expect(page.getByTestId("media-scope-todos")).toHaveAttribute("aria-checked", "true");
  const during = await pending;
  expect(during.min, "a lista nunca ficou vazia durante a troca").toBeGreaterThanOrEqual(3);
  expect(during.sawSwitching, "mostrou o indicador de carregando").toBe(true);
  expect(during.sawSkeleton, "não caiu no esqueleto de primeira carga").toBe(false);
  expect(during.end).toBe(total);

  // De volta ao "Este workspace": instantâneo, sem esperar rede.
  const back = sample(400);
  await page.getByTestId("media-scope-este").click();
  const afterBack = await back;
  expect(afterBack.min).toBe(3);
  expect(afterBack.sawSwitching).toBe(false);

  // E "Todos" de novo agora vem do cache: nada de espera.
  const again = sample(400);
  await page.getByTestId("media-scope-todos").click();
  const cached = await again;
  expect(cached.sawSwitching).toBe(false);
  expect(cached.end).toBe(total);
});

test("o seletor de escopo funciona pelo teclado (setas) e a escolha fica guardada", async ({ page }) => {
  const { ws } = await seed(page);
  const total = await totalMedia(page);
  await openMedia(page, ws);
  await page.getByTestId("media-scope-este").focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByTestId("media-scope-outro")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("media-scope-outro")).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByTestId("media-scope-todos")).toHaveAttribute("aria-checked", "true");
  await expect(page.locator('[data-testid^="media-card-"]')).toHaveCount(total);
  await page.reload();
  await expect(page.getByTestId("media-scope-todos")).toHaveAttribute("aria-checked", "true");
});

test("a gaveta abre pela direita com pelo menos metade da janela e fecha pelo fundo, pelo Esc e pelo botão", async ({ page }) => {
  const { ws, own } = await seed(page);
  await openMedia(page, ws);
  const card = page.getByTestId(`media-card-${own[0]!.id}`);

  await card.click();
  const drawer = page.getByRole("dialog", { name: /Detalhe de/ });
  await expect(drawer).toBeVisible();
  await expect(drawer).toHaveAttribute("aria-modal", "true");
  const viewport = page.viewportSize()!;
  const panel = page.getByTestId("media-drawer-panel");
  const box = (await panel.boundingBox())!;
  expect(box.width).toBeGreaterThanOrEqual(viewport.width / 2 - 1);
  expect(box.x + box.width).toBeCloseTo(viewport.width, 0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
  await expect(page.getByTestId("media-stage").locator("img")).toBeVisible();
  // o foco está dentro da gaveta e continua nela ao navegar por Tab
  for (let i = 0; i < 8; i += 1) await page.keyboard.press("Tab");
  expect(await page.evaluate(() => !!document.activeElement?.closest("dialog.ui-drawer"))).toBe(true);

  // Esc fecha e o foco volta ao cartão
  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);
  await expect(card).toBeFocused();

  // clicar no fundo preto fecha
  await card.click();
  await expect(drawer).toBeVisible();
  await page.mouse.click(8, viewport.height / 2);
  await expect(drawer).toHaveCount(0);

  // o botão de fechar
  await card.click();
  await page.getByTestId("media-close").click();
  await expect(drawer).toHaveCount(0);
  await expect(card).toBeFocused();
});

test("anterior e próxima pelo teclado e pelos botões, com a posição, sem fechar a gaveta; o cartão da grade fica marcado", async ({ page }) => {
  const { ws, own } = await seed(page);
  await openMedia(page, ws);
  await page.getByTestId(`media-card-${own[0]!.id}`).click();
  const position = page.getByTestId("media-position");
  await expect(position).toHaveText("1 de 3");
  await expect(page.getByTestId("media-prev")).toBeDisabled();

  await page.keyboard.press("ArrowRight");
  await expect(position).toHaveText("2 de 3");
  await expect(page.getByTestId("media-detail").getByRole("heading", { level: 3 })).toHaveText(own[1]!.title);
  await expect(page).toHaveURL(new RegExp(`midia=${ws}%3A${own[1]!.id}`));
  await expect(page.getByTestId(`media-card-${own[1]!.id}`)).toHaveAttribute("aria-current", "true");

  await page.getByTestId("media-next").click();
  await expect(position).toHaveText("3 de 3");
  await expect(page.getByTestId("media-next")).toBeDisabled();
  await page.keyboard.press("ArrowLeft");
  await expect(position).toHaveText("2 de 3");
  await expect(page.getByRole("dialog", { name: /Detalhe de/ })).toBeVisible();

  // fechar em outra mídia devolve o foco ao cartão dela
  await page.keyboard.press("Escape");
  await expect(page.getByTestId(`media-card-${own[1]!.id}`)).toBeFocused();
});

test("o endereço reflete a mídia aberta: o Voltar fecha a gaveta e um link abre direto", async ({ page }) => {
  const { ws, own } = await seed(page);
  await openMedia(page, ws);
  await page.getByTestId(`media-card-${own[1]!.id}`).click();
  await expect(page.getByRole("dialog", { name: /Detalhe de/ })).toBeVisible();
  await expect(page).toHaveURL(/midia=/);
  await page.goBack();
  await expect(page.getByRole("dialog", { name: /Detalhe de/ })).toHaveCount(0);
  await expect(page).not.toHaveURL(/midia=/);

  await page.goto(`/#/biblioteca/midia/${ws}?midia=${ws}%3A${own[2]!.id}`);
  await page.reload();
  await expect(page.getByRole("dialog", { name: /Detalhe de/ })).toBeVisible();
  await expect(page.getByTestId("media-position")).toHaveText("3 de 3");
});

test("duplo clique na imagem e o botão abrem o visualizador em tela cheia; Esc fecha só ele", async ({ page }) => {
  const { ws, own } = await seed(page);
  await openMedia(page, ws);
  await page.getByTestId(`media-card-${own[0]!.id}`).click();
  await page.getByTestId("media-stage").locator("img").dblclick();
  const viewer = page.getByTestId("media-lightbox");
  await expect(viewer).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(viewer).toHaveCount(0);
  await expect(page.getByRole("dialog", { name: /Detalhe de/ })).toBeVisible();
  await page.getByTestId("media-fullscreen").click();
  await expect(viewer).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(viewer).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: /Detalhe de/ })).toHaveCount(0);
});

test("dá para alargar a gaveta arrastando a borda e a largura fica guardada", async ({ page }) => {
  const { ws, own } = await seed(page);
  await openMedia(page, ws);
  await page.getByTestId(`media-card-${own[0]!.id}`).click();
  const panel = page.getByTestId("media-drawer-panel");
  const before = (await panel.boundingBox())!;
  const grip = (await page.getByTestId("media-drawer-grip").boundingBox())!;
  await page.mouse.move(grip.x + grip.width / 2, grip.y + 200);
  await page.mouse.down();
  await page.mouse.move(grip.x - 120, grip.y + 200, { steps: 6 });
  await page.mouse.up();
  const after = (await panel.boundingBox())!;
  expect(after.width).toBeGreaterThan(before.width + 80);
  await page.keyboard.press("Escape");
  await page.getByTestId(`media-card-${own[0]!.id}`).click();
  const again = (await panel.boundingBox())!;
  expect(Math.abs(again.width - after.width)).toBeLessThanOrEqual(2);
});

test("no celular a gaveta ocupa a tela inteira", async ({ page }) => {
  const { ws, own } = await seed(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await openMedia(page, ws);
  await page.getByTestId(`media-card-${own[0]!.id}`).click();
  const box = (await page.getByTestId("media-drawer-panel").boundingBox())!;
  expect(box.width).toBeCloseTo(390, 0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
});
