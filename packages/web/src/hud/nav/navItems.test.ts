import { describe, expect, it } from "vitest";
import { foldersSummary, activeChild, APP_WIDE_SECTIONS, childSub, counterLabel, counterParts, isGroupOpen, menuPages, NAV_SECTIONS, nonEmptySections, PAGE_HINTS, PARA_VOCE_BUTTONS, railGroupSub, visibleChildren, visibleParaVoce, visibleSections } from "./navItems";

describe("menu de páginas", () => {
  it("grupos na ordem: Trabalho, Agentes ao vivo e, depois do traço, Gestão e Biblioteca", () => {
    expect(NAV_SECTIONS.map((section) => [section.title, section.items.map((item) => item.page)])).toEqual([
      ["Trabalho", ["office", "trabalho", "para-voce", "quadro", "arquivos"]],
      ["Agentes ao vivo", ["navegador", "scripts"]],
      [null, ["gestao", "biblioteca"]],
    ]);
    expect(NAV_SECTIONS.map((section) => Boolean(section.separated))).toEqual([false, false, true]);
    expect(menuPages()).toEqual(["office", "trabalho", "para-voce", "quadro", "arquivos", "navegador", "scripts", "gestao", "biblioteca"]);
  });

  it("Aprovações continua sendo a página para-voce, com os mesmos ids de teste", () => {
    const items = NAV_SECTIONS.flatMap((section) => section.items);
    expect(items.find((item) => item.page === "para-voce")).toMatchObject({ icon: "para-voce", testId: "nav-para-voce" });
    expect(items.map((item) => item.testId)).toEqual(["nav-office", "nav-trabalho", "nav-para-voce", "nav-quadro", "nav-arquivos", "nav-navegador", "nav-scripts", "nav-gestao", "nav-biblioteca"]);
  });

  it("o Quadro vem logo depois de Aprovações, com ícone próprio e dica curta", () => {
    const items = NAV_SECTIONS.flatMap((section) => section.items);
    const quadro = items.find((item) => item.page === "quadro");
    expect(quadro).toMatchObject({ icon: "quadro", testId: "nav-quadro", hint: "Os dados que os agentes montam para você" });
  });

  it("Arquivos vem depois do Quadro, com ícone de pasta, só com workspace", () => {
    const items = NAV_SECTIONS[0]!.items;
    expect(items.map((item) => item.page).indexOf("arquivos")).toBe(items.map((item) => item.page).indexOf("quadro") + 1);
    expect(items.find((item) => item.page === "arquivos")).toMatchObject({ icon: "pasta", testId: "nav-arquivos", hint: PAGE_HINTS.arquivos, needsWorkspace: true });
  });

  it("Mídia, Cérebro, Gastos, Atividade, Calendário não são linhas do menu; Navegador e Scripts são, com contagem", () => {
    const pages: string[] = menuPages();
    for (const gone of ["midia", "cerebro", "gastos", "atividade", "calendario", "agenda"]) expect(pages).not.toContain(gone);
    const live = NAV_SECTIONS[1]!.items;
    expect(live.map((item) => [item.label, item.counter, item.needsWorkspace])).toEqual([
      ["Navegador", "tabs", true],
      ["Scripts", "running", true],
    ]);
  });

  it("seção vazia some (e o título dela junto)", () => {
    const sections = [...NAV_SECTIONS, { title: "Conhecimento", items: [] }];
    expect(nonEmptySections(sections)).toHaveLength(NAV_SECTIONS.length);
  });

  it("com workspace, as seções são as do menu; sem workspace, só o que vale para o app inteiro", () => {
    expect(visibleSections(false)).toEqual(NAV_SECTIONS);
    expect(visibleSections(true)).toEqual(APP_WIDE_SECTIONS);
    expect(APP_WIDE_SECTIONS[0]!.items.map((item) => [item.page, item.sub ?? ""])).toEqual([
      ["biblioteca", ""],
      ["gestao", "atividade"],
    ]);
    // Uma linha de workspace num grupo solto não deixa título vazio para trás.
    const mixed = [{ title: "Agentes ao vivo", items: NAV_SECTIONS[1]!.items }];
    expect(nonEmptySections(mixed.map((section) => ({ ...section, items: section.items.filter((item) => !item.needsWorkspace) })))).toEqual([]);
  });
});

describe("Para você: quatro botões", () => {
  it("Hoje, Espera, Avisos e Agenda, com o nome inteiro para leitor de tela e dica", () => {
    expect(PARA_VOCE_BUTTONS.map((button) => [button.id, button.short, button.label])).toEqual([
      ["hoje", "Hoje", "Hoje"],
      ["espera", "Espera", "Esperando você"],
      ["avisos", "Avisos", "Notificações"],
      ["agenda", "Agenda", "Sua agenda"],
    ]);
    for (const button of PARA_VOCE_BUTTONS) expect(button.hint, button.id).toBeTruthy();
  });

  it("sem workspace, só a Agenda", () => {
    expect(visibleParaVoce(false)).toHaveLength(4);
    expect(visibleParaVoce(true).map((button) => button.id)).toEqual(["agenda"]);
  });
});

describe("contagem à direita das linhas", () => {
  it("abas: 1 aba, N abas, nada quando é zero", () => {
    expect(counterLabel("tabs", 0)).toBeNull();
    expect(counterLabel("tabs", 1)).toBe("1 aba");
    expect(counterLabel("tabs", 3)).toBe("3 abas");
  });

  it("scripts: N rodando (o número e a palavra separados, para a barra recolhida mostrar só o número)", () => {
    expect(counterLabel("running", 0)).toBeNull();
    expect(counterLabel("running", 1)).toBe("1 rodando");
    expect(counterLabel("running", 2)).toBe("2 rodando");
    expect(counterParts("running", 2)).toEqual({ number: "2", word: "rodando", label: "2 rodando" });
  });
});

describe("grupos que abrem e fecham", () => {
  const gestao = NAV_SECTIONS[2]!.items[0]!;

  it("fechado por padrão; aberto quando a página atual é do grupo", () => {
    expect(isGroupOpen(gestao, "office", undefined)).toBe(false);
    expect(isGroupOpen(gestao, "gestao", undefined)).toBe(true);
  });

  it("no menu do celular o grupo já vem aberto; quem fechou de propósito continua vendo fechado", () => {
    expect(isGroupOpen(gestao, "office", undefined, true)).toBe(true);
    expect(isGroupOpen(gestao, "office", false, true)).toBe(false);
    expect(isGroupOpen(gestao, "office", undefined, false)).toBe(false);
  });

  it("a escolha lembrada vale: abriu = aberto em qualquer página; fechou = fechado, mesmo dentro dele", () => {
    expect(isGroupOpen(gestao, "office", true)).toBe(true);
    expect(isGroupOpen(gestao, "gestao", false)).toBe(false);
    expect(isGroupOpen(gestao, "biblioteca", false)).toBe(false);
  });
});

describe("nomes claros e destinos visíveis", () => {
  const gestao = NAV_SECTIONS[2]!.items.find((item) => item.page === "gestao")!;
  const biblioteca = NAV_SECTIONS[2]!.items.find((item) => item.page === "biblioteca")!;

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

  it("Navegador e Scripts têm nome curto na linha e o nome inteiro na dica da página", () => {
    const [navegador, scripts] = NAV_SECTIONS[1]!.items;
    expect([navegador!.label, scripts!.label]).toEqual(["Navegador", "Scripts"]);
    expect(navegador!.hint).toBe(PAGE_HINTS.navegador);
    expect(scripts!.hint).toBe(PAGE_HINTS.scripts);
  });
});

describe("barra recolhida: itens com sublinks", () => {
  const gestao = NAV_SECTIONS[2]!.items.find((item) => item.page === "gestao")!;
  const biblioteca = NAV_SECTIONS[2]!.items.find((item) => item.page === "biblioteca")!;

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
