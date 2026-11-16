import { beforeEach, describe, expect, it } from "vitest";
import { isCommandShortcut } from "./CommandBar";
import { bindingFromEvent, bindingIssue, bindingKeys, bindingText, DEFAULT_SHORTCUTS, matchesBinding, readShortcuts, resetShortcut, resetShortcutsForTests, sameBinding, setShortcut, shortcuts, SHORTCUTS_KEY, type KeyBinding } from "./shortcuts";

const key = (init: Partial<Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">>) => ({ key: "k", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...init });
const binding = (init: Partial<KeyBinding>): KeyBinding => ({ key: "k", mod: false, alt: false, shift: false, ...init });

function memoryStore(initial?: string) {
  const data = new Map<string, string>(initial === undefined ? [] : [[SHORTCUTS_KEY, initial]]);
  return { getItem: (name: string) => data.get(name) ?? null, setItem: (name: string, value: string) => void data.set(name, value), data };
}

beforeEach(() => resetShortcutsForTests());

describe("combinações de teclas", () => {
  it("o padrão do Maestro é Ctrl+K (ou ⌘K)", () => {
    expect(DEFAULT_SHORTCUTS.maestro).toEqual({ key: "k", mod: true, alt: false, shift: false });
    expect(matchesBinding(key({ ctrlKey: true }), DEFAULT_SHORTCUTS.maestro)).toBe(true);
    expect(matchesBinding(key({ metaKey: true, key: "K" }), DEFAULT_SHORTCUTS.maestro)).toBe(true);
    expect(matchesBinding(key({}), DEFAULT_SHORTCUTS.maestro)).toBe(false);
    expect(matchesBinding(key({ ctrlKey: true, shiftKey: true }), DEFAULT_SHORTCUTS.maestro)).toBe(false);
  });

  it("a combinação vem do evento, e só modificador ainda não é combinação", () => {
    expect(bindingFromEvent(key({ key: "Control", ctrlKey: true }))).toBeNull();
    expect(bindingFromEvent(key({ key: "Shift", shiftKey: true }))).toBeNull();
    expect(bindingFromEvent(key({ key: "J", ctrlKey: true, shiftKey: true }))).toEqual({ key: "j", mod: true, alt: false, shift: true });
    expect(bindingFromEvent(key({ key: "F2" }))).toEqual({ key: "f2", mod: false, alt: false, shift: false });
  });

  it("recusa tecla solta, teclas de navegação e combinações já usadas", () => {
    expect(bindingIssue(binding({ key: "j" }))).toMatch(/Ctrl/);
    expect(bindingIssue(binding({ key: "j", shift: true }))).toMatch(/Ctrl/);
    expect(bindingIssue(binding({ key: "enter", mod: true }))).toMatch(/tecla já tem função/);
    expect(bindingIssue(binding({ key: "b", mod: true }))).toMatch(/já é usada/);
    expect(bindingIssue(binding({ key: "w", mod: true }))).toMatch(/já é usada/);
    // As mesmas letras com Shift ou Alt junto ficam livres.
    expect(bindingIssue(binding({ key: "b", mod: true, shift: true }))).toBeUndefined();
    expect(bindingIssue(binding({ key: "j", mod: true }))).toBeUndefined();
    expect(bindingIssue(binding({ key: "m", alt: true }))).toBeUndefined();
    expect(bindingIssue(binding({ key: "f2" }))).toBeUndefined();
    expect(bindingIssue(DEFAULT_SHORTCUTS.maestro)).toBeUndefined();
  });

  it("escreve a combinação para Windows/Linux e para Mac", () => {
    expect(bindingKeys(DEFAULT_SHORTCUTS.maestro, false)).toEqual(["Ctrl", "K"]);
    expect(bindingKeys(DEFAULT_SHORTCUTS.maestro, true)).toEqual(["⌘", "K"]);
    expect(bindingText(binding({ key: "j", mod: true, alt: true, shift: true }), false)).toBe("Ctrl+Alt+Shift+J");
    expect(bindingText(binding({ key: " ", alt: true }), false)).toBe("Alt+Espaço");
    expect(bindingText(binding({ key: "f2" }), false)).toBe("F2");
    expect(bindingText(binding({ key: "/", mod: true }), true)).toBe("⌘+/");
  });
});

describe("atalhos guardados no navegador", () => {
  it("sem nada guardado, com valor estragado ou com combinação que não serve, vale o padrão", () => {
    expect(readShortcuts(null)).toEqual(DEFAULT_SHORTCUTS);
    expect(readShortcuts(memoryStore())).toEqual(DEFAULT_SHORTCUTS);
    expect(readShortcuts(memoryStore("{nada"))).toEqual(DEFAULT_SHORTCUTS);
    expect(readShortcuts(memoryStore(JSON.stringify({ maestro: { key: "w", mod: true } })))).toEqual(DEFAULT_SHORTCUTS);
    expect(readShortcuts(memoryStore(JSON.stringify({ maestro: { key: 7 } })))).toEqual(DEFAULT_SHORTCUTS);
  });

  it("trocar guarda e passa a valer; voltar ao padrão desfaz", () => {
    const store = memoryStore();
    expect(setShortcut("maestro", binding({ key: "j", mod: true }), store)).toBeUndefined();
    expect(shortcuts().maestro).toEqual({ key: "j", mod: true, alt: false, shift: false });
    expect(readShortcuts(store).maestro).toEqual({ key: "j", mod: true, alt: false, shift: false });
    // O atalho do Maestro segue a combinação guardada.
    expect(isCommandShortcut(key({ key: "j", ctrlKey: true }), shortcuts().maestro)).toBe(true);
    expect(isCommandShortcut(key({ ctrlKey: true }), shortcuts().maestro)).toBe(false);
    resetShortcut("maestro", store);
    expect(sameBinding(shortcuts().maestro, DEFAULT_SHORTCUTS.maestro)).toBe(true);
    expect(readShortcuts(store)).toEqual(DEFAULT_SHORTCUTS);
  });

  it("uma combinação recusada devolve o motivo e não muda nada", () => {
    const store = memoryStore();
    expect(setShortcut("maestro", binding({ key: "j" }), store)).toMatch(/Ctrl/);
    expect(shortcuts()).toEqual(DEFAULT_SHORTCUTS);
    expect(store.data.size).toBe(0);
  });
});
