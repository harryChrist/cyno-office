import type { OfficeState } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { makeAgent, makeLogEntry, makeOffice, makeRoom, makeTask } from "../test-fixtures";
import { awaitingReply, maestroChatItems } from "./maestroChatView";

function withMaestro(): OfficeState {
  const office = makeOffice();
  office.tasks = [];
  office.rooms.push(makeRoom("sala", { kind: "maestro", name: "Sala do Maestro", gridPosition: { x: -1, y: 0 } }));
  office.teams.push({ id: "gerencia", roomId: "sala", name: "Gerência", focus: "coordenar" });
  office.agents.push(makeAgent("maestro", "gerencia", { role: "maestro" }));
  return office;
}

const at = (minute: number) => `2026-11-08T10:${String(minute).padStart(2, "0")}:00.000Z`;
const chat = "conversa-maestro-20261108";
const log = (id: string, taskId: string, minute: number, body: Parameters<typeof makeLogEntry>[1]) => makeLogEntry(id, body, { taskId, agentId: "maestro", at: at(minute) });

describe("maestroChatItems", () => {
  it("falas e respostas da conversa, avisos e os pedidos do Maestro (com a resposta final) na ordem; o trabalho do turno fica de fora", () => {
    const office = withMaestro();
    office.tasks.push(
      makeTask("p1", { roomId: "sala", teamId: "gerencia", agentId: "maestro", prompt: "Post sobre IA\n\nBriefing completo", status: "done", result: "Post pronto", createdAt: at(3), updatedAt: at(8) }),
      makeTask("s1", { roomId: "sala", teamId: "gerencia", agentId: "ana", projectId: "p1", prompt: "escreva", status: "done", createdAt: at(4), updatedAt: at(7) }),
    );
    const items = maestroChatItems(
      [
        log("a", chat, 1, { kind: "chat", from: "user", text: "estou pensando num post sobre IA", via: "terminal" }),
        log("b", chat, 1, { kind: "tool", toolUseId: "t", name: "mcp__office__get_team", summary: "", status: "ok" }),
        log("c", chat, 2, { kind: "chat", from: "agent", text: "Boa! Para quem é?" }),
        log("d", chat, 9, { kind: "status", status: "waiting", message: "Maestro sem cota: a mensagem espera" }),
        log("e", "p1", 3, { kind: "status", status: "started", message: "Pedido aberto pelo Maestro: ‘Post sobre IA’" }),
      ],
      office,
      "maestro",
      {},
    );
    expect(items.map((item) => item.kind)).toEqual(["message", "message", "pedido", "notice"]);
    expect(items[0]).toMatchObject({ from: "user", fromTerminal: true });
    expect(items[2]).toMatchObject({ kind: "pedido", taskId: "p1", title: "Post sobre IA", stageLabel: "Concluído", result: "Post pronto" });
    expect(items[3]).toMatchObject({ tone: "attention" });
  });

  it("'respondendo…' só com o Maestro trabalhando e a última fala sendo do usuário", () => {
    const office = withMaestro();
    const items = maestroChatItems([log("a", chat, 1, { kind: "chat", from: "user", text: "oi" })], office, "maestro", {});
    expect(awaitingReply(items, true)).toBe(true);
    expect(awaitingReply(items, false)).toBe(false);
    const answered = maestroChatItems([log("a", chat, 1, { kind: "chat", from: "user", text: "oi" }), log("b", chat, 2, { kind: "chat", from: "agent", text: "olá" })], office, "maestro", {});
    expect(awaitingReply(answered, true)).toBe(false);
  });
});
