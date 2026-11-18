import type { ForYouItem, ServerEvent } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { makeOffice, makeTask } from "../test-fixtures";
import { applyForYouEvent, pendingCount, pendingItemForTask } from "./forYouItems";
import { INITIAL_SYNC, officeReducer } from "./officeReducer";

function item(id: string, overrides: Partial<ForYouItem> = {}): ForYouItem {
  return {
    id,
    agentId: "ana",
    roomId: "a",
    type: "convite",
    status: "pendente",
    meta: {},
    text: "oi",
    originalText: "oi",
    editedByUser: false,
    createdAt: "2026-11-07T10:00:00.000Z",
    ...overrides,
  };
}

const upsert = (value: ForYouItem): ServerEvent => ({ type: "foryou:upserted", item: value });

describe("itens de Aprovações no store", () => {
  it("antes do GET (null) ignora eventos; depois, insere e atualiza", () => {
    expect(applyForYouEvent(null, upsert(item("A-0001")))).toBeNull();
    const one = applyForYouEvent([], upsert(item("A-0001")))!;
    expect(one.map((current) => current.id)).toEqual(["A-0001"]);
    const decided = applyForYouEvent(one, upsert(item("A-0001", { status: "aprovado" })))!;
    expect(decided).toHaveLength(1);
    expect(decided[0]!.status).toBe("aprovado");
    const list = [item("A-0001")];
    expect(applyForYouEvent(list, { type: "agent:deleted", id: "x" })).toBe(list);
  });

  it("foryou:deleted tira o item (id desconhecido ou antes do GET: nada muda)", () => {
    const list = [item("A-0001"), item("A-0002")];
    const removed: ServerEvent = { type: "foryou:deleted", id: "A-0001" };
    expect(applyForYouEvent(list, removed)!.map((current) => current.id)).toEqual(["A-0002"]);
    expect(applyForYouEvent(list, { type: "foryou:deleted", id: "A-9999" })).toBe(list);
    expect(applyForYouEvent(null, removed)).toBeNull();
    expect(officeReducer({ ...INITIAL_SYNC, forYou: list }, removed).forYou).toHaveLength(1);
  });

  it("foryou:archived tira os itens que foram para o arquivo, em silêncio (ids desconhecidos ou antes do GET: nada muda)", () => {
    const list = [item("A-0001", { status: "aprovado" }), item("A-0002"), item("A-0003", { status: "rejeitado" })];
    const archived: ServerEvent = { type: "foryou:archived", ids: ["A-0001", "A-0003"] };
    expect(applyForYouEvent(list, archived)!.map((current) => current.id)).toEqual(["A-0002"]);
    expect(applyForYouEvent(list, { type: "foryou:archived", ids: ["A-9999"] })).toBe(list);
    expect(applyForYouEvent(list, { type: "foryou:archived", ids: [] })).toBe(list);
    expect(applyForYouEvent(null, archived)).toBeNull();
    const synced = officeReducer({ ...INITIAL_SYNC, forYou: list }, archived);
    expect(synced.forYou).toHaveLength(1);
    expect(synced.office).toBeNull();
    // Sem o office carregado o evento não quebra nada e um item sem originalText segue válido.
    const compact = item("A-0004");
    delete compact.originalText;
    expect(applyForYouEvent([compact], upsert({ ...compact, status: "aprovado" }))![0]!.status).toBe("aprovado");
  });

  it("o reducer do escritório aplica foryou:* mesmo antes do snapshot e mantém o resto", () => {
    const loaded = { ...INITIAL_SYNC, forYou: [] };
    const next = officeReducer(loaded, upsert(item("A-0001")));
    expect(next.forYou).toHaveLength(1);
    expect(next.office).toBeNull();
    const withOffice = officeReducer(next, { type: "office:snapshot", office: makeOffice() });
    expect(withOffice.forYou).toBe(next.forYou);
    expect(officeReducer(INITIAL_SYNC, upsert(item("A-0001")))).toBe(INITIAL_SYNC);
  });

  it("conta os pendentes (selo da aba)", () => {
    expect(pendingCount(null)).toBe(0);
    expect(pendingCount([item("A-0001"), item("A-0002", { status: "rejeitado" }), item("A-0003")])).toBe(2);
  });

  it("acha o item pendente da tarefa ou da subtarefa (Maestro)", () => {
    const tasks = [makeTask("pai"), makeTask("filha", { projectId: "pai" })];
    const items = [item("A-0001", { taskId: "filha", status: "aprovado" }), item("A-0002", { taskId: "filha" })];
    expect(pendingItemForTask(items, tasks, "pai")?.id).toBe("A-0002");
    expect(pendingItemForTask(items, tasks, "filha")?.id).toBe("A-0002");
    expect(pendingItemForTask(items, tasks, "outra")).toBeUndefined();
    expect(pendingItemForTask(null, tasks, "pai")).toBeUndefined();
  });
});
