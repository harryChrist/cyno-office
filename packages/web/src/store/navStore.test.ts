import { describe, expect, it } from "vitest";
import { hashFor, hashSuffix, isHomeHash, PAGES, pageFromHash, pageLabel, parseHash } from "./navStore";

describe("pageFromHash", () => {
  it("lê a página do endereço e cai no Office se não reconhecer", () => {
    expect(pageFromHash("#/principal/trabalho")).toBe("trabalho");
    expect(pageFromHash("#/linkedin/calendario/2026-11")).toBe("agenda");
    expect(pageFromHash("#/principal")).toBe("office");
    expect(pageFromHash("#/principal/nada")).toBe("office");
    expect(pageFromHash("")).toBe("office");
    // Formato antigo, só com a página.
    expect(pageFromHash("#/trabalho")).toBe("trabalho");
    expect(pageFromHash("#para-voce")).toBe("para-voce");
  });

  it("o endereço antigo `tarefas` abre Projetos e tarefas (a página nova)", () => {
    expect(pageFromHash("#/principal/tarefas")).toBe("trabalho");
    expect(pageFromHash("#/tarefas")).toBe("trabalho");
    expect(parseHash("#/linkedin/tarefas")).toEqual({ workspaceId: "linkedin", page: "trabalho" });
    expect(pageLabel("trabalho")).toBe("Projetos e tarefas");
  });

  it("reconhece as Configurações (página sem aba, aberta pela engrenagem), com ou sem seção", () => {
    expect(pageFromHash("#/principal/configuracoes")).toBe("configuracoes");
    expect(pageFromHash("#/principal/configuracoes/motores")).toBe("configuracoes");
    expect(pageFromHash("#/configuracoes")).toBe("configuracoes");
    expect(PAGES.map((page) => page.id)).not.toContain("configuracoes");
  });
});

describe("Cyno (página do app inteiro)", () => {
  it("o Quadro vive em `#/<ws>/quadro[/<id>]` e vem antes da Gestão no menu de páginas", () => {
    expect(parseHash("#/principal/quadro")).toEqual({ workspaceId: "principal", page: "quadro" });
    expect(parseHash("#/principal/quadro/Q-0002")).toEqual({ workspaceId: "principal", page: "quadro", sub: "Q-0002" });
    expect(hashFor({ workspaceId: "principal", page: "quadro", sub: "Q-0002" })).toBe("#/principal/quadro/Q-0002");
    expect(pageLabel("quadro")).toBe("Quadro");
    const ids = PAGES.map((page) => page.id) as string[];
    expect(ids.indexOf("quadro")).toBe(ids.indexOf("gestao") - 1);
  });

  it("#/cyno abre a página do Cyno sem workspace, e o endereço dela nunca leva workspace", () => {
    expect(parseHash("#/cyno")).toEqual({ workspaceId: null, page: "cyno" });
    expect(pageFromHash("#/principal/cyno")).toBe("cyno");
    expect(hashFor({ workspaceId: "principal", page: "cyno" })).toBe("#/cyno");
    expect(hashFor({ workspaceId: null, page: "cyno" })).toBe("#/cyno");
    // As outras páginas continuam levando o workspace.
    expect(hashFor({ workspaceId: "principal", page: "trabalho" })).toBe("#/principal/trabalho");
    expect(pageLabel("cyno")).toBe("Cyno · Início");
    // O Cyno não vira aba do menu de workspace.
    expect(PAGES.map((page) => page.id)).not.toContain("cyno");
  });

  it("a rota inicial continua a de antes (a Fatia 2 é que muda): sem endereço, o Office", () => {
    expect(parseHash("")).toEqual({ workspaceId: null, page: "office" });
    expect(parseHash("#/")).toEqual({ workspaceId: null, page: "office" });
  });
});

describe("parseHash / hashFor", () => {
  it("separa workspace e página", () => {
    expect(parseHash("#/principal/trabalho")).toEqual({ workspaceId: "principal", page: "trabalho" });
    expect(parseHash("#/instagram")).toEqual({ workspaceId: "instagram", page: "office" });
    expect(parseHash("#/cerebro")).toEqual({ workspaceId: null, page: "biblioteca", sub: "cerebro" });
    expect(parseHash("")).toEqual({ workspaceId: null, page: "office" });
    expect(parseHash("#/linkedin/cerebro")).toEqual({ workspaceId: "linkedin", page: "biblioteca", sub: "cerebro/linkedin" });
  });

  it("monta o endereço e volta ao mesmo lugar", () => {
    expect(hashFor({ workspaceId: "principal", page: "trabalho" })).toBe("#/principal/trabalho");
    expect(hashFor({ workspaceId: "linkedin", page: "office" })).toBe("#/linkedin/office");
    expect(hashFor({ workspaceId: null, page: "office" })).toBe("#/office");
    for (const location of [
      { workspaceId: "principal", page: "para-voce" },
      { workspaceId: "trabalho", page: "office" },
    ] as const) {
      expect(parseHash(hashFor(location))).toEqual(location);
    }
  });
});

describe("hashSuffix", () => {
  it("devolve o que vem depois de workspace e página", () => {
    expect(hashSuffix("#/principal/cerebro/projetox/nota.md")).toBe("/projetox/nota.md");
    expect(hashSuffix("#/principal/cerebro")).toBe("");
    expect(hashSuffix("")).toBe("");
  });
});

describe("pageLabel", () => {
  it("dá o nome das abas e das páginas extras (título da barra do celular)", () => {
    expect(pageLabel("office")).toBe("Escritório");
    expect(pageLabel("trabalho")).toBe("Projetos e tarefas");
    expect(pageLabel("para-voce")).toBe("Aprovações");
    expect(pageLabel("gestao")).toBe("Gestão");
    expect(pageLabel("biblioteca")).toBe("Biblioteca");
    expect(pageLabel("agenda")).toBe("Sua agenda");
    expect(pageLabel("navegador")).toBe("Navegador dos agentes");
  });
});

describe("rota inicial", () => {
  it("endereço vazio é a página inicial (Cyno); os links antigos não", () => {
    for (const hash of ["", "#", "#/", "#/?x=1"]) expect(isHomeHash(hash)).toBe(true);
    for (const hash of ["#/cyno", "#/linkedin", "#/linkedin/office", "#/trabalho"]) expect(isHomeHash(hash)).toBe(false);
  });

  it("o Cyno é página do app inteiro: o endereço dele nunca leva workspace", () => {
    expect(hashFor({ workspaceId: "linkedin", page: "cyno" })).toBe("#/cyno");
    expect(parseHash("#/cyno")).toEqual({ workspaceId: null, page: "cyno" });
  });
});

describe("filtros de Projetos e tarefas no endereço", () => {
  it("guarda o ?filtros no sub só de trabalho", () => {
    expect(parseHash("#/linkedin/trabalho/tarefas?sprint=ativa&agente=eco")).toEqual({ workspaceId: "linkedin", page: "trabalho", sub: "tarefas?sprint=ativa&agente=eco" });
    expect(parseHash("#/linkedin/gestao/gastos?x=1")).toEqual({ workspaceId: "linkedin", page: "gestao", sub: "gastos" });
    expect(hashFor({ workspaceId: "linkedin", page: "trabalho", sub: "tarefas?sprint=ativa" })).toBe("#/linkedin/trabalho/tarefas?sprint=ativa");
  });
});
