import { describe, expect, it } from "vitest";
import { soloTeam } from "../../dev/test-api";
import { useTestApp } from "../../dev/test-app";

const setupApp = useTestApp();

describe("projeto de rotina (ProjectService.startRoutineTask)", () => {
  it("em Pede OK cria uma folha do Avulsas (meta com routineRef), entrega a Task ao agente e a folha fecha quando ela termina", async () => {
    const ctx = await setupApp();
    const { agent } = await soloTeam(ctx.app);
    const runtime = ctx.workspaces.get("principal");
    const { task, project } = await runtime.plans.startRoutineTask({
      routineId: "R-0001",
      routineTitle: "Inscrições",
      mode: { kind: "pede-ok" },
      scheduleId: "S1",
      slotKey: "2026-11-11T09:00",
      period: "2026-W46",
      agentId: agent.id,
      title: "E-mail 09:00",
      prompt: "Rotina: Inscrições\n\nLeia os e-mails",
    });
    expect(project).toMatchObject({ id: "avulsas", system: "avulsas" });
    const leaf = project.tasks.find((candidate) => candidate.meta?.requestId === task.id)!;
    expect(leaf).toMatchObject({ ref: "A1", title: "Inscrições: E-mail 09:00", ownerId: agent.id, steps: [{ agentId: agent.id, taskId: task.id }], meta: { requestId: task.id, origin: "rotina", routineRef: { routineId: "R-0001", scheduleId: "S1", slot: "2026-11-11T09:00", period: "2026-W46" } } });
    expect(task).toMatchObject({ agentId: agent.id, routineId: "R-0001", work: { projectId: "avulsas", ref: "A1", step: 0 } });

    // O agente simulado termina a tarefa; a folha acompanha e fecha. A vista do pedido é o projeto de rotina de antes.
    await ctx.log.waitForTask(task.id, "done");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(runtime.plans.get(task.id)).toMatchObject({ id: task.id, kind: "tarefa", origin: "rotina", status: "concluido", routineRef: { routineId: "R-0001" }, tasks: [{ status: "concluida" }] });
  });

  it("em Automático segue como Projeto kind tarefa próprio (teto do dia da rotina; não é dobrado)", async () => {
    const ctx = await setupApp();
    const { agent } = await soloTeam(ctx.app);
    const runtime = ctx.workspaces.get("principal");
    const mode = { kind: "automatico" as const, grant: { actions: ["post"], approvedAt: new Date().toISOString() } };
    const { task, project } = await runtime.plans.startRoutineTask({ routineId: "R-0002", routineTitle: "Posts", mode, scheduleId: "S1", slotKey: "2026-11-11T09:00", period: "2026-W46", agentId: agent.id, title: "Post", prompt: "Publique" });
    expect(project).toMatchObject({ id: task.id, kind: "tarefa", origin: "rotina", mode: { kind: "automatico" }, routineRef: { routineId: "R-0002" } });
    expect(task.work).toEqual({ projectId: task.id, ref: "T1", step: 0 });
    expect(runtime.plans.list().find((candidate) => candidate.id === "avulsas")!.tasks).toHaveLength(0);
    await ctx.log.waitForTask(task.id, "done");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(runtime.plans.get(task.id)).toMatchObject({ status: "concluido" });
  });

  it("agente inexistente: erro 400 e nenhum projeto criado", async () => {
    const ctx = await setupApp();
    const runtime = ctx.workspaces.get("principal");
    const before = runtime.plans.list().length;
    await expect(runtime.plans.startRoutineTask({ routineId: "R-0001", routineTitle: "x", mode: { kind: "pede-ok" }, scheduleId: "S1", slotKey: "2026-11-11T09:00", period: "2026-W46", agentId: "nao-existe", title: "t", prompt: "p" })).rejects.toThrow();
    expect(runtime.plans.list()).toHaveLength(before);
  });
});
