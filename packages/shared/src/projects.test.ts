import { describe, expect, it } from "vitest";
import { projectSchema, taskSchema } from "./api";
import { BLOCKED_SPANS_MAX, buildProjectTasks, clearBlocked, setBlocked, isoFromInput, isPlanned, paceFromInput, progressLabel, projectDefaults, projectProgress, projectTaskDefaults, type ProjectTask } from "./projects";

const AT = "2026-11-08T12:00:00.000Z";

describe("projectSchema", () => {
  it("preenche os padrões ao ler um projeto só com os campos obrigatórios", () => {
    const parsed = projectSchema.parse({
      id: "p1",
      title: "Posts",
      status: "ativo",
      version: 1,
      tasks: [{ ref: "T1", title: "a", briefing: "b", ownerId: "ana", steps: [], current: 0, dependsOn: [], priority: "normal", status: "a_fazer", updatedAt: AT }],
      createdAt: AT,
      updatedAt: AT,
    });
    expect(parsed).toMatchObject({ kind: "projeto", origin: "maestro", priority: "normal", mode: { kind: "pede-ok" }, worked: {} });
    expect(parsed.tasks[0]).toMatchObject({ doneWhen: [], rework: { count: 0 } });
  });

  it("lê de volta a tarefa criada à mão sem responsável (etapa com agente vazio)", () => {
    const parsed = projectSchema.parse({
      id: "p1",
      title: "Posts",
      status: "ativo",
      version: 1,
      tasks: [{ ref: "T1", title: "a", briefing: "b", ownerId: "", steps: [{ agentId: "", what: "a", status: "pendente" }], current: 0, dependsOn: [], priority: "normal", status: "backlog", updatedAt: AT }],
      createdAt: AT,
      updatedAt: AT,
    });
    expect(parsed.tasks[0]!.steps[0]!.agentId).toBe("");
    // Id inválido continua recusado.
    expect(projectSchema.safeParse({ ...parsed, tasks: [{ ...parsed.tasks[0], steps: [{ agentId: "Ana Maria", what: "a", status: "pendente" }] }] }).success).toBe(false);
  });

  it("aceita todos os campos do desenho", () => {
    const grant = { actions: ["comentario"], sites: ["linkedin.com"], dailyCap: 5, approvedAt: AT };
    const parsed = projectSchema.parse({
      id: "p1",
      kind: "tarefa",
      title: "Comentar",
      origin: "usuario",
      status: "pausado",
      version: 1,
      priority: "alta",
      startAt: AT,
      dueAt: AT,
      pace: { hoursPerDay: 1.5, window: { from: "09:00", to: "12:00" }, maxParallel: 2 },
      mode: { kind: "automatico", grant },
      modeProposal: { grant, by: "maestro", at: AT },
      doneWhen: [{ id: "d1", text: "3 comentários", met: false }],
      worked: { "2026-11-08": 3_600_000 },
      tasks: [
        {
          ref: "T1",
          title: "a",
          briefing: "b",
          ownerId: "ana",
          current: 0,
          dependsOn: [],
          priority: "baixa",
          status: "backlog",
          updatedAt: AT,
          steps: [{ agentId: "ana", address: "linkedin/ana", what: "x", status: "pendente" }],
          startAt: AT,
          dueAt: AT,
          doneWhen: [{ id: "d1", text: "ok" }],
          blocked: { type: "cota", by: "linkedin/ana", note: "sem cota", since: AT },
          rework: { count: 1, last: { reason: "tom", at: AT, itemId: "A-0001" } },
          origin: { fromAddress: "linkedin/eco", fromRef: "T1", intent: "pass_on", hops: 1 },
        },
      ],
      createdAt: AT,
      updatedAt: AT,
    });
    expect(parsed.mode.kind).toBe("automatico");
    expect(parsed.tasks[0]!.blocked?.type).toBe("cota");
  });

  it("os padrões e isPlanned", () => {
    expect(projectDefaults()).toMatchObject({ kind: "projeto", priority: "normal", mode: { kind: "pede-ok" }, worked: {} });
    expect(projectTaskDefaults()).toEqual({ doneWhen: [], rework: { count: 0 } });
    expect(isPlanned({ kind: "projeto", approvedAt: AT })).toBe(true);
    expect(isPlanned({ kind: "tarefa", approvedAt: undefined })).toBe(false);
    expect(isPlanned({ kind: "projeto" })).toBe(false);
  });
});

describe("pulada, done_when e endereço (fatia 3)", () => {
  const pool = { agents: [{ id: "ana", name: "Ana" }, { id: "beto", name: "Beto" }] };
  const base = { title: "Post", briefing: "Escreva", owner: "Ana" };

  it("projectProgress não conta a pulada como concluída e o texto diz '1 pulada'", () => {
    const task = (ref: string, status: ProjectTask["status"], skipped = false) => ({ ref, status, ...(skipped ? { skipped: true } : {}) }) as ProjectTask;
    const progress = projectProgress({ tasks: [task("T1", "concluida"), task("T2", "concluida", true), task("T3", "concluida"), task("T4", "cancelada")] });
    expect(progress).toEqual({ done: 2, total: 2, skipped: 1 });
    expect(progressLabel(progress)).toBe("2 de 2 concluídas, 1 pulada");
    expect(progressLabel({ done: 1, total: 3 })).toBe("1 de 3 concluídas");
    expect(progressLabel({ done: 0, total: 1, skipped: 2 })).toBe("0 de 1 concluídas, 2 puladas");
  });

  it("buildProjectTasks lê done_when, start_at e due_at e aceita workspace/agente nas etapas", () => {
    const built = buildProjectTasks(
      [{ ...base, done_when: [" até 1200 caracteres ", "", "abre com gancho"], start_at: "2026-11-12", due_at: "2026-11-13T18:00:00-03:00", steps: [{ agent: "linkedin/ana", does: "escrever" }, { agent: "beto", does: "revisar" }] }],
      pool,
      AT,
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.tasks[0]).toMatchObject({
      doneWhen: [{ id: "d1", text: "até 1200 caracteres" }, { id: "d2", text: "abre com gancho" }],
      startAt: "2026-11-12T00:00:00.000Z",
      dueAt: "2026-11-13T21:00:00.000Z",
      steps: [{ agentId: "ana" }, { agentId: "beto" }],
    });
  });

  it("recusa data inválida e início depois do prazo", () => {
    const built = buildProjectTasks([{ ...base, start_at: "sexta", due_at: "2026-11-13" }, { ...base, ref: "T2", start_at: "2026-11-20", due_at: "2026-11-13" }], pool, AT);
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.errors.join("\n")).toContain('start_at "sexta" is not a valid date');
    expect(built.errors.join("\n")).toContain("start_at is after due_at");
  });

  it("paceFromInput e isoFromInput convertem o contrato em inglês", () => {
    expect(paceFromInput({ hours_per_day: 1.5, window: { from: "09:00", to: "12:00" }, max_parallel: 2 })).toEqual({ hoursPerDay: 1.5, window: { from: "09:00", to: "12:00" }, maxParallel: 2 });
    expect(paceFromInput({})).toBeUndefined();
    expect(isoFromInput("2026-11-12")).toBe("2026-11-12T00:00:00.000Z");
    expect(isoFromInput("nunca")).toBeUndefined();
  });

  it("o selo skipped e o outcome cancelled passam pelo schema", () => {
    const parsed = projectSchema.parse({
      id: "p1",
      title: "Posts",
      status: "ativo",
      version: 1,
      tasks: [{ ref: "T1", title: "a", briefing: "b", ownerId: "ana", steps: [], current: 0, dependsOn: [], priority: "normal", status: "concluida", skipped: true, updatedAt: AT }],
      createdAt: AT,
      updatedAt: AT,
    });
    expect(parsed.tasks[0]!.skipped).toBe(true);
    expect(taskSchema.parse({ id: "t1", roomId: "a", teamId: "a-time", prompt: "x", status: "failed", outcome: "cancelled", createdAt: AT, updatedAt: AT }).outcome).toBe("cancelled");
  });
});

describe("blockedSpans: o histórico dos bloqueios que acabaram", () => {
  const blocked = (since: string) => ({ type: "cota" as const, by: "ws/eco", note: "sem cota", since });
  const at = (minutes: number) => new Date(Date.parse(AT) + minutes * 60_000).toISOString();

  it("limpar o bloqueio grava o trecho (tipo, quem, desde, até) e tira `blocked`", () => {
    const task: Pick<ProjectTask, "blocked" | "blockedSpans"> = { blocked: blocked(AT) };
    clearBlocked(task, at(90));
    expect(task.blocked).toBeUndefined();
    expect(task.blockedSpans).toEqual([{ type: "cota", by: "ws/eco", since: AT, until: at(90) }]);
  });

  it("sem bloqueio não grava nada; trecho de duração zero não é gravado", () => {
    const task: Pick<ProjectTask, "blocked" | "blockedSpans"> = {};
    clearBlocked(task, at(10));
    expect(task.blockedSpans).toBeUndefined();
    const instant: Pick<ProjectTask, "blocked" | "blockedSpans"> = { blocked: blocked(AT) };
    clearBlocked(instant, AT);
    expect(instant.blocked).toBeUndefined();
    expect(instant.blockedSpans).toBeUndefined();
  });

  it("guarda só os últimos 20 (os mais antigos saem)", () => {
    const task: Pick<ProjectTask, "blocked" | "blockedSpans"> = {};
    for (let i = 0; i < BLOCKED_SPANS_MAX + 5; i += 1) {
      task.blocked = blocked(at(i * 10));
      clearBlocked(task, at(i * 10 + 5));
    }
    expect(task.blockedSpans).toHaveLength(BLOCKED_SPANS_MAX);
    expect(task.blockedSpans![0]!.since).toBe(at(5 * 10));
    expect(task.blockedSpans!.at(-1)!.until).toBe(at((BLOCKED_SPANS_MAX + 4) * 10 + 5));
  });

  it("setBlocked: trocar o motivo encerra o anterior; manter o mesmo (mesmo `since`) não grava trecho", () => {
    const task: Pick<ProjectTask, "blocked" | "blockedSpans"> = { blocked: blocked(AT) };
    setBlocked(task, { ...blocked(AT), note: "ainda sem cota" }, at(5));
    expect(task.blockedSpans).toBeUndefined();
    setBlocked(task, { type: "agente", note: "espera o Maestro", since: at(30) }, at(30));
    expect(task.blocked).toMatchObject({ type: "agente" });
    expect(task.blockedSpans).toEqual([{ type: "cota", by: "ws/eco", since: AT, until: at(30) }]);
  });

  it("registro antigo (sem blockedSpans, queuedAt e failureKind) continua carregando", () => {
    const parsed = projectSchema.parse({
      id: "p1",
      title: "Posts",
      status: "ativo",
      version: 1,
      tasks: [{ ref: "T1", title: "a", briefing: "b", ownerId: "ana", steps: [], current: 0, dependsOn: [], priority: "normal", status: "a_fazer", updatedAt: AT }],
      createdAt: AT,
      updatedAt: AT,
    });
    expect(parsed.tasks[0]!.blockedSpans).toBeUndefined();
    expect(parsed.tasks[0]!.queuedAt).toBeUndefined();
    const withNew = projectSchema.parse({ ...parsed, tasks: [{ ...parsed.tasks[0]!, queuedAt: AT, blockedSpans: [{ type: "voce", since: AT, until: at(10) }] }] });
    expect(withNew.tasks[0]).toMatchObject({ queuedAt: AT, blockedSpans: [{ type: "voce" }] });
    expect(taskSchema.parse({ id: "t1", roomId: "a", teamId: "a-time", prompt: "x", status: "failed", failureKind: "cota", createdAt: AT, updatedAt: AT }).failureKind).toBe("cota");
    expect(taskSchema.safeParse({ id: "t1", roomId: "a", teamId: "a-time", prompt: "x", status: "failed", failureKind: "bobo", createdAt: AT, updatedAt: AT }).success).toBe(false);
  });
});

describe("projetos da semente do app de teste", () => {
  it("só o id com prefixo seed- é da semente (o agendador não executa esses)", async () => {
    const { isSeedProject } = await import("./projects");
    expect(isSeedProject({ id: "seed-p3" })).toBe(true);
    expect(isSeedProject({ id: "P-0003" })).toBe(false);
    expect(isSeedProject({ id: "meu-seed-" })).toBe(false);
    const { isSeedTask } = await import("./projects");
    expect(isSeedTask({ meta: { requestId: "seed-r12" } })).toBe(true);
    expect(isSeedTask({ meta: { requestId: "req-1" } })).toBe(false);
    expect(isSeedTask({})).toBe(false);
  });
});
