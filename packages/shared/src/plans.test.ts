import { describe, expect, it } from "vitest";
import { answeredCount, formatAnswers } from "./for-you";
import { buildPlanTasks, dispatchSettings, findDependencyCycle, kanbanColumn, planMarkdown, planProgress, type PlanTaskInput } from "./plans";

const AT = "2026-11-08T12:00:00.000Z";
const pool = {
  agents: [
    { id: "ana", name: "Ana" },
    { id: "beto", name: "Beto" },
    { id: "maestro", name: "Maestro" },
  ],
  forbidden: new Set(["maestro"]),
};

const task = (ref: string, extra: Partial<PlanTaskInput> = {}): PlanTaskInput => ({ ref, title: `Tarefa ${ref}`, briefing: `Fazer ${ref}`, owner: "ana", ...extra });

describe("buildPlanTasks", () => {
  it("monta as tarefas: etapas por id ou nome, dono como etapa única, refs automáticos e status pelas dependências", () => {
    const built = buildPlanTasks(
      [
        task("T1"),
        { title: "Escrever", briefing: "Escrever o texto", owner: "Beto", steps: [{ agent: "ana", does: "ler os comentários" }, { agent: "BETO", does: "escrever as respostas" }], depends_on: ["T1"], priority: "high" },
      ],
      pool,
      AT,
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const [first, second] = built.tasks;
    expect(first).toMatchObject({ ref: "T1", ownerId: "ana", status: "a_fazer", priority: "normal", steps: [{ agentId: "ana", what: "Fazer T1", status: "pendente" }] });
    expect(second).toMatchObject({ ref: "T2", ownerId: "beto", status: "backlog", priority: "alta", dependsOn: ["T1"], current: 0 });
    expect(second!.steps.map((step) => step.agentId)).toEqual(["ana", "beto"]);
  });

  it("recusa agente desconhecido, o Maestro, dependência que não existe, ref repetido e ciclo", () => {
    const unknown = buildPlanTasks([task("T1", { owner: "zé" })], pool, AT);
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.errors.join("\n")).toContain('agent "zé" does not exist');
    const maestro = buildPlanTasks([task("T1", { steps: [{ agent: "maestro", does: "x" }] })], pool, AT);
    expect(maestro.ok).toBe(false);
    const dep = buildPlanTasks([task("T1", { depends_on: ["T9"] })], pool, AT);
    expect(!dep.ok && dep.errors.join("\n")).toContain('depends on "T9", which is not in the plan');
    const repeated = buildPlanTasks([task("T1"), task("T1")], pool, AT);
    expect(!repeated.ok && repeated.errors.join("\n")).toContain('ref "T1" already exists');
    const cycle = buildPlanTasks([task("A", { depends_on: ["C"] }), task("B", { depends_on: ["A"] }), task("C", { depends_on: ["B"] })], pool, AT);
    expect(cycle.ok).toBe(false);
    if (!cycle.ok) expect(cycle.errors.join("\n")).toMatch(/cycle: (A → C → B → A|A → B → C → A|C → B → A → C)/);
    const self = buildPlanTasks([task("A", { depends_on: ["A"] })], pool, AT);
    expect(!self.ok && self.errors.join("\n")).toContain("cannot depend on itself");
  });

  it("add_plan_tasks: refs novos continuam a numeração, podem depender das que já existem e não repetem", () => {
    const first = buildPlanTasks([task("T1"), task("T2")], pool, AT);
    if (!first.ok) throw new Error("plano inválido");
    first.tasks[0]!.status = "concluida";
    const more = buildPlanTasks([{ title: "Extra", briefing: "Mais", owner: "beto", depends_on: ["T1"] }, { title: "Outra", briefing: "Mais", owner: "beto", depends_on: ["T2"] }], pool, AT, first.tasks);
    expect(more.ok).toBe(true);
    if (!more.ok) return;
    expect(more.tasks.map((item) => [item.ref, item.status])).toEqual([
      ["T3", "a_fazer"],
      ["T4", "backlog"],
    ]);
    expect(buildPlanTasks([task("T2")], pool, AT, first.tasks).ok).toBe(false);
  });
});

describe("plano: quadro, progresso e texto", () => {
  it("coluna do kanban por status (falhou fica em andamento; cancelada em concluído)", () => {
    expect(kanbanColumn({ status: "backlog" })).toBe("backlog");
    expect(kanbanColumn({ status: "a_fazer" })).toBe("a_fazer");
    expect(kanbanColumn({ status: "falhou" })).toBe("em_andamento");
    expect(kanbanColumn({ status: "esperando_voce" })).toBe("esperando_voce");
    expect(kanbanColumn({ status: "cancelada" })).toBe("concluido");
  });

  it("progresso conta as concluídas sobre o total sem as canceladas; markdown lista dono e etapas", () => {
    const built = buildPlanTasks([task("T1"), task("T2", { steps: [{ agent: "ana", does: "a" }, { agent: "beto", does: "b" }], depends_on: ["T1"] }), task("T3")], pool, AT);
    if (!built.ok) throw new Error("plano inválido");
    built.tasks[0]!.status = "concluida";
    built.tasks[2]!.status = "cancelada";
    expect(planProgress({ tasks: built.tasks })).toEqual({ done: 1, total: 2, skipped: 0 });
    const text = planMarkdown({ title: "Campanha", tasks: built.tasks }, (id) => (id === "ana" ? "Ana" : "Beto"));
    expect(text).toContain("**T2 · Tarefa T2** — dono: Ana; etapas: Ana → Beto (depois de T1)");
  });

  it("ciclo nas dependências e configuração da distribuição", () => {
    expect(findDependencyCycle(new Map([["a", ["b"]], ["b", []]]))).toBeNull();
    expect(dispatchSettings(undefined)).toEqual({ maxRunning: 3, perAgent: 1 });
    expect(dispatchSettings({ maxRunning: 5 })).toEqual({ maxRunning: 5, perAgent: 1 });
  });
});

describe("questionário", () => {
  it("formata as respostas (puladas e em branco = decida você, com a sugestão) e conta as respondidas", () => {
    const questions = [
      { id: "q1", text: "Público?", default: "devs" },
      { id: "q2", text: "Tom?" },
      { id: "q3", text: "Prazo?" },
    ];
    const answers = { q1: { skipped: true }, q2: { text: "leve" } };
    expect(formatAnswers(questions, answers)).toBe("1. Público?\n   → decida você (sugestão: devs)\n2. Tom?\n   → leve\n3. Prazo?\n   → decida você");
    expect(answeredCount({ questions, answers })).toBe(2);
  });
});
