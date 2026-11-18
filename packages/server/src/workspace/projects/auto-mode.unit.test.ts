import { projectModeBodySchema, type OfficeState, type Project, type Task } from "@cyno/shared";
import { describe, expect, it, vi } from "vitest";
import { ProjectService, type ProjectServiceDeps } from "./project-service";

const AT = "2026-11-11T12:00:00.000Z";

function project(extra: Partial<Project> = {}): Project {
  return { id: "p1", kind: "projeto", title: "Comentários", origin: "maestro", status: "ativo", version: 1, priority: "normal", mode: { kind: "pede-ok" }, worked: {}, tasks: [], createdAt: AT, updatedAt: AT, approvedAt: AT, ...extra };
}

function harness(initial: Project | Project[], extra: Partial<ProjectServiceDeps> = {}) {
  const clock = { now: new Date(AT) };
  const commit = vi.fn(async () => undefined);
  const deps = {
    workspaceId: "ws",
    state: { read: () => ({ rooms: [], teams: [], agents: [], tasks: [] }) as unknown as OfficeState, commit, publish: vi.fn() } as never,
    agentLog: { append: vi.fn() } as never,
    orchestrator: { enqueue: vi.fn(), cancelTask: vi.fn(), retryWaiting: vi.fn() },
    forYou: { openSpecial: vi.fn(), close: vi.fn(), isArchived: vi.fn(() => false) },
    host: () => undefined,
    settings: () => ({ maxRunning: 3, perAgent: 1 }),
    log: { info: vi.fn(), error: vi.fn() },
    now: () => clock.now,
    checkEveryMs: 0,
    persistDelaysMs: [0, 0],
    ...extra,
  } as unknown as ProjectServiceDeps;
  const service = new ProjectService(Array.isArray(initial) ? initial : [initial], deps);
  return { service, clock };
}

const work = { work: { projectId: "p1", ref: "T1", step: 0 } } as Pick<Task, "work">;
const on = (grant: Partial<Extract<Project["mode"], { kind: "automatico" }>["grant"]> = {}) => project({ mode: { kind: "automatico", grant: { actions: ["comentario"], dailyCap: 2, approvedAt: AT, ...grant } } });

describe("setMode (a rota do usuário)", () => {
  it("liga o Automático gravando o approvedAt no servidor, e volta para Pede OK", async () => {
    const { service } = harness(project());
    const on1 = await service.setMode("p1", { kind: "automatico", actions: ["comentario", "comentario"], dailyCap: 8, sites: ["site.test"] });
    expect(on1.mode).toEqual({ kind: "automatico", grant: { actions: ["comentario"], dailyCap: 8, sites: ["site.test"], approvedAt: AT } });
    const off = await service.setMode("p1", { kind: "pede-ok" });
    expect(off.mode).toEqual({ kind: "pede-ok" });
  });

  it("proposta do Maestro: aceitar liga (com approvedAt de agora); recusar só limpa a sugestão", async () => {
    const proposal = { by: "maestro" as const, at: "2026-11-10T10:00:00.000Z", grant: { actions: ["comentario"], dailyCap: 4, approvedAt: "2026-11-10T10:00:00.000Z" } };
    const accepted = await harness(project({ modeProposal: proposal })).service.setMode("p1", { kind: "proposta", accept: true });
    expect(accepted.mode).toMatchObject({ kind: "automatico", grant: { actions: ["comentario"], dailyCap: 4, approvedAt: AT } });
    expect(accepted.modeProposal).toBeUndefined();
    const refused = await harness(project({ modeProposal: proposal })).service.setMode("p1", { kind: "proposta", accept: false });
    expect(refused.mode).toEqual({ kind: "pede-ok" });
    expect(refused.modeProposal).toBeUndefined();
    await expect(harness(project()).service.setMode("p1", { kind: "proposta", accept: true })).rejects.toMatchObject({ statusCode: 409 });
    await expect(harness(project()).service.setMode("nada", { kind: "pede-ok" })).rejects.toMatchObject({ statusCode: 404 });
  });

  it("o corpo da rota exige tipos e teto, e não aceita campos soltos como approvedAt", () => {
    expect(projectModeBodySchema.safeParse({ kind: "automatico", actions: ["comentario"], dailyCap: 8 }).success).toBe(true);
    expect(projectModeBodySchema.safeParse({ kind: "automatico", actions: [], dailyCap: 8 }).success).toBe(false);
    expect(projectModeBodySchema.safeParse({ kind: "automatico", actions: ["x"] }).success).toBe(false);
    expect(projectModeBodySchema.safeParse({ kind: "automatico", actions: ["x"], dailyCap: 1, approvedAt: AT }).success).toBe(false);
  });
});

describe("autoReserve (ação dentro e fora do grant, teto do dia, pausa)", () => {
  it("Pede OK: nunca libera", () => {
    expect(harness(project()).service.autoReserve(work, { type: "comentario" })).toEqual({ ok: false });
  });

  it("dentro do grant conta o uso; fora do grant diz por quê", () => {
    const { service } = harness(on());
    expect(service.autoReserve(work, { type: "comentario" })).toEqual({ ok: true, projectId: "p1", label: "1 de 2 hoje" });
    expect(service.autoReserve(work, { type: "convite" })).toMatchObject({ ok: false, note: expect.stringContaining("não está liberado") });
  });

  it("teto por dia: o 3º pede OK com a nota; na virada do dia (São Paulo) zera", () => {
    const { service, clock } = harness(on());
    expect(service.autoReserve(work, { type: "comentario" })).toMatchObject({ ok: true });
    expect(service.autoReserve(work, { type: "comentario" })).toMatchObject({ ok: true, label: "2 de 2 hoje" });
    expect(service.autoReserve(work, { type: "comentario" })).toEqual({ ok: false, note: "Teto de 2 por dia atingido" });
    // 02:00Z de 12/11 = 23:00 de 11/11 em São Paulo: ainda o mesmo dia.
    clock.now = new Date("2026-11-12T02:00:00.000Z");
    expect(service.autoReserve(work, { type: "comentario" })).toMatchObject({ ok: false });
    // 03:30Z de 12/11 = 00:30 de 12/11 em São Paulo: dia novo.
    clock.now = new Date("2026-11-12T03:30:00.000Z");
    expect(service.autoReserve(work, { type: "comentario" })).toMatchObject({ ok: true, label: "1 de 2 hoje" });
  });

  it("projeto pausado: nada é aprovado sozinho", () => {
    const { service } = harness({ ...on(), status: "pausado" });
    expect(service.autoReserve(work, { type: "comentario" })).toEqual({ ok: false, note: "Projeto pausado: nada é aprovado sozinho" });
  });

  it("clique no navegador: o site precisa estar na lista (quando há lista)", () => {
    const { service } = harness(on({ sites: ["site.test"] }));
    expect(service.autoReserve(work, { type: "comentario", host: "app.site.test" })).toMatchObject({ ok: true });
    expect(service.autoReserve(work, { type: "comentario", host: "outro.com" })).toMatchObject({ ok: false, note: expect.stringContaining("outro.com") });
  });

  it("tarefa sem projeto ou de projeto que não existe: não libera", () => {
    const { service } = harness(on());
    expect(service.autoReserve({}, { type: "comentario" })).toEqual({ ok: false });
    expect(service.autoReserve({ work: { projectId: "zz", ref: "T1", step: 0 } }, { type: "comentario" })).toEqual({ ok: false });
  });
});

describe("autoReserve de tarefa de rotina (o teto do dia é da rotina)", () => {
  const routineProject = (id: string, extra: Partial<Project> = {}) => project({ id, kind: "tarefa", origin: "rotina", routineRef: { routineId: "R-0001", period: "2026-W46" }, mode: { kind: "automatico", grant: { actions: ["comentario"], dailyCap: 2, approvedAt: AT } }, ...extra });
  const workOf = (id: string) => ({ work: { projectId: id, ref: "T1", step: 0 } }) as Pick<Task, "work">;

  it("delega à rotina (ao vivo) e duas execuções dividem o mesmo teto", () => {
    let used = 0;
    const routineAuto = vi.fn((_routineId: string, input: { type?: string }) => {
      if (input.type !== "comentario") return { ok: false as const, note: "tipo fora" };
      if (used >= 2) return { ok: false as const, note: "Teto de 2 por dia atingido" };
      used += 1;
      return { ok: true as const, label: `${used} de 2 hoje` };
    });
    const { service } = harness([routineProject("e1"), routineProject("e2")], { routineAuto });
    expect(service.autoReserve(workOf("e1"), { type: "comentario" })).toEqual({ ok: true, projectId: "e1", label: "1 de 2 hoje" });
    expect(service.autoReserve(workOf("e2"), { type: "comentario" })).toEqual({ ok: true, projectId: "e2", label: "2 de 2 hoje" });
    expect(service.autoReserve(workOf("e1"), { type: "comentario" })).toEqual({ ok: false, note: "Teto de 2 por dia atingido" });
    expect(service.autoReserve(workOf("e1"), { type: "x" })).toEqual({ ok: false, note: "tipo fora" });
    expect(routineAuto).toHaveBeenCalledWith("R-0001", { type: "comentario" });
    // O contador do projeto de execução não é usado.
    expect(service.get("e1").autoUsage).toBeUndefined();
  });

  it("projeto de rotina pausado ou fechado nunca libera; sem o gancho cai na regra do projeto", () => {
    const routineAuto = vi.fn(() => ({ ok: true as const, label: "x" }));
    expect(harness(routineProject("e1", { status: "pausado" }), { routineAuto }).service.autoReserve(workOf("e1"), { type: "comentario" })).toEqual({ ok: false, note: "Projeto pausado: nada é aprovado sozinho" });
    expect(harness(routineProject("e1", { status: "concluido" }), { routineAuto }).service.autoReserve(workOf("e1"), { type: "comentario" })).toEqual({ ok: false });
    expect(routineAuto).not.toHaveBeenCalled();
    expect(harness(routineProject("e1")).service.autoReserve(workOf("e1"), { type: "comentario" })).toMatchObject({ ok: true, label: "1 de 2 hoje" });
  });
});
