import { APPROVAL_REFUSED_RESULT, MAX_REWORK, type ForYouItem, type Plan, type ServerEvent, type Task } from "@cyno/shared";
import { describe, expect, it, vi } from "vitest";
import { API, useTestApp, type TestApp } from "../../dev/test-app";
import type { AgentRunner, ApprovalDecision, RunHooks, RunInput, RunOutcome } from "../../engines/runner/types";

const setupApp = useTestApp();

/** Agente que pede aprovação de um texto; se a recusa voltar com `retry`, refaz e pede de novo. */
function reworkingRunner() {
  const seen: { decisions: ApprovalDecision[]; asked: string[] } = { decisions: [], asked: [] };
  const runner: AgentRunner = {
    async run(input: RunInput, hooks: RunHooks): Promise<RunOutcome> {
      if (!input.task.work) return { status: "done", result: "ok" };
      let text = "Versão 1";
      for (;;) {
        seen.asked.push(text);
        const decision = await hooks.requestApproval({ question: "Posso publicar?", draft: { type: "comentario", text, where: "Post X" } });
        seen.decisions.push(decision);
        if (decision.retry) {
          text = `${text} + ajuste (${decision.reason})`;
          continue;
        }
        if (!decision.approved) return { status: "failed", result: `Recusado: ${decision.response ?? ""}` };
        return { status: "done", result: `publicado: ${decision.text}` };
      }
    },
  };
  return { runner, seen };
}

const api = (ctx: TestApp, method: "GET" | "POST", url: string, payload?: unknown) => ctx.app.inject({ method, url: `${API}${url}`, ...(payload ? { payload: payload as Record<string, unknown> } : {}) });
const items = async (ctx: TestApp) => (await api(ctx, "GET", "/for-you")).json() as ForYouItem[];

async function pendingFor(ctx: TestApp, taskId: string, expected: number): Promise<ForYouItem> {
  await vi.waitFor(async () => expect((await items(ctx)).filter((item) => item.taskId === taskId && item.status === "pendente")).toHaveLength(expected), { timeout: 5000 });
  return (await items(ctx)).filter((item) => item.taskId === taskId && item.status === "pendente").at(-1)!;
}

describe("recusa com motivo: retrabalho sozinho com o mesmo agente, até duas vezes", () => {
  it("1ª e 2ª recusas voltam ao agente com o motivo (rework.count, rework.last); a 3ª falha como Recusado e chama o Maestro", async () => {
    const { runner, seen } = reworkingRunner();
    const ctx = await setupApp({ runner });
    const wake = vi.spyOn(ctx.workspaces.get("principal").maestro, "wake");
    const response = await api(ctx, "POST", "/tasks", { prompt: "[plano] Campanha de lançamento" });
    const request = response.json() as Task;
    const proposed = (await ctx.log.waitFor((event) => event.type === "project:upserted" && event.project.id === request.id)) as Extract<ServerEvent, { type: "project:upserted" }>;
    await api(ctx, "POST", `/plans/${proposed.project.id}/approve`);

    // O item do plano também é do "Para você"; o da etapa nasce quando o agente pede aprovação.
    const stepTask = await vi.waitFor(
      () => {
        const found = ctx.store.snapshot().tasks.find((task) => task.projectId === request.id && task.work?.ref === "T1" && task.status === "waiting_approval");
        expect(found).toBeDefined();
        return found!;
      },
      { timeout: 5000 },
    );
    const planOf = () => ctx.workspaces.get("principal").plans.get(request.id) as Plan;
    const reworkOf = () => planOf().tasks.find((task) => task.ref === "T1")!.rework;

    const first = await pendingFor(ctx, stepTask.id, 1);
    await api(ctx, "POST", `/for-you/${first.id}/decision`, { status: "rejeitado", reason: "muito formal" });
    expect(reworkOf()).toMatchObject({ count: 1, last: { reason: "muito formal", itemId: first.id } });
    const second = await vi.waitFor(async () => {
      const pending = (await items(ctx)).filter((item) => item.taskId === stepTask.id && item.status === "pendente");
      expect(pending).toHaveLength(1);
      return pending[0]!;
    });
    expect(second.id).not.toBe(first.id);
    expect(second.text).toContain("muito formal");
    expect((await items(ctx)).find((item) => item.id === first.id)).toMatchObject({ status: "rejeitado", rejection: { reason: "muito formal" } });

    await api(ctx, "POST", `/for-you/${second.id}/decision`, { status: "rejeitado", reason: "curto demais" });
    expect(reworkOf()).toMatchObject({ count: 2, last: { reason: "curto demais" } });
    expect(MAX_REWORK).toBe(2);
    const third = await vi.waitFor(async () => {
      const pending = (await items(ctx)).filter((item) => item.taskId === stepTask.id && item.status === "pendente");
      expect(pending).toHaveLength(1);
      return pending[0]!;
    });
    expect(wake).not.toHaveBeenCalled();

    // A 3ª recusa não volta mais: o fluxo antigo (a tarefa falha e o Maestro decide).
    await api(ctx, "POST", `/for-you/${third.id}/decision`, { status: "rejeitado", reason: "não é isso" });
    await ctx.log.waitForTask(stepTask.id, "failed");
    expect(reworkOf().count).toBe(2);
    await vi.waitFor(() => expect(wake.mock.calls.map((call) => call[1])).toEqual(["failed"]));
    expect(ctx.store.snapshot().tasks.find((task) => task.id === stepTask.id)?.result).toContain(APPROVAL_REFUSED_RESULT);
    expect(seen.decisions.map((decision) => [decision.approved, decision.retry ?? false])).toEqual([
      [false, true],
      [false, true],
      [false, false],
    ]);
    expect(seen.asked).toHaveLength(3);
  });

  it("recusa sem motivo não conta retrabalho: segue o fluxo antigo", async () => {
    const { runner } = reworkingRunner();
    const ctx = await setupApp({ runner });
    const wake = vi.spyOn(ctx.workspaces.get("principal").maestro, "wake");
    const request = (await api(ctx, "POST", "/tasks", { prompt: "[plano] Campanha de lançamento" })).json() as Task;
    await ctx.log.waitFor((event) => event.type === "project:upserted" && event.project.id === request.id);
    await api(ctx, "POST", `/plans/${request.id}/approve`);
    const stepTask = await vi.waitFor(() => {
      const found = ctx.store.snapshot().tasks.find((task) => task.projectId === request.id && task.work?.ref === "T1" && task.status === "waiting_approval");
      expect(found).toBeDefined();
      return found!;
    }, { timeout: 5000 });
    const item = await pendingFor(ctx, stepTask.id, 1);
    await api(ctx, "POST", `/for-you/${item.id}/decision`, { status: "rejeitado" });
    await ctx.log.waitForTask(stepTask.id, "failed");
    expect((ctx.workspaces.get("principal").plans.get(request.id) as Plan).tasks.find((task) => task.ref === "T1")!.rework.count).toBe(0);
    await vi.waitFor(() => expect(wake.mock.calls.map((call) => call[1])).toEqual(["failed"]));
  });
});
