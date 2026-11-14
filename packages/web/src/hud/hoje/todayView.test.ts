import type { OfficeState, TodayNow, TodayView } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import {
  blockLabel,
  changeLabel,
  elapsedLabel,
  EMPTY_TEXT,
  goalLabel,
  goalStatusLabel,
  goalTone,
  hourLabel,
  isPlatformQuiet,
  routineTimeline,
  runningCount,
  sectionCounts,
  stageLabel,
  todayHeading,
  trimTimeline,
  waitingLabel,
  withLiveProgress,
  workedLabel,
  type RoutineRow,
} from "./todayView";

const emptyView = (): TodayView => ({
  workspace: "w",
  day: "2026-11-11",
  now: [],
  projects: [],
  routines: { ran: [], running: [], upcoming: [], skipped: [] },
  changes: [],
  goals: [],
  agenda: [],
  waiting: { count: 0, oldest: [] },
  waitingForYou: 0,
  done: [],
  at: "2026-11-11T15:00:00.000Z",
});

describe("cabeçalho e horários (America/Sao_Paulo)", () => {
  it("todayHeading: 'Hoje · quarta, 11/11' e a virada do dia no fuso do dono", () => {
    expect(todayHeading(new Date("2026-11-11T15:00:00Z"))).toBe("Hoje · quarta, 11/11");
    // 23:30 em São Paulo ainda é quarta; 00:30 (03:30Z) já é quinta.
    expect(todayHeading(new Date("2026-11-12T02:30:00Z"))).toBe("Hoje · quarta, 11/11");
    expect(todayHeading(new Date("2026-11-12T03:30:00Z"))).toBe("Hoje · quinta, 12/11");
  });

  it("hourLabel e elapsedLabel", () => {
    expect(hourLabel("2026-11-11T11:04:00Z")).toBe("08:04");
    expect(hourLabel("lixo")).toBe("");
    const now = new Date("2026-11-11T15:00:00Z");
    expect(elapsedLabel("2026-11-11T14:59:20Z", now)).toBe("40 s");
    expect(elapsedLabel("2026-11-11T14:55:00Z", now)).toBe("5 min");
    expect(elapsedLabel("2026-11-11T13:55:00Z", now)).toBe("1 h 05");
    expect(elapsedLabel("2026-11-11T13:00:00Z", now)).toBe("2 h");
    expect(elapsedLabel("x", now)).toBe("");
  });
});

describe("Agora", () => {
  const office = {
    rooms: [{ id: "m", kind: "maestro" }, { id: "r", kind: "team" }],
    teams: [{ id: "tm", roomId: "m" }, { id: "t", roomId: "r" }],
    agents: [{ id: "maestro", teamId: "tm" }, { id: "eco", teamId: "t" }],
    tasks: [
      { id: "a", status: "in_progress", agentId: "eco", teamId: "t", roomId: "r", prompt: "x" },
      { id: "b", status: "queued", agentId: "eco", teamId: "t", roomId: "r", prompt: "y" },
      { id: "c", status: "in_progress", agentId: "maestro", teamId: "tm", roomId: "m", prompt: "coord" },
      { id: "d", status: "in_progress", role: "request", teamId: "tm", roomId: "m", prompt: "pedido" },
    ],
  } as unknown as OfficeState;

  it("runningCount conta só as tarefas de trabalho fazendo (sem fila, Maestro nem pedido)", () => {
    expect(runningCount(office)).toBe(1);
    expect(runningCount(null)).toBe(0);
  });

  it("withLiveProgress põe o progresso novo por cima, menos na fila", () => {
    const rows: TodayNow[] = [
      { taskId: "a", title: "A", since: "", queued: false, progress: 0.2 },
      { taskId: "b", title: "B", since: "", queued: true },
    ];
    const out = withLiveProgress(rows, { a: { agentId: "eco", progress: 0.6, message: "3/5" }, b: { agentId: "eco", progress: 0.9, message: "x" } });
    expect(out[0]).toMatchObject({ progress: 0.6, message: "3/5" });
    expect(out[1]!.progress).toBeUndefined();
  });
});

describe("textos das linhas", () => {
  it("projeto: etapa, bloqueio e horas", () => {
    expect(stageLabel({ status: "ativo", stage: { index: 2, total: 4, title: "roteiro" } })).toBe("etapa 2/4: roteiro");
    expect(stageLabel({ status: "pausado" })).toBe("pausado");
    expect(blockLabel({ type: "voce", note: "esperando você" })).toBe("esperando você");
    expect(blockLabel({ type: "voce", note: "Caio espera você" })).toBe("Caio espera você");
    expect(blockLabel({ type: "cota", note: "Beto sem cota" })).toBe("sem cota: Beto sem cota");
    expect(blockLabel({ type: "falha", note: "timeout" })).toBe("a etapa falhou: timeout");
    expect(workedLabel({ workedMs: 1_800_000, limitMs: 3_600_000 })).toBe("0,5/1 h");
    expect(workedLabel({ workedMs: 5_400_000 })).toBe("1,5 h");
    expect(workedLabel({ workedMs: 0 })).toBe("");
  });

  it("metas: batida, atrasada e no ritmo", () => {
    expect(goalLabel({ title: "Posts", done: 1, target: 2 })).toBe("Posts 1/2");
    const base = { title: "x", done: 1, target: 2 };
    expect(goalTone({ ...base, pace: "no_ritmo" })).toBe("ok");
    expect(goalTone({ ...base, pace: "atrasada" })).toBe("danger");
    expect(goalTone({ ...base, pace: "no_ritmo", blocked: "captcha" })).toBe("warn");
    expect(goalTone({ ...base, done: 2, pace: "concluida" })).toBe("ok");
    expect(goalStatusLabel({ ...base, done: 2, pace: "concluida" })).toBe("Batida");
    expect(goalStatusLabel({ ...base, pace: "atrasada" })).toBe("Atrasada");
  });

  it("acompanhamento: 'Empresa X → Entrevista (hoje 08:04)'", () => {
    expect(changeLabel({ item: "Empresa X", to: "Entrevista", at: "2026-11-11T11:04:00Z" })).toBe("Empresa X → Entrevista (hoje 08:04)");
  });

  it("esperando você", () => {
    expect(waitingLabel(3)).toBe("Esperando você: 3");
    expect(waitingLabel(0)).toBe("Nada esperando você");
  });
});

describe("rotinas numa linha do tempo", () => {
  it("ordena por horário, marca o estado e leva o resultado ou o motivo", () => {
    const rows = routineTimeline({
      ran: [{ routineId: "R-1", title: "E-mail", at: "2026-11-11T11:00:00Z", outcome: "ok", summary: "2 novos registrados" }, { routineId: "R-3", title: "Radar", at: "2026-11-11T12:00:00Z", outcome: "falhou", summary: "site fora" }],
      running: [{ routineId: "R-2", title: "Status", startedAt: "2026-11-11T14:55:00Z", agent: "Ana" }],
      upcoming: [{ routineId: "R-1", title: "E-mail", at: "2026-11-11T21:00:00Z", label: "18:00", agent: "Ana" }],
      skipped: [{ routineId: "R-4", title: "Vagas", at: "2026-11-11T13:00:00Z", reason: "site pediu captcha" }],
    });
    expect(rows.map((row) => [row.label, row.state, row.detail])).toEqual([
      ["08:00 E-mail", "ran", "2 novos registrados"],
      ["09:00 Radar", "failed", "falhou: site fora"],
      ["10:00 Vagas", "skipped", "pulada: site pediu captcha"],
      ["11:55 Status", "running", "rodando · Ana"],
      ["18:00 E-mail", "upcoming", "Ana"],
    ]);
  });
});

describe("seções recolhidas", () => {
  it("o dia vazio tem todas as seções com zero linhas e um texto curto para cada", () => {
    const view = emptyView();
    expect(Object.values(sectionCounts(view)).every((count) => count === 0)).toBe(true);
    expect(EMPTY_TEXT.rotinas).toBe("Nenhuma rotina hoje");
    expect(isPlatformQuiet([view])).toBe(true);
  });

  it("sectionCounts soma as quatro listas de rotinas e a plataforma deixa de ser quieta com algo esperando", () => {
    const view = emptyView();
    view.routines = { ran: [{ routineId: "R", title: "t", at: "x", outcome: "ok" }], running: [], upcoming: [{ routineId: "R", title: "t", at: "x", label: "18:00" }], skipped: [] };
    expect(sectionCounts(view).rotinas).toBe(2);
    const waiting = { ...emptyView(), waiting: { count: 1, oldest: [] } };
    expect(isPlatformQuiet([emptyView(), waiting])).toBe(false);
  });
});

describe("trimTimeline", () => {
  const row = (n: number, state: "ran" | "upcoming" | "running" | "skipped"): RoutineRow => ({ key: `${state}${n}`, routineId: "R", state, at: `2026-11-11T${String(10 + n).padStart(2, "0")}:00:00Z`, label: `${n}` });
  const rows = [row(0, "ran"), row(1, "ran"), row(2, "skipped"), row(3, "ran"), row(4, "ran"), row(5, "running"), row(6, "upcoming"), row(7, "upcoming"), row(8, "upcoming"), row(9, "upcoming"), row(10, "upcoming"), row(11, "upcoming")];

  it("recolhe o excesso: últimas 3 feitas, a que roda agora e as 4 próximas", () => {
    const { rows: shown, hidden } = trimTimeline(rows, false);
    expect(shown.map((r) => r.key)).toEqual(["skipped2", "ran3", "ran4", "running5", "upcoming6", "upcoming7", "upcoming8", "upcoming9"]);
    expect(hidden).toBe(4);
  });

  it("expandido mostra tudo; poucas linhas não escondem nada", () => {
    expect(trimTimeline(rows, true)).toEqual({ rows, hidden: 0 });
    expect(trimTimeline(rows.slice(3, 8), false).hidden).toBe(0);
  });
});
