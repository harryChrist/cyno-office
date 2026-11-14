import { describe, expect, it } from "vitest";
import { parseSkillMarkdown, selftestSkillMarkdown, skillBigNote, skillBodyWarning, skillBudgetWarnings, skillMarkdownTemplate, skillSizeLabel, SKILL_LIMITS, SELFTEST_SKILL_ID } from "./library-skills";

describe("SKILL.md", () => {
  it("lê name e description (simples, entre aspas, bloco dobrado e literal)", () => {
    const simple = parseSkillMarkdown("---\nname: pdf\ndescription: Use quando o assunto for PDF.\n---\ncorpo\nlinha");
    expect(simple.errors).toEqual([]);
    expect(simple.frontmatter).toMatchObject({ name: "pdf", description: "Use quando o assunto for PDF." });
    expect(simple.body).toBe("corpo\nlinha");
    const quoted = parseSkillMarkdown('---\nname: "A: B"\ndescription: "diz \\"oi\\""\n---\n');
    expect(quoted.frontmatter).toMatchObject({ name: "A: B", description: 'diz "oi"' });
    const folded = parseSkillMarkdown("---\nname: x\ndescription: >-\n  primeira\n  segunda\n\n  terceira\nallowed-tools: Read\n---\n");
    expect(folded.frontmatter!.description).toBe("primeira segunda terceira");
    expect(folded.frontmatter!.fields["allowed-tools"]).toBe("Read");
    const literal = parseSkillMarkdown("---\nname: x\ndescription: |\n  linha 1\n  linha 2\n---\n");
    expect(literal.frontmatter!.description).toBe("linha 1\nlinha 2");
    const crlf = parseSkillMarkdown("---\r\nname: x\r\ndescription: ok ok ok ok\r\n---\r\ncorpo");
    expect(crlf.frontmatter).toMatchObject({ name: "x", description: "ok ok ok ok" });
  });

  it("aponta o que falta", () => {
    expect(parseSkillMarkdown("nada").errors[0]).toMatch(/frontmatter/);
    expect(parseSkillMarkdown("---\nname: x\n---\n").errors.join(" ")).toMatch(/description/);
    expect(parseSkillMarkdown(`---\nname: x\ndescription: ${"d".repeat(1025)}\n---\n`).errors.join(" ")).toMatch(/1024/);
  });

  it("o modelo e a skill de autoteste voltam a ser lidos sem erro", () => {
    const template = skillMarkdownTemplate("Minha skill: teste", "Use quando algo.", "corpo\n");
    expect(parseSkillMarkdown(template).frontmatter).toMatchObject({ name: "Minha skill: teste", description: "Use quando algo." });
    const selftest = parseSkillMarkdown(selftestSkillMarkdown("PIZZA-123"));
    expect(selftest.errors).toEqual([]);
    expect(selftest.frontmatter!.name).toBe(SELFTEST_SKILL_ID);
    expect(selftest.body).toContain("PIZZA-123");
    // A frase secreta só aparece no corpo, nunca na descrição (que vai para o índice do prompt).
    expect(selftest.frontmatter!.description).not.toContain("PIZZA-123");
  });

  it("avisos de limite por agente: mais de 12 skills ou índice acima de 6 mil tokens", () => {
    const skills = (count: number, tokens: number) => Array.from({ length: count }, () => ({ indexTokens: tokens }));
    expect(skillBudgetWarnings(skills(12, 50))).toEqual([]);
    expect(skillBudgetWarnings(skills(13, 50))[0]).toMatch(/Mais de 12/);
    expect(skillBudgetWarnings(skills(7, 1000))[0]).toMatch(/6000 tokens/);
    expect(SKILL_LIMITS.maxPerAgent).toBe(12);
  });
});

describe("skills grandes: avisos e teto", () => {
  it("o teto técnico é alto e o tamanho comum não gera aviso", () => {
    expect(SKILL_LIMITS.maxBytes).toBe(100 * 1024 * 1024);
    expect(SKILL_LIMITS.maxFiles).toBe(5000);
    expect(skillBigNote(449 * 1024, 29)).toBeNull();
    expect(skillBigNote(2 * 1024 * 1024, 29)).toBe("grande: 2,0 MB em 29 arquivos");
    expect(skillBigNote(10 * 1024, 250)).toMatch(/250 arquivos/);
    expect(skillSizeLabel(449 * 1024)).toBe("449 KB");
    expect(skillBodyWarning(8000)).toBeNull();
    expect(skillBodyWarning(9000)).toMatch(/~9000 tokens entram no contexto do agente/);
  });
});
