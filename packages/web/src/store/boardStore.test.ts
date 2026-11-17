import type { Board } from "@cyno/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api/client";
import { isBoardEvent, useBoardStore } from "./boardStore";
import { useNavStore } from "./navStore";

const board = (id: string, title = id): Board => ({ id, title, description: "", createdBy: "clara", createdAt: "2026-11-16T10:00:00.000Z", pageUpdatedAt: "2026-11-16T10:00:00.000Z", dataUpdatedAt: "2026-11-16T10:00:00.000Z", pageBytes: 1, dataBytes: 1 });

afterEach(() => {
  vi.restoreAllMocks();
  useBoardStore.getState().reset();
  useNavStore.setState({ workspaceId: null });
});

describe("boardStore", () => {
  it("reconhece só os eventos de quadro", () => {
    expect(isBoardEvent({ type: "board:deleted", id: "Q-0001" })).toBe(true);
    expect(isBoardEvent({ type: "media:deleted", id: "M-0001" })).toBe(false);
  });

  it("carrega a lista do workspace atual; trocar de workspace descarta a anterior", async () => {
    useNavStore.setState({ workspaceId: "principal" });
    const spy = vi.spyOn(api, "listBoards").mockResolvedValueOnce([board("Q-0001")]).mockResolvedValueOnce([board("Q-0007")]);
    await useBoardStore.getState().load();
    expect(useBoardStore.getState().boards?.map((b) => b.id)).toEqual(["Q-0001"]);
    useNavStore.setState({ workspaceId: "laboratorio" });
    useBoardStore.getState().ensureLoaded();
    expect(useBoardStore.getState().boards).toBeNull();
    await vi.waitFor(() => expect(useBoardStore.getState().boards?.map((b) => b.id)).toEqual(["Q-0007"]));
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("resposta de um workspace que já não é o atual é descartada", async () => {
    useNavStore.setState({ workspaceId: "principal" });
    let resolve!: (value: Board[]) => void;
    vi.spyOn(api, "listBoards").mockReturnValueOnce(new Promise((r) => (resolve = r)));
    const loading = useBoardStore.getState().load();
    useNavStore.setState({ workspaceId: "laboratorio" });
    resolve([board("Q-0001")]);
    await loading;
    expect(useBoardStore.getState().boards).toBeNull();
  });

  it("falha na lista guarda a mensagem", async () => {
    useNavStore.setState({ workspaceId: "principal" });
    vi.spyOn(api, "listBoards").mockRejectedValueOnce(new Error("sem rede"));
    await useBoardStore.getState().load();
    expect(useBoardStore.getState().error).toBeTruthy();
    expect(useBoardStore.getState().boards).toBeNull();
  });

  it("eventos: novo entra, alterado troca e deixa o aviso, apagado sai", () => {
    useBoardStore.setState({ boards: [board("Q-0001")] });
    const { apply } = useBoardStore.getState();
    apply({ type: "board:upserted", board: board("Q-0002"), changed: ["meta", "page", "data"], created: true });
    expect(useBoardStore.getState().boards?.map((b) => b.id)).toEqual(["Q-0002", "Q-0001"]);
    const before = useBoardStore.getState().signal?.seq ?? 0;
    apply({ type: "board:upserted", board: board("Q-0001", "Outro"), changed: ["data"] });
    const state = useBoardStore.getState();
    expect(state.boards?.find((b) => b.id === "Q-0001")?.title).toBe("Outro");
    expect(state.signal).toMatchObject({ id: "Q-0001", changed: ["data"] });
    expect(state.signal!.seq).toBeGreaterThan(before);
    apply({ type: "board:deleted", id: "Q-0002" });
    expect(useBoardStore.getState().boards?.map((b) => b.id)).toEqual(["Q-0001"]);
  });

  it("eventos antes do primeiro carregamento não inventam lista", () => {
    useBoardStore.getState().apply({ type: "board:upserted", board: board("Q-0001"), changed: ["meta"] });
    expect(useBoardStore.getState().boards).toBeNull();
  });

  it("renomear e apagar chamam a API e atualizam a lista", async () => {
    useBoardStore.setState({ boards: [board("Q-0001"), board("Q-0002")] });
    const update = vi.spyOn(api, "updateBoard").mockResolvedValue(board("Q-0001", "Novo"));
    const remove = vi.spyOn(api, "deleteBoard").mockResolvedValue(undefined);
    await useBoardStore.getState().rename("Q-0001", { title: "Novo" });
    expect(update).toHaveBeenCalledWith("Q-0001", { title: "Novo" });
    expect(useBoardStore.getState().boards?.[0]?.title).toBe("Novo");
    await useBoardStore.getState().remove("Q-0002");
    expect(remove).toHaveBeenCalledWith("Q-0002");
    expect(useBoardStore.getState().boards?.map((b) => b.id)).toEqual(["Q-0001"]);
  });
});
