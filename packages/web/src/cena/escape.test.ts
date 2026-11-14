import { describe, expect, it } from "vitest";
import { escapeReturnsToMap, type EscapeInput } from "./escape";

const base: EscapeInput = { key: "Escape", defaultPrevented: false, target: { tagName: "BODY", isContentEditable: false }, modalOpen: false };

describe("Esc no canvas", () => {
  it("volta ao mapa com o foco na página", () => {
    expect(escapeReturnsToMap(base)).toBe(true);
    expect(escapeReturnsToMap({ ...base, target: null })).toBe(true);
    expect(escapeReturnsToMap({ ...base, target: { tagName: "CANVAS", isContentEditable: false } })).toBe(true);
  });

  it("não mexe na câmera com uma janela modal aberta (o Esc fecha só a janela)", () => {
    expect(escapeReturnsToMap({ ...base, modalOpen: true })).toBe(false);
    expect(escapeReturnsToMap({ ...base, modalOpen: true, target: { tagName: "BUTTON", isContentEditable: false } })).toBe(false);
  });

  it("respeita quem já tratou o evento e os campos de formulário", () => {
    expect(escapeReturnsToMap({ ...base, defaultPrevented: true })).toBe(false);
    for (const tagName of ["INPUT", "TEXTAREA", "SELECT"]) expect(escapeReturnsToMap({ ...base, target: { tagName, isContentEditable: false } })).toBe(false);
    expect(escapeReturnsToMap({ ...base, target: { tagName: "DIV", isContentEditable: true } })).toBe(false);
  });

  it("ignora outras teclas", () => {
    expect(escapeReturnsToMap({ ...base, key: "Enter" })).toBe(false);
  });
});
