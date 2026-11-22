import { AGENT_STATUSES, CHAT_QUESTION_WAITING, TASK_STATUSES, type Task } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { agentStatusLabel, AGENT_STATUS_LABELS, AWAITING_REPLY_LABEL, countLabel, formatAgo, formatDateTime, formatTime, percent, ranWithLabel, roomDeletionParts, statusTone, TASK_STATUS_LABELS, taskStatusLabel, truncate } from "./format";

describe("ranWithLabel", () => {
  it("motor de CLI mostra motor · modelo · esforço; simulado ou sem registro, nada", () => {
    expect(ranWithLabel({ ranWith: { engine: "claude", model: "sonnet", effort: "medium" } })).toBe("Claude Code · sonnet · médio");
    expect(ranWithLabel({ ranWith: { engine: "mock" } })).toBeNull();
    expect(ranWithLabel({})).toBeNull();
  });
});

describe("rótulos e tons de status", () => {
  it("todo status tem rótulo em pt-BR", () => {
    for (const status of AGENT_STATUSES) expect(AGENT_STATUS_LABELS[status]).toBeTruthy();
    for (const status of TASK_STATUSES) expect(TASK_STATUS_LABELS[status]).toBeTruthy();
  });

  it("tom por status", () => {
    expect(statusTone("idle")).toBe("neutral");
    expect(statusTone("queued")).toBe("neutral");
    expect(statusTone("working")).toBe("busy");
    expect(statusTone("in_progress")).toBe("busy");
    expect(statusTone("waiting_approval")).toBe("attention");
    expect(statusTone("done")).toBe("success");
    expect(statusTone("failed")).toBe("danger");
  });
});

describe("datas", () => {
  const now = new Date("2026-11-07T12:00:00.000Z");

  it("hora e data/hora; texto inválido volta igual", () => {
    expect(formatTime("2026-11-07T10:05:00.000Z")).toMatch(/^\d{2}:\d{2}$/);
    expect(formatDateTime("2026-11-07T10:05:00.000Z", now)).toMatch(/^\d{2}\/\d{2} \d{2}:\d{2}$/);
    expect(formatDateTime("2025-03-01T10:05:00.000Z", now)).toMatch(/^\d{2}\/\d{2}\/2025 \d{2}:\d{2}$/);
    expect(formatTime("ontem")).toBe("ontem");
    expect(formatDateTime("ontem", now)).toBe("ontem");
  });

  it("tempo relativo", () => {
    expect(formatAgo("2026-11-07T11:59:30.000Z", now)).toBe("agora");
    expect(formatAgo("2026-11-07T12:00:30.000Z", now)).toBe("agora");
    expect(formatAgo("2026-11-07T11:55:00.000Z", now)).toBe("há 5 min");
    expect(formatAgo("2026-11-07T09:00:00.000Z", now)).toBe("há 3 h");
    expect(formatAgo("2026-11-05T09:00:00.000Z", now)).toMatch(/^05\/11 /);
  });
});

describe("números e texto", () => {
  it("porcentagem limitada a 0..100", () => {
    expect(percent(0.456)).toBe("46%");
    expect(percent(2)).toBe("100%");
    expect(percent(-1)).toBe("0%");
    expect(percent(Number.NaN)).toBe("0%");
  });

  it("plural", () => {
    expect(countLabel(1, "nota", "notas")).toBe("1 nota");
    expect(countLabel(0, "nota", "notas")).toBe("0 notas");
  });

  it("truncate junta espaços e corta com reticências", () => {
    expect(truncate("  abc   def ", 20)).toBe("abc def");
    expect(truncate("abcdefghij", 5)).toBe("abcd…");
    expect(truncate("abcdefghij", 5)).toHaveLength(5);
  });
});

describe("roomDeletionParts", () => {
  const empty = { teams: 0, agents: 0, tasks: 0, activeTasks: 0, brainNotes: 0, forYouItems: 0, calendarEvents: 0, logs: 0 };

  it("lista só o que existe, no singular ou plural", () => {
    expect(roomDeletionParts(empty)).toEqual([]);
    expect(roomDeletionParts({ teams: 2, agents: 5, tasks: 12, activeTasks: 1, brainNotes: 12, forYouItems: 3, calendarEvents: 2, logs: 1 })).toEqual([
      "2 times",
      "5 agentes",
      "12 tarefas (1 ativa)",
      "12 notas do Cérebro",
      "3 aprovações em Aprovações",
      "2 eventos do calendário",
      "1 log de trabalho",
    ]);
    expect(roomDeletionParts({ ...empty, tasks: 1, forYouItems: 1, calendarEvents: 1 })).toEqual(["1 tarefa", "1 aprovação em Aprovações", "1 evento do calendário"]);
  });
});

describe("pedido que só espera resposta na conversa", () => {
  const question = { id: "t1", agentId: "maestro", status: "waiting_approval", waiting: CHAT_QUESTION_WAITING } as Task;
  const approval = { id: "t2", agentId: "maestro", status: "waiting_approval" } as Task;

  it("não se chama aprovação", () => {
    expect(taskStatusLabel(question)).toBe(AWAITING_REPLY_LABEL);
    expect(taskStatusLabel(approval)).toBe("aguardando aprovação");
  });

  it("o agente só diz 'aguardando aprovação' quando alguma tarefa pede aprovação de verdade", () => {
    const agent = { id: "maestro", status: "waiting_approval" as const };
    expect(agentStatusLabel(agent, [question, { ...question, id: "t3" }])).toBe(AWAITING_REPLY_LABEL);
    expect(agentStatusLabel(agent, [question, approval])).toBe("aguardando aprovação");
    expect(agentStatusLabel({ id: "maestro", status: "working" }, [question])).toBe("trabalhando");
  });
});
