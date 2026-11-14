/** Cores da paleta dos tipos (--ui-tc-N) usadas nas iniciais dos workspaces (sem o cinza). */
const INITIAL_COLORS = [1, 2, 3, 4, 5, 6, 7, 8] as const;

/** Cor do workspace (a da inicial no seletor): mesma cor para o mesmo nome. */
export function workspaceColor(name: string): string {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return `var(--ui-tc-${INITIAL_COLORS[hash % INITIAL_COLORS.length]})`;
}
