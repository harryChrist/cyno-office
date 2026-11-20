import type { FileEntry, FileListResponse, FileReadResponse } from "@cyno/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiRequestError } from "../api/client";
import { nodeKey, tabKey } from "../pages/files/filesView";
import { draftOf, setDraft, useFilesStore } from "./filesStore";
import { useNavStore } from "./navStore";

const dir = (name: string): FileEntry => ({ name, kind: "dir" });
const file = (name: string): FileEntry => ({ name, kind: "file", size: 5 });
const page = (root: string, path: string, entries: FileEntry[]): FileListResponse => ({ root, path, entries, total: entries.length, offset: 0, more: false });
const read = (path: string, version: string, text = "oi"): FileReadResponse => ({ root: "dados", path, name: path, size: 2, mtime: "2026-11-19T12:00:00.000Z", version, view: "text", text, truncated: false });
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  useNavStore.setState({ workspaceId: "ws" });
  useFilesStore.getState().reset();
  vi.spyOn(api, "getFileRoots").mockResolvedValue({ roots: [{ id: "dados", kind: "data", name: "Dados do workspace", path: "/d", writable: false }] });
});
afterEach(() => {
  vi.restoreAllMocks();
  useFilesStore.getState().reset();
});

describe("filesStore", () => {
  it("abre uma pasta só ao abrir e pede uma lista por pasta", async () => {
    const list = vi.spyOn(api, "listFiles").mockImplementation(async (root, path) => page(root, path, path === "" ? [dir("a"), dir("b")] : [file("x")]));
    await useFilesStore.getState().init("ws");
    // A raiz nasce recolhida: nada é listado até a pessoa abrir.
    expect(list).toHaveBeenCalledTimes(0);
    expect(useFilesStore.getState().rootsOpen.dados).toBeUndefined();
    useFilesStore.getState().toggleRoot("dados");
    await flush();
    expect(list).toHaveBeenCalledTimes(1);
    expect(useFilesStore.getState().rootsOpen.dados).toBe(true);
    useFilesStore.getState().toggleDir("dados", "a");
    await flush();
    expect(list).toHaveBeenCalledTimes(2);
    expect(useFilesStore.getState().open[nodeKey("dados", "a")]).toBe(true);
    useFilesStore.getState().toggleDir("dados", "a");
    expect(useFilesStore.getState().open[nodeKey("dados", "a")]).toBeUndefined();
  });

  it("abre sozinho a cadeia de pastas com um único item", async () => {
    vi.spyOn(api, "listFiles").mockImplementation(async (root, path) => page(root, path, path === "" ? [dir("a")] : path === "a" ? [dir("b")] : path === "a/b" ? [dir("c")] : [file("f")]));
    await useFilesStore.getState().init("ws");
    useFilesStore.getState().toggleDir("dados", "a");
    await vi.waitFor(() => expect(useFilesStore.getState().dirs[nodeKey("dados", "a/b/c")]).toBeDefined());
    const open = Object.keys(useFilesStore.getState().open);
    expect(open).toEqual(expect.arrayContaining([nodeKey("dados", "a"), nodeKey("dados", "a/b"), nodeKey("dados", "a/b/c")]));
  });

  it("'mostrar mais' anexa a próxima página e o filtro volta à primeira", async () => {
    const calls: Array<{ offset?: number; filter?: string }> = [];
    vi.spyOn(api, "listFiles").mockImplementation(async (root, path, options = {}) => {
      calls.push(options);
      const all = Array.from({ length: 5 }, (_, index) => file(`f${index}`));
      const start = options.offset ?? 0;
      const entries = all.slice(start, start + 3);
      return { root, path, entries, total: 5, offset: start, more: start + 3 < 5 };
    });
    useFilesStore.setState({ workspaceId: "ws" });
    await useFilesStore.getState().loadDir("dados", "");
    expect(useFilesStore.getState().dirs[nodeKey("dados", "")]!.entries).toHaveLength(3);
    await useFilesStore.getState().loadDir("dados", "", { more: true });
    expect(useFilesStore.getState().dirs[nodeKey("dados", "")]!.entries).toHaveLength(5);
    expect(calls[1]).toMatchObject({ offset: 3 });
    await useFilesStore.getState().loadDir("dados", "", { filter: "f1" });
    expect(calls[2]).toMatchObject({ offset: 0, filter: "f1" });
  });

  it("aba provisória, fixa e limite de abas", () => {
    vi.spyOn(api, "readFile").mockImplementation(async (_root, path) => read(path, "1"));
    const store = useFilesStore.getState();
    store.openFile({ root: "dados", path: "a" }, false);
    store.openFile({ root: "dados", path: "b" }, false);
    expect(useFilesStore.getState().tabs.map((tab) => [tab.path, tab.preview])).toEqual([["b", true]]);
    useFilesStore.getState().openFile({ root: "dados", path: "b" }, true);
    expect(useFilesStore.getState().tabs[0]!.preview).toBe(false);
    for (let n = 0; n < 25; n += 1) useFilesStore.getState().openFile({ root: "dados", path: `f${n}` }, true);
    expect(useFilesStore.getState().tabs).toHaveLength(20);
    expect(useFilesStore.getState().active).toBe(tabKey({ root: "dados", path: "f24" }));
  });

  it("releitura ao vivo: sem mudança nada troca; com mudança troca o texto e marca 'atualizado'", async () => {
    let version = "1";
    let text = "um";
    const spy = vi.spyOn(api, "readFile").mockImplementation(async (_root, path, known) => (known === version ? { unchanged: true, version } : read(path, version, text)));
    useFilesStore.setState({ workspaceId: "ws" });
    useFilesStore.getState().openFile({ root: "dados", path: "a.txt" }, true);
    await vi.waitFor(() => expect(useFilesStore.getState().files[tabKey({ root: "dados", path: "a.txt" })]?.status).toBe("ready"));
    const tab = useFilesStore.getState().tabs[0]!;
    await useFilesStore.getState().loadFile(tab, true);
    expect(spy).toHaveBeenLastCalledWith("dados", "a.txt", "1");
    expect(useFilesStore.getState().files[tabKey(tab)]!.updatedAt).toBeUndefined();
    version = "2";
    text = "dois";
    await useFilesStore.getState().loadFile(tab, true);
    const state = useFilesStore.getState().files[tabKey(tab)]!;
    expect(state.data?.text).toBe("dois");
    expect(state.updatedAt).toBeTypeOf("number");
  });

  it("arquivo que sumiu vira mensagem na aba", async () => {
    vi.spyOn(api, "readFile").mockRejectedValue(new ApiRequestError(404, "not found"));
    useFilesStore.setState({ workspaceId: "ws" });
    useFilesStore.getState().openFile({ root: "dados", path: "x" }, true);
    await vi.waitFor(() => expect(useFilesStore.getState().files[tabKey({ root: "dados", path: "x" })]?.status).toBe("error"));
    expect(useFilesStore.getState().files[tabKey({ root: "dados", path: "x" })]!.error).toBe("Esse arquivo não existe mais.");
  });

  it("foco numa pasta vira a base daquela raiz e é lembrado por workspace", async () => {
    const store = new Map<string, string>();
    vi.stubGlobal("window", { localStorage: { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => void store.set(key, value) } });
    vi.spyOn(api, "listFiles").mockImplementation(async (root, path) => page(root, path, [file("z")]));
    vi.spyOn(api, "readFile").mockImplementation(async (_root, path) => read(path, "1"));
    await useFilesStore.getState().init("ws");
    useFilesStore.getState().setFocus("dados", "a/b");
    useFilesStore.getState().openFile({ root: "dados", path: "a/b/z" }, true);
    expect(store.has("cyno.files.ws")).toBe(true);
    useFilesStore.getState().reset();
    useNavStore.setState({ workspaceId: "ws" });
    await useFilesStore.getState().init("ws");
    expect(useFilesStore.getState().focus).toEqual({ dados: "a/b" });
    expect(useFilesStore.getState().tabs.map((tab) => tab.path)).toEqual(["a/b/z"]);
    // Outro workspace começa vazio.
    useNavStore.setState({ workspaceId: "outro" });
    await useFilesStore.getState().init("outro");
    expect(useFilesStore.getState().tabs).toEqual([]);
    expect(useFilesStore.getState().focus).toEqual({});
    vi.unstubAllGlobals();
  });

  it("localStorage que falha não derruba nada", async () => {
    vi.stubGlobal("window", {
      get localStorage(): Storage {
        throw new Error("bloqueado");
      },
    });
    vi.spyOn(api, "listFiles").mockResolvedValue(page("dados", "", []));
    vi.spyOn(api, "readFile").mockResolvedValue(read("a", "1"));
    await useFilesStore.getState().init("ws");
    useFilesStore.getState().openFile({ root: "dados", path: "a" }, true);
    expect(useFilesStore.getState().tabs).toHaveLength(1);
    vi.unstubAllGlobals();
  });

  it("revelar uma pasta abre a árvore até ela e tira o foco que a deixa de fora", async () => {
    vi.spyOn(api, "listFiles").mockImplementation(async (root, path) => page(root, path, [dir("x")]));
    await useFilesStore.getState().init("ws");
    useFilesStore.getState().setFocus("dados", "outra");
    await useFilesStore.getState().reveal("dados", "a/b");
    const state = useFilesStore.getState();
    expect(state.focus.dados).toBeUndefined();
    expect(Object.keys(state.open)).toEqual(expect.arrayContaining([nodeKey("dados", "a"), nodeKey("dados", "a/b")]));
    expect(state.dirs[nodeKey("dados", "a/b")]).toBeDefined();
  });
});

const writableRoot = { id: "dados", kind: "folder" as const, name: "Projeto", path: "/p", writable: true };
const textFile = (path: string, version: string, text: string, root = "dados"): FileReadResponse => ({ root, path, name: path.split("/").pop()!, size: text.length, mtime: "2026-11-19T12:00:00.000Z", version, view: "text", text, truncated: false });
const ref = (path: string) => ({ root: "dados", path });
const keyOf = (path: string) => tabKey(ref(path));

describe("filesStore: editar", () => {
  beforeEach(() => {
    vi.spyOn(api, "getFileRoots").mockResolvedValue({ roots: [writableRoot] });
    useFilesStore.setState({ workspaceId: "ws" });
  });

  it("abre o editor com o texto exato, fixa a aba e marca sujo só na transição", async () => {
    const readFile = vi.spyOn(api, "readFile").mockImplementation(async (_r, path) => textFile(path, "1", "a\r\nb\r\n"));
    useFilesStore.getState().openFile(ref("n.md"), false);
    expect(await useFilesStore.getState().startEdit(ref("n.md"))).toBeNull();
    expect(readFile).toHaveBeenLastCalledWith("dados", "n.md", undefined, true);
    const session = useFilesStore.getState().edits[keyOf("n.md")]!;
    expect(session).toMatchObject({ text: "a\nb\n", version: "1", dirty: false });
    expect(useFilesStore.getState().tabs[0]!.preview).toBe(false);
    useFilesStore.getState().setDirty(keyOf("n.md"), true);
    expect(useFilesStore.getState().dirtyNames()).toEqual(["n.md"]);
  });

  it("servidor que recusa devolve a mensagem e não abre o editor", async () => {
    vi.spyOn(api, "readFile").mockRejectedValue(new ApiRequestError(400, "O arquivo passa de 512 KB."));
    expect(await useFilesStore.getState().startEdit(ref("g.txt"))).toBe("O arquivo passa de 512 KB.");
    expect(useFilesStore.getState().edits[keyOf("g.txt")]).toBeUndefined();
  });

  it("salvar manda baseVersion e o estilo original; depois volta à leitura com 'salvo'", async () => {
    let disk = textFile("n.md", "1", "\u{feff}a\r\nb\r\n");
    vi.spyOn(api, "readFile").mockImplementation(async () => disk);
    const write = vi.spyOn(api, "writeFile").mockImplementation(async (body) => {
      disk = textFile("n.md", "2", body.text);
      return { root: "dados", path: "n.md", name: "n.md", size: 1, mtime: "x", version: "2" };
    });
    vi.spyOn(api, "listFiles").mockResolvedValue(page("dados", "", []));
    useFilesStore.getState().openFile(ref("n.md"), true);
    await useFilesStore.getState().startEdit(ref("n.md"));
    setDraft(keyOf("n.md"), "a\nb\nc\n");
    useFilesStore.getState().setDirty(keyOf("n.md"), true);
    expect(await useFilesStore.getState().saveEdit(ref("n.md"))).toEqual({ ok: true });
    expect(write).toHaveBeenCalledWith({ root: "dados", path: "n.md", text: "\u{feff}a\r\nb\r\nc\r\n", baseVersion: "1" });
    const state = useFilesStore.getState();
    expect(state.edits[keyOf("n.md")]).toBeUndefined();
    expect(state.files[keyOf("n.md")]).toMatchObject({ status: "ready", data: { version: "2" } });
    expect(state.files[keyOf("n.md")]!.savedAt).toBeTypeOf("number");
    expect(draftOf(keyOf("n.md"))).toBeUndefined();
  });

  it("409 abre o conflito; 'salvar por cima' manda sem baseVersion", async () => {
    vi.spyOn(api, "readFile").mockImplementation(async (_r, path) => textFile(path, "1", "x"));
    vi.spyOn(api, "listFiles").mockResolvedValue(page("dados", "", []));
    const write = vi.spyOn(api, "writeFile").mockRejectedValueOnce(new ApiRequestError(409, "O arquivo mudou.")).mockResolvedValue({ root: "dados", path: "c.txt", name: "c.txt", size: 1, mtime: "x", version: "3" });
    useFilesStore.getState().openFile(ref("c.txt"), true);
    await useFilesStore.getState().startEdit(ref("c.txt"));
    setDraft(keyOf("c.txt"), "y");
    const first = await useFilesStore.getState().saveEdit(ref("c.txt"));
    expect(first).toMatchObject({ ok: false, conflict: true });
    expect(useFilesStore.getState().edits[keyOf("c.txt")]).toBeDefined();
    expect(useFilesStore.getState().edits[keyOf("c.txt")]!.saving).toBe(false);
    expect(await useFilesStore.getState().saveEdit(ref("c.txt"), true)).toEqual({ ok: true });
    expect(write).toHaveBeenLastCalledWith({ root: "dados", path: "c.txt", text: "y" });
  });

  it("releitura ao vivo em edição não troca o texto: só avisa que mudou; 'continuar' esconde o aviso", async () => {
    let version = "1";
    const spy = vi.spyOn(api, "readFile").mockImplementation(async (_r, path, known) => (known === version ? { unchanged: true, version } : textFile(path, version, version === "1" ? "um" : "novo")));
    useFilesStore.getState().openFile(ref("l.txt"), true);
    await vi.waitFor(() => expect(useFilesStore.getState().files[keyOf("l.txt")]?.status).toBe("ready"));
    await useFilesStore.getState().startEdit(ref("l.txt"));
    const tab = useFilesStore.getState().tabs[0]!;
    await useFilesStore.getState().loadFile(tab, true);
    expect(useFilesStore.getState().edits[keyOf("l.txt")]!.diskChanged).toBe(false);
    version = "2";
    await useFilesStore.getState().loadFile(tab, true);
    expect(spy).toHaveBeenLastCalledWith("dados", "l.txt", "1");
    expect(useFilesStore.getState().edits[keyOf("l.txt")]!.diskChanged).toBe(true);
    expect(useFilesStore.getState().files[keyOf("l.txt")]!.data?.text).toBe("um");
    useFilesStore.getState().keepEditing(keyOf("l.txt"));
    expect(useFilesStore.getState().edits[keyOf("l.txt")]).toMatchObject({ diskChanged: false, seen: "2", version: "1" });
    await useFilesStore.getState().loadFile(tab, true);
    expect(useFilesStore.getState().edits[keyOf("l.txt")]!.diskChanged).toBe(false);
  });

  it("recarregar descarta o rascunho e recomeça do disco", async () => {
    vi.spyOn(api, "readFile").mockImplementation(async (_r, path) => textFile(path, "5", "do disco"));
    useFilesStore.getState().openFile(ref("r.txt"), true);
    await useFilesStore.getState().startEdit(ref("r.txt"));
    setDraft(keyOf("r.txt"), "rascunho");
    useFilesStore.getState().setDirty(keyOf("r.txt"), true);
    expect(await useFilesStore.getState().reloadEdit(ref("r.txt"))).toBeNull();
    expect(useFilesStore.getState().edits[keyOf("r.txt")]).toMatchObject({ text: "do disco", version: "5", dirty: false, rev: 1 });
    expect(draftOf(keyOf("r.txt"))).toBeUndefined();
  });

  it("fechar aba suja, fechar todos e cancelar edição suja pedem confirmação; limpa não pede", async () => {
    vi.spyOn(api, "readFile").mockImplementation(async (_r, path) => textFile(path, "1", "x"));
    const store = useFilesStore.getState;
    store().openFile(ref("a.txt"), true);
    store().openFile(ref("b.txt"), true);
    await store().startEdit(ref("a.txt"));
    store().requestCloseTab(keyOf("b.txt"));
    expect(store().tabs.map((t) => t.path)).toEqual(["a.txt"]);
    store().openFile(ref("b.txt"), true);
    store().setDirty(keyOf("a.txt"), true);
    store().requestCloseTab(keyOf("a.txt"));
    expect(store().discard).toEqual({ message: "Descartar as alterações de a.txt?", action: { type: "close", key: keyOf("a.txt") } });
    expect(store().tabs).toHaveLength(2);
    store().dismissDiscard();
    store().requestCloseAll();
    expect(store().discard?.action.type).toBe("close-all");
    store().dismissDiscard();
    store().requestCancelEdit(keyOf("a.txt"));
    expect(store().discard?.action).toEqual({ type: "cancel-edit", key: keyOf("a.txt") });
    store().confirmDiscard();
    expect(store().edits[keyOf("a.txt")]).toBeUndefined();
    expect(store().discard).toBeNull();
    expect(store().tabs).toHaveLength(2);
    store().requestCloseAll();
    expect(store().tabs).toEqual([]);
  });
});

describe("filesStore: criar, renomear, apagar", () => {
  beforeEach(() => {
    vi.spyOn(api, "getFileRoots").mockResolvedValue({ roots: [writableRoot] });
    vi.spyOn(api, "listFiles").mockImplementation(async (root, path) => page(root, path, []));
    vi.spyOn(api, "readFile").mockImplementation(async (_r, path) => textFile(path, "1", "x"));
    useFilesStore.setState({ workspaceId: "ws" });
  });

  it("criar arquivo já o abre numa aba em edição; 409 volta como 'já existe'", async () => {
    const create = vi.spyOn(api, "createFile").mockResolvedValueOnce({ root: "dados", path: "n.md", kind: "file" }).mockRejectedValueOnce(new ApiRequestError(409, "Já existe."));
    expect(await useFilesStore.getState().createItem("dados", "n.md", "file")).toEqual({ ok: true });
    expect(create).toHaveBeenCalledWith({ root: "dados", path: "n.md", kind: "file" });
    expect(useFilesStore.getState().active).toBe(keyOf("n.md"));
    expect(useFilesStore.getState().edits[keyOf("n.md")]).toBeDefined();
    expect(await useFilesStore.getState().createItem("dados", "n.md", "file")).toMatchObject({ ok: false, conflict: true });
  });

  it("criar pasta abre a pasta", async () => {
    vi.spyOn(api, "createFile").mockResolvedValue({ root: "dados", path: "nova", kind: "dir" });
    await useFilesStore.getState().createItem("dados", "nova", "dir");
    expect(useFilesStore.getState().open[nodeKey("dados", "nova")]).toBe(true);
  });

  it("renomear arquivo atualiza aba, ativa, endereço de leitura e a pasta é relida", async () => {
    vi.spyOn(api, "renameFile").mockResolvedValue({ root: "dados", path: "a/z.txt" });
    const store = useFilesStore.getState;
    store().openFile(ref("a/x.txt"), true);
    await vi.waitFor(() => expect(store().files[keyOf("a/x.txt")]?.status).toBe("ready"));
    const list = vi.mocked(api.listFiles);
    list.mockClear();
    expect(await store().renamePath("dados", "a/x.txt", "a/z.txt")).toEqual({ ok: true });
    expect(store().tabs.map((t) => t.path)).toEqual(["a/z.txt"]);
    expect(store().active).toBe(keyOf("a/z.txt"));
    expect(store().files[keyOf("a/z.txt")]?.data).toMatchObject({ path: "a/z.txt", name: "z.txt" });
    expect(store().files[keyOf("a/x.txt")]).toBeUndefined();
    expect(list).toHaveBeenCalledWith("dados", "a", expect.anything());
  });

  it("renomear pasta leva abas, pastas abertas e foco", async () => {
    vi.spyOn(api, "renameFile").mockResolvedValue({ root: "dados", path: "novo" });
    const store = useFilesStore.getState;
    store().openFile(ref("p/q/f.txt"), true);
    store().setDirOpen("dados", "p", true);
    store().setFocus("dados", "p/q");
    await store().renamePath("dados", "p", "novo");
    expect(store().tabs.map((t) => t.path)).toEqual(["novo/q/f.txt"]);
    expect(store().open[nodeKey("dados", "novo")]).toBe(true);
    expect(store().open[nodeKey("dados", "p")]).toBeUndefined();
    expect(store().focus.dados).toBe("novo/q");
  });

  it("renomear arquivo com aba suja é recusado, sem chamar o servidor", async () => {
    const rename = vi.spyOn(api, "renameFile");
    const store = useFilesStore.getState;
    store().openFile(ref("p/f.txt"), true);
    await store().startEdit(ref("p/f.txt"));
    store().setDirty(keyOf("p/f.txt"), true);
    expect(await store().renamePath("dados", "p/f.txt", "p/g.txt")).toEqual({ ok: false, conflict: false, message: "Salve ou descarte as alterações antes de renomear." });
    expect(await store().renamePath("dados", "p", "novo")).toMatchObject({ ok: false });
    expect(rename).not.toHaveBeenCalled();
  });

  it("apagar arquivo fecha a aba; apagar pasta fecha as de dentro (mesmo sujas) sem perguntar", async () => {
    vi.spyOn(api, "deleteFile").mockResolvedValue({ root: "dados", path: "", deleted: 1 });
    const store = useFilesStore.getState;
    store().openFile(ref("p/a.txt"), true);
    store().openFile(ref("p/q/b.txt"), true);
    store().openFile(ref("outro.txt"), true);
    await store().startEdit(ref("p/q/b.txt"));
    store().setDirty(keyOf("p/q/b.txt"), true);
    await store().deletePath("dados", "p/a.txt");
    expect(store().tabs.map((t) => t.path)).toEqual(["p/q/b.txt", "outro.txt"]);
    store().setFocus("dados", "p/q");
    await store().deletePath("dados", "p");
    expect(store().tabs.map((t) => t.path)).toEqual(["outro.txt"]);
    expect(store().edits[keyOf("p/q/b.txt")]).toBeUndefined();
    expect(store().discard).toBeNull();
    expect(store().focus.dados).toBeUndefined();
  });

  it("apagar que o servidor recusa lança e mantém as abas", async () => {
    vi.spyOn(api, "deleteFile").mockRejectedValue(new ApiRequestError(403, "Pasta só leitura."));
    useFilesStore.getState().openFile(ref("p/a.txt"), true);
    await expect(useFilesStore.getState().deletePath("dados", "p")).rejects.toThrow("Pasta só leitura.");
    expect(useFilesStore.getState().tabs).toHaveLength(1);
  });
});

describe("filesStore: enviar", () => {
  beforeEach(() => {
    vi.spyOn(api, "getFileRoots").mockResolvedValue({ roots: [writableRoot] });
    vi.spyOn(api, "listFiles").mockImplementation(async (root, path) => page(root, path, []));
    useFilesStore.setState({ workspaceId: "ws" });
  });
  const f = (name: string) => ({ name, size: 3 }) as File;

  it("envia um por vez, relê a pasta de destino e mostra o resumo", async () => {
    const order: string[] = [];
    vi.spyOn(api, "uploadFile").mockImplementation(async (_r, dir, file) => {
      order.push(`${dir}/${file.name}`);
      return { root: "dados", path: "x", name: file.name, size: 3, mtime: "x", version: "1" };
    });
    await useFilesStore.getState().uploadFiles("dados", "docs", [f("a.txt"), f("b.txt")]);
    expect(order).toEqual(["docs/a.txt", "docs/b.txt"]);
    expect(useFilesStore.getState().upload).toMatchObject({ status: "done", text: "2 arquivos enviados" });
    expect(api.listFiles).toHaveBeenCalledWith("dados", "docs", expect.anything());
    expect(useFilesStore.getState().open[nodeKey("dados", "docs")]).toBe(true);
  });

  it("409 pergunta; 'substituir' manda de novo por cima", async () => {
    const calls: boolean[] = [];
    vi.spyOn(api, "uploadFile").mockImplementation(async (_r, _d, file, options) => {
      calls.push(options?.overwrite === true);
      if (!options?.overwrite) throw new ApiRequestError(409, "Já existe.");
      return { root: "dados", path: "x", name: file.name, size: 3, mtime: "x", version: "1" };
    });
    const run = useFilesStore.getState().uploadFiles("dados", "", [f("a.txt")]);
    await vi.waitFor(() => expect(useFilesStore.getState().upload?.asking).toBe("a.txt"));
    useFilesStore.getState().answerReplace({ action: "replace", all: false });
    await run;
    expect(calls).toEqual([false, true]);
    expect(useFilesStore.getState().upload?.text).toBe("1 arquivo enviado");
  });

  it("cancelar com a pergunta aberta encerra o envio", async () => {
    vi.spyOn(api, "uploadFile").mockRejectedValue(new ApiRequestError(409, "Já existe."));
    const run = useFilesStore.getState().uploadFiles("dados", "", [f("a.txt"), f("b.txt")]);
    await vi.waitFor(() => expect(useFilesStore.getState().upload?.asking).toBe("a.txt"));
    useFilesStore.getState().cancelUpload();
    await run;
    expect(api.uploadFile).toHaveBeenCalledTimes(1);
    expect(useFilesStore.getState().upload?.text).toBe("Envio cancelado");
  });

  it("arquivo com nome trancado é pulado sem chamar o servidor", async () => {
    const send = vi.spyOn(api, "uploadFile");
    await useFilesStore.getState().uploadFiles("dados", "", [f(".env")]);
    expect(send).not.toHaveBeenCalled();
    expect(useFilesStore.getState().upload?.notes[0]).toMatch(/^\.env: /);
  });
});
