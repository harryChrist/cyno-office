import { describe, expect, it } from "vitest";
import { makeLogEntry as entry } from "../../test-fixtures";
import { runningSubagents } from "@cyno/shared/cena";

const started = (id: string, sub: string, extra: { model?: string; taskId?: string } = {}) =>
  entry(id, { kind: "subagent", phase: "started", subagentId: sub, label: `Peça ${sub}`, goal: "x", ...(extra.model ? { model: extra.model } : {}) }, extra.taskId ? { taskId: extra.taskId } : {});
const finished = (id: string, sub: string) => entry(id, { kind: "subagent", phase: "finished", subagentId: sub, label: `Peça ${sub}`, status: "ok" });

describe("runningSubagents", () => {
  it("só os subagentes rodando da tarefa aberta (o que terminou some)", () => {
    const log = [started("e001", "a", { model: "haiku" }), started("e002", "b"), finished("e003", "a")];
    expect(runningSubagents(log).map((thread) => thread.id)).toEqual(["b"]);
    // Tarefa fechada no log: nada roda mais, mesmo sem o "finished".
    const closed = [...log, entry("e004", { kind: "status", status: "done", message: "Concluída" })];
    expect(runningSubagents(closed)).toEqual([]);
  });
});
