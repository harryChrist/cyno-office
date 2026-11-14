import { describe, expect, it } from "vitest";
import { isCommandShortcut } from "./CommandBar";

const key = (init: Partial<Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">>) => ({
  key: "k",
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...init,
});

describe("isCommandShortcut", () => {
  it("aceita Ctrl+K e ⌘K (maiúsculo ou minúsculo)", () => {
    expect(isCommandShortcut(key({ ctrlKey: true }))).toBe(true);
    expect(isCommandShortcut(key({ metaKey: true }))).toBe(true);
    expect(isCommandShortcut(key({ key: "K", ctrlKey: true }))).toBe(true);
  });

  it("ignora K sozinho, outras teclas e combinações com Alt/Shift", () => {
    expect(isCommandShortcut(key({}))).toBe(false);
    expect(isCommandShortcut(key({ key: "j", ctrlKey: true }))).toBe(false);
    expect(isCommandShortcut(key({ ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(isCommandShortcut(key({ metaKey: true, altKey: true }))).toBe(false);
  });
});
