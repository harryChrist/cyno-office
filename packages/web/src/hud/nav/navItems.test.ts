import { describe, expect, it } from "vitest";
import { foldersSummary, activeChild, APP_WIDE_SECTIONS, childSub, menuPages, NAV_SECTIONS, nonEmptySections, PAGE_HINTS, railGroupSub, SHORTCUTS, visibleChildren, visibleShortcuts } from "./navItems";

describe("menu de páginas", () => {
  it("Office, Trabalho, Para você, Quadro (antes da Gestão), Gestão e Biblioteca (mais o Cyno no topo)", () => {
    expect(menuPages()).toEqual(["office", "trabalho", "para-voce", "quadro", "gestao", "biblioteca"]);
  });

  it("o Quadro vem logo antes da Gestão, com ícone próprio e dica curta", () => {
    const items = NAV_SECTIONS.flatMap((section) => section.items);
    const quadro = items.findIndex((item) => item.page === "quadro");
    expect(items[quadro + 1]?.page).toBe("gestao");
    expect(items[quadro]).toMatchObject({ icon: "quadro", testId: "nav-quadro", hint: "Os dados que os agentes montam para você" });
  });

  it("Mídia, Cérebro, Gastos, Atividade, Calendário e Navegador não são itens de menu", () => {
    const pages: string[] = menuPages();
    for (const gone of ["midia", "cerebro", "gastos", "atividade", "calendario", "navegador"]) expect(pages).not.toContain(gone);
  });

  it("seção vazia some (e o título dela junto)", () => {
    const sections = [...NAV_SECTIONS, { title: "Conhecimento", items: [] }];
    expect(nonEmptySections(sections)).toHaveLength(NAV_SECTIONS.length);
    expect(NAV_SECTIONS.every((section) => section.title === null)).toBe(true);
  });

  it("sem workspace: a Biblioteca e a Atividade do sistema", () => {
    expect(APP_WIDE_SECTIONS[0]!.items.map((item) => [item.page, item.sub ?? ""])).toEqual([
      ["biblioteca", ""],
      ["gestao", "atividade"],
    ]);
  });

  it("atalhos: agenda e navegador; sem workspace, só a agenda", () => {
    expect(SHORTCUTS.map((shortcut) => shortcut.item.page)).toEqual(["agenda", "navegador"]);
    expect(visibleShortcuts(false)).toHaveLength(2);
    expect(visibleShortcuts(true).map((shortcut) => shortcut.item.page)).toEqual(["agenda"]);
  });
});

describe("nomes claros e destinos visíveis", () => {
  const gestao = NAV_SECTIONS[0]!.items.find((item) => item.page === "gestao")!;
  const biblioteca = NAV_SECTIONS[1]!.items[0]!;

  it("cada página do menu tem uma descrição curta", () => {
    for (const item of NAV_SECTIONS.flatMap((section) => section.items)) expect(item.hint, item.page).toBeTruthy();
    expect(PAGE_HINTS["para-voce"]).toBe("O que espera a sua resposta");
  });

  it("Gestão e Biblioteca mostram os destinos como links diretos, com os nomes novos", () => {
    expect(gestao.children!.map((child) => child.label)).toEqual(["Painel", "Rotinas e metas", "Pessoas", "Gastos", "Atividade", "Relatórios"]);
    expect(biblioteca.children!.map((child) => child.label)).toEqual(["Cérebro (notas)", "Mídia", "Apps", "Conectores (MCP)", "Skills"]);
    expect(NAV_SECTIONS.flatMap((section) => section.items).filter((item) => item.children).map((item) => item.page)).toEqual(["gestao", "biblioteca"]);
  });

  it("o destino aceso acompanha a aba do endereço (e a de abertura vale sem aba)", () => {
    expect(activeChild(gestao, "gestao", "")?.label).toBe("Painel");
    expect(activeChild(gestao, "gestao", "rotinas")?.label).toBe("Rotinas e metas");
    expect(activeChild(gestao, "gestao", "pessoas")?.label).toBe("Pessoas");
    expect(activeChild(gestao, "gestao", "gastos")?.label).toBe("Gastos");
    expect(activeChild(gestao, "gestao", "atividade")?.label).toBe("Atividade");
    expect(activeChild(biblioteca, "biblioteca", "")?.label).toBe("Cérebro (notas)");
    expect(activeChild(biblioteca, "biblioteca", "midia/principal")?.label).toBe("Mídia");
    expect(activeChild(biblioteca, "biblioteca", "cerebro/principal/c/nota")?.label).toBe("Cérebro (notas)");
    expect(activeChild(gestao, "trabalho", "")).toBeNull();
  });

  it("Mídia e Cérebro levam o workspace no endereço; os outros não", () => {
    const [, midia, apps] = biblioteca.children!;
    expect(childSub(midia!, "meu ws")).toBe("midia/meu%20ws");
    expect(childSub(midia!, null)).toBe("midia");
    expect(childSub(apps!, "principal")).toBe("apps");
  });

  it("sem workspace, os destinos de um workspace só somem", () => {
    expect(visibleChildren(gestao, true).map((child) => child.sub)).toEqual(["atividade"]);
    expect(visibleChildren(biblioteca, true).map((child) => child.sub)).toEqual(["apps", "conectores", "skills"]);
    expect(visibleChildren(biblioteca, false)).toHaveLength(5);
  });

  it("atalhos com os nomes novos", () => {
    expect(SHORTCUTS.map((shortcut) => shortcut.tip)).toEqual(["Sua agenda", "Navegador dos agentes"]);
  });
});

describe("barra recolhida: itens com sublinks", () => {
  const gestao = NAV_SECTIONS[0]!.items.find((item) => item.page === "gestao")!;
  const biblioteca = NAV_SECTIONS[1]!.items.find((item) => item.page === "biblioteca")!;

  it("o clique no ícone leva à primeira página do grupo (Painel; Cérebro), não à última aberta", () => {
    expect(railGroupSub(gestao, false, "demo")).toBe("");
    expect(railGroupSub(biblioteca, false, "demo")).toBe("cerebro/demo");
  });

  it("sem workspace, a primeira página que vale (os destinos de um workspace só somem)", () => {
    expect(railGroupSub(gestao, true, null)).toBe("atividade");
    expect(railGroupSub(biblioteca, true, null)).toBe("apps");
  });

  it("o pai fica ativo em qualquer filha aberta (activeChild acha a filha; a página decide o pai)", () => {
    expect(activeChild(gestao, "gestao", "gastos")?.label).toBe("Gastos");
    expect(activeChild(biblioteca, "biblioteca", "skills")?.label).toBe("Skills");
    expect(activeChild(biblioteca, "office", "skills")).toBeNull();
  });
});

describe("resumo do indicador de pastas de trabalho", () => {
  const folder = (name: string, mode: "read" | "write") => ({ id: name, name, path: `/x/${name}`, mode });

  it("sem pastas", () => {
    expect(foldersSummary(undefined)).toMatchObject({ count: 0, writable: 0, label: "Sem pasta de trabalho" });
    expect(foldersSummary([]).aria).toContain("nenhuma");
  });

  it("uma pasta mostra o nome; mais de uma, o nome da primeira e +N", () => {
    expect(foldersSummary([folder("App", "read")])).toMatchObject({ count: 1, writable: 0, label: "App" });
    const two = foldersSummary([folder("App", "write"), folder("Notas", "read")]);
    expect(two).toMatchObject({ count: 2, writable: 1, label: "App +1" });
    expect(two.aria).toContain("1 com escrita");
    expect(two.tip).toContain("App, Notas");
  });
});
