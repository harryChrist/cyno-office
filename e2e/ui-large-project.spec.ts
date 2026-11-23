import { projectDefaults, type Project, type ProjectTask } from "@cyno/shared";
import { expect, test } from "@playwright/test";

const AT = "2026-11-10T12:00:00.000Z";
const AGENTS = ["lia", "davi", "nina", "caio", "bruna", "iara"] as const;
const PRIORITIES = ["alta", "normal", "baixa"] as const;
const STATUSES: readonly ProjectTask["status"][] = ["concluida", "concluida", "em_andamento", "a_fazer", "a_fazer", "backlog", "esperando_voce", "cancelada"];

function makeLargeProject(id: string, modules: number, tasksPerMod: number, subsPerTask: number): Project {
  const tasks: ProjectTask[] = [];
  let seq = 1;
  for (let m = 1; m <= modules; m += 1) {
    const modRef = `G${m}`;
    tasks.push({
      ref: modRef,
      title: `Módulo ${m}`,
      briefing: "",
      ownerId: "",
      steps: [],
      current: 0,
      dependsOn: m === 3 ? ["G2"] : [],
      priority: PRIORITIES[m % PRIORITIES.length]!,
      doneWhen: [],
      rework: { count: 0 },
      status: "backlog",
      updatedAt: AT,
      order: m * 1000,
      group: true,
    });
    for (let t = 1; t <= tasksPerMod; t += 1) {
      const taskRef = `T${seq++}`;
      tasks.push({
        ref: taskRef,
        parent: modRef,
        title: `Tarefa ${m}.${t}`,
        briefing: "",
        ownerId: "",
        steps: [],
        current: 0,
        dependsOn: [],
        priority: PRIORITIES[(m + t) % PRIORITIES.length]!,
        doneWhen: [],
        rework: { count: 0 },
        status: "backlog",
        updatedAt: AT,
        order: t * 1000,
      });
      let prev: string | undefined;
      for (let s = 1; s <= subsPerTask; s += 1) {
        const subRef = `T${seq++}`;
        const owner = AGENTS[(m + t + s) % AGENTS.length]!;
        const status = STATUSES[(m * 7 + t * 3 + s) % STATUSES.length]!;
        tasks.push({
          ref: subRef,
          parent: taskRef,
          title: `Subtarefa ${m}.${t}.${s}`,
          briefing: "b",
          ownerId: owner,
          steps: [{ agentId: owner, what: "passo", status: status === "concluida" ? "feita" : "pendente" }],
          current: 0,
          dependsOn: s === 2 && prev ? [prev] : [],
          priority: PRIORITIES[(m + t + s) % PRIORITIES.length]!,
          doneWhen: [],
          rework: { count: 0 },
          status,
          ...((m + t + s) % 3 === 0 ? { released: false } : {}),
          updatedAt: AT,
          order: s * 1000,
        });
        prev = subRef;
      }
    }
  }
  return { ...projectDefaults(), id, title: `Projeto sintético (${tasks.length} itens)`, status: "pausado", version: 1, tasks, labels: [], sprints: [], createdAt: AT, updatedAt: AT };
}

test("projeto grande (10 mil itens): abre rápido, nasce fechado com poucas linhas no DOM e virtualiza ao passar de 200 linhas abertas", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto("/#/principal/trabalho");
  await expect(page.getByTestId("socket-status")).toHaveAttribute("data-state", "open", { timeout: 20_000 });
  await expect.poll(() => page.evaluate(() => window.__agentOffice?.office.getState().office?.rooms.length ?? 0)).toBeGreaterThan(0);

  const big = makeLargeProject("e2e-proj-10k", 50, 40, 4);
  expect(big.tasks.length).toBe(10_050);

  await page.evaluate((project) => {
    window.__agentOffice!.work.getState().apply({ type: "project:upserted", project });
  }, big);

  const started = Date.now();
  await page.evaluate(() => {
    window.location.hash = "#/principal/trabalho/p/e2e-proj-10k/tarefas";
  });
  await expect(page.getByTestId("tree-row-G1")).toBeVisible({ timeout: 5_000 });
  const elapsedMs = Date.now() - started;
  // Teto generoso para evitar flakiness em CI (antes travava >120 s).
  expect(elapsedMs).toBeLessThan(3_000);

  // Nasce fechado: só a 1ª página de raízes (30) + "ver mais" + linha de adicionar = 32 linhas.
  const initialRows = await page.locator("li.tt-row").count();
  expect(initialRows).toBeLessThanOrEqual(35);

  // Teclado: ArrowRight abre o módulo G1 e ArrowLeft fecha de volta.
  const g1 = page.getByTestId("tree-row-G1");
  await g1.focus();
  await page.keyboard.press("ArrowRight");
  await expect(g1).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("ArrowLeft");
  await expect(g1).toHaveAttribute("aria-expanded", "false");

  // Abre 6 módulos (32 + 6×32 = 224 linhas > 200): a árvore liga a janela de rolagem e mantém poucas linhas montadas no DOM.
  for (let m = 1; m <= 6; m += 1) {
    await page.getByTestId(`tree-toggle-G${m}`).click();
  }
  const body = page.locator("ul.tt-body");
  await expect(body).toHaveAttribute("data-virtualized", "true");
  const totalRows = Number(await body.getAttribute("data-total-rows"));
  expect(totalRows).toBeGreaterThan(200);
  const renderedRows = await page.locator("li.tt-row").count();
  expect(renderedRows).toBeLessThan(80);
  expect(pageErrors).toEqual([]);
});
