import { describe, expect, it } from "vitest";
import { officeToolDoneWith, officeToolShort } from "../agentWork/officeTools";
import { toolLabel } from "../agentWork/maestroActivityLogic";
import { keyMessage } from "./browserStream";

const key = (value: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) =>
  keyMessage({ key: value, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods });

describe("teclado do painel Navegador", () => {
  it("letras viram texto; teclas especiais e atalhos viram nomes do Playwright", () => {
    expect(key("a")).toEqual({ t: "type", text: "a" });
    expect(key("Ç")).toEqual({ t: "type", text: "Ç" });
    expect(key("Enter")).toEqual({ t: "key", key: "Enter" });
    expect(key(" ")).toEqual({ t: "type", text: " " });
    expect(key("a", { ctrlKey: true })).toEqual({ t: "key", key: "Control+a" });
    expect(key("Tab", { shiftKey: true })).toEqual({ t: "key", key: "Shift+Tab" });
    expect(key("Shift")).toBeNull();
    expect(key("Dead")).toBeNull();
  });
});

describe("rótulos pt-BR das ferramentas do navegador", () => {
  it("a atividade diz o que o agente fez", () => {
    expect(officeToolDoneWith("browser_open", { url: "https://www.google.com/search?q=x" })).toBe("Abriu google.com");
    expect(officeToolDoneWith("browser_open", { url: "linkedin.com/feed" })).toBe("Abriu linkedin.com");
    expect(officeToolDoneWith("browser_type", { ref: "e3", text: "pizza de manga", submit: true })).toBe("Digitou “pizza de manga” e enviou");
    expect(officeToolDoneWith("browser_press", { key: "Enter" })).toBe("Apertou Enter");
    expect(officeToolDoneWith("browser_click", { ref: "e9" })).toBe("Clicou na página");
    expect(toolLabel("mcp__office__browser_open", { url: "https://g1.globo.com" })).toBe("Abriu g1.globo.com");
    expect(officeToolShort("browser_snapshot")).toBe("ler página");
  });
});
