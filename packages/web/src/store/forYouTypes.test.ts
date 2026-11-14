import { autoForYouType, builtinForYouTypes, type ForYouItem, type ForYouTypeDef, type ServerEvent } from "@cyno/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

const listForYou = vi.hoisted(() => vi.fn<() => Promise<ForYouItem[]>>());
const listForYouTypes = vi.hoisted(() => vi.fn<() => Promise<ForYouTypeDef[]>>());
vi.mock("../api/client", () => ({ api: { listForYou, listForYouTypes } }));
vi.mock("../ws/officeSocket", () => ({ backendUp: async () => true }));

const { applyForYouTypesEvent, createdByMaestro } = await import("./forYouTypes");
const { INITIAL_SYNC, officeReducer } = await import("./officeReducer");
const { useOfficeStore } = await import("./officeStore");
const { useNavStore } = await import("./navStore");
const { useNoticesStore } = await import("./notices");

const AT = "2026-11-08T12:00:00.000Z";
const BUILTINS = builtinForYouTypes(AT);
const reels = autoForYouType("Reels", BUILTINS, AT);
const upserted = (forYouType: ForYouTypeDef, created = false): ServerEvent => ({ type: "foryou-types:upserted", forYouType, ...(created ? { created } : {}) });

describe("tipos do Para você no store", () => {
  it("antes do GET ignora; depois insere, atualiza e tira", () => {
    expect(applyForYouTypesEvent(null, upserted(reels))).toBeNull();
    const added = applyForYouTypesEvent(BUILTINS, upserted(reels))!;
    expect(added.map((type) => type.id)).toEqual(["pergunta", "outro", "reels"]);
    const renamed = applyForYouTypesEvent(added, upserted({ ...reels, name: "Vídeos" }))!;
    expect(renamed[2]!.name).toBe("Vídeos");
    expect(applyForYouTypesEvent(renamed, { type: "foryou-types:deleted", id: "reels", movedTo: "outro" })!.map((type) => type.id)).toEqual(["pergunta", "outro"]);
    expect(applyForYouTypesEvent(BUILTINS, { type: "foryou-types:deleted", id: "nao-existe", movedTo: "outro" })).toBe(BUILTINS);
    expect(applyForYouTypesEvent(BUILTINS, { type: "agent:deleted", id: "x" })).toBe(BUILTINS);
  });

  it("o reducer guarda os tipos fora do escritório (mesmo antes do snapshot)", () => {
    const loaded = { ...INITIAL_SYNC, forYouTypes: BUILTINS };
    const next = officeReducer(loaded, upserted(reels, true));
    expect(next.forYouTypes).toHaveLength(3);
    expect(next.office).toBeNull();
    expect(officeReducer(INITIAL_SYNC, upserted(reels))).toBe(INITIAL_SYNC);
  });

  it("só o tipo novo criado pelo Maestro vira aviso", () => {
    expect(createdByMaestro(upserted(reels, true))).toEqual(reels);
    expect(createdByMaestro(upserted(reels))).toBeNull();
    expect(createdByMaestro(upserted({ ...reels, createdBy: "user" }, true))).toBeNull();
  });
});

describe("officeStore: tipos e avisos", () => {
  beforeEach(() => {
    useNavStore.setState({ workspaceId: "principal" });
    useOfficeStore.getState().reset();
    listForYou.mockReset();
    listForYouTypes.mockReset();
  });

  it("carrega itens e tipos juntos", async () => {
    listForYou.mockResolvedValue([]);
    listForYouTypes.mockResolvedValue(BUILTINS);
    await useOfficeStore.getState().loadForYou();
    expect(useOfficeStore.getState()).toMatchObject({ forYou: [], forYouTypes: BUILTINS, forYouError: null });
  });

  it("tipo criado pelo Maestro: entra na lista e o sino ganha um aviso (sem repetir); trocar de workspace limpa", async () => {
    listForYou.mockResolvedValue([]);
    listForYouTypes.mockResolvedValue(BUILTINS);
    await useOfficeStore.getState().loadForYou();
    useOfficeStore.getState().applyEvent(upserted(reels, true));
    useOfficeStore.getState().applyEvent(upserted(reels, true));
    expect(useOfficeStore.getState().forYouTypes?.map((type) => type.id)).toContain("reels");
    expect(useNoticesStore.getState()).toMatchObject({ unread: 1, notices: [{ text: "O Maestro criou o tipo “Reels”", target: "foryou-types" }] });
    useNoticesStore.getState().markRead();
    expect(useNoticesStore.getState().unread).toBe(0);
    useOfficeStore.getState().reset();
    expect(useNoticesStore.getState().notices).toEqual([]);
  });
});
