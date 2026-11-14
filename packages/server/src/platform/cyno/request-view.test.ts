import { buildProjectPlan, projectDefaults, type ForYouItem, type Project, type Task } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { requestDetail, requestLine, requestView, type RequestSnapshot } from "./request-view";

const AT = "2026-11-12T12:00:00.000Z";
const NOW = Date.parse(AT);
const names: Record<string, string> = { eco: "Eco", sol: "Sol" };
const pool = { agents: [{ id: "eco", name: "Eco" }, { id: "sol", name: "Sol" }] };

function project(): Project {
  const plan = buildProjectPlan(
    {
      sprints: [{ ref: "a", name: "Sprint 1", goal: "Base", start_at: "2026-11-10T12:00:00.000Z" }, { ref: "b", name: "Sprint 2" }],
      tasks: [
        { ref: "D1", title: "Front", briefing: "g", kind: "group" },
        { ref: "T1", title: "Tela", briefing: "Tela", owner: "Eco", parent: "D1", sprint: "a" },
        { ref: "T2", title: "Arte", briefing: "Arte", owner: "Sol", parent: "D1", sprint: "b" },
      ],
    },
    pool,
    AT,
    NOW,
  );
  if (!plan.ok) throw new Error("setup");
  const sprints = plan.sprints.map((sprint, index) => ({ ...sprint, status: index === 0 ? ("ativa" as const) : ("planejada" as const) }));
  return { ...projectDefaults(), id: "req-1", title: "Curso", status: "ativo", version: 1, tasks: plan.tasks, sprints, labels: [], createdAt: AT, updatedAt: AT } as unknown as Project;
}

const snap = (plan: Project, forYou: ForYouItem[] = []): RequestSnapshot => ({
  workspaceName: "Principal",
  project: plan,
  tasks: [{ id: "req-1", status: "in_progress" } as Task],
  forYou,
  media: [],
  agentName: (id) => names[id],
});
const record = { projectId: "req-1", workspace: "principal", title: "Curso", address: "principal/maestro", sentAt: AT };

describe("o estado de um pedido do Cyno mostra a sprint e a entrega esperando o OK", () => {
  it("sprint ativa com o dia, e o detalhe em árvore com as sprints", () => {
    const view = requestView(record, snap(project()), NOW);
    expect(view.sprint).toBe("Sprint 1 · day 3 of 7");
    expect(view.deliveryWaiting).toBeUndefined();
    expect(requestLine(view)).toContain("Sprint 1 · day 3 of 7");
    const detail = requestDetail(view, snap(project()));
    expect(detail).toContain("Sprints:");
    expect(detail).toContain("- Sprint 1 [ativa] 2026-11-10 → 2026-11-17; 0/1 done; goal: Base");
    expect(detail).toContain("- D1 «Front» (deliverable) [to do] 0/2; Eco, Sol");
    expect(detail).toContain("  - T1 «Tela» [to do]");
  });

  it("sprint fechando: a entrega que espera o OK do dono aparece na linha e no detalhe", () => {
    const plan = project();
    plan.sprints![0] = { ...plan.sprints![0]!, status: "fechando", summary: { builtAt: AT, done: [{ ref: "T1", title: "Tela", assignees: ["eco"], finishedAt: AT }], carried: [], failed: [], skipped: [], byAgent: {}, workedMs: 0 } };
    const view = requestView(record, snap(plan), NOW);
    expect(view.sprint).toBeUndefined();
    expect(view.deliveryWaiting).toBe("Sprint 1");
    expect(requestLine(view)).toContain("Sprint 1 delivery waits for the owner's OK");
    expect(requestDetail(view, snap(plan))).toContain("delivery waits for the owner's OK (1 done, 0 carried over)");
  });

  it("projeto sem sprints: nada de sprint na linha", () => {
    const plan = project();
    plan.sprints = [];
    const view = requestView(record, snap(plan), NOW);
    expect(view.sprint).toBeUndefined();
    expect(requestLine(view)).not.toContain("Sprint");
  });
});
