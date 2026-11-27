import { describe, expect, it } from "vitest";
import { headingId, headingOutline, inlineText, isSafeHref, parseInline, parseMarkdown, plainText, wikiTarget } from "./markdownTree";

const text = (value: string) => ({ type: "text", text: value });

describe("parseMarkdown: blocos", () => {
  it("títulos, parágrafos e linha horizontal", () => {
    expect(parseMarkdown("# Título\n\nUm parágrafo\ncom duas linhas.\n\n---\n### Sub ###")).toEqual([
      { type: "heading", level: 1, children: [text("Título")] },
      { type: "paragraph", children: [text("Um parágrafo"), { type: "break" }, text("com duas linhas.")] },
      { type: "rule" },
      { type: "heading", level: 3, children: [text("Sub")] },
    ]);
  });

  it("#tag sem espaço não é título", () => {
    expect(parseMarkdown("#tag no começo")).toEqual([{ type: "paragraph", children: [text("#tag no começo")] }]);
  });

  it("listas simples, numeradas e aninhadas", () => {
    expect(parseMarkdown("- um\n- dois\n  - dois.a\n  - dois.b\n* três")).toEqual([
      {
        type: "list",
        ordered: false,
        start: 1,
        items: [
          { children: [text("um")], blocks: [] },
          {
            children: [text("dois")],
            blocks: [
              {
                type: "list",
                ordered: false,
                start: 1,
                items: [
                  { children: [text("dois.a")], blocks: [] },
                  { children: [text("dois.b")], blocks: [] },
                ],
              },
            ],
          },
          { children: [text("três")], blocks: [] },
        ],
      },
    ]);
    const [ordered] = parseMarkdown("3. c\n4. d\n\nfim");
    expect(ordered).toMatchObject({ type: "list", ordered: true, start: 3, items: [{ children: [text("c")] }, { children: [text("d")] }] });
    expect(parseMarkdown("3. c\n4. d\n\nfim")[1]).toEqual({ type: "paragraph", children: [text("fim")] });
  });

  it("parágrafo seguido de lista sem linha em branco vira dois blocos", () => {
    expect(parseMarkdown("Itens:\n- a").map((block) => block.type)).toEqual(["paragraph", "list"]);
  });

  it("bloco de código cercado guarda o texto cru (sem markdown nem HTML)", () => {
    expect(parseMarkdown("```ts\nconst a = **1**;\n<script>x</script>\n```\ndepois")).toEqual([
      { type: "code", lang: "ts", text: "const a = **1**;\n<script>x</script>" },
      { type: "paragraph", children: [text("depois")] },
    ]);
    expect(parseMarkdown("```\nsem fim")).toEqual([{ type: "code", lang: "", text: "sem fim" }]);
  });

  it("citação com blocos dentro", () => {
    expect(parseMarkdown("> **Nota:** importante\n> - item")).toEqual([
      {
        type: "quote",
        blocks: [
          { type: "paragraph", children: [{ type: "strong", children: [text("Nota:")] }, text(" importante")] },
          { type: "list", ordered: false, start: 1, items: [{ children: [text("item")], blocks: [] }] },
        ],
      },
    ]);
  });

  it("HTML cru vira texto", () => {
    expect(parseMarkdown('<img src=x onerror="alert(1)">')).toEqual([
      { type: "paragraph", children: [text('<img src=x onerror="alert(1)">')] },
    ]);
  });
});

describe("parseMarkdown: tabelas", () => {
  it("cabeçalho, alinhamento, células com marcação e linhas curtas completadas", () => {
    expect(parseMarkdown("Antes\n| Nome | Qtd |  Obs |\n|:--|--:|:-:|\n| **a** | 1 | x \\| y |\n| b |\n\nDepois")).toEqual([
      { type: "paragraph", children: [text("Antes")] },
      {
        type: "table",
        align: ["left", "right", "center"],
        head: [[text("Nome")], [text("Qtd")], [text("Obs")]],
        rows: [
          [[{ type: "strong", children: [text("a")] }], [text("1")], [text("x | y")]],
          [[text("b")], [], []],
        ],
      },
      { type: "paragraph", children: [text("Depois")] },
    ]);
  });

  it("sem a linha separadora (ou com colunas diferentes) continua parágrafo", () => {
    expect(parseMarkdown("a | b\nc | d")[0]!.type).toBe("paragraph");
    expect(parseMarkdown("| a | b |\n| --- |")[0]!.type).toBe("paragraph");
  });

  it("o texto da tabela entra no plainText", () => {
    expect(plainText("| A | B |\n|---|---|\n| 1 | 2 |")).toBe("A B 1 2");
  });
});

describe("parseInline", () => {
  it("endereço sem esquema de domínio comum vira link https; arquivos e e-mails não", () => {
    expect(parseInline("perfil: linkedin.com/in/fulano · Vila Velha")).toEqual([
      text("perfil: "),
      { type: "link", href: "https://linkedin.com/in/fulano", children: [text("linkedin.com/in/fulano")] },
      text(" · Vila Velha"),
    ]);
    expect(parseInline("site www.exemplo.com.br.")).toEqual([
      text("site "),
      { type: "link", href: "https://www.exemplo.com.br", children: [text("www.exemplo.com.br")] },
      text("."),
    ]);
    expect(parseInline("veja nota.md, pasta/site.com e a@b.com")).toEqual([text("veja nota.md, pasta/site.com e a@b.com")]);
  });

  it("negrito, itálico e código", () => {
    expect(parseInline("**forte** e *leve* e _também_ e `x * y`")).toEqual([
      { type: "strong", children: [text("forte")] },
      text(" e "),
      { type: "em", children: [text("leve")] },
      text(" e "),
      { type: "em", children: [text("também")] },
      text(" e "),
      { type: "code", text: "x * y" },
    ]);
    expect(parseInline("***ambos***")).toEqual([{ type: "strong", children: [{ type: "em", children: [text("ambos")] }] }]);
    expect(parseInline("*a **b** c*")).toEqual([
      { type: "em", children: [text("a "), { type: "strong", children: [text("b")] }, text(" c")] },
    ]);
  });

  it("delimitadores soltos, snake_case e escapes ficam como texto", () => {
    expect(parseInline("2 * 3 = 6 e snake_case_id")).toEqual([text("2 * 3 = 6 e snake_case_id")]);
    expect(parseInline("**sem fim")).toEqual([text("**sem fim")]);
    expect(parseInline("\\*não\\* é itálico")).toEqual([text("*não* é itálico")]);
  });

  it("links só com http(s); o resto vira o texto do rótulo", () => {
    expect(parseInline("[site](https://exemplo.dev/a?b=1) e [mal](javascript:alert(1)) e [rel](../x.md)")).toEqual([
      { type: "link", href: "https://exemplo.dev/a?b=1", children: [text("site")] },
      text(" e "),
      text("mal"),
      text(") e "),
      text("rel"),
    ]);
    expect(parseInline("veja https://exemplo.dev/x.")).toEqual([
      text("veja "),
      { type: "link", href: "https://exemplo.dev/x", children: [text("https://exemplo.dev/x")] },
      text("."),
    ]);
  });

  it("wiki links com rótulo, seção e .md", () => {
    expect(parseInline("ver [[Preferências do usuário]] e [[notas/plano.md#Fase 2|o plano]]")).toEqual([
      text("ver "),
      { type: "wiki", target: "Preferências do usuário", label: "Preferências do usuário" },
      text(" e "),
      { type: "wiki", target: "notas/plano", label: "o plano" },
    ]);
    expect(parseInline("[[]] e [[sem fim")).toEqual([text("[[]] e [[sem fim")]);
  });
});

describe("auxiliares", () => {
  it("isSafeHref só aceita http(s)", () => {
    expect(isSafeHref("https://a.b")).toBe(true);
    expect(isSafeHref("HTTP://a.b")).toBe(true);
    for (const href of ["javascript:alert(1)", "data:text/html,x", "//a.b", "/api", "mailto:a@b"]) expect(isSafeHref(href)).toBe(false);
  });

  it("wikiTarget e inlineText", () => {
    expect(wikiTarget("Nota.md#Seção")).toBe("Nota");
    expect(wikiTarget("Nota^bloco")).toBe("Nota");
    expect(inlineText(parseInline("**a** `b` [[c|d]] [e](https://x.y)\nf"))).toBe("a b d e f");
  });
});

describe("plainText", () => {
  it("tira títulos, marcadores, ênfase e links e pula o título da primeira linha", () => {
    const md = [
      "## Resultado (simulado)",
      "",
      "**Pedido:** fazer o *post* do [blog](https://exemplo.com).",
      "",
      "### Entrega",
      "- Rascunho em `passos`.",
      "  1. Revisar [[Nota#Seção|a nota]].",
      "",
      "> Gerado pelo MockRunner.",
      "---",
    ].join("\n");
    expect(plainText(md)).toBe("Pedido: fazer o post do blog. Entrega Rascunho em passos. Revisar a nota. Gerado pelo MockRunner.");
  });

  it("pula uma primeira linha toda em negrito, mas não um título sozinho nem um parágrafo comum", () => {
    expect(plainText("**Resultado**\n\nTudo certo.")).toBe("Tudo certo.");
    expect(plainText("# Só o título")).toBe("Só o título");
    expect(plainText("Primeira linha\nsegunda linha")).toBe("Primeira linha segunda linha");
    expect(plainText("")).toBe("");
  });
});

describe("headingOutline", () => {
  it("lista só títulos até o nível 3, com âncora pelo índice do bloco", () => {
    const blocks = parseMarkdown("# A\n\ntexto\n\n## B **forte**\n\n#### fundo\n\n### C");
    expect(headingOutline(blocks, "n")).toEqual([
      { id: "n-h0", level: 1, text: "A" },
      { id: "n-h2", level: 2, text: "B forte" },
      { id: "n-h4", level: 3, text: "C" },
    ]);
    expect(headingId("n", 2)).toBe("n-h2");
  });
});
