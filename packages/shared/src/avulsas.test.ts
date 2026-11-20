import { describe, expect, it } from "vitest";
import { projectSchema } from "./api";
import { AVULSAS_ID, emptyAvulsas, expandAvulsas, isArchivable, isDeletable, requestProject, takeAvulsasRef } from "./avulsas";
import type { Project, ProjectTask } from "./projects";

const at = "2026-11-11T12:00:00.000Z";

function leaf(ref: string, requestId: string, extra: Partial<ProjectTask> = {}): ProjectTask {
  return {
    ref,
    title: `Pedido ${requestId}`,
    briefing: "faça",
    ownerId: "eco",
    steps: [{ agentId: "eco", what: "faz", status: "pendente" }],
    current: 0,
    dependsOn: [],
    priority: "normal",
    doneWhen: [],
    status: "a_fazer",
    rework: { count: 0 },
    updatedAt: at,
    meta: { requestId, origin: "usuario", createdAt: "2026-11-10T10:00:00.000Z" },
    ...extra,
  };
}

describe("Avulsas", () => {
  it("o projeto vazio é válido, fixo e ativo", () => {
    const avulsas = emptyAvulsas(at);
    expect(projectSchema.safeParse(avulsas).success).toBe(true);
    expect(avulsas).toMatchObject({ id: AVULSAS_ID, system: "avulsas", kind: "tarefa", status: "ativo", title: "Avulsas", tasks: [] });
  });

  it("takeAvulsasRef usa o contador e depois continua de onde parou", () => {
    const avulsas = emptyAvulsas(at);
    expect([takeAvulsasRef(avulsas), takeAvulsasRef(avulsas), avulsas.nextRef]).toEqual(["A1", "A2", 3]);
    const sem = { tasks: [leaf("A4", "r"), leaf("A9", "r")] } as Pick<Project, "tasks" | "nextRef">;
    expect(takeAvulsasRef(sem)).toBe("A10");
  });

  it("isArchivable: só finalizada há mais de 14 dias", () => {
    const now = Date.parse("2026-11-30T00:00:00.000Z");
    expect(isArchivable({ status: "concluida", finishedAt: "2026-11-01T00:00:00.000Z", updatedAt: at }, now)).toBe(true);
    expect(isArchivable({ status: "concluida", finishedAt: "2026-11-20T00:00:00.000Z", updatedAt: at }, now)).toBe(false);
    expect(isArchivable({ status: "em_andamento", updatedAt: "2026-01-01T00:00:00.000Z" }, now)).toBe(false);
    expect(isArchivable({ status: "falhou", updatedAt: "2026-01-01T00:00:00.000Z" }, now)).toBe(true);
    expect(isArchivable({ status: "a_fazer", updatedAt: "2026-01-01T00:00:00.000Z" }, now)).toBe(false);
  });

  it("isDeletable: concluída ou cancelada há mais de N dias (0 = qualquer idade); aberta e falhada nunca", () => {
    const now = Date.parse("2026-11-30T00:00:00.000Z");
    const done = { status: "concluida" as const, finishedAt: "2026-11-20T00:00:00.000Z", updatedAt: at };
    expect(isDeletable(done, 7, now)).toBe(true);
    expect(isDeletable(done, 10, now)).toBe(true);
    expect(isDeletable(done, 11, now)).toBe(false);
    expect(isDeletable(done, 0, now)).toBe(true);
    // Sem `finishedAt`, vale a última atualização (a mesma noção do arquivamento).
    expect(isDeletable({ status: "cancelada", updatedAt: "2026-11-01T00:00:00.000Z" }, 14, now)).toBe(true);
    expect(isDeletable({ status: "falhou", updatedAt: "2026-01-01T00:00:00.000Z" }, 0, now)).toBe(false);
    for (const status of ["backlog", "a_fazer", "em_andamento", "esperando_voce"] as const) expect(isDeletable({ status, updatedAt: "2026-01-01T00:00:00.000Z" }, 0, now)).toBe(false);
    expect(isDeletable({ status: "concluida", finishedAt: "ilegível", updatedAt: "ilegível" }, 0, now)).toBe(false);
  });

  it("a vista antiga: um projeto kind tarefa por pedido, com o id do pedido", () => {
    const avulsas: Project = {
      ...emptyAvulsas(at),
      tasks: [
        leaf("A1", "req-1", { status: "concluida", finishedAt: "2026-11-10T11:00:00.000Z" }),
        leaf("A2", "req-2", { priority: "alta", dueAt: "2026-11-20T00:00:00.000Z", meta: { requestId: "req-2", origin: "cyno", brief: "briefing", createdAt: "2026-11-11T01:00:00.000Z" } }),
        leaf("A3", "req-3", { status: "falhou", finishedAt: "2026-11-10T11:00:00.000Z" }),
      ],
    };
    const other: Project = { ...emptyAvulsas(at), id: "p1", kind: "projeto", system: undefined, title: "Plano" };
    const view = expandAvulsas([other, avulsas]);
    expect(view.map((project) => project.id)).toEqual(["p1", "req-1", "req-2", "req-3"]);
    expect(view[1]).toMatchObject({ kind: "tarefa", status: "concluido", finishedAt: "2026-11-10T11:00:00.000Z" });
    expect(view[2]).toMatchObject({ kind: "tarefa", status: "ativo", priority: "alta", dueAt: "2026-11-20T00:00:00.000Z", origin: "cyno", brief: "briefing" });
    expect(view[2]!.finishedAt).toBeUndefined();
    expect(view[3]).toMatchObject({ status: "cancelado" });
    expect(view.every((project) => project.system === undefined)).toBe(true);
  });

  it("requestProject acha o projeto próprio ou a vista do pedido", () => {
    const avulsas: Project = { ...emptyAvulsas(at), tasks: [leaf("A1", "req-1"), leaf("A2", "req-1")] };
    const plan: Project = { ...emptyAvulsas(at), id: "plano", kind: "projeto", system: undefined };
    expect(requestProject([plan, avulsas], "plano")?.id).toBe("plano");
    const view = requestProject([plan, avulsas], "req-1");
    expect(view?.tasks.map((task) => task.ref)).toEqual(["A1", "A2"]);
    expect(requestProject([plan, avulsas], "nada")).toBeUndefined();
    expect(requestProject([plan], "req-1")).toBeUndefined();
  });
});
