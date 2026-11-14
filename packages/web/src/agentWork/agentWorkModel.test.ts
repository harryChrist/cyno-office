import { describe, expect, it } from "vitest";
import { makeLogEntry as entry, makeOffice, makeTask } from "../test-fixtures";
import { defaultTaskId, taskOptions } from "./agentWorkModel";

const at = (minute: number) => `2026-11-08T10:${String(minute).padStart(2, "0")}:00.000Z`;

describe("taskOptions", () => {
  it("tarefas do agente (escritório + só-log), as mais novas primeiro, marcando as atuais", () => {
    const office = makeOffice();
    office.tasks = [
      makeTask("velha", { agentId: "ana", status: "done", createdAt: at(1) }),
      makeTask("agora", { agentId: "ana", status: "in_progress", createdAt: at(5), prompt: "  escrever\n post  " }),
      makeTask("outra", { agentId: "caio", status: "in_progress", createdAt: at(6) }),
    ];
    const log = [
      entry("e1", { kind: "text", text: "a" }, { taskId: "sumida-1234567890", at: at(3) }),
      entry("e2", { kind: "text", text: "b" }, { taskId: "agora", at: at(5) }),
      entry("e3", { kind: "text", text: "c" }, { taskId: "x", agentId: "caio", at: at(7) }),
    ];
    const options = taskOptions(office, "ana", log);
    expect(options.map((option) => [option.id, option.current])).toEqual([
      ["agora", true],
      ["sumida-1234567890", true],
      ["velha", false],
    ]);
    expect(options[0]!.label).toBe("escrever post");
    expect(options[1]!.label).toBe("Tarefa sumida-1");
    expect(taskOptions(office, "ana", log, 1)).toHaveLength(1);
  });
});

describe("defaultTaskId", () => {
  it("em andamento vence a fila (mesmo mais nova); sem atual, a mais recente", () => {
    const office = makeOffice();
    office.tasks = [
      makeTask("rodando", { agentId: "ana", status: "in_progress", createdAt: at(1) }),
      makeTask("fila", { agentId: "ana", status: "queued", createdAt: at(9) }),
      makeTask("feita", { agentId: "ana", status: "done", createdAt: at(0) }),
    ];
    expect(defaultTaskId(taskOptions(office, "ana", []), [])).toBe("rodando");
    office.tasks = [makeTask("a", { agentId: "ana", status: "done", createdAt: at(1) }), makeTask("b", { agentId: "ana", status: "failed", createdAt: at(2) })];
    expect(defaultTaskId(taskOptions(office, "ana", []), [])).toBe("b");
    expect(defaultTaskId([], [])).toBeUndefined();
  });

  it("um log aberto vence uma tarefa só na fila", () => {
    const office = makeOffice();
    office.tasks = [makeTask("fila", { agentId: "ana", status: "queued", createdAt: at(9) })];
    const log = [entry("e1", { kind: "status", status: "started", message: "Começou" }, { taskId: "do-log", at: at(2) })];
    expect(defaultTaskId(taskOptions(office, "ana", log), log)).toBe("do-log");
  });
});
