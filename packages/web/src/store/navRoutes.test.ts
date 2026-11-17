import { describe, expect, it } from "vitest";
import { hashFor, LEGACY_ROUTES, migrateLegacyHash, PAGES, parseHash, subForWorkspace, subWorkspace } from "./navStore";

describe("rotas antigas (LEGACY_ROUTES)", () => {
  const table: [string, string][] = [
    ["#/principal/midia", "#/biblioteca/midia/principal"],
    ["#/midia", "#/biblioteca/midia"],
    ["#/principal/cerebro", "#/biblioteca/cerebro/principal"],
    ["#/principal/cerebro/projetox/nota.md", "#/biblioteca/cerebro/principal/projetox/nota.md"],
    ["#/cerebro", "#/biblioteca/cerebro"],
    ["#/principal/gastos", "#/principal/gestao/gastos"],
    ["#/gastos", "#/gestao/gastos"],
    ["#/principal/atividade", "#/principal/gestao/atividade"],
    ["#/principal/logs", "#/principal/gestao/atividade"],
    ["#/atividade", "#/gestao/atividade"],
    ["#/logs", "#/gestao/atividade"],
    ["#/principal/calendario", "#/agenda/principal"],
    ["#/principal/calendario/2026-11", "#/agenda/principal"],
    ["#/calendario", "#/agenda"],
    ["#/principal/tarefas", "#/principal/trabalho"],
    ["#/tarefas", "#/trabalho"],
    ["#/configuracoes/skills", "#/biblioteca/skills"],
    ["#/principal/configuracoes/skills", "#/biblioteca/skills/principal"],
    ["#/principal/midia?x=1", "#/biblioteca/midia/principal?x=1"],
  ];

  it.each(table)("%s vai para %s", (old, next) => {
    expect(migrateLegacyHash(old)).toBe(next);
  });

  it("a tabela cobre toda chave de LEGACY_ROUTES", () => {
    const covered = new Set(table.map(([old]) => old.replace(/^#\/([^/]+\/)?/, "").split(/[/?]/)[0]));
    for (const key of Object.keys(LEGACY_ROUTES)) expect(covered.has(key)).toBe(true);
  });

  it("endereços novos e os que continuam valendo não são mexidos", () => {
    for (const hash of ["#/principal/navegador", "#/principal/gestao", "#/principal/gestao/gastos", "#/biblioteca/midia/principal", "#/agenda", "#/agenda/principal", "#/principal/trabalho", "#/configuracoes/motores", "#/principal/configuracoes/conectores", "#/gastos/trabalho", "#/cyno"]) {
      expect(migrateLegacyHash(hash)).toBeNull();
    }
  });

  it("parseHash lê o endereço antigo como o novo", () => {
    expect(parseHash("#/principal/midia")).toEqual({ workspaceId: "principal", page: "biblioteca", sub: "midia/principal" });
    expect(parseHash("#/principal/gastos")).toEqual({ workspaceId: "principal", page: "gestao", sub: "gastos" });
    expect(parseHash("#/principal/calendario")).toEqual({ workspaceId: null, page: "agenda", sub: "principal" });
    expect(parseHash("#/principal/navegador")).toEqual({ workspaceId: "principal", page: "navegador" });
  });
});

describe("abas no endereço", () => {
  it("monta e lê o endereço das abas da Gestão e da Biblioteca", () => {
    expect(hashFor({ workspaceId: "principal", page: "gestao", sub: "gastos" })).toBe("#/principal/gestao/gastos");
    expect(hashFor({ workspaceId: null, page: "gestao", sub: "atividade" })).toBe("#/gestao/atividade");
    expect(hashFor({ workspaceId: "principal", page: "biblioteca", sub: "midia/principal" })).toBe("#/biblioteca/midia/principal");
    expect(parseHash("#/principal/gestao/atividade")).toEqual({ workspaceId: "principal", page: "gestao", sub: "atividade" });
    expect(parseHash("#/gestao/atividade")).toEqual({ workspaceId: null, page: "gestao", sub: "atividade" });
    expect(parseHash("#/biblioteca/cerebro/linkedin/global/a.md")).toEqual({ workspaceId: "linkedin", page: "biblioteca", sub: "cerebro/linkedin/global/a.md" });
    expect(parseHash("#/biblioteca/skills")).toEqual({ workspaceId: null, page: "biblioteca", sub: "skills" });
  });

  it("o workspace da aba Mídia/Cérebro vem do endereço; trocar de workspace troca a aba certa", () => {
    expect(subWorkspace("biblioteca", "midia/meu%20ws")).toBe("meu ws");
    expect(subWorkspace("biblioteca", "skills")).toBeNull();
    expect(subForWorkspace("gestao", "gastos", "outro")).toBe("gastos");
    expect(subForWorkspace("biblioteca", "cerebro/principal/global/a.md", "outro")).toBe("cerebro/outro");
    expect(subForWorkspace("biblioteca", "skills", "outro")).toBe("skills");
    expect(subForWorkspace("trabalho", "", "outro")).toBe("");
    expect(subForWorkspace("agenda", "principal", "outro")).toBe("outro");
    expect(subForWorkspace("agenda", "", "outro")).toBe("");
  });

  it("as páginas de workspace do menu", () => {
    expect(PAGES.map((page) => page.id)).toEqual(["office", "trabalho", "para-voce", "quadro", "gestao"]);
  });
});
