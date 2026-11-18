/**
 * Tetos do Cérebro (em caracteres), todos aqui. O contexto de uma tarefa carrega só o que o time
 * precisa SEGUIR (regras e briefing, cada um com teto); as outras notas entram como lista de
 * títulos (o agente lê com `read_note`) e o histórico (`historico/`) só aparece por busca.
 */
export const BRAIN_LIMITS = {
  /** Teto do `_regras` e do `_briefing` do próprio quarto e do lobby. */
  fixed: { regras: 2000, briefing: 2000 },
  /** Teto das regras do próprio agente (`agents/<id>/regras.md`). */
  agentRules: 2000,
  /** Teto de cada nota de regra (cortada com um aviso para ler inteira). */
  ruleNote: 1500,
  /** Orçamento total das notas de regra (próprio quarto e depois lobby). */
  rulesTotal: 8000,
  /** Teto do `_briefing` de um quarto conectado ou, para o Maestro, de cada quarto. */
  peerFixed: 1200,
  /** Teto da visão geral dos quartos (soma dos briefings dos quartos conectados/gerenciados). */
  peersTotal: 12_000,
  /** Linhas da lista de títulos das outras notas (o resto vira "+N"). */
  titles: 30,
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
