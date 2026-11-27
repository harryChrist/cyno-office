import type { FsBrowseResponse } from "@cyno/shared";

/** Um item clicável na barra de migalhas do seletor de pastas. */
export type PathBreadcrumb = {
  label: string;
  path: string;
};

/** Um item exibido na lista do seletor (subpasta ou unidade de disco). */
export type FolderPickerItem = {
  name: string;
  path: string;
  isGitRepo: boolean;
  isRoot?: boolean;
};

/** Resultado de uma tecla pressionada na lista de pastas. */
export type FolderPickerKeyAction =
  | { kind: "focus"; index: number }
  | { kind: "open"; path: string }
  | { kind: "up" }
  | { kind: "close" }
  | null;

/** O caminho usa convenção do Windows (`C:\...` ou `\\servidor\pasta`)? */
export function isWindowsPath(dirPath: string): boolean {
  return /^[A-Za-z]:[\\/]|^\\\\/.test(dirPath.trim());
}

/**
 * Quebra um caminho absoluto (Linux ou Windows) em migalhas clicáveis.
 * Ex.: `/home/voce/app` -> `/`, `home`, `voce`, `app`;
 *      `C:\Users\voce\app` -> `C:\`, `Users`, `voce`, `app`.
 */
export function pathBreadcrumbs(dirPath: string): PathBreadcrumb[] {
  const trimmed = dirPath.trim();
  if (!trimmed) return [];

  if (isWindowsPath(trimmed)) {
    const normalized = trimmed.replace(/\//g, "\\");
    const unc = /^(\\\\[^\\]+\\[^\\]+)(?:\\(.*))?$/.exec(normalized);
    if (unc) {
      const root = `${unc[1]}\\`;
      const rest = (unc[2] ?? "").split("\\").filter(Boolean);
      const crumbs: PathBreadcrumb[] = [{ label: root, path: root }];
      let acc = unc[1]!;
      for (const part of rest) {
        acc = `${acc}\\${part}`;
        crumbs.push({ label: part, path: acc });
      }
      return crumbs;
    }

    const drive = `${normalized.slice(0, 2).toUpperCase()}\\`;
    const rest = normalized.slice(2).split("\\").filter(Boolean);
    const crumbs: PathBreadcrumb[] = [{ label: drive, path: drive }];
    let acc = drive;
    for (const part of rest) {
      acc = acc.endsWith("\\") ? `${acc}${part}` : `${acc}\\${part}`;
      crumbs.push({ label: part, path: acc });
    }
    return crumbs;
  }

  const parts = trimmed.split("/").filter(Boolean);
  const crumbs: PathBreadcrumb[] = [{ label: "/", path: "/" }];
  let acc = "";
  for (const part of parts) {
    acc = `${acc}/${part}`;
    crumbs.push({ label: part, path: acc });
  }
  return crumbs;
}

/** Sugere o nome curto de uma pasta a partir do caminho escolhido (ex.: `/a/b/meu-app` -> `meu-app`). */
export function suggestedFolderName(dirPath: string): string {
  const trimmed = dirPath.trim().replace(/[\\/]+$/, "");
  if (!trimmed) return "";
  if (/^[A-Za-z]:$/.test(trimmed)) return trimmed.slice(0, 1).toUpperCase();
  const parts = trimmed.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? "";
}

/** Há lista de unidades separada (Windows ou múltiplas raízes)? */
export function hasDrivesList(data: Pick<FsBrowseResponse, "roots" | "path"> | null): boolean {
  if (!data) return false;
  return data.roots.length > 1 || data.roots.some(isWindowsPath) || isWindowsPath(data.path);
}

/** Itens visíveis na lista: unidades de disco ou subpastas da pasta atual. */
export function visiblePickerItems(data: FsBrowseResponse | null, showingRoots: boolean): FolderPickerItem[] {
  if (!data) return [];
  if (showingRoots) {
    return data.roots.map((root) => ({ name: root, path: root, isGitRepo: false, isRoot: true }));
  }
  return data.entries;
}

/** O botão "Subir" deve ficar habilitado? (Na raiz de uma unidade Windows, sobe para a lista de unidades.) */
export function canGoUp(data: FsBrowseResponse | null, showingRoots: boolean): boolean {
  if (!data || showingRoots) return false;
  if (data.parent !== null) return true;
  return hasDrivesList(data);
}

/** O botão "Usar esta pasta" pode confirmar a escolha atual? */
export function canSelectCurrent(
  data: FsBrowseResponse | null,
  showingRoots: boolean,
  loading: boolean,
  error: string | null,
): boolean {
  return Boolean(data && !showingRoots && !loading && !error && data.path);
}

/** Calcula o próximo índice focado na lista de pastas ao usar setas, Home ou End. */
export function nextListIndex(current: number, key: string, total: number): number {
  if (total <= 0) return -1;
  if (key === "ArrowDown") return current < 0 ? 0 : Math.min(total - 1, current + 1);
  if (key === "ArrowUp") return current < 0 ? total - 1 : Math.max(0, current - 1);
  if (key === "Home") return 0;
  if (key === "End") return total - 1;
  return current;
}

/** Traduz a tecla pressionada na lista de pastas em uma ação de navegação. */
export function handlePickerListKey(
  key: string,
  state: { items: readonly FolderPickerItem[]; focusedIndex: number; canUp: boolean },
): FolderPickerKeyAction {
  if (key === "Escape") return { kind: "close" };
  if (key === "ArrowDown" || key === "ArrowUp" || key === "Home" || key === "End") {
    const index = nextListIndex(state.focusedIndex, key, state.items.length);
    return index >= 0 ? { kind: "focus", index } : null;
  }
  if (key === "Enter") {
    const item = state.items[state.focusedIndex];
    return item ? { kind: "open", path: item.path } : null;
  }
  if (key === "Backspace" && state.canUp) return { kind: "up" };
  return null;
}

/**
 * Decide qual seletor abrir ao clicar em "Escolher pasta…":
 * - no aplicativo desktop (Tauri), abre o diálogo nativo (se devolver `null`, não faz nada);
 * - nos demais ambientes (navegador, Linux, Docker), abre o `FolderPicker` interno.
 */
export async function resolveFolderPick(options: {
  desktop: boolean;
  pickNative: () => Promise<string | null>;
}): Promise<{ kind: "picked"; path: string } | { kind: "cancelled" } | { kind: "open-modal" }> {
  if (!options.desktop) return { kind: "open-modal" };
  const picked = await options.pickNative();
  return picked ? { kind: "picked", path: picked } : { kind: "cancelled" };
}
