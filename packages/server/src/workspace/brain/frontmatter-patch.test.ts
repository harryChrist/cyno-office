import { describe, expect, it } from "vitest";
import { parseFrontmatter, patchFrontmatter, replaceBody } from "./frontmatter";

const NOTE = `---\ntipo: "doc"\ndata: "2026-10-01"\ntags: ["a", "b"]\n---\n\n# Título\n\nCorpo.\n`;

describe("patchFrontmatter / replaceBody", () => {
  it("mantém os campos e a ordem, troca valores e acrescenta no fim; o corpo fica igual", () => {
    const out = patchFrontmatter(NOTE, { tipo: "regra", tags: ["a", "b", "regra"], motivo: "organizar" });
    expect(out.split("\n").slice(0, 6)).toEqual(["---", 'tipo: "regra"', 'data: "2026-10-01"', 'tags: ["a", "b", "regra"]', 'motivo: "organizar"', "---"]);
    expect(parseFrontmatter(out).body).toBe(parseFrontmatter(NOTE).body);
  });

  it("`undefined` tira o campo e uma nota sem bloco ganha um", () => {
    expect(patchFrontmatter(NOTE, { data: undefined })).not.toContain("data:");
    const out = patchFrontmatter("# Solta\n\ntexto\n", { arquivado: "2026-11-18" });
    expect(parseFrontmatter(out)).toMatchObject({ frontmatter: { arquivado: "2026-11-18" }, body: "\n# Solta\n\ntexto\n" });
  });

  it("replaceBody troca só o corpo e acerta o frontmatter", () => {
    const out = replaceBody(NOTE, "# Título\n\nNovo.", { atualizado: "2026-11-18" });
    const parsed = parseFrontmatter(out);
    expect(parsed.frontmatter).toMatchObject({ tipo: "doc", tags: ["a", "b"], atualizado: "2026-11-18" });
    expect(parsed.body).toBe("\n# Título\n\nNovo.\n");
  });
});
