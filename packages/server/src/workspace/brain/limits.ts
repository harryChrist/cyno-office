/**
 * Tetos do Cérebro (em caracteres), todos aqui. O contexto de uma tarefa tem tamanho limitado por
 * construção: fixos (com teto cada) + notas curtas escolhidas por relevância até o orçamento total +
 * a lista de títulos do que ficou de fora. O histórico (`historico/`) nunca entra sozinho.
 */
export const BRAIN_LIMITS = {
  /** Teto de cada arquivo fixo do próprio quarto e do lobby. */
  fixed: { regras: 2000, indice: 3000, briefing: 2000 },
  /** Teto de cada fixo (`_briefing`, `_indice`) de um quarto conectado ou, para o Maestro, de cada quarto. */
  peerFixed: 1200,
  /** Teto da visão geral dos quartos (soma dos fixos dos quartos conectados/gerenciados). */
  peersTotal: 12_000,
  /** Teto de cada nota curta no contexto (cortada com um aviso para ler inteira). */
  note: 1800,
  /** Orçamento total das notas curtas no contexto (os fixos não contam aqui). */
  notesTotal: 12_000,
  /** Títulos listados em "também existem" (o resto vira "+N"). */
  omittedTitles: 40,
  /** `read_note`: teto do texto devolvido. */
  readNote: 16_000,
  /** `save_note`: tamanho máximo do conteúdo de uma nota curta. */
  saveNote: 6000,
  /** `save_note` em `_indice` / `_briefing` / `_regras` (um pouco maior que o teto do contexto). */
  saveFixed: 4000,
  /** `search_notes`: resultados padrão e máximo; tamanho do trecho de cada um. */
  searchDefault: 8,
  searchMax: 20,
  snippet: 240,
} as const;

/** Diário do agente (o que ele fez nas últimas tarefas, no topo de cada tarefa nova). */
export const DIARY_LIMITS = {
  /** Entradas mostradas na mensagem da tarefa. */
  recent: 5,
  /** Teto do bloco "O que você fez recentemente". */
  recentChars: 1500,
  /** Tamanho de cada entrada (1–3 linhas). */
  entryChars: 280,
  /** Entradas guardadas no arquivo (as mais antigas saem). */
  keep: 60,
} as const;
