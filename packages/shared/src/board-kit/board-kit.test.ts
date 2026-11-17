import { describe, expect, it } from "vitest";
import { BOARD_CSP, BOARD_EXAMPLE_CATALOG_HTML, BOARD_EXAMPLE_STUDY_HTML, BOARD_GUIDE, BOARD_KIT_CSS, BOARD_KIT_JS, buildBoardDocument, exampleCatalogData, exampleStudyData, jsonForScript } from "./index";

const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);

describe("buildBoardDocument", () => {
  const doc = buildBoardDocument({ html: '<p id="x">oi</p>', data: { a: 1 }, meta: { id: "Q-0001", title: "Obras <b>" } });

  it("monta doctype, charset, viewport, CSP sem rede, CSS, JSON, JS do kit e o HTML do agente, nessa ordem", () => {
    expect(doc.startsWith("<!doctype html>")).toBe(true);
    const order = ['<meta charset="utf-8">', 'name="viewport"', "Content-Security-Policy", '<style id="quadro-kit">', 'id="quadro-data"', 'id="quadro-kit-js"', '<p id="x">oi</p>'].map((part) => doc.indexOf(part));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(doc).toContain(`content="${BOARD_CSP}"`);
    expect(BOARD_CSP).toContain("default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src https: data: blob:; font-src data:");
    expect(doc).toContain("<title>Obras &lt;b&gt;</title>");
    expect(doc).toContain(BOARD_KIT_CSS);
  });

  it("embute os dados e o meta num envelope JSON legível pelo kit", () => {
    const match = /<script id="quadro-data" type="application\/json">([\s\S]*?)<\/script>/.exec(doc);
    expect(JSON.parse(match![1]!)).toEqual({ data: { a: 1 }, meta: { id: "Q-0001", title: "Obras <b>" } });
  });

  it("escapa o JSON: </script>, <!--, & e U+2028/2029 dentro dos dados não fecham a tag nem quebram o parse", () => {
    const evil = { t: "</script><script>alert(1)</script><!-- & " + LS + " " + PS + " ]]>" };
    const out = buildBoardDocument({ html: "", data: evil });
    const match = /<script id="quadro-data" type="application\/json">([\s\S]*?)<\/script>/.exec(out)!;
    expect(match[1]).not.toMatch(new RegExp("[<>&" + LS + PS + "]"));
    expect(JSON.parse(match[1]!).data).toEqual(evil);
    expect(out.match(/<\/script>/g)?.length).toBe(2);
    expect(out.slice(0, out.indexOf('id="quadro-kit-js"'))).not.toContain("<script>alert");
  });

  it("jsonForScript trata undefined e valores estranhos", () => {
    expect(jsonForScript(undefined)).toBe("null");
    expect(jsonForScript({ a: [1, "<"] })).toBe('{"a":[1,"\\u003c"]}');
  });

  it("dados ausentes viram {} e o meta é opcional", () => {
    const out = buildBoardDocument({ html: "<i></i>", data: undefined });
    const match = /<script id="quadro-data" type="application\/json">([\s\S]*?)<\/script>/.exec(out)!;
    expect(JSON.parse(match[1]!)).toEqual({ data: {}, meta: {} });
  });
});

describe("kit", () => {
  it("o JS do kit não contém o fechamento de script nem abre comentário HTML (quebraria o documento)", () => {
    expect(BOARD_KIT_JS).not.toMatch(/<\/script/i);
    expect(BOARD_KIT_JS).not.toContain("<!--");
    expect(BOARD_KIT_CSS).not.toMatch(/<\/style/i);
  });

  it("o JS do kit é sintaticamente válido e expõe a API", () => {
    expect(() => new Function(BOARD_KIT_JS)).not.toThrow();
    for (const api of ["onData", "table", "chart", "fmt", "esc", "rows", "get", "stat", "badge", "progress", "ready", "quadro:data", "quadro:ready"]) expect(BOARD_KIT_JS).toContain(api);
  });

  it("o guia é em inglês, cabe em ~150 linhas e traz os dois exemplos", () => {
    expect(BOARD_GUIDE.split("\n").length).toBeLessThanOrEqual(150);
    expect(BOARD_GUIDE).toContain(BOARD_EXAMPLE_CATALOG_HTML);
    expect(BOARD_GUIDE).toContain(BOARD_EXAMPLE_STUDY_HTML);
    for (const name of ["board_save", "board_set_data", "board_patch_data", "board_read_data", "Quadro.table", "Quadro.onData"]) expect(BOARD_GUIDE).toContain(name);
    expect(BOARD_GUIDE).not.toMatch(/—|→/);
  });

  it("dados de exemplo: 300 obras por id e estudos com datas", () => {
    const catalog = exampleCatalogData(300);
    expect(Object.keys(catalog.works)).toHaveLength(300);
    expect(exampleCatalogData(5)).toEqual(exampleCatalogData(5));
    expect((exampleStudyData().milestones as unknown[]).length).toBeGreaterThan(3);
  });
});
