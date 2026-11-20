import { describe, expect, it } from "vitest";
import { canHighlight, fileTone, HIGHLIGHT_MAX_CHARS, highlightRuns, htmlToRuns, languageOf } from "./highlight";

describe("linguagem pelo nome do arquivo", () => {
  it("reconhece pela extensão, sem ligar para maiúsculas", () => {
    expect(languageOf("baixar.mjs")).toBe("javascript");
    expect(languageOf("App.TSX")).toBe("typescript");
    expect(languageOf("rodar.py")).toBe("python");
    expect(languageOf("pagina.html")).toBe("xml");
    expect(languageOf("config.toml")).toBe("ini");
    expect(languageOf("notas.md")).toBe("markdown");
    expect(languageOf("linhas.jsonl")).toBe("json");
  });

  it("reconhece arquivos conhecidos pelo nome inteiro", () => {
    expect(languageOf("Dockerfile")).toBe("dockerfile");
    expect(languageOf("Dockerfile.dev")).toBe("dockerfile");
    expect(languageOf("Makefile")).toBe("makefile");
    expect(languageOf(".env.example")).toBe("ini");
    expect(languageOf(".bashrc")).toBe("bash");
  });

  it("texto comum, log e tipo desconhecido ficam sem linguagem", () => {
    expect(languageOf("saida.log")).toBeNull();
    expect(languageOf("leia.txt")).toBeNull();
    expect(languageOf("sem-extensao")).toBeNull();
  });

  it("só colore tipo conhecido, com texto, até o tamanho limite", () => {
    expect(canHighlight("a.ts", "const a = 1;")).toBe(true);
    expect(canHighlight("a.ts", "")).toBe(false);
    expect(canHighlight("a.log", "linha")).toBe(false);
    expect(canHighlight("a.ts", "x".repeat(HIGHLIGHT_MAX_CHARS + 1))).toBe(false);
  });
});

describe("saída do realçador em trechos", () => {
  it("separa por cor e devolve os caracteres escapados ao normal", () => {
    expect(htmlToRuns('<span class="hljs-keyword">const</span> a = <span class="hljs-string">&quot;x &lt; y &amp;&amp; z&quot;</span>;')).toEqual([
      { text: "const", kind: "keyword" },
      { text: " a = " },
      { text: '"x < y && z"', kind: "string" },
      { text: ";" },
    ]);
  });

  it("no trecho dentro de trecho vale a cor de dentro; sem cor própria, herda a de fora", () => {
    expect(htmlToRuns('<span class="hljs-string">`a ${<span class="hljs-subst">b</span>} c`</span>')).toEqual([
      { text: "`a ${", kind: "string" },
      { text: "b", kind: "escape" },
      { text: "} c`", kind: "string" },
    ]);
    expect(htmlToRuns('<span class="hljs-comment">antes <span class="language-xml">meio</span> depois</span>')).toEqual([{ text: "antes meio depois", kind: "comment" }]);
  });

  it("nome de função e nome de classe têm cores diferentes", () => {
    expect(htmlToRuns('<span class="hljs-title function_">rodar</span>')[0]?.kind).toBe("function");
    expect(htmlToRuns('<span class="hljs-title class_">Fila</span>')[0]?.kind).toBe("type");
  });

  it("o texto somado dos trechos é o texto original", () => {
    const html = 'a &lt; b <span class="hljs-number">1</span>\n<span class="hljs-comment">// fim</span>\n';
    expect(htmlToRuns(html).map((run) => run.text).join("")).toBe("a < b 1\n// fim\n");
  });
});

describe("colorir de verdade", () => {
  it("TypeScript: palavra-chave, texto, número e comentário ganham cor, e nada do texto se perde", async () => {
    const source = '// soma\nexport function soma(a: number): string {\n  const total = a + 42;\n  return `total: ${total}`;\n}\n';
    const runs = await highlightRuns("soma.ts", source);
    expect(runs).not.toBeNull();
    expect(runs!.map((run) => run.text).join("")).toBe(source);
    const kindOf = (text: string) => runs!.find((run) => run.text === text)?.kind;
    expect(kindOf("// soma")).toBe("comment");
    expect(kindOf("export")).toBe("keyword");
    expect(kindOf("soma")).toBe("function");
    expect(kindOf("42")).toBe("number");
  });

  it("texto com sinais de HTML continua igual depois de colorido", async () => {
    const source = 'if (a < b && c > d) { console.log("<b>&amp;</b>"); }\n';
    const runs = await highlightRuns("teste.js", source);
    expect(runs!.map((run) => run.text).join("")).toBe(source);
  });

  it("linguagens fora do pacote comum também funcionam", async () => {
    const runs = await highlightRuns("Dockerfile", "FROM node:22\nRUN npm ci\n");
    expect(runs!.find((run) => run.text === "FROM")?.kind).toBe("keyword");
  });

  it("sem linguagem conhecida devolve nada (a tela mostra o texto simples)", async () => {
    expect(await highlightRuns("saida.log", "linha 1\n")).toBeNull();
  });
});

describe("cor do ícone pela família", () => {
  it("separa código, dados, texto, página, estilo, comando e imagem", () => {
    expect(fileTone("app.ts")).toBe("code");
    expect(fileTone("dados.json")).toBe("data");
    expect(fileTone("tabela.csv")).toBe("data");
    expect(fileTone("notas.md")).toBe("doc");
    expect(fileTone("index.html")).toBe("web");
    expect(fileTone("tela.css")).toBe("style");
    expect(fileTone("rodar.sh")).toBe("shell");
    expect(fileTone("capa.png")).toBe("image");
  });

  it("tipo desconhecido fica na cor neutra", () => {
    expect(fileTone("dados.bin")).toBeUndefined();
    expect(fileTone("saida.log")).toBeUndefined();
  });
});
