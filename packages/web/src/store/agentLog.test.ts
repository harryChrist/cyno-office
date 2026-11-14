import type { AgentLogEntry } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { makeLogEntry as entry } from "../test-fixtures";
import { entriesOfThread, liveSummary, MAIN_THREAD, mergeEntry, mergeHistory, tasksOf, threadsOf } from "./agentLog";

const text = (id: string, value = id, extra = {}) => entry(id, { kind: "text", text: value }, extra);
const tool = (id: string, status: "running" | "ok" | "error", extra = {}) =>
  entry(id, { kind: "tool", toolUseId: `tu-${id}`, name: "busca", summary: "agentes", status }, extra);

describe("mergeEntry", () => {
  it("acrescenta no fim, substitui o mesmo id e encaixa fora de ordem", () => {
    const a = text("e001");
    const c = text("e003");
    let list = mergeEntry([], a);
    list = mergeEntry(list, c);
    expect(list.map((item) => item.id)).toEqual(["e001", "e003"]);
    list = mergeEntry(list, text("e002"));
    expect(list.map((item) => item.id)).toEqual(["e001", "e002", "e003"]);
    const updated = text("e002", "novo");
    list = mergeEntry(list, updated);
    expect(list).toHaveLength(3);
    expect(list[1]).toBe(updated);
  });

  it("ferramenta atualizada no lugar (mesmo id) vira ok", () => {
    const list = mergeEntry([tool("e001", "running")], tool("e001", "ok"));
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ kind: "tool", status: "ok" });
  });

  it("guarda só as mais novas acima do limite", () => {
    let list: AgentLogEntry[] = [];
    for (let i = 1; i <= 5; i++) list = mergeEntry(list, text(`e00${i}`), 3);
    expect(list.map((item) => item.id)).toEqual(["e003", "e004", "e005"]);
  });
});

describe("mergeHistory", () => {
  it("junta por id, ordena e limita", () => {
    const live = [text("e004"), text("e005")];
    const merged = mergeHistory(live, [text("e001"), text("e002"), text("e004", "do GET")], 4);
    expect(merged.map((item) => item.id)).toEqual(["e001", "e002", "e004", "e005"]);
    expect(merged.find((item) => item.id === "e004")).toMatchObject({ text: "do GET" });
    expect(mergeHistory(merged, [text("e006")], 3).map((item) => item.id)).toEqual(["e004", "e005", "e006"]);
  });

  it("uma ferramenta já terminada ao vivo não volta para running com um GET atrasado", () => {
    const merged = mergeHistory([tool("e001", "ok")], [tool("e001", "running")]);
    expect(merged[0]).toMatchObject({ status: "ok" });
    // O contrário (GET mais novo) vale normalmente.
    expect(mergeHistory([tool("e001", "running")], [tool("e001", "error")])[0]).toMatchObject({ status: "error" });
  });
});

describe("threads", () => {
  const log = [
    text("e001"),
    entry("e002", { kind: "subagent", phase: "started", subagentId: "sa1", label: "Ana · pesquisa", goal: "achar referências" }),
    entry("e003", { kind: "subagent", phase: "started", subagentId: "sa2", label: "Ana · rascunho", goal: "escrever" }),
    text("e004", "do sa1", { thread: "sa1" }),
    entry("e005", { kind: "subagent", phase: "finished", subagentId: "sa1", label: "Ana · pesquisa", status: "ok", result: "3 links" }),
    text("e006", "do sa2", { thread: "sa2" }),
  ];

  it("threadsOf: na ordem de início, com o estado de cada uma", () => {
    expect(threadsOf(log).map(({ id, status, label, goal }) => ({ id, status, label, goal }))).toEqual([
      { id: "sa1", status: "ok", label: "Ana · pesquisa", goal: "achar referências" },
      { id: "sa2", status: "running", label: "Ana · rascunho", goal: "escrever" },
    ]);
  });

  it("threadsOf: um 'finished' sem o 'started' (fora do limite) ainda vira thread", () => {
    expect(threadsOf([log[4]!])).toMatchObject([{ id: "sa1", status: "ok", goal: "" }]);
  });

  it("entriesOfThread: principal = sem thread; senão as do subagente", () => {
    expect(entriesOfThread(log, MAIN_THREAD).map((item) => item.id)).toEqual(["e001", "e002", "e003", "e005"]);
    expect(entriesOfThread(log, "sa2").map((item) => item.id)).toEqual(["e006"]);
  });

  it("tasksOf e liveSummary: tarefa aberta conta os subagentes rodando; fechada não", () => {
    const closed = [
      text("d001", "x", { taskId: "t0" }),
      entry("d002", { kind: "subagent", phase: "started", subagentId: "old", label: "velho", goal: "" }, { taskId: "t0" }),
      entry("d003", { kind: "status", status: "done", message: "Concluída" }, { taskId: "t0" }),
    ];
    const tasks = tasksOf([...closed, ...log]);
    expect(tasks.map(({ taskId, open, activeSubagents, entries }) => ({ taskId, open, activeSubagents, entries }))).toEqual([
      { taskId: "t0", open: false, activeSubagents: 0, entries: 3 },
      { taskId: "t1", open: true, activeSubagents: 1, entries: 6 },
    ]);
    expect(liveSummary([...closed, ...log])).toEqual({ activeTaskId: "t1", activeSubagents: 1 });
    expect(liveSummary(closed)).toEqual({ activeSubagents: 0 });
  });

  it("status final de um subagente (na thread dele) não fecha a tarefa", () => {
    const list = [text("e001"), entry("e002", { kind: "status", status: "done", message: "fim" }, { thread: "sa1" })];
    expect(tasksOf(list)[0]!.open).toBe(true);
  });
});
