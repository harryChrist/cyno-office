import { describe, expect, it } from "vitest";
import { fileReachNotice, FILE_REACH_WARNING } from "./engine-status";

const on = { enabled: true, available: true, active: true };

describe("o aviso de alcance dos arquivos (fileReachNotice)", () => {
  it("com a cerca ativa o Hermes diz a verdade nova: o que fecha e o que sobra", () => {
    const text = fileReachNotice("hermes", on)!;
    expect(text).toMatch(/^Cerca ativa/);
    expect(text).toMatch(/chave do OpenRouter/);
    expect(text).toMatch(/token de MCP do próprio agente/);
    expect(text).toMatch(/lista de números de processo/);
    // O aviso antigo some.
    expect(text).not.toContain(FILE_REACH_WARNING.hermes);
    expect(text).not.toMatch(/use em workspaces de confiança/);
  });

  it("na conta 'configuração do programa' acrescenta o que o programa precisa ler (.env e auth.json)", () => {
    expect(fileReachNotice("hermes", on, { mode: "openrouter", location: "cyno" })).not.toMatch(/auth\.json/);
    expect(fileReachNotice("hermes", on, { mode: "program", location: "cyno" })).toMatch(/\.env e auth\.json/);
  });

  it("sem a cerca o aviso antigo continua, com o motivo", () => {
    expect(fileReachNotice("hermes", undefined)).toBe(FILE_REACH_WARNING.hermes);
    expect(fileReachNotice("hermes", { enabled: false, available: true, active: false })).toMatch(/inclusive a chave do OpenRouter.*desligada/s);
    expect(fileReachNotice("hermes", { enabled: true, available: false, active: false })).toMatch(/inclusive a chave do OpenRouter.*não tem o Landlock/s);
  });

  it("o OpenClaw só tem texto com a cerca ativa (ele já confina por opção própria)", () => {
    expect(fileReachNotice("openclaw", undefined)).toBeUndefined();
    expect(fileReachNotice("openclaw", { enabled: false, available: true, active: false })).toBeUndefined();
    expect(fileReachNotice("openclaw", on)).toMatch(/^Cerca ativa \(além do confinamento do próprio OpenClaw\)/);
  });
});
