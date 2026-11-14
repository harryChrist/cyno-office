import type { AgentLogEntry, Confirmation, CynoState } from "@cyno/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeLogEntry } from "../test-fixtures";
import { useCynoStore } from "./cynoStore";

const state = (status: CynoState["status"]): CynoState => ({ status, choice: { engine: "claude", model: "sonnet", effort: "medium" }, everStarted: true, newConversation: false, idleMinutes: 10, updatedAt: "2026-11-11T10:00:00.000Z" });
const entry = (id: string, body: Parameters<typeof makeLogEntry>[1]): AgentLogEntry => makeLogEntry(id, body, { taskId: "conversa-cyno-20261111", agentId: "cyno" });

beforeEach(() => {
  useCynoStore.setState({ state: null, entries: [], requests: [], confirmations: [], proposals: [], deciding: [], loaded: false, sending: false, error: null });
  vi.restoreAllMocks();
});

describe("cynoStore", () => {
  it("o snapshot carrega estado e entradas; o ao vivo junta por id (a ferramenta atualizada substitui) e o estado muda", () => {
    const { applyEvent } = useCynoStore.getState();
    applyEvent({ type: "cyno:snapshot", state: state("sleeping"), entries: [entry("a", { kind: "chat", from: "user", text: "oi" })] });
    expect(useCynoStore.getState()).toMatchObject({ loaded: true, state: { status: "sleeping" } });
    applyEvent({ type: "cyno:status", state: state("working") });
    applyEvent({ type: "cyno:log", entry: entry("b", { kind: "tool", toolUseId: "t", name: "x", summary: "", status: "running" }) });
    applyEvent({ type: "cyno:log", entry: entry("b", { kind: "tool", toolUseId: "t", name: "x", summary: "", status: "ok" }) });
    applyEvent({ type: "cyno:log", entry: entry("c", { kind: "chat", from: "agent", text: "oi!" }) });
    const current = useCynoStore.getState();
    expect(current.state?.status).toBe("working");
    expect(current.entries.map((item) => item.id)).toEqual(["a", "b", "c"]);
    expect(current.entries[1]).toMatchObject({ kind: "tool", status: "ok" });
  });

  it("uma reconexão (novo snapshot) não perde o que já chegou ao vivo", () => {
    const { applyEvent } = useCynoStore.getState();
    applyEvent({ type: "cyno:snapshot", state: state("awake"), entries: [entry("a", { kind: "chat", from: "user", text: "oi" })] });
    applyEvent({ type: "cyno:log", entry: entry("b", { kind: "chat", from: "agent", text: "oi!" }) });
    applyEvent({ type: "cyno:snapshot", state: state("sleeping"), entries: [entry("a", { kind: "chat", from: "user", text: "oi" })] });
    expect(useCynoStore.getState().entries.map((item) => item.id)).toEqual(["a", "b"]);
  });

  it("enviar: sucesso limpa o erro; falha guarda a mensagem e devolve false", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ id: "x" }), { status: 202 })).mockResolvedValueOnce(new Response(JSON.stringify({ error: "O Cyno não pode acordar com este motor" }), { status: 409 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await useCynoStore.getState().send("oi")).toBe(true);
    expect(useCynoStore.getState()).toMatchObject({ sending: false, error: null });
    expect(await useCynoStore.getState().send("de novo")).toBe(false);
    expect(useCynoStore.getState().error).toContain("não pode acordar");
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/cyno/messages");
    vi.unstubAllGlobals();
  });

  describe("fichas e Esperando você", () => {
    const cardOf = (workspace: string, summary = "") => ({ workspace, name: workspace, summary: { summary, by: "dono" }, waitingForYou: 0, waitingIds: [] }) as never;
    const route = (map: Record<string, unknown>) =>
      vi.fn(async (url: string, init?: RequestInit) => {
        const key = `${init?.method ?? "GET"} ${url}`;
        if (!(key in map)) return new Response("{}", { status: 404 });
        return new Response(JSON.stringify(map[key]), { status: 200 });
      });

    it("loadCards busca as fichas e o Esperando você de uma vez", async () => {
      const fetchMock = route({ "GET /api/cyno/cards": { cards: [cardOf("a")] }, "GET /api/cyno/waiting": { items: [{ workspace: "a", id: "A-1" }] } });
      vi.stubGlobal("fetch", fetchMock);
      await useCynoStore.getState().loadCards();
      expect(useCynoStore.getState()).toMatchObject({ cardsLoaded: true, cards: [{ workspace: "a" }], waiting: [{ id: "A-1" }] });
      vi.unstubAllGlobals();
    });

    it("sem rede, mantém o que tinha e marca como carregado", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
      useCynoStore.setState({ cards: [cardOf("a")], cardsLoaded: false });
      await useCynoStore.getState().loadCards();
      expect(useCynoStore.getState()).toMatchObject({ cardsLoaded: true, cards: [{ workspace: "a" }] });
      vi.unstubAllGlobals();
    });

    it("`cyno:cards` agrupa a rajada numa busca só", async () => {
      vi.useFakeTimers();
      const fetchMock = route({ "GET /api/cyno/cards": { cards: [] }, "GET /api/cyno/waiting": { items: [] } });
      vi.stubGlobal("fetch", fetchMock);
      const { applyEvent } = useCynoStore.getState();
      for (let i = 0; i < 5; i += 1) applyEvent({ type: "cyno:cards", workspaces: ["a"] });
      expect(fetchMock).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(300);
      expect(fetchMock.mock.calls.filter(([url]) => url === "/api/cyno/cards")).toHaveLength(1);
      vi.useRealTimers();
      vi.unstubAllGlobals();
    });

    it("saveSummary troca a ficha pelo que o servidor devolveu; erro fica na tela", async () => {
      useCynoStore.setState({ cards: [cardOf("a"), cardOf("b")] });
      vi.stubGlobal("fetch", route({ "PUT /api/cyno/cards/a": cardOf("a", "Nova frase") }));
      expect(await useCynoStore.getState().saveSummary("a", "Nova frase")).toBe(true);
      expect(useCynoStore.getState().cards.map((card) => card.summary.summary)).toEqual(["Nova frase", ""]);
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "A frase tem 300 caracteres" }), { status: 400 })));
      expect(await useCynoStore.getState().saveSummary("b", "x")).toBe(false);
      expect(useCynoStore.getState().error).toContain("300");
      vi.unstubAllGlobals();
    });
  });

  it("`cyno:requests` troca a lista de pedidos enviados (o estado dos cartões do chat vem dela)", () => {
    const view = { projectId: "p1", workspace: "linkedin", workspaceName: "LinkedIn", title: "Post", address: "linkedin/maestro", sentAt: "2026-11-11T10:00:00.000Z", state: "andando", tasksDone: 1, tasksTotal: 2, waitingForYou: 0 } as const;
    useCynoStore.getState().applyEvent({ type: "cyno:requests", requests: [view] });
    expect(useCynoStore.getState().requests).toEqual([view]);
    useCynoStore.getState().applyEvent({ type: "cyno:requests", requests: [{ ...view, state: "concluido", tasksDone: 2 }] });
    expect(useCynoStore.getState().requests[0]).toMatchObject({ state: "concluido", tasksDone: 2 });
  });
});

describe("cynoStore: confirmações e propostas", () => {
  const confirmation = (over: Partial<Confirmation> = {}): Confirmation => ({ id: "C-0001", action: "delete_workspace", params: {}, paramsHash: "h", summary: 'Apagar o workspace "Teste"', impact: "", details: [], reason: "", status: "pendente", origin: "cyno", createdAt: "2026-11-11T10:00:00.000Z", expiresAt: "2026-11-11T10:30:00.000Z", ...over });

  it("o ao vivo troca a lista de confirmações e de propostas inteira", () => {
    const { applyEvent } = useCynoStore.getState();
    applyEvent({ type: "cyno:confirmations", confirmations: [confirmation()] });
    expect(useCynoStore.getState().confirmations.map((item) => item.id)).toEqual(["C-0001"]);
    applyEvent({ type: "cyno:confirmations", confirmations: [confirmation({ status: "executada" })] });
    expect(useCynoStore.getState().confirmations[0]!.status).toBe("executada");
  });

  it("confirmar chama a rota do dono, guarda o resultado e desliga o botão só durante o clique", async () => {
    useCynoStore.setState({ confirmations: [confirmation()] });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const fetchMock = vi.fn(async (_url: string) => {
      await gate;
      return new Response(JSON.stringify(confirmation({ status: "executada", result: "feito" })), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const pending = useCynoStore.getState().decide("confirmation", "C-0001", "approve");
    expect(useCynoStore.getState().deciding).toEqual(["C-0001"]);
    // Um segundo clique durante o primeiro não dispara outra chamada.
    await useCynoStore.getState().decide("confirmation", "C-0001", "approve");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    release();
    await pending;
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/cyno/confirmations/C-0001/approve");
    expect(useCynoStore.getState()).toMatchObject({ deciding: [], confirmations: [{ status: "executada", result: "feito" }] });
    vi.unstubAllGlobals();
  });

  it("recusar usa a rota de recusa; erro (ex.: já venceu) aparece e a lista é conferida de novo", async () => {
    useCynoStore.setState({ confirmations: [confirmation()] });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "Esta confirmação expirou" }), { status: 409 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ confirmations: [confirmation({ status: "expirada" })] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ proposals: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await useCynoStore.getState().decide("confirmation", "C-0001", "reject");
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/cyno/confirmations/C-0001/reject");
    expect(useCynoStore.getState().error).toContain("expirou");
    await vi.waitFor(() => expect(useCynoStore.getState().confirmations[0]!.status).toBe("expirada"));
    vi.unstubAllGlobals();
  });
});
