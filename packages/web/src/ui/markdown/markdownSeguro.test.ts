import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown } from "./Markdown";

const render = (source: string, plainLinks = true) => renderToStaticMarkup(createElement(Markdown, { source, resolveWiki: () => null, plainLinks }));

/** Conteúdo de agente não vira elemento ativo: nada de HTML cru, script, evento nem link perigoso. */
describe("markdown de agente (casos de ataque)", () => {
  it("HTML cru vira texto escapado", () => {
    const html = render('<script>alert(1)</script> e <img src=x onerror="alert(1)"> e <iframe src="//x"></iframe>');
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<iframe");
    expect(html).toContain("&lt;script&gt;");
  });

  it("link javascript: não vira link (nem com maiúsculas)", () => {
    for (const href of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,x", "vbscript:x"]) {
      const html = render(`[clique](${href})`);
      expect(html).not.toMatch(/<a[\s>]/);
      expect(html.toLowerCase()).not.toContain('href="javascript');
    }
  });

  it("imagem em markdown não carrega nada", () => {
    const html = render("![x](https://exemplo.dev/a.png) e ![y](javascript:alert(1))");
    expect(html).not.toContain("<img");
  });

  it("no log de agente o link http vira texto com o endereço na dica, nada clicável", () => {
    const html = render("veja [o site](https://exemplo.dev/a)");
    expect(html).not.toMatch(/<a[\s>]/);
    expect(html).toContain('title="https://exemplo.dev/a"');
    expect(html).toContain("o site");
  });

  it("fora do log de agente (Cérebro) o link http segue clicável, com rel seguro", () => {
    const html = render("veja [o site](https://exemplo.dev/a)", false);
    expect(html).toContain('href="https://exemplo.dev/a"');
    expect(html).toContain("noopener");
  });

  it("tag dentro de código fica como texto", () => {
    const html = render('`<b onclick="x()">` e\n\n```html\n<a href="javascript:1" onmouseover="y()">z</a>\n```');
    expect(html).not.toMatch(/<a[\s>]/);
    expect(html).not.toMatch(/<b[\s>]/);
    expect(html).toContain("&lt;b onclick");
  });
});
