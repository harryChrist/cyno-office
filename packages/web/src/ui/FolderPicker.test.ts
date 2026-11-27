import type { FsBrowseResponse } from "@cyno/shared";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FolderPickerView, type FolderPickerViewProps } from "./FolderPicker";
import {
  canGoUp,
  canSelectCurrent,
  handlePickerListKey,
  hasDrivesList,
  pathBreadcrumbs,
  resolveFolderPick,
  suggestedFolderName,
  visiblePickerItems,
} from "./folderPickerLogic";

const linuxData: FsBrowseResponse = {
  path: "/home/voce/projetos",
  parent: "/home/voce",
  home: "/home/voce",
  roots: ["/"],
  truncated: false,
  entries: [
    { name: "cyno", path: "/home/voce/projetos/cyno", isGitRepo: true },
    { name: "notas", path: "/home/voce/projetos/notas", isGitRepo: false },
  ],
};

const winData: FsBrowseResponse = {
  path: "C:\\Users\\voce",
  parent: "C:\\Users",
  home: "C:\\Users\\voce",
  roots: ["C:\\", "D:\\"],
  truncated: false,
  entries: [{ name: "MeuApp", path: "C:\\Users\\voce\\MeuApp", isGitRepo: true }],
};

function renderPicker(extra: Partial<FolderPickerViewProps> = {}): string {
  const props: FolderPickerViewProps = {
    data: linuxData,
    showingRoots: false,
    hidden: false,
    loading: false,
    error: null,
    focusedIndex: -1,
    onOpen: () => undefined,
    onUp: () => undefined,
    onHome: () => undefined,
    onRoots: () => undefined,
    onToggleHidden: () => undefined,
    onRetry: () => undefined,
    onConfirm: () => undefined,
    onCancel: () => undefined,
    onFocusIndex: () => undefined,
    ...extra,
  };
  return renderToStaticMarkup(createElement(FolderPickerView, props));
}

describe("FolderPicker: renderização dos estados", () => {
  it("mostra migalhas, atalhos, pastas e diferencia ícone/selo de repositório git no Linux", () => {
    const html = renderPicker();
    expect(html).toContain("↑ Subir");
    expect(html).toContain("Pasta pessoal");
    expect(html).toContain("Raiz (/)");
    expect(html).toContain("Mostrar ocultas");
    expect(html).toContain("cyno");
    expect(html).toContain("notas");
    expect(html).toContain('data-icon="git"');
    expect(html).toContain('data-icon="folder"');
    expect(html).toContain("Repositório Git");
    expect(html).toContain("Usar esta pasta");
    expect(html).toContain("Cancelar");
    expect(html).toContain("/home/voce/projetos");
  });

  it("mostra atalho de Unidades e lista unidades de disco no Windows", () => {
    const inDrive = renderPicker({ data: winData });
    expect(inDrive).toContain("Unidades");
    expect(inDrive).toContain("C:\\");
    expect(inDrive).toContain("MeuApp");

    const drivesList = renderPicker({ data: { ...winData, path: "C:\\", parent: null }, showingRoots: true });
    expect(drivesList).toContain('data-icon="drive"');
    expect(drivesList).toContain("C:\\");
    expect(drivesList).toContain("D:\\");
    expect(drivesList).toContain("Escolha uma unidade para continuar.");
  });

  it("mostra estados de carregando, vazio, truncado e erro", () => {
    expect(renderPicker({ loading: true })).toContain("Carregando pastas…");
    expect(renderPicker({ data: { ...linuxData, entries: [] } })).toContain("Nenhuma subpasta visível aqui.");
    expect(renderPicker({ data: { ...linuxData, entries: [] }, hidden: true })).toContain("Nenhuma subpasta aqui.");
    expect(renderPicker({ data: { ...linuxData, truncated: true } })).toContain("Mostrando as primeiras 500 pastas.");
    const erro = renderPicker({ error: "Sem permissão para abrir esta pasta." });
    expect(erro).toContain("Sem permissão para abrir esta pasta.");
    expect(erro).toContain("Tentar de novo");
  });
});

describe("FolderPicker: migalhas, navegação, teclado e escolha", () => {
  it("quebra caminhos Linux e Windows em migalhas clicáveis e sugere o nome da pasta", () => {
    expect(pathBreadcrumbs("/")).toEqual([{ label: "/", path: "/" }]);
    expect(pathBreadcrumbs("/home/voce/projetos")).toEqual([
      { label: "/", path: "/" },
      { label: "home", path: "/home" },
      { label: "voce", path: "/home/voce" },
      { label: "projetos", path: "/home/voce/projetos" },
    ]);
    expect(pathBreadcrumbs("C:\\Users\\voce\\App")).toEqual([
      { label: "C:\\", path: "C:\\" },
      { label: "Users", path: "C:\\Users" },
      { label: "voce", path: "C:\\Users\\voce" },
      { label: "App", path: "C:\\Users\\voce\\App" },
    ]);
    expect(suggestedFolderName("/home/voce/meu-app/")).toBe("meu-app");
    expect(suggestedFolderName("C:\\Users\\voce\\Meu Projeto\\")).toBe("Meu Projeto");
    expect(suggestedFolderName("C:\\")).toBe("C");
  });

  it("controla Subir, lista de unidades e permissão de confirmar no Linux e no Windows", () => {
    expect(hasDrivesList(linuxData)).toBe(false);
    expect(hasDrivesList(winData)).toBe(true);

    // Linux na raiz: não sobe mais.
    expect(canGoUp({ ...linuxData, path: "/", parent: null }, false)).toBe(false);
    expect(canGoUp(linuxData, false)).toBe(true);

    // Windows na raiz da unidade: Subir volta para a lista de unidades.
    const winRoot: FsBrowseResponse = { ...winData, path: "C:\\", parent: null };
    expect(canGoUp(winRoot, false)).toBe(true);
    expect(canGoUp(winRoot, true)).toBe(false);
    expect(visiblePickerItems(winRoot, true).map((item) => item.path)).toEqual(["C:\\", "D:\\"]);

    // Só pode confirmar quando há pasta concreta aberta sem erro/carregamento.
    expect(canSelectCurrent(linuxData, false, false, null)).toBe(true);
    expect(canSelectCurrent(winRoot, true, false, null)).toBe(false);
    expect(canSelectCurrent(linuxData, false, true, null)).toBe(false);
    expect(canSelectCurrent(linuxData, false, false, "Erro")).toBe(false);
  });

  it("navega na lista pelo teclado (setas, Home, End, Enter, Backspace e Esc)", () => {
    const items = visiblePickerItems(linuxData, false);
    expect(handlePickerListKey("ArrowDown", { items, focusedIndex: -1, canUp: true })).toEqual({ kind: "focus", index: 0 });
    expect(handlePickerListKey("ArrowDown", { items, focusedIndex: 0, canUp: true })).toEqual({ kind: "focus", index: 1 });
    expect(handlePickerListKey("ArrowDown", { items, focusedIndex: 1, canUp: true })).toEqual({ kind: "focus", index: 1 });
    expect(handlePickerListKey("ArrowUp", { items, focusedIndex: 1, canUp: true })).toEqual({ kind: "focus", index: 0 });
    expect(handlePickerListKey("End", { items, focusedIndex: 0, canUp: true })).toEqual({ kind: "focus", index: 1 });
    expect(handlePickerListKey("Home", { items, focusedIndex: 1, canUp: true })).toEqual({ kind: "focus", index: 0 });
    expect(handlePickerListKey("Enter", { items, focusedIndex: 0, canUp: true })).toEqual({
      kind: "open",
      path: "/home/voce/projetos/cyno",
    });
    expect(handlePickerListKey("Backspace", { items, focusedIndex: 0, canUp: true })).toEqual({ kind: "up" });
    expect(handlePickerListKey("Backspace", { items, focusedIndex: 0, canUp: false })).toBeNull();
    expect(handlePickerListKey("Escape", { items, focusedIndex: 0, canUp: true })).toEqual({ kind: "close" });
  });

  it("usa diálogo nativo no app desktop (ignorando cancelamento) e abre modal no navegador", async () => {
    expect(await resolveFolderPick({ desktop: true, pickNative: async () => "C:\\Projetos\\Cyno" })).toEqual({
      kind: "picked",
      path: "C:\\Projetos\\Cyno",
    });
    expect(await resolveFolderPick({ desktop: true, pickNative: async () => null })).toEqual({
      kind: "cancelled",
    });
    expect(await resolveFolderPick({ desktop: false, pickNative: async () => "C:\\nao-chama" })).toEqual({
      kind: "open-modal",
    });
  });
});
