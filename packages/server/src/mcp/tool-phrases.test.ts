import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describeWork, OFFICE_TOOL_PHRASES } from "@cyno/shared";
import { describe, expect, it } from "vitest";

/**
 * Toda ferramenta MCP do escritório registrada neste servidor precisa ter frase (ícone, gerúndio,
 * passado e rótulo curto) na tabela do `shared`. O teste lê o código-fonte de `src/mcp/` (todo
 * `name: "..."` de `defineTool`, mais os apelidos antigos, `withAlias` e `listed: false`), então uma ferramenta nova sem
 * frase faz ele falhar.
 */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path] : [];
  });
}

function registeredToolNames(): string[] {
  const names = new Set<string>();
  for (const file of sourceFiles(__dirname)) {
    const text = readFileSync(file, "utf8");
    // `name: "snake_case",` com a descrição ao lado: é o `defineTool`/ferramenta literal.
    for (const match of text.matchAll(/\bname:\s*"([a-z][a-z0-9_]*)",?\s*\n?\s*(?:description|input)/g)) names.add(match[1]!);
    for (const match of text.matchAll(/name:\s*"([a-z_]+)",\s*listed:\s*false/g)) names.add(match[1]!);
    for (const match of text.matchAll(/withAlias\([^,]+,\s*"([a-z_]+)"\)/g)) names.add(match[1]!);
  }
  return [...names].sort();
}

describe("frases das ferramentas do escritório", () => {
  const names = registeredToolNames();

  it("acha as ferramentas registradas (não é um teste vazio)", () => {
    expect(names.length).toBeGreaterThan(100);
    for (const known of ["request_approval", "submit_result", "send_to_colleague", "request_help", "save_note", "media_render_html", "browser_open", "agenda_book", "routine_propose", "create_plan"]) {
      expect(names, known).toContain(known);
    }
  });

  it.each(names)("%s tem frase, ícone e passado", (tool) => {
    const phrase = OFFICE_TOOL_PHRASES[tool];
    expect(phrase, `falta a frase de ${tool} em packages/shared/src/work-phrase.ts`).toBeDefined();
    const described = describeWork(`mcp__office__${tool}`, {});
    expect(described.icon).not.toBe("🛠️");
    expect(described.text.length).toBeLessThanOrEqual(46);
  });

  it("a tabela não guarda ferramenta que não existe mais", () => {
    const orphans = Object.keys(OFFICE_TOOL_PHRASES).filter((tool) => !names.includes(tool));
    expect(orphans).toEqual([]);
  });
});
