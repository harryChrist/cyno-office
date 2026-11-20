import type { FileEntry } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import {
  ancestorDirs,
  clampTreeWidth,
  closeTab,
  emptyPersisted,
  filesStorageKey,
  filesSub,
  flattenTree,
  fullPathOf,
  indentFor,
  isHighlightableJson,
  isInside,
  jsonRuns,
  kindLabel,
  lineNumbers,
  loadPersisted,
  modifiedAgo,
  nodeKey,
  openTab,
  parseFilesSub,
  pinTab,
  savePersisted,
  shortRootPath,
  tabKey,
  tabLabels,
  treeWidthForKey,
  type DirListing,
  type FileTab,
  type TabsState,
} from "./filesView";

const dir = (name: string, extra: Partial<FileEntry> = {}): FileEntry => ({ name, kind: "dir", ...extra });
const file = (name: string, size = 10): FileEntry => ({ name, kind: "file", size });
const listing = (entries: FileEntry[], extra: Partial<DirListing> = {}): DirListing => ({ entries, total: entries.length, more: false, filter: "", loading: false, ...extra });
const empty: TabsState = { tabs: [], active: null };
const ref = (path: string, root = "dados") => ({ root, path });

describe("endereço", () => {
  it("monta e lê <rootId>/<caminho> com caracteres especiais", () => {
    const original = { root: "pasta 1", path: "obras/294 regressor/título #1?.md" };
    const sub = filesSub(original);
    expect(sub).toBe("pasta%201/obras/294%20regressor/t%C3%ADtulo%20%231%3F.md");
    expect(parseFilesSub(sub)).toEqual(original);
  });

  it("sem arquivo, com pedaço inválido ou com ponto-ponto não há arquivo", () => {
    expect(filesSub(null)).toBe("");
    expect(parseFilesSub("")).toBeNull();
    expect(parseFilesSub("dados")).toBeNull();
    expect(parseFilesSub("dados/%E0%A4%A")).toBeNull();
    expect(parseFilesSub("dados/a/%2E%2E/b")).toBeNull();
    expect(parseFilesSub("dados/a%2Fb")).toBeNull();
  });

  it("monta o caminho completo para copiar", () => {
    expect(fullPathOf({ path: "/home/x/obra" }, "a/b.md")).toBe("/home/x/obra/a/b.md");
    expect(fullPathOf({ path: "/home/x/obra/" }, "a.md")).toBe("/home/x/obra/a.md");
    expect(fullPathOf({ path: "/" }, "etc")).toBe("/etc");
    expect(fullPathOf({ path: "/home/x" }, "")).toBe("/home/x");
  });

  it("encurta o caminho da raiz", () => {
    expect(shortRootPath("/home/harry/projetos/mahou-reader")).toBe("/home/…/mahou-reader");
    expect(shortRootPath("/home/x")).toBe("/home/x");
  });
});

describe("abas", () => {
  it("clique simples abre aba provisória e o próximo clique simples a substitui no mesmo lugar", () => {
    let state = openTab(empty, ref("a.md"), false);
    expect(state.tabs).toEqual([{ ...ref("a.md"), preview: true }]);
    state = openTab(state, ref("b.md"), true);
    state = openTab(state, ref("c.md"), false);
    state = openTab(state, ref("d.md"), false);
    expect(state.tabs.map((tab) => [tab.path, tab.preview])).toEqual([["d.md", true], ["b.md", false]]);
    expect(state.active).toBe(tabKey(ref("d.md")));
  });

  it("dois cliques (ou clique duplo na aba) fixam", () => {
    let state = openTab(empty, ref("a.md"), false);
    state = openTab(state, ref("a.md"), true);
    expect(state.tabs[0]!.preview).toBe(false);
    state = openTab(state, ref("b.md"), false);
    state = pinTab(state, tabKey(ref("b.md")));
    expect(state.tabs.every((tab) => !tab.preview)).toBe(true);
  });

  it("clique simples num arquivo que já tem aba só ativa", () => {
    let state = openTab(empty, ref("a.md"), true);
    state = openTab(state, ref("b.md"), true);
    const next = openTab(state, ref("a.md"), false);
    expect(next.tabs).toEqual(state.tabs);
    expect(next.active).toBe(tabKey(ref("a.md")));
  });

  it("passou do limite: fecha a mais antiga que não é a ativa", () => {
    let state = empty;
    for (const name of ["1", "2", "3"]) state = openTab(state, ref(name), true, 3);
    state = openTab(state, ref("4"), true, 3);
    expect(state.tabs.map((tab) => tab.path)).toEqual(["2", "3", "4"]);
    expect(state.active).toBe(tabKey(ref("4")));
  });

  it("fechar a ativa passa para a vizinha da direita, ou da esquerda se era a última", () => {
    let state = empty;
    for (const name of ["a", "b", "c"]) state = openTab(state, ref(name), true);
    state = { ...state, active: tabKey(ref("b")) };
    state = closeTab(state, tabKey(ref("b")));
    expect(state.active).toBe(tabKey(ref("c")));
    state = closeTab(state, tabKey(ref("c")));
    expect(state.active).toBe(tabKey(ref("a")));
    state = closeTab(state, tabKey(ref("a")));
    expect(state).toEqual({ tabs: [], active: null });
  });

  it("fechar uma aba que não é a ativa mantém a ativa", () => {
    let state = openTab(empty, ref("a"), true);
    state = openTab(state, ref("b"), true);
    expect(closeTab(state, tabKey(ref("a"))).active).toBe(tabKey(ref("b")));
  });

  it("nome repetido mostra a pasta; nome único não", () => {
    const tabs: FileTab[] = [
      { ...ref("obras/a/capa.png", "r1"), preview: false },
      { ...ref("obras/b/capa.png", "r1"), preview: false },
      { ...ref("capa.png", "r2"), preview: false },
      { ...ref("notas.md", "r1"), preview: false },
    ];
    const labels = tabLabels(tabs, (id) => `Raiz ${id}`);
    expect(labels.map((label) => label.hint)).toEqual(["a", "b", "Raiz r2", undefined]);
  });
});

describe("árvore", () => {
  const ctx = (dirs: Record<string, DirListing>, open: string[] = []) => ({ dirs, open: Object.fromEntries(open.map((key) => [key, true as const])) as Record<string, true> });

  it("lista a raiz com pastas e arquivos, sem abrir nada", () => {
    const rows = flattenTree("r", "", ctx({ [nodeKey("r", "")]: listing([dir("a"), file("x.md")]) }));
    expect(rows.map((row) => [row.kind, row.kind === "dir" || row.kind === "file" ? row.label : "", row.depth])).toEqual([["dir", "a", 0], ["file", "x.md", 0]]);
  });

  it("caminho compacto: pasta aberta com um único item que é pasta aberta vira uma linha a/b/c", () => {
    const dirs = {
      [nodeKey("r", "")]: listing([dir("a")]),
      [nodeKey("r", "a")]: listing([dir("b")]),
      [nodeKey("r", "a/b")]: listing([dir("c")]),
      [nodeKey("r", "a/b/c")]: listing([file("f.txt"), file("g.txt")]),
    };
    const rows = flattenTree("r", "", ctx(dirs, [nodeKey("r", "a"), nodeKey("r", "a/b"), nodeKey("r", "a/b/c")]));
    expect(rows.map((row) => (row.kind === "dir" || row.kind === "file" ? `${row.label}@${row.depth}` : row.kind))).toEqual(["a/b/c@0", "f.txt@1", "g.txt@1"]);
    const first = rows[0]!;
    expect(first.kind === "dir" && first.path).toBe("a/b/c");
  });

  it("a cadeia para onde a pasta filha está fechada: aparecem separadas e dá para fechar a de cima", () => {
    const dirs = { [nodeKey("r", "")]: listing([dir("a")]), [nodeKey("r", "a")]: listing([dir("b")]), [nodeKey("r", "a/b")]: listing([file("f")]) };
    const rows = flattenTree("r", "", ctx(dirs, [nodeKey("r", "a")]));
    expect(rows.map((row) => (row.kind === "dir" ? `${row.label}:${row.open}` : row.kind))).toEqual(["a:true", "b:false"]);
  });

  it("não funde pasta com mais de um item, com cadeado ou em listagem filtrada", () => {
    const base = { [nodeKey("r", "")]: listing([dir("a")]) };
    const two = flattenTree("r", "", ctx({ ...base, [nodeKey("r", "a")]: listing([dir("b"), file("x")]), [nodeKey("r", "a/b")]: listing([]) }, [nodeKey("r", "a"), nodeKey("r", "a/b")]));
    expect(two.find((row) => row.kind === "dir")).toMatchObject({ label: "a" });
    const locked = flattenTree("r", "", ctx({ ...base, [nodeKey("r", "a")]: listing([dir("b", { locked: true })]) }, [nodeKey("r", "a"), nodeKey("r", "a/b")]));
    expect(locked.filter((row) => row.kind === "dir").map((row) => row.kind === "dir" && row.label)).toEqual(["a", "b"]);
    const filtered = flattenTree("r", "", ctx({ ...base, [nodeKey("r", "a")]: listing([dir("b")], { filter: "b" }), [nodeKey("r", "a/b")]: listing([]) }, [nodeKey("r", "a"), nodeKey("r", "a/b")]));
    expect(filtered.filter((row) => row.kind === "dir")).toHaveLength(2);
  });

  it("pasta aberta ainda sem lista mostra 'Carregando'; com erro, o motivo; vazia, 'Pasta vazia'", () => {
    const open = [nodeKey("r", "a")];
    expect(flattenTree("r", "", ctx({ [nodeKey("r", "")]: listing([dir("a")]) }, open)).pop()).toMatchObject({ kind: "status", tone: "loading" });
    expect(flattenTree("r", "", ctx({ [nodeKey("r", "")]: listing([dir("a")]), [nodeKey("r", "a")]: listing([], { error: "sem permissão" }) }, open)).pop()).toMatchObject({ kind: "status", tone: "error", text: "sem permissão" });
    expect(flattenTree("r", "", ctx({ [nodeKey("r", "")]: listing([dir("a")]), [nodeKey("r", "a")]: listing([]) }, open)).pop()).toMatchObject({ kind: "status", tone: "empty", text: "Pasta vazia." });
  });

  it("pasta com mais de uma página ganha o filtro e o 'mostrar mais' com o que falta", () => {
    const many = Array.from({ length: 3 }, (_, index) => file(`f${index}`));
    const rows = flattenTree("r", "", ctx({ [nodeKey("r", "")]: listing(many, { total: 250, more: true }) }), 2);
    expect(rows[0]).toMatchObject({ kind: "filter" });
    expect(rows[rows.length - 1]).toMatchObject({ kind: "more", remaining: 247 });
  });

  it("com foco, a base é a pasta focada", () => {
    const rows = flattenTree("r", "x/y", ctx({ [nodeKey("r", "x/y")]: listing([file("z")]) }));
    expect(rows[0]).toMatchObject({ kind: "file", path: "x/y/z", depth: 0 });
  });

  it("o recuo cresce até 6 níveis e para", () => {
    expect([0, 1, 5, 6, 7, 20].map(indentFor)).toEqual([0, 14, 70, 84, 84, 84]);
  });

  it("ancestrais e 'está dentro de'", () => {
    expect(ancestorDirs("a/b/c")).toEqual(["a/b/c", "a/b", "a"]);
    expect(ancestorDirs("")).toEqual([]);
    expect(isInside("", "a")).toBe(true);
    expect(isInside("a/b", "a/b/c")).toBe(true);
    expect(isInside("a/b", "a/bc")).toBe(false);
  });
});

describe("rótulos", () => {
  const now = Date.parse("2026-11-19T12:00:00.000Z");
  const ago = (ms: number) => new Date(now - ms).toISOString();
  it("modificado há X", () => {
    expect(modifiedAgo(ago(5_000), now)).toBe("há instantes");
    expect(modifiedAgo(ago(12 * 60_000), now)).toBe("há 12 min");
    expect(modifiedAgo(ago(3 * 3_600_000), now)).toBe("há 3 h");
    expect(modifiedAgo(ago(24 * 3_600_000), now)).toBe("há 1 dia");
    expect(modifiedAgo(ago(5 * 86_400_000), now)).toBe("há 5 dias");
    expect(modifiedAgo(ago(65 * 86_400_000), now)).toBe("há 2 meses");
    expect(modifiedAgo(ago(800 * 86_400_000), now)).toBe("há 2 anos");
    expect(modifiedAgo(undefined, now)).toBe("");
    expect(modifiedAgo("nada", now)).toBe("");
  });

  it("tipo do arquivo", () => {
    expect(kindLabel("a.md", "markdown")).toBe("Markdown");
    expect(kindLabel("a.json", "text")).toBe("JSON");
    expect(kindLabel("a.ts", "text")).toBe("TS");
    expect(kindLabel("Makefile", "text")).toBe("Texto");
    expect(kindLabel("capa.png", "image")).toBe("PNG");
    expect(kindLabel("x", "binary")).toBe("Arquivo");
  });
});

describe("divisória", () => {
  it("árvore de 220 a 640 px e o arquivo com pelo menos 420 px", () => {
    expect(clampTreeWidth(100, 1400)).toBe(220);
    expect(clampTreeWidth(900, 1400)).toBe(640);
    expect(clampTreeWidth(900, 900)).toBe(480);
    expect(clampTreeWidth(500, 500)).toBe(220);
    expect(clampTreeWidth(Number.NaN, 1400)).toBe(320);
  });

  it("teclado: setas, Home e End", () => {
    expect(treeWidthForKey("ArrowRight", 320, 1400)).toBe(336);
    expect(treeWidthForKey("ArrowLeft", 320, 1400)).toBe(304);
    expect(treeWidthForKey("Home", 320, 1400)).toBe(220);
    expect(treeWidthForKey("End", 320, 1400)).toBe(640);
    expect(treeWidthForKey("End", 320, 900)).toBe(480);
    expect(treeWidthForKey("a", 320, 1400)).toBeNull();
  });
});

describe("estado lembrado", () => {
  const memory = () => {
    const data = new Map<string, string>();
    return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => void data.set(key, value), data };
  };

  it("guarda e restaura por workspace", () => {
    const storage = memory();
    const a = { ...emptyPersisted(), tabs: [{ ...ref("x.md"), preview: true }], active: tabKey(ref("x.md")), open: [nodeKey("dados", "agentes")], focus: { dados: "agentes" }, width: 400 };
    savePersisted("ws1", a, storage);
    savePersisted("ws2", { ...emptyPersisted(), width: 500 }, storage);
    expect(loadPersisted("ws1", storage)).toEqual(a);
    expect(loadPersisted("ws2", storage).tabs).toEqual([]);
    expect(loadPersisted("ws2", storage).width).toBe(500);
    expect(loadPersisted("ws3", storage)).toEqual(emptyPersisted());
  });

  it("sem armazenamento, ou com ele falhando, a página funciona vazia", () => {
    const broken = {
      getItem: () => {
        throw new Error("bloqueado");
      },
      setItem: () => {
        throw new Error("cheio");
      },
    };
    expect(loadPersisted("ws", broken)).toEqual(emptyPersisted());
    expect(loadPersisted("ws", undefined)).toEqual(emptyPersisted());
    expect(() => savePersisted("ws", emptyPersisted(), broken)).not.toThrow();
    expect(() => savePersisted("ws", emptyPersisted(), undefined)).not.toThrow();
  });

  it("texto quebrado ou formato estranho é ignorado, sem derrubar", () => {
    const storage = memory();
    storage.setItem(filesStorageKey("ws"), "{nao é json");
    expect(loadPersisted("ws", storage)).toEqual(emptyPersisted());
    storage.setItem(filesStorageKey("ws"), JSON.stringify({ tabs: [{ root: 1 }, { root: "r", path: "ok.md", preview: "sim" }, { root: "r", path: "ok.md" }], active: "inexistente", open: [1, "a"], focus: { r: 3, s: "p" }, width: "larga" }));
    const loaded = loadPersisted("ws", storage);
    expect(loaded.tabs).toEqual([{ root: "r", path: "ok.md", preview: false }]);
    expect(loaded.active).toBe(tabKey({ root: "r", path: "ok.md" }));
    expect(loaded.open).toEqual(["a"]);
    expect(loaded.focus).toEqual({ s: "p" });
    expect(loaded.width).toBe(320);
  });
});

describe("realce do JSON e números de linha", () => {
  it("pinta chaves, textos, números e literais e devolve o texto inteiro", () => {
    const text = '{\n  "n": 12,\n  "s": "a:b",\n  "ok": true,\n  "x": null\n}';
    const runs = jsonRuns(text);
    expect(runs.map((run) => run.text).join("")).toBe(text);
    expect(runs.filter((run) => run.kind).map((run) => [run.kind, run.text])).toEqual([
      ["key", '"n"'],
      ["number", "12"],
      ["key", '"s"'],
      ["string", '"a:b"'],
      ["key", '"ok"'],
      ["literal", "true"],
      ["key", '"x"'],
      ["literal", "null"],
    ]);
  });

  it("só pinta .json de até uns 200 KB", () => {
    expect(isHighlightableJson("a.json", "{}")).toBe(true);
    expect(isHighlightableJson("a.txt", "{}")).toBe(false);
    expect(isHighlightableJson("a.json", "x".repeat(200_001))).toBe(false);
  });

  it("números de linha: uma linha vazia final não conta", () => {
    expect(lineNumbers("")).toBe("1");
    expect(lineNumbers("a\nb\nc")).toBe("1\n2\n3");
    expect(lineNumbers("a\nb\n")).toBe("1\n2");
  });
});
