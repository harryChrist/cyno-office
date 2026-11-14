/** Navegador do Cérebro (página "Cérebro"): os Cérebros de um workspace e as suas notas. */

import type { BrainNoteLayer } from "./brain";

/** "lobby" = Cérebro global; os outros vêm do `kind` do quarto. */
export type BrainKind = "lobby" | "maestro" | "team";

/** Valores do frontmatter YAML de uma nota (só escalares e listas de texto). */
export type BrainFrontmatter = Record<string, string | string[]>;

/** Resumo de uma nota na lista. */
export type BrainNoteSummary = {
  /** Nome do arquivo .md dentro da pasta do Cérebro (no histórico: "historico/<arquivo>.md"). */
  file: string;
  /** Fixa (`_regras`, `_indice`, `_briefing`), nota curta ou histórico. */
  layer: BrainNoteLayer;
  title: string;
  /**
   * Data ISO: do frontmatter (`data`/`date`), senão do nome do arquivo datado, senão da última
   * modificação do arquivo. null se nada disso existir.
   */
  date: string | null;
  tags: string[];
  /** Começo do texto (sem frontmatter, título e marcação), com até ~160 caracteres. */
  excerpt: string;
};

export type BrainSummary = {
  /** "global" (lobby) ou o id do quarto. */
  id: string;
  kind: BrainKind;
  /** "Lobby" ou o nome do quarto. */
  name: string;
  /** Fixas primeiro (regras, índice, briefing), depois notas e histórico, mais recentes primeiro. */
  notes: BrainNoteSummary[];
};

/** GET /api/w/:ws/brains: lobby, Sala do Maestro e os quartos, nesta ordem. */
export type ListBrainsResponse = BrainSummary[];

/** GET /api/w/:ws/brains/:brainId/notes/:file */
export type BrainNoteResponse = {
  file: string;
  title: string;
  frontmatter: BrainFrontmatter;
  /** Markdown da nota sem o bloco de frontmatter. */
  body: string;
};

/** Tamanho máximo do trecho das notas na lista. */
export const BRAIN_EXCERPT_LENGTH = 160;

/** Nome do Cérebro global na UI. */
export const LOBBY_BRAIN_NAME = "Lobby";
