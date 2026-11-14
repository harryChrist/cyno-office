import type { ForYouItem, Task } from "@cyno/shared";
import type { ActivityEntry } from "@cyno/shared";
import { afterEach, describe, expect, it } from "vitest";
import { ActivityLog, setActivityLog } from "../activity/log";
import { call, createTask, getOffice, soloTeam, wsApi } from "../../dev/test-api";
import { useTestApp, type TestApp } from "../../dev/test-app";
import type { AgentRunner, ApprovalDecision, RunHooks, RunInput, RunOutcome } from "../../engines/runner/types";

/** Aprovar em lote (Gestão): `POST /for-you/batch`. */
const setupApp = useTestApp();
type App = TestApp["app"];

afterEach(() => setActivityLog(undefined));

type Draft = { question: string; draft: { type: string; text: string; where: string } };
const drafts = (types: string[]): Draft[] => types.map((type, index) => ({ question: `Item ${index + 1}?`, draft: { type, text: `Rascunho ${index + 1}`, where: "Post X" } }));

/** Runner que abre um lote com os tipos dados e guarda a decisão única que volta. */
function lotRunner(types: string[]) {
  const seen: ApprovalDecision[] = [];
  const runner: AgentRunner = {
    async run(input: RunInput, hooks: RunHooks): Promise<RunOutcome> {
      if (input.resumedDecision) {
        seen.push(input.resumedDecision);
        return { status: "done", result: "feito" };
      }
      const decision = await hooks.requestApproval({ question: "Lote", items: drafts(types) });
      seen.push(decision);
      return { status: "done", result: "feito" };
    },
  };
  return { runner, seen };
}

const listItems = (app: App) => call<ForYouItem[]>(app, "GET", `${wsApi()}/for-you`);
const batch = (app: App, body: object, status = 200) => call<{ items: ForYouItem[]; error?: string }>(app, "POST", `${wsApi()}/for-you/batch`, body, status);
const taskOf = async (app: App, id: string): Promise<Task> => (await getOffice(app)).tasks.find((task) => task.id === id)!;

async function waitingLot(setup: TestApp, count: number) {
  const { room, team } = await soloTeam(setup.app, "Solo");
  const task = await createTask(setup.app, room.id, team.id, "Itens do lote");
  await setup.log.waitForTask(task.id, "waiting_approval");
  const items = await listItems(setup.app);
  expect(items).toHaveLength(count);
  return { task, items };
}

describe("POST /for-you/batch", () => {
  it("aprova 3 comentários de uma vez: cada um fica aprovado por você, marcado como de lote, e a tarefa segue com uma decisão só", async () => {
    const activity = new ActivityLog({ dataDir: "/nunca-grava", flushMs: 1_000_000 });
    const entries: ActivityEntry[] = [];
    activity.onAppend((entry) => entries.push(entry));
    const { runner, seen } = lotRunner(["comentario", "comentario", "comentario"]);
    const setup = await setupApp({ runner, activity });
    const { task, items } = await waitingLot(setup, 3);

    const response = await batch(setup.app, { ids: items.map((item) => item.id), decision: "aprovado" });
    expect(response.items.map((item) => item.id)).toEqual(items.map((item) => item.id));
    await setup.log.waitForTask(task.id, "done");
    const saved = await listItems(setup.app);
    expect(saved.map((item) => item.status)).toEqual(["aprovado", "aprovado", "aprovado"]);
    expect(saved.every((item) => item.decidedBy === "usuario" && item.viaBatch === true && !item.editedByUser)).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.items?.map((item) => item.status)).toEqual(["approved", "approved", "approved"]);
    expect((await taskOf(setup.app, task.id)).status).toBe("done");
    // Um evento de lote na Atividade, além de um por item.
    const batchEvent = entries.find((entry) => entry.action === "aprovado-em-lote");
    expect(batchEvent).toMatchObject({ category: "aprovacao", actor: "usuario", data: { type: "comentario", ids: items.map((item) => item.id) } });
    expect(batchEvent!.summary).toContain("3 itens");
    expect(entries.filter((entry) => entry.action === "aprovada" && (entry.data as { batch?: boolean }).batch === true)).toHaveLength(3);
  });

  it("recusa, sem decidir nenhum, um lote com tipos misturados", async () => {
    const { runner } = lotRunner(["comentario", "comentario", "resposta"]);
    const setup = await setupApp({ runner });
    const { items } = await waitingLot(setup, 3);
    const response = await batch(setup.app, { ids: items.map((item) => item.id), decision: "aprovado" }, 400);
    expect(response.error).toMatch(/um tipo por vez/);
    expect((await listItems(setup.app)).every((item) => item.status === "pendente")).toBe(true);
  });

  it("recusa o lote inteiro se um item tem edição pendente, e diz qual", async () => {
    const { runner } = lotRunner(["comentario", "comentario"]);
    const setup = await setupApp({ runner });
    const { items } = await waitingLot(setup, 2);
    // O item 2 chega ao servidor com o texto já mexido (o armazenamento devolve cópias, então troca a leitura).
    const deps = (setup.workspaces.get("principal").forYou as unknown as { deps: { state: { readForYou: () => ForYouItem[] } } }).deps;
    const real = deps.state.readForYou.bind(deps.state);
    deps.state.readForYou = () => real().map((item) => (item.id === items[1]!.id ? { ...item, text: "Texto que o dono já mexeu", editedByUser: true } : item));
    const response = await batch(setup.app, { ids: items.map((item) => item.id), decision: "aprovado" }, 400);
    expect(response.error).toContain(items[1]!.id);
    expect(response.error).toMatch(/edição/);
    expect((await listItems(setup.app)).every((item) => item.status === "pendente")).toBe(true);
  });

  it("recusa mais de 20, repetidos, decisão que não seja aprovar, lista vazia e item que não existe", async () => {
    const { runner } = lotRunner(["comentario", "comentario"]);
    const setup = await setupApp({ runner });
    const { items } = await waitingLot(setup, 2);
    const ids = Array.from({ length: 21 }, (_, index) => `A-${String(index + 1).padStart(4, "0")}`);
    await batch(setup.app, { ids, decision: "aprovado" }, 400);
    await batch(setup.app, { ids: [items[0]!.id, items[0]!.id], decision: "aprovado" }, 400);
    await batch(setup.app, { ids: [items[0]!.id], decision: "rejeitado" }, 400);
    await batch(setup.app, { ids: [], decision: "aprovado" }, 400);
    const missing = await batch(setup.app, { ids: ["A-0099"], decision: "aprovado" }, 400);
    expect(missing.error).toMatch(/não existe/);
    expect((await listItems(setup.app)).every((item) => item.status === "pendente")).toBe(true);
  });

  it("convite só entra em lote depois de uma aprovação individual do mesmo agente nesse tipo", async () => {
    const { runner } = lotRunner(["convite", "convite", "convite"]);
    const setup = await setupApp({ runner });
    const { task, items } = await waitingLot(setup, 3);
    const ids = items.map((item) => item.id);
    const refused = await batch(setup.app, { ids, decision: "aprovado" }, 400);
    expect(refused.error).toMatch(/aprovação individual/);
    expect((await listItems(setup.app)).every((item) => item.status === "pendente")).toBe(true);

    // Aprovado um a um, o primeiro vira "histórico" e o resto do lote passa.
    await call(setup.app, "POST", `${wsApi()}/for-you/${ids[0]}/decision`, { status: "aprovado" }, 200);
    const done = await batch(setup.app, { ids: ids.slice(1), decision: "aprovado" });
    expect(done.items).toHaveLength(2);
    await setup.log.waitForTask(task.id, "done");
    const saved = await listItems(setup.app);
    expect(saved.map((item) => [item.status, item.viaBatch === true])).toEqual([
      ["aprovado", false],
      ["aprovado", true],
      ["aprovado", true],
    ]);
  });
});
