import type { ForYouItem, Task } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { call, createTask, getOffice, soloTeam, wsApi } from "../../dev/test-api";
import { useTestApp, type TestApp } from "../../dev/test-app";
import type { AgentRunner, ApprovalDecision, RunHooks, RunInput, RunOutcome } from "../../engines/runner/types";

const setupApp = useTestApp();
type App = TestApp["app"];

const drafts = (count: number) => Array.from({ length: count }, (_, index) => ({ question: `Comentário ${index + 1}?`, draft: { type: "comentario", text: `Rascunho ${index + 1}`, where: "Post X" } }));

/** Runner que pede um lote de aprovações e guarda a decisão única que volta. */
function batchRunner(count: number) {
  const seen: { decisions: ApprovalDecision[]; inputs: RunInput[] } = { decisions: [], inputs: [] };
  const runner: AgentRunner = {
    async run(input: RunInput, hooks: RunHooks): Promise<RunOutcome> {
      seen.inputs.push(input);
      // Depois de um restart com a decisão já tomada, o agente só segue com ela.
      if (input.resumedDecision) {
        seen.decisions.push(input.resumedDecision);
        return { status: "done", result: "feito depois do restart" };
      }
      const decision = await hooks.requestApproval({ question: "Lote de comentários", items: drafts(count) });
      seen.decisions.push(decision);
      return { status: "done", result: "feito" };
    },
  };
  return { runner, seen };
}

const listItems = (app: App) => call<ForYouItem[]>(app, "GET", `${wsApi()}/for-you`);
const decide = (app: App, id: string, body: Record<string, unknown>, status = 200) => call<ForYouItem>(app, "POST", `${wsApi()}/for-you/${id}/decision`, body, status);
const taskOf = async (app: App, id: string): Promise<Task> => (await getOffice(app)).tasks.find((task) => task.id === id)!;

async function waitingBatch(setup: TestApp, count: number) {
  const { room, team } = await soloTeam(setup.app, "Solo");
  const task = await createTask(setup.app, room.id, team.id, "Comentários do lote");
  await setup.log.waitForTask(task.id, "waiting_approval");
  const items = await listItems(setup.app);
  expect(items).toHaveLength(count);
  return { task, items };
}

describe("lote de aprovações de um agente (request_approval com items)", () => {
  it("abre N itens com o mesmo taskId e groupId; a tarefa só segue quando TODOS saem (fora de ordem, com edição e um cancelado) e o agente recebe uma decisão", async () => {
    const { runner, seen } = batchRunner(3);
    const setup = await setupApp({ runner });
    const { task, items } = await waitingBatch(setup, 3);
    expect(new Set(items.map((item) => item.taskId))).toEqual(new Set([task.id]));
    expect(new Set(items.map((item) => item.groupId)).size).toBe(1);
    expect(items.every((item) => item.groupId && item.status === "pendente")).toBe(true);
    expect(items.map((item) => item.text)).toEqual(["Rascunho 1", "Rascunho 2", "Rascunho 3"]);

    // Fora de ordem: o 2 com edição, depois o 3 cancelado, por último o 1.
    await decide(setup.app, items[1]!.id, { status: "aprovado", text: "Rascunho 2 editado" });
    expect((await taskOf(setup.app, task.id)).status).toBe("waiting_approval");
    await call(setup.app, "POST", `${wsApi()}/for-you/${items[2]!.id}/cancel`, { reason: "não vale" }, 200);
    expect((await taskOf(setup.app, task.id)).status).toBe("waiting_approval");
    expect(seen.decisions).toHaveLength(0);
    await decide(setup.app, items[0]!.id, { status: "aprovado" });

    await setup.log.waitForTask(task.id, "done");
    expect(seen.decisions).toHaveLength(1);
    const decision = seen.decisions[0]!;
    expect(decision.approved).toBe(true);
    expect(decision.items?.map((item) => [item.itemId, item.status])).toEqual([
      [items[0]!.id, "approved"],
      [items[1]!.id, "approved"],
      [items[2]!.id, "cancelled"],
    ]);
    expect(decision.items?.[1]).toMatchObject({ text: "Rascunho 2 editado" });
    expect(decision.items?.[2]?.cancelled).toMatchObject({ by: "usuario", reason: "não vale" });
    const saved = await listItems(setup.app);
    expect(saved.map((item) => item.status)).toEqual(["aprovado", "aprovado", "cancelado"]);
    expect(saved[1]).toMatchObject({ editedByUser: true, decidedBy: "usuario" });
  });

  it("recusa em lote sem projeto (nada de retrabalho): guarda o motivo no item e a tarefa falha como Recusado depois do último item", async () => {
    const { runner, seen } = batchRunner(2);
    const setup = await setupApp({ runner });
    const { task, items } = await waitingBatch(setup, 2);
    const refused = await decide(setup.app, items[0]!.id, { status: "rejeitado", reason: "tom errado" });
    expect(refused).toMatchObject({ status: "rejeitado", rejection: { reason: "tom errado" }, decidedBy: "usuario" });
    await decide(setup.app, items[1]!.id, { status: "aprovado" });
    await setup.log.waitForTask(task.id, "failed");
    expect((await taskOf(setup.app, task.id)).result).toContain("tom errado");
    expect(seen.decisions[0]).toEqual({ approved: false });
  });

  it("POST /tasks/:id/approval decide o item pendente mais antigo do lote", async () => {
    const { runner } = batchRunner(3);
    const setup = await setupApp({ runner });
    const { task, items } = await waitingBatch(setup, 3);
    await call(setup.app, "POST", `${wsApi()}/tasks/${task.id}/approval`, { approved: true }, 200);
    const after = await listItems(setup.app);
    expect(after.map((item) => item.status)).toEqual(["aprovado", "pendente", "pendente"]);
    expect(items).toHaveLength(3);
  });

  it("restart no meio: os N itens voltam (um agente esperando); decidir o resto entrega o resultado de todos ao agente", async () => {
    const first = batchRunner(3);
    const setup = await setupApp({ runner: first.runner });
    const { task, items } = await waitingBatch(setup, 3);
    await decide(setup.app, items[0]!.id, { status: "aprovado", text: "Versão final do 1" });
    await setup.store.flush();

    const second = batchRunner(3);
    const rebooted = await setupApp({ dataDir: setup.dataDir, runner: second.runner });
    const restored = await listItems(rebooted.app);
    expect(restored.map((item) => item.status)).toEqual(["aprovado", "pendente", "pendente"]);
    expect(new Set(restored.map((item) => item.groupId)).size).toBe(1);
    const office = await getOffice(rebooted.app);
    expect(office.tasks.find((candidate) => candidate.id === task.id)?.status).toBe("waiting_approval");
    expect(office.agents.filter((agent) => agent.status === "waiting_approval")).toHaveLength(1);
    expect(second.seen.inputs).toHaveLength(0);

    await decide(rebooted.app, items[2]!.id, { status: "aprovado" });
    expect((await taskOf(rebooted.app, task.id)).status).toBe("waiting_approval");
    await decide(rebooted.app, items[1]!.id, { status: "aprovado" });
    await rebooted.log.waitForTask(task.id, "done");
    const resumed = second.seen.decisions[0]!;
    expect(resumed.items?.map((item) => item.status)).toEqual(["approved", "approved", "approved"]);
    expect(resumed.items?.[0]).toMatchObject({ text: "Versão final do 1" });
  });
});
