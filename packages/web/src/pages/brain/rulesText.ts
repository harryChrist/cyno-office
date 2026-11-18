/** O texto das regras como lista: uma abertura opcional (texto antes da lista) e as regras, uma por item. */
export type RulesDraft = { intro: string; rules: string[] };

const BULLET = /^\s{0,3}(?:[-*+]|\d+[.)])\s+(.*)$/;

/**
 * Lê o markdown das regras como lista. Devolve `null` quando o texto tem mais do que uma abertura
 * seguida de uma lista simples (títulos, parágrafos no meio, tabelas): aí só dá para editar como texto.
 */
export function parseRules(text: string): RulesDraft | null {
  const intro: string[] = [];
  const rules: string[] = [];
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    const bullet = BULLET.exec(line);
    if (bullet) {
      rules.push(bullet[1]!.trim());
      continue;
    }
    if (line.trim() === "") {
      if (rules.length === 0) intro.push("");
      continue;
    }
    if (rules.length === 0) {
      if (/^\s*(#{1,6}\s|\||```|~~~|>)/.test(line)) return null;
      intro.push(line.trimEnd());
      continue;
    }
    // Linha recuada depois de um item continua a regra; qualquer outra coisa não é uma lista simples.
    if (!/^\s+\S/.test(line)) return null;
    rules[rules.length - 1] = `${rules[rules.length - 1]} ${line.trim()}`;
  }
  return { intro: intro.join("\n").trim(), rules: rules.filter(Boolean) };
}

/** Uma regra numa linha só (quebras viram espaço), sem traço na frente. */
export function cleanRule(rule: string): string {
  return rule.replace(/\s+/g, " ").trim().replace(/^[-*+]\s+/, "");
}

/** A lista de volta em markdown: a abertura, uma linha em branco e um traço por regra (as vazias saem). */
export function renderRules(draft: RulesDraft): string {
  const rules = draft.rules.map(cleanRule).filter(Boolean);
  return [draft.intro.trim(), rules.map((rule) => `- ${rule}`).join("\n")].filter(Boolean).join("\n\n");
}

/** "Nenhuma regra", "1 regra", "3 regras". */
export function rulesCountLabel(rules: readonly string[]): string {
  const count = rules.map(cleanRule).filter(Boolean).length;
  return count === 0 ? "Nenhuma regra" : count === 1 ? "1 regra" : `${count} regras`;
}
