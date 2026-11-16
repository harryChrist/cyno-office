// Atalhos do teclado que o dono pode trocar. Preferência só deste navegador (localStorage, sem server), como o som e
// os bichos. Hoje há um: abrir o chat do Maestro de qualquer tela (padrão Ctrl+K; no Mac, ⌘K).
import { useSyncExternalStore } from "react";

/** Uma combinação: a tecla (o `event.key` em minúsculas) e os modificadores. `mod` é Ctrl ou ⌘, o que o sistema usar. */
export type KeyBinding = { key: string; mod: boolean; alt: boolean; shift: boolean };

export type Shortcuts = { maestro: KeyBinding };

export const DEFAULT_SHORTCUTS: Shortcuts = { maestro: { key: "k", mod: true, alt: false, shift: false } };
export const SHORTCUTS_KEY = "cyno.atalhos.v1";

type KeyLike = Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">;

const MODIFIER_KEYS = new Set(["control", "shift", "alt", "meta", "altgraph", "capslock", "os", "dead", "unidentified", "process"]);
/** Teclas que não viram atalho mesmo com modificador: fecham janelas, andam pelo foco e enviam formulários. */
const NAVIGATION_KEYS = new Set(["escape", "tab", "enter", "backspace", "delete"]);
/** Ctrl/⌘ + uma destas (sem Alt nem Shift) já é do navegador ou do próprio Cyno (Ctrl+B recolhe a barra, Ctrl+F busca no terminal). */
const TAKEN_WITH_MOD = new Set(["a", "b", "c", "f", "l", "n", "p", "r", "s", "t", "v", "w", "x", "y", "z"]);

export function sameBinding(a: KeyBinding, b: KeyBinding): boolean {
  return a.key === b.key && a.mod === b.mod && a.alt === b.alt && a.shift === b.shift;
}

/** O evento de teclado é exatamente esta combinação? */
export function matchesBinding(event: KeyLike, binding: KeyBinding): boolean {
  return event.key.toLowerCase() === binding.key && (event.ctrlKey || event.metaKey) === binding.mod && event.altKey === binding.alt && event.shiftKey === binding.shift;
}

/** A combinação que o evento representa; null enquanto só há modificadores apertados. */
export function bindingFromEvent(event: KeyLike): KeyBinding | null {
  const key = event.key.toLowerCase();
  if (!key || MODIFIER_KEYS.has(key)) return null;
  return { key, mod: event.ctrlKey || event.metaKey, alt: event.altKey, shift: event.shiftKey };
}

/** Por que esta combinação não serve, ou undefined se serve. */
export function bindingIssue(binding: KeyBinding): string | undefined {
  if (NAVIGATION_KEYS.has(binding.key)) return "Essa tecla já tem função nas telas. Escolha outra.";
  const functionKey = /^f([1-9]|1[0-9]|2[0-4])$/.test(binding.key);
  if (!binding.mod && !binding.alt && !functionKey) return "Use Ctrl (ou ⌘) ou Alt junto com uma tecla, para o atalho não atrapalhar a digitação.";
  if (binding.mod && !binding.alt && !binding.shift && TAKEN_WITH_MOD.has(binding.key)) return "Essa combinação já é usada pelo navegador ou pelo Cyno. Escolha outra.";
  return undefined;
}

const KEY_NAMES: Readonly<Record<string, string>> = { " ": "Espaço", arrowup: "↑", arrowdown: "↓", arrowleft: "←", arrowright: "→", pageup: "PgUp", pagedown: "PgDn", home: "Home", end: "End", insert: "Ins" };

/** As teclas da combinação, na ordem de leitura, prontas para um `<kbd>` cada: ["Ctrl", "K"]; no Mac, ["⌘", "K"]. */
export function bindingKeys(binding: KeyBinding, mac: boolean): string[] {
  const keys: string[] = [];
  if (binding.mod) keys.push(mac ? "⌘" : "Ctrl");
  if (binding.alt) keys.push(mac ? "⌥" : "Alt");
  if (binding.shift) keys.push(mac ? "⇧" : "Shift");
  keys.push(KEY_NAMES[binding.key] ?? (binding.key.length === 1 ? binding.key.toUpperCase() : binding.key.charAt(0).toUpperCase() + binding.key.slice(1)));
  return keys;
}

/** A combinação em texto corrido, para dica e leitor de tela: "Ctrl+K". */
export function bindingText(binding: KeyBinding, mac: boolean): string {
  return bindingKeys(binding, mac).join("+");
}

export const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

// ---------- A preferência guardada ----------

type Store = Pick<Storage, "getItem" | "setItem">;

function browserStore(): Store | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

function readBinding(value: unknown): KeyBinding | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.key !== "string" || raw.key.length === 0 || raw.key.length > 20) return null;
  const binding = { key: raw.key.toLowerCase(), mod: raw.mod === true, alt: raw.alt === true, shift: raw.shift === true };
  return bindingIssue(binding) ? null : binding;
}

/** Lê os atalhos guardados; sem armazenamento, com valor estragado ou com combinação que não serve mais, vale o padrão. */
export function readShortcuts(store: Store | null = browserStore()): Shortcuts {
  try {
    const raw = store?.getItem(SHORTCUTS_KEY);
    const saved: unknown = raw ? JSON.parse(raw) : null;
    if (saved && typeof saved === "object") return { maestro: readBinding((saved as Record<string, unknown>).maestro) ?? DEFAULT_SHORTCUTS.maestro };
  } catch {
    // Valor estragado: padrão.
  }
  return { ...DEFAULT_SHORTCUTS };
}

let current: Shortcuts | null = null;
const listeners = new Set<() => void>();

export function shortcuts(): Shortcuts {
  return (current ??= readShortcuts());
}

/** Troca um atalho. Recusa (devolve o motivo) se a combinação não serve; nada é guardado nesse caso. */
export function setShortcut(id: keyof Shortcuts, binding: KeyBinding, store: Store | null = browserStore()): string | undefined {
  const issue = bindingIssue(binding);
  if (issue) return issue;
  current = { ...shortcuts(), [id]: binding };
  try {
    store?.setItem(SHORTCUTS_KEY, JSON.stringify(current));
  } catch {
    // Sem armazenamento: vale só nesta sessão.
  }
  for (const notify of listeners) notify();
  return undefined;
}

export function resetShortcut(id: keyof Shortcuts, store: Store | null = browserStore()): void {
  setShortcut(id, DEFAULT_SHORTCUTS[id], store);
}

function subscribe(notify: () => void): () => void {
  listeners.add(notify);
  return () => listeners.delete(notify);
}

export function useShortcuts(): Shortcuts {
  return useSyncExternalStore(subscribe, shortcuts, () => DEFAULT_SHORTCUTS);
}

/** Só para testes: esquece o valor guardado em memória. */
export function resetShortcutsForTests(): void {
  current = null;
  listeners.clear();
}
