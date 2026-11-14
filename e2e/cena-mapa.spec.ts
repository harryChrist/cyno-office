import type { Agent, Room, Team } from "@cyno/shared";
import { expect, test } from "./helpers/fixtures";
import { openOffice } from "./helpers/office";

// O mapa novo (motor de cena do Habblaud): o essencial sem olhar pixels. A conferência usa o gancho de desenvolvimento
// `window.__cena` (o mundo da cena: seleção, posição na tela, `probe()` com as salas e os personagens), não o desenho.

type Mundo = {
  getSelection(): { type: "agent" | "room"; id: string } | null;
  screenPositionOf(agentId: string): { x: number; y: number } | null;
  probe(): { camera: { x: number; y: number; zoom: number }; sim: { chars: Map<string, { info: { roomId: string; status: string } }>; rooms: Map<string, { listed: boolean }> } };
  extras: { onFrame(cb: () => void): () => void };
};
type Janela = { __cena?: Mundo };

/** Ids dos agentes que o escritório (o estado do Cyno) tem agora. */
const agentesDoEscritorio = (page: import("@playwright/test").Page) => page.evaluate(() => window.__agentOffice!.office.getState().office!.agents.map((agent) => agent.id));

/** Os ids dos personagens que a cena tem agora (o mundo simulado). */
const personagens = (page: import("@playwright/test").Page) => page.evaluate(() => [...(window as unknown as Janela).__cena!.probe().sim.chars.keys()]);

/** Em que sala a cena pôs o personagem (null se ele não está lá). */
const salaDoPersonagem = (page: import("@playwright/test").Page, id: string) =>
  page.evaluate((agentId) => (window as unknown as Janela).__cena!.probe().sim.chars.get(agentId)?.info.roomId ?? null, id);

/** A sala está na lista do mapa? (Apagada, ela deixa de estar listada na hora e some do mundo depois da animação de desmontar.) */
const temSala = (page: import("@playwright/test").Page, id: string) => page.evaluate((roomId) => (window as unknown as Janela).__cena!.probe().sim.rooms.get(roomId)?.listed === true, id);

async function post<T>(page: import("@playwright/test").Page, url: string, data: unknown): Promise<T> {
  const response = await page.request.post(url, { data });
  expect(response.status(), url).toBe(201);
  return (await response.json()) as T;
}

test("abre o Escritório: a cena monta e todos os agentes do workspace aparecem no mapa", async ({ page }) => {
  await openOffice(page);
  await expect(page.getByTestId("cena-escritorio")).toBeVisible();
  expect(await page.evaluate(() => typeof (window as unknown as Janela).__cena?.probe)).toBe("function");
  const esperados = await agentesDoEscritorio(page);
  expect(esperados.length).toBeGreaterThan(0);
  // Chegam pelo elevador, um depois do outro: espera todos entrarem na cena.
  await expect.poll(() => personagens(page), { timeout: 20_000 }).toEqual(expect.arrayContaining(esperados));
});

test("clicar num personagem seleciona o agente e abre o painel dele; Esc fecha", async ({ page }) => {
  await openOffice(page);
  await expect.poll(() => personagens(page), { timeout: 20_000 }).toContain("lia");
  // O personagem anda: lê a posição e clica no corpo (abaixo do ponto acima da cabeça), de novo se ele se mexeu.
  await expect
    .poll(
      async () => {
        const at = await page.evaluate(() => (window as unknown as Janela).__cena!.screenPositionOf("lia"));
        if (!at) return null;
        await page.mouse.click(at.x, at.y + 22);
        return page.evaluate(() => (window as unknown as Janela).__cena!.getSelection());
      },
      { timeout: 20_000, intervals: [300, 600, 1000] },
    )
    .toEqual({ type: "agent", id: "lia" });
  // A seleção da cena chega à interface: o painel do agente abre.
  await expect(page.getByTestId("agent-panel")).toHaveAttribute("data-agent-id", "lia");
  expect(await page.evaluate(() => window.__agentOffice!.view.getState().selection)).toEqual({ kind: "agent", id: "lia" });

  await page.keyboard.press("Escape");
  await expect(page.getByTestId("agent-panel")).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as unknown as Janela).__cena!.getSelection())).toBeNull();
});

test("selecionar pela interface (lista, painel) destaca o mesmo personagem na cena", async ({ page }) => {
  await openOffice(page);
  await expect.poll(() => personagens(page), { timeout: 20_000 }).toContain("davi");
  await page.evaluate(() => window.__agentOffice!.view.getState().select({ kind: "agent", id: "davi" }));
  await expect.poll(() => page.evaluate(() => (window as unknown as Janela).__cena!.getSelection()), { timeout: 5_000 }).toEqual({ type: "agent", id: "davi" });
  await expect(page.getByTestId("agent-panel")).toHaveAttribute("data-agent-id", "davi");
  await page.evaluate(() => window.__agentOffice!.view.getState().select(null));
  await expect.poll(() => page.evaluate(() => (window as unknown as Janela).__cena!.getSelection())).toBeNull();
});

test("criar e apagar uma sala: ela entra no mapa e sai dele", async ({ page }) => {
  await openOffice(page);
  const room = await post<Room>(page, "/api/w/principal/rooms", { name: "Sala do e2e do mapa", theme: "ocean" });
  await expect.poll(() => temSala(page, room.id), { timeout: 10_000 }).toBe(true);
  const response = await page.request.delete(`/api/w/principal/rooms/${room.id}`);
  expect(response.status()).toBe(204);
  await expect.poll(() => temSala(page, room.id), { timeout: 10_000 }).toBe(false);
});

test("mover um agente de time (para outro quarto): o personagem muda de sala no mapa", async ({ page }) => {
  await openOffice(page);
  const origem = await post<Room>(page, "/api/w/principal/rooms", { name: "Origem do mapa", theme: "ocean" });
  const destino = await post<Room>(page, "/api/w/principal/rooms", { name: "Destino do mapa", theme: "ocean" });
  const timeOrigem = await post<Team>(page, "/api/w/principal/teams", { roomId: origem.id, name: "Time A", focus: "origem" });
  const timeDestino = await post<Team>(page, "/api/w/principal/teams", { roomId: destino.id, name: "Time B", focus: "destino" });
  const agente = await post<Agent>(page, "/api/w/principal/agents", {
    teamId: timeOrigem.id,
    name: "Mudador",
    role: "Teste",
    instructions: "",
    avatar: { skin: "tone2", hair: "short", hairColor: "wood-dark", shirt: "mint", pants: "denim" },
  });

  await expect.poll(() => salaDoPersonagem(page, agente.id), { timeout: 20_000 }).toBe(origem.id);
  const moved = await page.request.patch(`/api/w/principal/agents/${agente.id}`, { data: { teamId: timeDestino.id } });
  expect(moved.status()).toBe(200);
  await expect.poll(() => salaDoPersonagem(page, agente.id), { timeout: 20_000 }).toBe(destino.id);

  await page.request.delete(`/api/w/principal/rooms/${origem.id}`);
  await page.request.delete(`/api/w/principal/rooms/${destino.id}`);
  await expect.poll(() => temSala(page, destino.id), { timeout: 10_000 }).toBe(false);
});

test("agente com aprovação pendente fica com a mão levantada (esperando) na cena e volta a trabalhar depois de aprovar", async ({ page }) => {
  await openOffice(page);
  const response = await page.request.post("/api/w/principal/tasks", { data: { roomId: "projetoy", teamId: "projetoy-conteudo", prompt: "Revisar o texto da home [aprovar]" } });
  expect(response.status()).toBe(201);
  const task = (await response.json()) as { id: string; agentId: string };
  const status = () => page.evaluate((id) => (window as unknown as Janela).__cena!.probe().sim.chars.get(id)?.info.status ?? null, task.agentId);
  await expect.poll(status, { timeout: 20_000 }).toBe("waiting");
  const aprovada = await page.request.post(`/api/w/principal/tasks/${task.id}/approval`, { data: { approved: true } });
  expect(aprovada.status()).toBe(200);
  await expect.poll(status, { timeout: 20_000 }).not.toBe("waiting");
});

test("'Ver no mapa' no painel do agente leva a câmera até o personagem", async ({ page }) => {
  await openOffice(page);
  await expect.poll(() => personagens(page), { timeout: 20_000 }).toContain("clara");
  await page.evaluate(() => window.__agentOffice!.view.getState().select({ kind: "agent", id: "clara" }));
  await expect(page.getByTestId("agent-panel")).toHaveAttribute("data-agent-id", "clara");
  await page.getByTestId("agent-show-on-map").click();
  // A câmera anda (animada) e o personagem fica dentro da janela.
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const at = (window as unknown as Janela).__cena!.screenPositionOf("clara");
          return at !== null && at.x > 0 && at.y > 0 && at.x < window.innerWidth && at.y < window.innerHeight;
        }),
      { timeout: 10_000 },
    )
    .toBe(true);
});

/** A câmera da cena agora (posição e zoom). */
const camera = (page: import("@playwright/test").Page) => page.evaluate(() => {
  const { x, y, zoom } = (window as unknown as Janela).__cena!.probe().camera;
  return { x, y, zoom };
});

test("arrastar o mapa move a câmera (e não seleciona nada)", async ({ page }) => {
  await openOffice(page);
  await expect.poll(() => personagens(page), { timeout: 20_000 }).toContain("lia");
  await page.waitForTimeout(1500);
  const antes = await camera(page);
  const caixa = (await page.getByTestId("cena-escritorio").locator("canvas").first().boundingBox())!;
  const inicio = { x: caixa.x + caixa.width * 0.5, y: caixa.y + caixa.height * 0.5 };
  await page.mouse.move(inicio.x, inicio.y);
  await page.mouse.down();
  await page.mouse.move(inicio.x + 120, inicio.y + 70, { steps: 8 });
  await page.mouse.up();
  const depois = await camera(page);
  expect(Math.hypot(depois.x - antes.x, depois.y - antes.y), "a câmera andou").toBeGreaterThan(20);
  expect(depois.zoom).toBe(antes.zoom);
  // Arrastar não é clicar: a seleção continua vazia.
  expect(await page.evaluate(() => (window as unknown as Janela).__cena!.getSelection())).toBeNull();
});

test("a roda do mouse aproxima e afasta o mapa, dentro dos limites", async ({ page }) => {
  await openOffice(page);
  await expect.poll(() => personagens(page), { timeout: 20_000 }).toContain("lia");
  await page.waitForTimeout(1500);
  const caixa = (await page.getByTestId("cena-escritorio").locator("canvas").first().boundingBox())!;
  await page.mouse.move(caixa.x + caixa.width * 0.5, caixa.y + caixa.height * 0.5);
  const inicial = (await camera(page)).zoom;
  await page.mouse.wheel(0, -120);
  await expect.poll(async () => (await camera(page)).zoom, { timeout: 5_000 }).toBeGreaterThan(inicial);
  const perto = (await camera(page)).zoom;
  await page.mouse.wheel(0, 120);
  await expect.poll(async () => (await camera(page)).zoom, { timeout: 5_000 }).toBeLessThan(perto);
  // Muita roda para o mesmo lado: o zoom para num limite (não passa de 8x nem some).
  for (let k = 0; k < 10; k++) await page.mouse.wheel(0, -120);
  await page.waitForTimeout(600);
  const maximo = (await camera(page)).zoom;
  expect(maximo).toBeGreaterThan(inicial);
  expect(maximo).toBeLessThanOrEqual(8);
});

test("desempenho: a cena desenha quadros sem parar (medida folgada)", async ({ page }) => {
  await openOffice(page);
  await expect.poll(() => personagens(page), { timeout: 20_000 }).toContain("lia");
  await page.waitForTimeout(1500);
  // Conta os quadros desenhados em 3 s pelo gancho `extras.onFrame` da cena. O limite é bem baixo de propósito
  // (headless com WebGL por software roda devagar): pega uma cena travada ou desligada, não uma queda de fps.
  const quadros = await page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        let n = 0;
        const parar = (window as unknown as Janela).__cena!.extras.onFrame(() => void n++);
        setTimeout(() => {
          parar();
          resolve(n);
        }, 3000);
      }),
  );
  expect(quadros, "quadros em 3 s").toBeGreaterThanOrEqual(30);
});
