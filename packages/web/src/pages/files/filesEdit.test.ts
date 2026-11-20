import { describe, expect, it } from "vitest";
import {
  deleteConfirmText,
  diskTextOf,
  discardMessage,
  dropNodeKeys,
  editorTextOf,
  editTooBig,
  flattenTree,
  focusAfterDelete,
  menuActions,
  nameStemEnd,
  nodeKey,
  readonlyHint,
  remapActive,
  remapFocus,
  remapNodeKeys,
  remapPath,
  remapTabs,
  tabsInside,
  textStyleOf,
  withNamingRow,
  type DirListing,
  type FileTab,
} from "./filesView";

describe("quebras de linha e BOM", () => {
  it("arquivo só com \\r\\n volta como \\r\\n; o editor vê \\n", () => {
    const raw = "a\r\nb\r\n";
    const style = textStyleOf(raw);
    expect(style).toEqual({ crlf: true, bom: false });
    expect(editorTextOf(raw, style)).toBe("a\nb\n");
    expect(diskTextOf("a\nb\nc\n", style)).toBe("a\r\nb\r\nc\r\n");
  });

  it("arquivo misto ou só \\n não vira \\r\\n", () => {
    expect(textStyleOf("a\r\nb\nc").crlf).toBe(false);
    expect(textStyleOf("a\nb").crlf).toBe(false);
    expect(diskTextOf("a\nb", textStyleOf("a\nb"))).toBe("a\nb");
  });

  it("BOM é tirado do editor e devolvido ao salvar", () => {
    const raw = "\u{feff}oi\r\nmundo";
    const style = textStyleOf(raw);
    expect(style).toEqual({ crlf: true, bom: true });
    expect(editorTextOf(raw, style)).toBe("oi\nmundo");
    expect(diskTextOf("oi\nmundo", style)).toBe("\u{feff}oi\r\nmundo");
    expect(diskTextOf("x", textStyleOf("sem bom"))).toBe("x");
  });

  it("limite de 512 KB conta bytes, não letras", () => {
    expect(editTooBig("a".repeat(512 * 1024))).toBe(false);
    expect(editTooBig("a".repeat(512 * 1024 + 1))).toBe(true);
    expect(editTooBig("é".repeat(300 * 1024))).toBe(true);
  });
});

const tab = (path: string, root = "r"): FileTab => ({ root, path, preview: false });

describe("renomear e apagar", () => {
  it("remapPath só mexe no item e no que está dentro", () => {
    expect(remapPath("a/b", "a/b", "a/c")).toBe("a/c");
    expect(remapPath("a/b/x.txt", "a/b", "a/c")).toBe("a/c/x.txt");
    expect(remapPath("a/bb/x", "a/b", "a/c")).toBeNull();
  });

  it("renomear arquivo atualiza aba, ativa e foco", () => {
    const tabs = [tab("a/x.md"), tab("a/y.md"), tab("a/x.md", "outra")];
    expect(remapTabs(tabs, "r", "a/x.md", "a/z.md").map((t) => `${t.root}:${t.path}`)).toEqual(["r:a/z.md", "r:a/y.md", "outra:a/x.md"]);
    expect(remapActive(nodeKey("r", "a/x.md"), "r", "a/x.md", "a/z.md")).toBe(nodeKey("r", "a/z.md"));
    expect(remapActive(nodeKey("outra", "a/x.md"), "r", "a/x.md", "a/z.md")).toBe(nodeKey("outra", "a/x.md"));
    expect(remapFocus({ r: "a", outra: "a" }, "r", "a", "b")).toEqual({ r: "b", outra: "a" });
  });

  it("renomear pasta leva abas, pastas abertas e listas junto", () => {
    expect(remapTabs([tab("p/q/f.txt"), tab("p2/f.txt")], "r", "p", "novo").map((t) => t.path)).toEqual(["novo/q/f.txt", "p2/f.txt"]);
    const open = { [nodeKey("r", "p")]: true as const, [nodeKey("r", "p/q")]: true as const, [nodeKey("r", "p2")]: true as const };
    expect(Object.keys(remapNodeKeys(open, "r", "p", "novo")).sort()).toEqual([nodeKey("r", "novo"), nodeKey("r", "novo/q"), nodeKey("r", "p2")].sort());
    expect(remapFocus({ r: "p/q" }, "r", "p", "novo")).toEqual({ r: "novo/q" });
  });

  it("apagar pasta tira as abas e as chaves de dentro, e sobe o foco", () => {
    expect(tabsInside([tab("p/a"), tab("p/b/c"), tab("pp/a")], "r", "p").map((t) => t.path)).toEqual(["p/a", "p/b/c"]);
    const files = { [nodeKey("r", "p/a")]: 1, [nodeKey("r", "p")]: 2, [nodeKey("r", "pp/a")]: 3 };
    expect(Object.keys(dropNodeKeys(files, "r", "p"))).toEqual([nodeKey("r", "pp/a")]);
    expect(focusAfterDelete({ r: "x/y/z" }, "r", "x/y")).toEqual({ r: "x" });
    expect(focusAfterDelete({ r: "x" }, "r", "x")).toEqual({});
    expect(focusAfterDelete({ r: "outra" }, "r", "x")).toEqual({ r: "outra" });
  });
});

describe("menu de ações", () => {
  const base = { name: "a.md", locked: false };
  it("trancado não tem ação nenhuma", () => {
    expect(menuActions({ ...base, kind: "file", locked: true, writable: true })).toEqual([]);
    expect(menuActions({ ...base, kind: "dir", locked: true, writable: true })).toEqual([]);
  });
  it("pasta: com escrita cria, envia, renomeia e apaga; só leitura só foca e copia", () => {
    expect(menuActions({ ...base, kind: "dir", writable: true })).toEqual(["new-file", "new-dir", "upload", "rename", "delete", "focus", "copy-path"]);
    expect(menuActions({ ...base, kind: "dir", writable: false })).toEqual(["focus", "copy-path"]);
  });
  it("arquivo: com escrita edita e apaga; só leitura abre, baixa e copia; imagem não edita", () => {
    expect(menuActions({ ...base, kind: "file", writable: true })).toEqual(["open", "edit", "rename", "download", "copy-path", "delete"]);
    expect(menuActions({ ...base, kind: "file", writable: false })).toEqual(["open", "download", "copy-path"]);
    expect(menuActions({ name: "foto.png", locked: false, kind: "file", writable: true })).not.toContain("edit");
  });
});

describe("textos e nomes", () => {
  it("renomear seleciona o nome sem a extensão", () => {
    expect(nameStemEnd("relatorio.final.md", "file")).toBe("relatorio.final".length);
    expect(nameStemEnd("Makefile", "file")).toBe(8);
    expect(nameStemEnd(".gitignore", "file")).toBe(10);
    expect(nameStemEnd("pasta.v2", "dir")).toBe(8);
  });

  it("confirmação de apagar: arquivo, pasta singular, plural e truncada", () => {
    expect(deleteConfirmText("x.txt", "file")).toBe("Apagar 'x.txt'? Não dá para desfazer.");
    expect(deleteConfirmText("src", "dir", { files: 1, dirs: 0, truncated: false })).toBe("Apagar a pasta 'src' e o 1 item dentro dela? Não dá para desfazer.");
    expect(deleteConfirmText("src", "dir", { files: 8, dirs: 4, truncated: false })).toBe("Apagar a pasta 'src' e os 12 itens dentro dela? Não dá para desfazer.");
    expect(deleteConfirmText("src", "dir", { files: 15000, dirs: 5000, truncated: true })).toBe("Apagar a pasta 'src' e os mais de 20000 itens dentro dela? Não dá para desfazer.");
    expect(deleteConfirmText("vazia", "dir", { files: 0, dirs: 0, truncated: false })).toBe("Apagar a pasta 'vazia'? Não dá para desfazer.");
  });

  it("aviso de descartar e dicas de só leitura", () => {
    expect(discardMessage(["a.md"])).toBe("Descartar as alterações de a.md?");
    expect(discardMessage(["a.md", "b.md"])).toBe("Descartar as alterações de 2 arquivos?");
    expect(readonlyHint({ kind: "data", writable: false })).toBe("Os dados do workspace não são alterados por aqui.");
    expect(readonlyHint({ kind: "folder", writable: false })).toBe("Para alterar por aqui, mude para leitura e escrita em Configurações, Pastas de trabalho.");
    expect(readonlyHint({ kind: "folder", writable: true })).toBeNull();
  });
});

describe("campo de nome na árvore", () => {
  const listing = (...names: string[]): DirListing => ({ entries: names.map((name) => ({ name, kind: name.includes(".") ? "file" : "dir" })), total: names.length, more: false, filter: "", loading: false });
  const dirs = { [nodeKey("r", "")]: listing("src", "a.md"), [nodeKey("r", "src")]: listing("b.ts") };
  const open = { [nodeKey("r", "src")]: true as const };
  const rows = flattenTree("r", "", { dirs, open });

  it("renomear troca a linha do item", () => {
    const out = withNamingRow(rows, { mode: "rename", root: "r", path: "a.md", kind: "file" }, "r", "");
    const at = out.findIndex((row) => row.kind === "name");
    expect(out[at]).toMatchObject({ initial: "a.md", nodeKind: "file", depth: 0 });
    expect(out.some((row) => row.kind === "file" && row.path === "a.md")).toBe(false);
  });

  it("criar na raiz vai ao topo e em pasta aberta vai logo abaixo dela", () => {
    const top = withNamingRow(rows, { mode: "create-file", root: "r", dir: "" }, "r", "");
    expect(top[0]).toMatchObject({ kind: "name", initial: "", nodeKind: "file", depth: 0 });
    const inside = withNamingRow(rows, { mode: "create-dir", root: "r", dir: "src" }, "r", "");
    expect(inside[0]).toMatchObject({ kind: "dir", path: "src" });
    expect(inside[1]).toMatchObject({ kind: "name", nodeKind: "dir", depth: 1 });
  });

  it("não mexe em outra raiz nem em pasta que não está à vista", () => {
    expect(withNamingRow(rows, { mode: "create-file", root: "outra", dir: "" }, "r", "")).toEqual(rows);
    expect(withNamingRow(rows, { mode: "create-file", root: "r", dir: "nao/aberta" }, "r", "")).toEqual(rows);
  });

  it("pasta vazia dá lugar ao campo", () => {
    const empty = flattenTree("r", "", { dirs: { [nodeKey("r", "")]: listing() }, open: {} });
    const out = withNamingRow(empty, { mode: "create-file", root: "r", dir: "" }, "r", "");
    expect(out).toHaveLength(1);
    expect(out[0]!.kind).toBe("name");
  });
});
