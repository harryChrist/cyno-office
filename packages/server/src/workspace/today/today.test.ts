import type { AgendaEvent, ForYouItem, MediaItem, OfficeState, Project, ProjectTask, RoutinesToday, Task } from "@cyno/shared";
import { isTodayEmpty } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { buildPlatformToday, buildToday, todayAgenda, type TodayInput } from "./today";
import { renderPlatformToday, renderToday } from "./today-text";

// 11/11/2026 12:00 em São Paulo (15:00 UTC).
const NOW = new Date("2026-11-11T15:00:00Z");
const AT = (hhmm: string) => `2026-11-11T${hhmm}:00.000Z`;

const state = (tasks: Task[] = []): OfficeState =>
  ({ rooms: [{ id: "sala", kind: "team" }], teams: [{ id: "time", roomId: "sala", name: "Time" }], agents: [{ id: "eco", name: "ECO", teamId: "time" }, { id: "ana", name: "Ana", teamId: "time" }], tasks }) as unknown as OfficeState;

const task = (over: Partial<Task>): Task => ({ id: "t1", roomId: "sala", teamId: "time", prompt: "Comentar posts", agentId: "eco", status: "in_progress", createdAt: AT("14:00"), updatedAt: AT("14:30"), ...over }) as Task;

const planTask = (over: Partial<ProjectTask>): ProjectTask =>
  ({ ref: "T1", title: "Roteiro", briefing: "b", ownerId: "ana", steps: [{ agentId: "ana", address: "w/ana", what: "escrever", status: "em_andamento" }], current: 0, dependsOn: [], priority: "normal", status: "em_andamento", doneWhen: [], rework: { count: 0 }, updatedAt: AT("14:00"), ...over }) as ProjectTask;

const project = (over: Partial<Project>): Project =>
  ({ id: "P-1", kind: "projeto", title: "Post com vídeo", origin: "maestro", status: "ativo", version: 1, priority: "normal", mode: { kind: "pede-ok" }, worked: {}, tasks: [planTask({})], createdAt: AT("10:00"), updatedAt: AT("14:00"), ...over }) as Project;

const emptyRoutines: RoutinesToday = { workspace: "w", at: NOW.toISOString(), ran: [], running: [], upcoming: [], goals: [], changes: [] };

const input = (over: Partial<TodayInput> = {}): TodayInput => ({ workspaceId: "w", workspaceName: "Marca", now: NOW, state: state(), progress: {}, projects: [], routines: emptyRoutines, forYou: [], ...over });

describe("buildToday", () => {
  it("nada hoje: tudo vazio e o painel se declara vazio", () => {
    const view = buildToday(input());
    expect(view).toMatchObject({ workspace: "w", day: "2026-11-11", now: [], projects: [], changes: [], goals: [], agenda: [], done: [], waitingForYou: 0 });
    expect(view.routines).toEqual({ ran: [], running: [], upcoming: [], skipped: [] });
    expect(isTodayEmpty(view)).toBe(true);
    expect(renderToday(view)).toContain("Nothing is happening today");
  });

  it("workspace sem rotinas: as outras seções funcionam e as de rotina ficam vazias", () => {
    const view = buildToday(input({ state: state([task({})]), progress: { t1: { agentId: "eco", progress: 0.6, message: "comentando 3/5" } } }));
    expect(view.now).toEqual([expect.objectContaining({ taskId: "t1", agent: "ECO", progress: 0.6, message: "comentando 3/5", queued: false })]);
    expect(view.routines.upcoming).toEqual([]);
    expect(isTodayEmpty(view)).toBe(false);
  });

  it("tudo ao mesmo tempo", () => {
    const routines: RoutinesToday = {
      ...emptyRoutines,
      ran: [{ routineId: "R-1", title: "E-mail", at: AT("11:00"), endedAt: AT("11:05"), outcome: "ok", summary: "2 novos", agent: "Ana" }],
      running: [{ routineId: "R-2", title: "Status", startedAt: AT("14:55"), taskId: "t2", agent: "Ana" }],
      upcoming: [{ routineId: "R-1", title: "E-mail", at: AT("21:00"), scheduleId: "s1", label: "18:00", action: "check", agent: "Ana" }],
      goals: [{ routineId: "R-3", title: "Posts", done: 1, target: 2, period: "week", periodKey: "2026-W46", pace: "no_ritmo" }],
      changes: [{ routineId: "R-4", title: "Vagas", item: "Empresa X", text: "Empresa X: Entrevista", at: AT("11:04"), to: "Entrevista", from: "Enviado" }],
    };
    const forYou = [{ id: "A-1", agentId: "eco", roomId: "sala", type: "post", status: "pendente", title: "Post do dia", meta: {}, text: "", originalText: "", editedByUser: false, createdAt: AT("13:00") }] as unknown as ForYouItem[];
    const agenda = [{ id: "E-1", title: "Call", start: AT("17:00"), end: AT("18:00"), kind: "reuniao", status: "marcado", by: { kind: "dono" }, source: "local", createdAt: AT("09:00") }] as unknown as AgendaEvent[];
    const media = [{ id: "M-1", kind: "image", title: "Capa", fileName: "capa.png", origin: "html", createdAt: AT("14:00") }] as unknown as MediaItem[];
    const view = buildToday(
      input({
        state: state([task({}), task({ id: "t2", routineId: "R-2", prompt: "Rotina Status" }), task({ id: "t3", status: "queued", prompt: "Outra" })]),
        projects: [project({ worked: { "2026-11-11": 1_800_000 }, pace: { hoursPerDay: 1 } })],
        routines,
        forYou,
        agenda,
        media,
      }),
    );
    expect(view.now.map((row) => [row.taskId, row.queued])).toEqual([["t1", false], ["t2", false], ["t3", true]]);
    // A rotina que roda já aparece em "Agora": não repete em Rotinas.
    expect(view.routines.running).toEqual([]);
    expect(view.routines.ran[0]).toMatchObject({ title: "E-mail", summary: "2 novos", outcome: "ok" });
    expect(view.routines.upcoming[0]).toMatchObject({ label: "18:00", agent: "Ana" });
    expect(view.goals[0]).toMatchObject({ done: 1, target: 2 });
    expect(view.changes[0]).toMatchObject({ item: "Empresa X", to: "Entrevista" });
    expect(view.projects[0]).toMatchObject({ id: "P-1", workedMs: 1_800_000, limitMs: 3_600_000, movedToday: true, stage: { index: 1, total: 1, title: "Roteiro", agent: "Ana" } });
    expect(view.agenda).toHaveLength(1);
    expect(view.waiting).toMatchObject({ count: 1, oldest: [{ id: "A-1", title: "Post do dia", agent: "ECO" }] });
    expect(view.done).toEqual([expect.objectContaining({ kind: "midia", mediaId: "M-1" })]);
    const text = renderToday(view);
    expect(text).toContain("stage 1/1");
    expect(text).toContain("Waiting for the owner: 1");
    expect(text).toContain("Owner's calendar today");
  });

  it("projeto: etapa N/M, próximo passo, bloqueio com o tipo e prazo em risco", () => {
    const tasks = [
      planTask({ ref: "T1", title: "Pesquisa", status: "concluida" }),
      planTask({
        ref: "T2",
        title: "Roteiro",
        status: "esperando_voce",
        blocked: { type: "voce", note: "aprove o roteiro", since: AT("13:00") },
        steps: [
          { agentId: "ana", address: "w/ana", what: "escrever", status: "em_andamento" },
          { agentId: "eco", address: "w/eco", what: "gravar", status: "pendente" },
        ],
      }),
      planTask({ ref: "T3", title: "Edição", status: "backlog" }),
    ];
    const view = buildToday(input({ projects: [project({ tasks, dueAt: AT("20:00") })] }));
    expect(view.projects[0]).toMatchObject({ stage: { index: 2, total: 3, title: "Roteiro" }, next: "gravar (ECO)", blocked: { type: "voce", note: "aprove o roteiro" }, atRisk: true });
    expect(renderToday(view)).toMatch(/BLOCKED, waiting for the owner: aprove o roteiro/);
    expect(renderToday(view)).toContain("DEADLINE AT RISK (due 11/11 17:00)");
  });

  it("projeto com sprint fechando mostra que a entrega espera o OK (e some quando ela fecha)", () => {
    const sprint = { id: "S1", name: "Sprint 1 · Marca", startAt: AT("01:00"), endAt: AT("12:00"), order: 1, status: "fechando" as const };
    const view = buildToday(input({ projects: [project({ sprints: [sprint] })] }));
    expect(view.projects[0]).toMatchObject({ deliveryWaiting: "Sprint 1 · Marca" });
    expect(renderToday(view)).toContain('sprint delivery summary "Sprint 1 · Marca" waits for the owner');
    const closed = buildToday(input({ projects: [project({ sprints: [{ ...sprint, status: "fechada" }] })] }));
    expect(closed.projects[0]).not.toHaveProperty("deliveryWaiting");
  });

  it("projeto pausado fica visível; cancelado, concluído e de rotina não", () => {
    const view = buildToday(
      input({
        projects: [project({ id: "P-1", status: "pausado" }), project({ id: "P-2", status: "cancelado" }), project({ id: "P-3", status: "concluido", finishedAt: AT("09:00") }), project({ id: "P-4", origin: "rotina" })],
      }),
    );
    expect(view.projects.map((p) => p.id)).toEqual(["P-1"]);
    // O concluído hoje vira entrega.
    expect(view.done.map((d) => [d.kind, d.id])).toEqual([["projeto", "P-3"]]);
  });

  it("meta batida e execução pulada com o motivo", () => {
    const routines: RoutinesToday = { ...emptyRoutines, goals: [{ routineId: "R-3", title: "Conexões", done: 2, target: 2, period: "week", periodKey: "2026-W46", pace: "concluida" }] };
    const routineList = [
      { id: "R-9", title: "Radar", schedules: [{ id: "s1", label: "09:00" }], lastRuns: [{ id: "x", scheduleId: "s1", startedAt: AT("12:00"), outcome: "pulada", skipReason: "site pediu captcha", changes: [] }] },
    ] as never;
    const view = buildToday(input({ routines, routineList }));
    expect(view.goals[0]).toMatchObject({ done: 2, target: 2, pace: "concluida" });
    expect(view.routines.skipped).toEqual([{ routineId: "R-9", title: "Radar", at: AT("12:00"), scheduleLabel: "09:00", reason: "site pediu captcha" }]);
    expect(renderToday(view)).toContain("skipped");
    expect(renderToday(view)).toContain("Conexões 2/2");
  });

  it("Feito hoje leva a manchete e o resumo da entrega (do resultado da etapa)", () => {
    const result = "O roteiro do vídeo ficou pronto. Segue o texto.\n\nFiz três versões do gancho e deixei a escolhida no topo, com as outras duas guardadas para teste depois.";
    const tasks = [planTask({ ref: "T1", status: "concluida", finishedAt: "2026-11-11T17:00:00.000Z", result })];
    const view = buildToday(input({ projects: [project({ tasks })] }));
    expect(view.done[0]).toMatchObject({ kind: "etapa", headline: "O roteiro do vídeo ficou pronto." });
    expect(view.done[0]!.summary).toMatch(/três versões do gancho/);
    const semTexto = buildToday(input({ projects: [project({ tasks: [planTask({ ref: "T1", status: "concluida", finishedAt: "2026-11-11T17:00:00.000Z" })] })] }));
    expect(semTexto.done[0]!.headline).toBeUndefined();
  });

  it("a manchete e o resumo de Feito hoje saem sem segredo", () => {
    const result = "Subi o acesso com Authorization: Bearer abcdef1234567890zzz agora.\n\nO resumo conta que password: hunter2hunter2 ficou guardado e que o resto está pronto para revisão.";
    const tasks = [planTask({ ref: "T1", status: "concluida", finishedAt: "2026-11-11T17:00:00.000Z", result })];
    const view = buildToday(input({ projects: [project({ tasks })] }));
    expect(JSON.stringify(view.done[0])).not.toMatch(/abcdef1234567890zzz|hunter2hunter2/);
    expect(view.done[0]!.headline).toBeTruthy();
  });

  it("virada do dia em America/Sao_Paulo: 23:30 ainda é hoje, 00:30 é outro dia", () => {
    const tasks = [planTask({ ref: "T1", status: "concluida", finishedAt: "2026-11-12T02:00:00.000Z" })];
    const p = project({ tasks, worked: { "2026-11-11": 600_000 }, updatedAt: "2026-11-12T02:00:00.000Z" });
    const before = buildToday(input({ now: new Date("2026-11-12T02:30:00Z"), projects: [p] }));
    expect(before.day).toBe("2026-11-11");
    expect(before.projects[0]!.workedMs).toBe(600_000);
    expect(before.done.map((d) => d.kind)).toEqual(["etapa"]);
    const after = buildToday(input({ now: new Date("2026-11-12T03:30:00Z"), projects: [p] }));
    expect(after.day).toBe("2026-11-12");
    expect(after.projects[0]!.workedMs).toBe(0);
    expect(after.projects[0]!.movedToday).toBe(false);
    expect(after.done).toEqual([]);
  });

  it("agenda: cancelados ficam de fora e a ordem é a do horário", () => {
    const events = [
      { id: "E-2", title: "B", start: AT("19:00"), end: AT("20:00"), kind: "outro", status: "marcado" },
      { id: "E-1", title: "A", start: AT("13:00"), end: AT("14:00"), kind: "outro", status: "marcado", workspace: "w" },
      { id: "E-3", title: "C", start: AT("15:00"), end: AT("16:00"), kind: "outro", status: "cancelado" },
    ] as unknown as AgendaEvent[];
    expect(todayAgenda(events, () => "Marca").map((item) => [item.id, item.workspaceName])).toEqual([["E-1", "Marca"], ["E-2", undefined]]);
  });
});

describe("buildPlatformToday", () => {
  it("agrupa por workspace, soma o esperando e lista os mais antigos", () => {
    const waiting = (id: string, at: string) => ({ id, type: "post", title: id, at });
    const a = { ...buildToday(input({ workspaceId: "a", workspaceName: "A" })), waiting: { count: 2, oldest: [waiting("A-1", AT("10:00")), waiting("A-2", AT("12:00"))] } };
    const b = { ...buildToday(input({ workspaceId: "b", workspaceName: "B", state: state([task({})]) })), waiting: { count: 1, oldest: [waiting("B-1", AT("09:00"))] } };
    const c = buildToday(input({ workspaceId: "c", workspaceName: "C" }));
    const platform = buildPlatformToday([a, b, c], [], NOW);
    expect(platform.waiting.count).toBe(3);
    expect(platform.waiting.oldest.map((item) => `${item.workspace}/${item.id}`)).toEqual(["b/B-1", "a/A-1", "a/A-2"]);
    expect(platform.workspaces.map((view) => view.workspace)).toEqual(["a", "b", "c"]);
    const text = renderPlatformToday(platform);
    expect(text).toContain('## b "B"');
    expect(text).toContain("Quiet today: C.");
    expect(text).toContain("Waiting for the owner: 3");
  });

  it("sem workspaces", () => {
    expect(renderPlatformToday(buildPlatformToday([], [], NOW))).toContain("no workspaces");
  });
});
