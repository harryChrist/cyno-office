import type { MediaItem } from "@cyno/shared";
import { describe, expect, it } from "vitest";
import { childFolders, countLabel, crumbs, folderChoices, folderOf, folderStats, isDirectlyIn, isInside, parentOf, remapAfterDelete, remapAfterRename, sumBytes } from "./mediaFolders";
import { filterMedia, NO_FILTERS } from "./mediaView";

const item = (id: string, folder: string | undefined, size = 100): MediaItem => ({ id, kind: "document", mime: "application/pdf", fileName: `${id}.pdf`, title: id, size, createdAt: "2026-11-10T12:00:00.000Z", createdBy: "usuario", origin: "upload", status: "rascunho", ...(folder ? { folder } : {}) });
const items = [item("M-0001", undefined), item("M-0002", "Livros", 1000), item("M-0003", "Livros/Matemática", 5000), item("M-0004", "Financeiro", 20)];
const folders = ["Financeiro", "Livros", "Livros/Matemática", "Vazia"];

describe("pastas da Mídia", () => {
  it("item sem pasta fica na raiz; dentro vs. diretamente", () => {
    expect(folderOf(items[0]!)).toBe("");
    expect(isDirectlyIn(items[1]!, "Livros")).toBe(true);
    expect(isDirectlyIn(items[2]!, "Livros")).toBe(false);
    expect(isInside(items[2]!, "Livros")).toBe(true);
    expect(isInside(items[3]!, "Livros")).toBe(false);
    expect(isInside(items[0]!, "")).toBe(true);
  });

  it("subpastas imediatas, migalhas e opções do Mover", () => {
    expect(childFolders(folders, "")).toEqual(["Financeiro", "Livros", "Vazia"]);
    expect(childFolders(folders, "Livros")).toEqual(["Livros/Matemática"]);
    expect(crumbs("Livros/Matemática")).toEqual([{ name: "Livros", path: "Livros" }, { name: "Matemática", path: "Livros/Matemática" }]);
    expect(crumbs("")).toEqual([]);
    expect(folderChoices(folders).map((choice) => [choice.name, choice.depth])).toEqual([["Financeiro", 0], ["Livros", 0], ["Matemática", 1], ["Vazia", 0]]);
    expect(parentOf("A/B")).toBe("A");
  });

  it("tamanho e contagem por pasta (com as subpastas) e a soma dos tamanhos", () => {
    expect(folderStats(items, folders, "Livros")).toEqual({ count: 2, bytes: 6000, folders: 1 });
    expect(folderStats(items, folders, "Vazia")).toEqual({ count: 0, bytes: 0, folders: 0 });
    expect(folderStats(items, folders, "")).toMatchObject({ count: 4, bytes: 6120, folders: 4 });
    expect(sumBytes(items)).toBe(6120);
    expect(countLabel(0)).toBe("vazia");
    expect(countLabel(1)).toBe("1 item");
    expect(countLabel(7)).toBe("7 itens");
  });

  it("a pasta aberta acompanha renomear e apagar", () => {
    expect(remapAfterRename("Livros/Matemática", "Livros", "Biblioteca")).toBe("Biblioteca/Matemática");
    expect(remapAfterRename("Livros", "Livros", "Biblioteca")).toBe("Biblioteca");
    expect(remapAfterRename("Outra", "Livros", "Biblioteca")).toBe("Outra");
    expect(remapAfterDelete("Livros", "Livros")).toBe("");
    expect(remapAfterDelete("Livros/Matemática", "Livros")).toBe("Matemática");
    expect(remapAfterDelete("A/B/C", "A/B")).toBe("A/C");
  });

  it("a busca olha o caminho da pasta", () => {
    expect(filterMedia(items, { ...NO_FILTERS, q: "matematica" }, new Map()).map((entry) => entry.id)).toEqual(["M-0003"]);
  });
});
