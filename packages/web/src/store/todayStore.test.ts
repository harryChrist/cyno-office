import type { ServerEvent, TodayView } from "@cyno/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api/client";
import { useNavStore } from "./navStore";
import { isTodayEvent, TODAY_RELOAD_DELAY_MS, useTodayStore } from "./todayStore";

const view = (workspace: string): TodayView => ({
  workspace,
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

describe("isTodayEvent", () => {
  it("tarefas, projetos, Para você e rotinas recalculam; progresso, log e uso não", () => {
    const yes = ["task:upserted", "project:upserted", "foryou:upserted", "routine:execution", "routine:entry", "media:upserted", "office:snapshot"];
    const no = ["task:progress", "agent:log", "usage:updated", "usage:agents", "activity:appended", "browser:tabs", "sync:resumed"];
    for (const type of yes) expect(isTodayEvent({ type } as unknown as ServerEvent), type).toBe(true);
    for (const type of no) expect(isTodayEvent({ type } as unknown as ServerEvent), type).toBe(false);
  });
});

describe("todayStore", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useNavStore.setState({ workspaceId: "a" });
    useTodayStore.getState().reset();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("carrega a visão do workspace atual e descarta a de outro workspace que chega atrasada", async () => {
    const getToday = vi.spyOn(api, "getToday").mockResolvedValue(view("a"));
    await useTodayStore.getState().loadWorkspace();
    expect(useTodayStore.getState()).toMatchObject({ workspaceId: "a", view: { workspace: "a" } });
    // Troca de workspace no meio da busca: a resposta velha não entra.
    getToday.mockImplementationOnce(async () => {
      useNavStore.setState({ workspaceId: "b" });
      return view("a");
    });
    await useTodayStore.getState().loadWorkspace();
    expect(useTodayStore.getState().view?.workspace).not.toBe("b");
    expect(useTodayStore.getState().workspaceId).toBe("a");
  });

  it("sem ninguém olhando o painel, os eventos não buscam nada", () => {
    const getToday = vi.spyOn(api, "getToday").mockResolvedValue(view("a"));
    useTodayStore.getState().apply({ type: "task:upserted" } as unknown as ServerEvent);
    vi.advanceTimersByTime(TODAY_RELOAD_DELAY_MS + 10);
    expect(getToday).not.toHaveBeenCalled();
  });
});
