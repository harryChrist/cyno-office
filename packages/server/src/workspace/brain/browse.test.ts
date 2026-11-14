import { describe, expect, it } from "vitest";
import { newestFirst, noteDate, noteExcerpt, noteTags, summarizeNote } from "./browse";
import { parseFrontmatter, renderFrontmatter } from "./frontmatter";

describe("parseFrontmatter", () => {
  it("lê de volta o que renderFrontmatter grava", () => {
    const fields = { task: 'aspas " e\nquebra', agent: "lia", team: "projetox-frontend", data: "2026-11-07T12:00:00.000Z", tags: ["a", "b, c"] };
    const { frontmatter, body } = parseFrontmatter(`${renderFrontmatter(fields)}\n# T\n`);
    expect(frontmatter).toEqual(fields);
    expect(body).toBe("\n# T\n");
  });

  it("aceita texto puro, aspas simples, listas em bloco e ignora objetos aninhados", () => {
    const content = [
      "---",
      "autor: Harry Potter",
      "titulo: 'it''s'",
      "tags:",
      "  - um",
      "  - \"dois\"",
      "meta:",
      "  nivel: 3",
      "# comentário",
      "agente: lia",
      "---",
      "corpo",
    ].join("\n");
    expect(parseFrontmatter(content)).toEqual({
      frontmatter: { autor: "Harry Potter", titulo: "it's", tags: ["um", "dois"], meta: [], agente: "lia" },
      body: "corpo",
    });
  });

  it("sem bloco ---: frontmatter vazio e o texto inteiro é o corpo", () => {
    expect(parseFrontmatter("# Só corpo\n---\nx: 1\n---\n")).toEqual({ frontmatter: {}, body: "# Só corpo\n---\nx: 1\n---\n" });
    expect(parseFrontmatter("---\n---\ncorpo")).toEqual({ frontmatter: {}, body: "corpo" });
  });
});

describe("resumo da nota", () => {
  it("data: frontmatter, depois nome datado, depois mtime", () => {
    const mtime = new Date("2020-05-05T05:05:05.000Z");
    expect(noteDate("x.md", { data: "2026-11-07T10:00:00.000Z" }, mtime)).toBe("2026-11-07T10:00:00.000Z");
    expect(noteDate("x.md", { date: "não é data" }, mtime)).toBe(mtime.toISOString());
    expect(noteDate("2026-11-07-090503-resumo.md", {}, mtime)).toBe(new Date(2026, 10, 7, 9, 5, 3).toISOString());
    expect(noteDate("2026-11-07-diario.md", {})).toBe(new Date(2026, 10, 7).toISOString());
    expect(noteDate("x.md", {})).toBeNull();
  });

  it("tags em lista ou texto, sem # e sem repetir", () => {
    expect(noteTags({ tags: ["#a", "b", "a"] })).toEqual(["a", "b"]);
    expect(noteTags({ tags: "a, #b c" })).toEqual(["a", "b", "c"]);
    expect(noteTags({ tag: "única" })).toEqual(["única"]);
    expect(noteTags({})).toEqual([]);
  });

  it("trecho sem o título, sem marcação e com até 160 caracteres", () => {
    const body = "# Título\n\n- **Agente:** Lia (Dev)\n- Ver [[Outra nota|a outra]] e [site](https://x.dev)\n\n```ts\nconst a = 1;\n```\n\n_fim_ de `tudo`";
    expect(noteExcerpt(body)).toBe("Agente: Lia (Dev) Ver a outra e site const a = 1; fim de tudo");
    const long = noteExcerpt(`# T\n\n${"palavra ".repeat(60)}`);
    expect(long.length).toBeLessThanOrEqual(160);
    expect(long.endsWith("…")).toBe(true);
    expect(noteExcerpt("snake_case_id fica")).toBe("snake_case_id fica");
  });

  it("summarizeNote junta tudo; newestFirst ordena do mais novo, sem data no fim", () => {
    const note = summarizeNote("n.md", '---\ndata: "2026-01-01T00:00:00.000Z"\ntags: [x]\n---\n# Nota\n\nTexto.');
    expect(note).toEqual({ file: "n.md", layer: "note", title: "Nota", date: "2026-01-01T00:00:00.000Z", tags: ["x"], excerpt: "Texto." });
    const old = { ...note, file: "a.md", date: "2025-01-01T00:00:00.000Z" };
    const none = { ...note, file: "z.md", date: null };
    expect([none, old, note].sort(newestFirst).map((item) => item.file)).toEqual(["n.md", "a.md", "z.md"]);
  });
});
