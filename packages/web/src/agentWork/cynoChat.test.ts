import { describe, expect, it } from "vitest";
import { askMarker, confirmationMarker, proposalMarker, requestMarker } from "@cyno/shared";
import { makeLogEntry } from "../test-fixtures";
import { cynoChatItems, cynoThinking } from "./cynoChat";

const at = (minute: number) => `2026-11-11T10:${String(minute).padStart(2, "0")}:00.000Z`;
const chat = "conversa-cyno-20261111";
const log = (id: string, minute: number, body: Parameters<typeof makeLogEntry>[1], taskId = chat) => makeLogEntry(id, body, { taskId, agentId: "cyno", at: at(minute) });

describe("cynoChatItems", () => {
  it("falas e respostas na ordem, com o trabalho do turno (ferramentas) entre a fala e a resposta", () => {
    const items = cynoChatItems(
      [
        log("a", 1, { kind: "chat", from: "user", text: "quais workspaces?" }),
        log("b", 1, { kind: "tool", toolUseId: "t1", name: "mcp__office__list_workspaces", summary: "{}", status: "ok" }),
        log("c", 2, { kind: "chat", from: "agent", text: "Existem 2." }),
      ],
      false,
    );
    expect(items.map((item) => item.kind)).toEqual(["message", "work", "message"]);
    const work = items[1]!;
    expect(work.kind === "work" && work.live).toBe(false);
    expect(work.kind === "work" && work.steps).toEqual([expect.objectContaining({ kind: "tool", label: "Consultou os workspaces", running: false })]);
    // "{}" (ferramenta sem argumentos) não é detalhe.
    expect(work.kind === "work" && work.steps[0]!.detail).toBeUndefined();
  });

  it("o trabalho do fim é ao vivo enquanto o Cyno trabalha, e a ferramenta em andamento aparece como rodando", () => {
    const entries = [
      log("a", 1, { kind: "chat", from: "user", text: "cota?" }),
      log("b", 1, { kind: "tool", toolUseId: "t1", name: "mcp__office__get_usage", summary: "", status: "running" }),
    ];
    const live = cynoChatItems(entries, true);
    expect(live.at(-1)).toMatchObject({ kind: "work", live: true, steps: [expect.objectContaining({ running: true, label: "Consultou o uso das assinaturas" })] });
    // A mesma ferramenta atualizada no lugar (mesmo id) termina sem duplicar o passo.
    const done = cynoChatItems([...entries.slice(0, 1), { ...entries[1]!, kind: "tool", toolUseId: "t1", name: "mcp__office__get_usage", summary: "", status: "ok" } as never], true);
    expect(done.filter((item) => item.kind === "work")).toHaveLength(1);
    expect(done.at(-1)).toMatchObject({ kind: "work", live: true, steps: [expect.objectContaining({ running: false })] });
  });

  it("a narração logo antes da resposta (que repete a resposta) não vira passo", () => {
    const items = cynoChatItems(
      [
        log("a", 1, { kind: "chat", from: "user", text: "oi" }),
        log("b", 1, { kind: "text", text: "Oi! Sou o Cyno." }),
        log("c", 2, { kind: "chat", from: "agent", text: "Oi! Sou o Cyno." }),
      ],
      false,
    );
    expect(items.map((item) => item.kind)).toEqual(["message", "message"]);
  });

  it("avisos: cota esperando, falha e nova conversa viram avisos com o tom certo; outras linhas do log ficam de fora", () => {
    const items = cynoChatItems(
      [
        log("a", 1, { kind: "status", status: "waiting", message: "Cyno sem cota: a mensagem espera" }),
        log("b", 2, { kind: "status", status: "failed", message: "O Cyno não respondeu" }),
        log("c", 3, { kind: "status", status: "resumed", message: "Nova conversa" }),
        log("d", 3, { kind: "status", status: "started", message: "ignorado" }),
        log("e", 3, { kind: "raw", stream: "stderr", text: "ruído" }),
        log("f", 3, { kind: "chat", from: "user", text: "de outra tarefa" }, "tarefa-qualquer"),
      ],
      false,
    );
    expect(items.map((item) => (item.kind === "notice" ? item.tone : item.kind))).toEqual(["attention", "danger", "info"]);
  });

  it("corta para os itens mais recentes", () => {
    const entries = Array.from({ length: 10 }, (_, index) => log(`m${String(index).padStart(2, "0")}`, index, { kind: "chat", from: "user", text: `fala ${index}` }));
    const items = cynoChatItems(entries, false, 3);
    expect(items.map((item) => (item.kind === "message" ? item.text : ""))).toEqual(["fala 7", "fala 8", "fala 9"]);
  });
});

describe("cynoThinking", () => {
  const user = { kind: "message", id: "1", at: at(1), from: "user", text: "oi" } as const;
  const agent = { kind: "message", id: "2", at: at(2), from: "agent", text: "oi" } as const;
  it("só mostra o \"respondendo…\" enquanto ele trabalha ou acorda e ainda não mostrou nada além da fala", () => {
    expect(cynoThinking([user], true, false)).toBe(true);
    expect(cynoThinking([user], false, true)).toBe(true);
    expect(cynoThinking([user], false, false)).toBe(false);
    expect(cynoThinking([user, agent], true, false)).toBe(false);
    expect(cynoThinking([user, { kind: "work", id: "w", at: at(1), steps: [], live: true }], true, false)).toBe(false);
    expect(cynoThinking([], true, false)).toBe(false);
  });
});

describe("cynoChatItems: pedidos enviados e trocas ask_cyno", () => {
  it("a marca do pedido vira um cartão (com o trabalho que veio antes recolhido) e a do ask vira uma linha discreta", () => {
    const items = cynoChatItems(
      [
        log("a", 1, { kind: "chat", from: "user", text: "post sobre café para o LinkedIn" }),
        log("b", 1, { kind: "tool", toolUseId: "t1", name: "mcp__office__send_request", summary: "{}", status: "ok" }),
        log("c", 2, { kind: "status", status: "started", message: requestMarker("linkedin", "req-1", "Post sobre café") }),
        log("d", 2, { kind: "chat", from: "agent", text: "Mandei ao LinkedIn." }),
        log("e", 3, { kind: "status", status: "resumed", message: askMarker("Maestro de Design perguntou: quem faz posts?") }),
        log("f", 3, { kind: "status", status: "resumed", message: "Pedido “Post sobre café” no LinkedIn: concluído" }),
      ],
      false,
    );
    expect(items.map((item) => item.kind)).toEqual(["message", "work", "request", "message", "ask", "notice"]);
    expect(items[2]).toMatchObject({ kind: "request", workspace: "linkedin", projectId: "req-1", title: "Post sobre café" });
    expect(items[4]).toMatchObject({ kind: "ask", text: "Maestro de Design perguntou: quem faz posts?" });
    expect(items[5]).toMatchObject({ kind: "notice", tone: "info" });
  });

  it("os cartões de confirmação e de proposta entram no chat pela marca, na ordem, e encerram o trabalho em curso", () => {
    const items = cynoChatItems(
      [
        log("a", 1, { kind: "chat", from: "user", text: "apaga o workspace Teste" }),
        log("b", 1, { kind: "tool", toolUseId: "t1", name: "mcp__office__delete_workspace", summary: "{}", status: "ok" }),
        log("c", 2, { kind: "status", status: "waiting", message: confirmationMarker("C-0001") }),
        log("d", 3, { kind: "status", status: "waiting", message: proposalMarker("P-0002") }),
        log("e", 4, { kind: "chat", from: "agent", text: "Pedi a sua confirmação." }),
      ],
      false,
    );
    expect(items.map((item) => item.kind)).toEqual(["message", "work", "confirmation", "proposal", "message"]);
    expect(items[2]).toMatchObject({ kind: "confirmation", confirmationId: "C-0001" });
    expect(items[3]).toMatchObject({ kind: "proposal", proposalId: "P-0002" });
    // A marca nunca vira um aviso ("notice") com o texto cru.
    expect(items.some((item) => item.kind === "notice")).toBe(false);
  });
});
