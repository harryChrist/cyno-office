/** Cérebro: notas .md de um quarto (ou do lobby/global) usadas como contexto dos agentes. */

/**
 * De onde veio cada fonte do contexto: as regras do próprio agente ("agent": só ele recebe), o
 * próprio quarto, o lobby (Cérebro global), um quarto conectado ou, só para a Sala do Maestro, cada
 * quarto do workspace ("managed").
 */
export type BrainSourceKind = "agent" | "self" | "lobby" | "connected" | "managed";

/**
 * Camadas do Cérebro (documentação viva do workspace):
 * - "fixed": `_regras.md`, `_indice.md` e `_briefing.md`;
 * - "note": notas curtas (decisões, docs, aprendizados);
 * - "history": resultados de tarefas e notas arquivadas em `historico/`.
 *
 * O que entra no contexto de uma tarefa é só o que o time precisa SEGUIR: as regras (o `_regras.md`,
 * as notas de regra e as regras do próprio agente) e o `_briefing`. As outras notas aparecem como
 * lista de títulos (o agente lê com `read_note` quando precisa) e o histórico só por busca. Veja
 * `brainShelf`.
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
  agent: "Só você",
  self: "Esta sala",
  lobby: "Lobby (Cérebro global)",
  connected: "Sala conectada",
  managed: "Sala do workspace",
};

/** Tag que faz de uma nota curta uma regra (sempre carregada no contexto de quem trabalha na sala). */
export const BRAIN_RULE_TAG = "regra";

/**
 * Prateleiras do Cérebro: "regra" = o time segue, entra em toda tarefa; "referencia" = como as
 * coisas funcionam, decisões, preferências (só o título entra; o texto, por `read_note`);
 * "registro" = o que foi feito (histórico: só por busca).
 */
export const BRAIN_SHELVES = ["regra", "referencia", "registro"] as const;
export type BrainShelf = (typeof BRAIN_SHELVES)[number];

export const BRAIN_SHELF_LABELS: Record<BrainShelf, string> = { regra: "Regras", referencia: "Referência", registro: "Histórico" };

/** Título que já diz que a nota é uma regra ("Regra: …"), como o Maestro costuma salvar. */
const RULE_TITLE = /^\s*regra\s*[:\-–—]/i;

/**
 * A nota curta é uma regra? Pela tag "regra" (ou "regras") ou pelo título "Regra: …" (as notas antigas do Maestro
 * não têm a tag). As fixas e o histórico nunca são.
 */
export function isBrainRuleNote(note: { layer?: BrainNoteLayer; tags: readonly string[]; title?: string }): boolean {
  if ((note.layer ?? "note") !== "note") return false;
  return note.tags.includes(BRAIN_RULE_TAG) || note.tags.includes(`${BRAIN_RULE_TAG}s`) || (note.title !== undefined && RULE_TITLE.test(note.title));
}

/** Em que prateleira a nota fica. O `_briefing` e o `_indice` contam como referência. */
export function brainShelf(note: { file: string; layer?: BrainNoteLayer; tags: readonly string[]; title?: string }): BrainShelf {
  const layer = note.layer ?? "note";
  if (layer === "history") return "registro";
  if (layer === "fixed") return note.file === BRAIN_FIXED_FILES.regras ? "regra" : "referencia";
  return isBrainRuleNote(note) ? "regra" : "referencia";
}

/**
 * Regras de um agente: texto curto em markdown que SÓ ele recebe, em toda tarefa (arquivo
 * `agents/<id>/regras.md`). O dono edita; o Maestro e o próprio agente acrescentam linhas.
 * GET e PUT /api/w/:ws/agents/:agentId/rules.
 */
export type AgentRulesResponse = { agentId: string; content: string; updatedAt: string | null };
export const agentRulesPath = (agentId: string) => `/agents/${encodeURIComponent(agentId)}/rules`;
/** PUT /api/w/:ws/brains/:brainId/rules: troca o texto do `_regras.md` (devolve a nota como o navegador lê). */
export const brainRulesPath = (brainId: string) => `/brains/${encodeURIComponent(brainId)}/rules`;
