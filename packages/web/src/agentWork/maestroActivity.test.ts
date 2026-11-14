import type { OfficeState } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { makeAgent, makeLogEntry, makeOffice, makeRoom, makeTask } from "../test-fixtures";
import { applyTerminalEvent } from "../store/terminalsStore";
import { entryToActivity, maestroActivityGroups, toolLabel } from "./maestroActivity";

function withMaestro(): OfficeState {
  const office = makeOffice();
  office.tasks = [];
  office.rooms.push(makeRoom("sala", { kind: "maestro", name: "Sala do Maestro", gridPosition: { x: -1, y: 0 } }));
  office.teams.push({ id: "gerencia", roomId: "sala", name: "Gerência", focus: "coordenar" });
  office.agents.push(makeAgent("maestro", "gerencia", { role: "maestro" }));
  return office;
}

const at = (minute: number) => `2026-11-08T10:${String(minute).padStart(2, "0")}:00.000Z`;
const log = (id: string, taskId: string, minute: number, body: Parameters<typeof makeLogEntry>[1], extra = {}) => makeLogEntry(id, body, { taskId, agentId: "maestro", at: at(minute), ...extra });

describe("maestroActivityGroups", () => {
  it("agrupa por pedido, em ordem, com o selo do pedido e passos em linguagem de gente; sem linhas cruas", () => {
    const office = withMaestro();
    office.tasks.push(
      makeTask("p1", { roomId: "sala", teamId: "gerencia", agentId: "maestro", prompt: "Escreva um slogan", status: "done", createdAt: at(1), updatedAt: at(9) }),
      makeTask("p2", { roomId: "sala", teamId: "gerencia", agentId: "maestro", prompt: "oi do terminal", status: "in_progress", createdAt: at(10), updatedAt: at(10) }),
    );
    const entries = [
      log("e1", "p1", 1, { kind: "status", status: "started", message: "Pedido recebido: ‘Escreva um slogan’" }),
      log("e2", "p1", 2, { kind: "raw", stream: "stderr", text: "[init] aviso enorme" }),
      log("e3", "p1", 2, { kind: "tool", toolUseId: "t1", name: "mcp__office__get_team", summary: "", status: "ok" }),
      log("e4", "p1", 3, { kind: "tool", toolUseId: "t2", name: "mcp__office__read_note", summary: "briefing", status: "ok" }),
      log("e5", "p1", 3, { kind: "tool", toolUseId: "t3", name: "mcp__office__read_note", summary: "briefing", status: "ok" }),
      log("e6", "p1", 4, { kind: "tool", toolUseId: "t4", name: "mcp__office__delegate_task", summary: "", status: "ok" }),
      log("e7", "p1", 4, { kind: "delegation", teamId: "a-time", teamName: "Time A", toAgentId: "ana", toAgentName: "Ana", reason: "Ana escreve bem", subtaskId: "s1" }),
      log("e8", "p1", 5, { kind: "text", text: "Vou esperar a Ana.\nDetalhes" }),
      log("e9", "p1", 6, { kind: "text", text: "**Ana entregou.**" }),
      log("e10", "p1", 9, { kind: "result", text: "Slogan: X" }),
      log("e11", "p1", 9, { kind: "status", status: "done", message: "Concluída" }),
      log("e12", "p2", 10, { kind: "status", status: "started", message: "Pedido pelo terminal: ‘oi do terminal’" }),
      log("e13", "p2", 10, { kind: "tool", toolUseId: "t5", name: "Read", summary: "CLAUDE.md", status: "running" }, { thread: undefined }),
      log("e14", "p2", 10, { kind: "text", text: "dentro do subagente" }, { thread: "sub1" }),
    ];
    const groups = maestroActivityGroups(entries, office, {});
    expect(groups.map((group) => [group.taskId, group.stageLabel, group.tone, group.fromTerminal])).toEqual([
      ["p1", "Concluído", "success", false],
      ["p2", "Triando", "busy", true],
    ]);
    expect(groups[0]!.steps.map((step) => [step.kind, step.label, step.count])).toEqual([
      ["received", "Recebeu o pedido", undefined],
      ["tool", "Consultou a equipe", undefined],
      ["tool", "Leu uma nota do Cérebro", 2],
      ["delegation", "Delegou para Ana · Time A", undefined],
      ["note", "Ana entregou.", undefined],
      ["result", "Respondeu", undefined],
    ]);
    expect(groups[0]!.steps.find((step) => step.kind === "delegation")).toMatchObject({ agentId: "ana", detail: "Ana escreve bem", tone: "busy" });
    expect(groups[1]!.steps.map((step) => [step.kind, step.label, step.tone])).toEqual([
      ["received", "Recebeu o pedido", "neutral"],
      ["tool", "Leu um arquivo", "busy"],
    ]);
  });

  it("a narração que é o começo da resposta some (fica só a resposta)", () => {
    const office = withMaestro();
    office.tasks.push(makeTask("p1", { roomId: "sala", teamId: "gerencia", agentId: "maestro", status: "done", createdAt: at(1), updatedAt: at(2) }));
    const groups = maestroActivityGroups(
      [log("a", "p1", 1, { kind: "text", text: "ok: tudo **certo** por aqui" }), log("b", "p1", 2, { kind: "result", text: "ok: tudo certo por aqui\n\nmais" })],
      office,
      {},
    );
    expect(groups[0]!.steps.map((step) => step.kind)).toEqual(["result"]);
  });

  it("conversa: cada fala do usuário vira uma troca leve com o que o Maestro fez e a resposta; o pedido aberto na conversa é marcado", () => {
    const office = withMaestro();
    office.tasks.push(makeTask("p1", { roomId: "sala", teamId: "gerencia", agentId: "maestro", prompt: "Post sobre IA\n\nBriefing", status: "in_progress", createdAt: at(5), updatedAt: at(5) }));
    const chat = "conversa-maestro-20261108";
    const entries = [
      log("c1", chat, 1, { kind: "chat", from: "user", text: "oi, tudo bem?", via: "painel" }),
      log("c2", chat, 1, { kind: "text", text: "Tudo ótimo!" }),
      log("c3", chat, 1, { kind: "chat", from: "agent", text: "Tudo ótimo! E você?" }),
      log("c4", chat, 4, { kind: "chat", from: "user", text: "pode pedir para o time escrever", via: "terminal" }),
      log("c5", chat, 5, { kind: "tool", toolUseId: "t1", name: "mcp__office__open_request", summary: "Post sobre IA", status: "ok" }),
      log("p1a", "p1", 5, { kind: "status", status: "started", message: "Pedido aberto pelo Maestro: ‘Post sobre IA’" }),
      log("c6", chat, 6, { kind: "chat", from: "agent", text: "Abri o pedido “Post sobre IA”." }),
    ];
    const groups = maestroActivityGroups(entries, office, {});
    expect(groups.map((group) => [group.kind, group.prompt, group.stageLabel, group.fromTerminal, group.fromChat])).toEqual([
      ["conversa", "oi, tudo bem?", "Conversa", false, false],
      ["conversa", "pode pedir para o time escrever", "Conversa", true, false],
      ["pedido", "Post sobre IA\n\nBriefing", "Triando", false, true],
    ]);
    expect(groups[0]).toMatchObject({ reply: "Tudo ótimo! E você?", taskId: `${chat}:c1` });
    expect(groups[0]!.steps.map((step) => step.kind)).toEqual(["result"]);
    expect(groups[1]!.steps.map((step) => step.label)).toEqual(["Abriu um pedido", "Respondeu"]);
    expect(groups[2]!.steps[0]).toMatchObject({ kind: "received", label: "Abriu o pedido a partir da conversa" });
  });

  it("conversa sem resposta ainda: 'Respondendo…'; com falha: 'Sem resposta'", () => {
    const office = withMaestro();
    const chat = "conversa-maestro-20261108";
    const groups = maestroActivityGroups(
      [
        log("a", chat, 1, { kind: "chat", from: "user", text: "primeira" }),
        log("b", chat, 1, { kind: "status", status: "failed", message: "O Maestro não respondeu: erro" }),
        log("c", chat, 2, { kind: "chat", from: "user", text: "segunda" }),
      ],
      office,
      {},
    );
    expect(groups.map((group) => [group.stageLabel, group.tone])).toEqual([
      ["Sem resposta", "danger"],
      ["Respondendo…", "busy"],
    ]);
  });

  it("limite: só os pedidos mais recentes", () => {
    const office = withMaestro();
    const entries = [];
    for (let i = 0; i < 5; i++) {
      office.tasks.push(makeTask(`p${i}`, { roomId: "sala", teamId: "gerencia", agentId: "maestro", createdAt: at(i), updatedAt: at(i), status: "done" }));
      entries.push(log(`e${i}`, `p${i}`, i, { kind: "result", text: "ok" }));
    }
    expect(maestroActivityGroups(entries, office, {}, 2).map((group) => group.taskId)).toEqual(["p3", "p4"]);
  });

  it("nomes das ferramentas: do escritório, embutidas e de conectores; as cobertas por outra entrada somem", () => {
    expect(toolLabel("mcp__office__get_team")).toBe("Consultou a equipe");
    expect(toolLabel("mcp__office__complete_request")).toBeNull();
    // Log de antes da troca de nomes: o nome antigo acha o mesmo rótulo.
    expect(toolLabel("mcp__office__ver_equipe")).toBe("Consultou a equipe");
    expect(toolLabel("mcp__office__concluir_pedido")).toBeNull();
    expect(toolLabel("mcp__office__notion__create_page")).toBe("create page (notion)");
    expect(toolLabel("mcp__office__nova_coisa")).toBe("Usou nova coisa");
    expect(toolLabel("Glob")).toBe("Procurou arquivos");
    expect(toolLabel("mcp__github__create_issue")).toBe("create issue (github)");
    expect(entryToActivity(makeLogEntry("x", { kind: "approval", phase: "asked", question: "Posso?", forYouId: "f1" }))).toMatchObject({ kind: "approval", tone: "attention", detail: "Posso?" });
    expect(entryToActivity(makeLogEntry("y", { kind: "progress", progress: 0.5, message: "meio" }))).toBeNull();
  });
});

describe("terminalsStore", () => {
  it("snapshot troca tudo; agent:terminal troca o do agente; outros eventos não mexem", () => {
    const info = { agentId: "maestro", engine: "claude" as const, status: "idle" as const, mode: "pty" as const, updatedAt: "x" };
    const snapshot = applyTerminalEvent({}, { type: "office:snapshot", office: makeOffice(), terminals: { maestro: info } });
    expect(snapshot).toEqual({ maestro: info });
    const next = applyTerminalEvent(snapshot, { type: "agent:terminal", terminal: { ...info, status: "busy", remote: { active: true, name: "M" } } });
    expect(next.maestro).toMatchObject({ status: "busy", remote: { active: true, name: "M" } });
    expect(applyTerminalEvent(next, { type: "room:deleted", id: "x" })).toBe(next);
    expect(applyTerminalEvent(next, { type: "office:snapshot", office: makeOffice() })).toEqual({});
  });
});
