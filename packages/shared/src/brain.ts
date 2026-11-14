/** Cérebro: notas .md de um quarto (ou do lobby/global) usadas como contexto dos agentes. */

/**
 * De onde veio cada fonte do contexto: o próprio quarto, o lobby (Cérebro global), um quarto
 * conectado ou, só para a Sala do Maestro, cada quarto do workspace ("managed").
 */
export type BrainSourceKind = "self" | "lobby" | "connected" | "managed";

/**
 * Camadas do Cérebro (documentação viva do workspace):
 * - "fixed": `_regras.md`, `_indice.md` e `_briefing.md` (sempre no contexto, com teto);
 * - "note": notas curtas (decisões, docs, aprendizados), escolhidas por relevância até o orçamento;
 * - "history": resultados de tarefas e diários em `historico/` (nunca entram sozinhos; só por busca).
 */
export type BrainNoteLayer = "fixed" | "note" | "history";

/** Arquivos fixos de cada Cérebro (o "_" põe no topo da pasta e deixa claro que são especiais). */
export const BRAIN_FIXED_FILES = { regras: "_regras.md", indice: "_indice.md", briefing: "_briefing.md" } as const;

/** Subpasta do histórico (resultados de tarefa datados) dentro da pasta de cada Cérebro. */
export const BRAIN_HISTORY_DIR = "historico";

export type BrainNote = {
  /** Nome do arquivo .md dentro da pasta do Cérebro (no histórico: "historico/<arquivo>.md"). */
  file: string;
  title: string;
  content: string;
  /** Camada (ausente = "note"). */
  layer?: BrainNoteLayer;
  /** O conteúdo entrou cortado no contexto (a nota inteira está em `read_note`). */
  truncated?: boolean;
};

/** Nota que não coube no contexto (o agente pode buscá-la pelo caminho). */
export type BrainOmittedNote = { file: string; title: string };

export type BrainContextSource = {
  kind: BrainSourceKind;
  /** Id do quarto; para o lobby é GLOBAL_BRAIN_ID ("global"). */
  id: string;
  name: string;
  /** O que entrou no contexto: os fixos primeiro, depois as notas escolhidas. */
  notes: BrainNote[];
  /** Notas visíveis que ficaram de fora (orçamento, ou fonte que só manda os fixos). */
  omitted?: BrainOmittedNote[];
};

/** Números do contexto montado (para o painel e os testes). */
export type BrainContextStats = { chars: number; included: number; omitted: number };

/**
 * Contexto que um agente recebe ao trabalhar num quarto (GET /api/w/:ws/rooms/:id/context).
 * Fontes, nesta ordem: o próprio quarto (sempre), o Cérebro global (só se o quarto lê o lobby)
 * e cada quarto diretamente conectado. Nunca inclui quartos não conectados (não é transitivo).
 * Exceção: a Sala do Maestro vê todos os quartos do workspace ("managed"), mas só o `_briefing`
 * e o `_indice` de cada um. Nunca entra nada de outro workspace. `text` é o mesmo conteúdo em
 * markdown, pronto para um prompt (com teto: veja brain/limits.ts no server).
 */
export type BrainContext = {
  roomId: string;
  sources: BrainContextSource[];
  text: string;
  stats?: BrainContextStats;
};

export const BRAIN_SOURCE_LABELS: Record<BrainSourceKind, string> = {
  self: "Esta sala",
  lobby: "Lobby (Cérebro global)",
  connected: "Sala conectada",
  managed: "Sala do workspace",
};
