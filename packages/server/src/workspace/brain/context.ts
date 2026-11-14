import {
  BRAIN_FIXED_FILES,
  BRAIN_SOURCE_LABELS,
  GLOBAL_BRAIN_ID,
  type BrainContext,
  type BrainContextSource,
  type BrainNote,
  type BrainOmittedNote,
  type Room,
} from "@cyno/shared";
import { HttpError } from "../../platform/http/errors";
import { noteTags } from "./browse";
import { parseFrontmatter, stripFrontmatter } from "./frontmatter";
import { BRAIN_LIMITS } from "./limits";
import type { StoredNote } from "./notes";
import { relevance, terms } from "./relevance";

export type ContextDeps = {
  rooms: () => Room[];
  /** Notas da raiz da pasta do Cérebro (fixas e curtas; o histórico nunca entra aqui). */
  readNotes: (brainId: string) => Promise<StoredNote[]>;
  now?: () => Date;
};

export const GLOBAL_BRAIN_NAME = "Cérebro global";

export type VisibleSource = Omit<BrainContextSource, "notes" | "omitted">;

/**
 * Regras de visibilidade (o coração do isolamento entre quartos). Vêm só da configuração
 * "Cérebro" do quarto, nunca das portas (que são automáticas e só servem para andar):
 * - o próprio quarto, sempre;
 * - o Cérebro global se e somente se `readsGlobalBrain`;
 * - cada quarto listado em `readsBrainsOf` que ainda existe (não é transitivo: o que esses
 *   quartos leem NÃO entra);
 * - exceção: a Sala do Maestro vê todos os outros quartos do workspace ("managed"), porque o
 *   Maestro conhece todo mundo.
 * Nenhuma outra pasta é lida, e `all` só tem quartos deste workspace (o Brain é por workspace),
 * então nada de outro workspace entra nunca. As ferramentas MCP do Cérebro usam as mesmas regras.
 */
export function visibleSources(room: Room, all: Room[]): VisibleSource[] {
  const sources: VisibleSource[] = [{ kind: "self", id: room.id, name: room.name }];
  if (room.readsGlobalBrain) sources.push({ kind: "lobby", id: GLOBAL_BRAIN_ID, name: GLOBAL_BRAIN_NAME });
  if (room.kind === "maestro") {
    for (const other of all) {
      if (other.id !== room.id) sources.push({ kind: "managed", id: other.id, name: other.name });
    }
    return sources;
  }
  const byId = new Map(all.map((ws) => [ws.id, ws]));
  for (const id of new Set(room.readsBrainsOf)) {
    const neighbor = byId.get(id);
    if (neighbor && neighbor.id !== room.id) {
      sources.push({ kind: "connected", id: neighbor.id, name: neighbor.name });
    }
  }
  return sources;
}

/** Caminho que o agente usa para pedir a nota (`read_note`): "<cérebro>/<arquivo>". */
export const notePath = (brainId: string, file: string) => `${brainId}/${file}`;

/** Corta um texto no teto, com o aviso de onde ler inteiro. */
function capText(text: string, max: number, path: string): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return { text: `${text.slice(0, max).trimEnd()}\n\n[… nota cortada; inteira com read_note("${path}")]`, truncated: true };
}

/** Corpo da nota para o contexto: sem frontmatter (economiza caracteres), com teto. */
function contextNote(brainId: string, note: StoredNote, max: number): BrainNote {
  const body = stripFrontmatter(note.content).trim();
  const capped = capText(body, max, notePath(brainId, note.file));
  return { file: note.file, title: note.title, content: capped.text, layer: note.layer, ...(capped.truncated ? { truncated: true } : {}) };
}

/** Ordem dos fixos no contexto: regras, briefing, índice. */
const FIXED_ORDER = [BRAIN_FIXED_FILES.regras, BRAIN_FIXED_FILES.briefing, BRAIN_FIXED_FILES.indice] as const;
const FIXED_CAP: Record<string, number> = {
  [BRAIN_FIXED_FILES.regras]: BRAIN_LIMITS.fixed.regras,
  [BRAIN_FIXED_FILES.briefing]: BRAIN_LIMITS.fixed.briefing,
  [BRAIN_FIXED_FILES.indice]: BRAIN_LIMITS.fixed.indice,
};
/** Fontes "de fora" (quartos conectados e, para o Maestro, todos): só briefing e índice. */
const PEER_FIXED = [BRAIN_FIXED_FILES.briefing, BRAIN_FIXED_FILES.indice] as const;
/** Pequena preferência pela origem quando a relevância empata: o próprio quarto, depois o lobby. */
const SOURCE_BONUS: Record<BrainContextSource["kind"], number> = { self: 0.3, lobby: 0.15, connected: 0, managed: 0 };

/** Empurrão das notas com a tag "regra" (as regras aprovadas pelo dono na retrospectiva). */
const RULE_BONUS = 2;

type Loaded = VisibleSource & { stored: StoredNote[] };
type Candidate = { source: Loaded; note: StoredNote; score: number };

/**
 * Monta o contexto que um agente recebe ao trabalhar em `roomId`, com tamanho limitado:
 * 1. fixos: `_regras`, `_briefing` e `_indice` do próprio quarto e do lobby (cada um com teto);
 *    dos quartos conectados (e, para o Maestro, de todos os quartos) só `_briefing` e `_indice`,
 *    com teto menor e um teto total;
 * 2. notas curtas do próprio quarto, do lobby e dos conectados, por relevância ao `query` (o texto
 *    da tarefa; sem ele, as mais recentes), cada uma com teto, até o orçamento total;
 * 3. o que não coube vira uma lista de títulos com o caminho (o agente lê com `read_note`).
 * O Maestro não recebe as notas curtas dos quartos (só os fixos deles): ele busca quando precisa.
 */
export async function buildContext(deps: ContextDeps, roomId: string, query = ""): Promise<BrainContext> {
  const all = deps.rooms();
  const room = all.find((ws) => ws.id === roomId);
  if (!room) throw new HttpError(404, `Sala "${roomId}" não encontrada`);
  const nowMs = (deps.now?.() ?? new Date()).getTime();
  const loaded: Loaded[] = await Promise.all(visibleSources(room, all).map(async (source) => ({ ...source, stored: await deps.readNotes(source.id) })));

  const included = new Map<Loaded, BrainNote[]>(loaded.map((source) => [source, []]));
  const omitted = new Map<Loaded, BrainOmittedNote[]>(loaded.map((source) => [source, []]));

  // 1. Fixos.
  let peersLeft: number = BRAIN_LIMITS.peersTotal;
  for (const source of loaded) {
    const own = source.kind === "self" || source.kind === "lobby";
    for (const file of own ? FIXED_ORDER : PEER_FIXED) {
      const note = source.stored.find((candidate) => candidate.file === file);
      if (!note) continue;
      if (own) {
        included.get(source)!.push(contextNote(source.id, note, FIXED_CAP[file]!));
        continue;
      }
      const rendered = contextNote(source.id, note, BRAIN_LIMITS.peerFixed);
      if (rendered.content.length > peersLeft) {
        omitted.get(source)!.push({ file: note.file, title: note.title });
        continue;
      }
      peersLeft -= rendered.content.length;
      included.get(source)!.push(rendered);
    }
  }

  // 2. Notas curtas por relevância, até o orçamento.
  const queryTerms = terms(query);
  const candidates: Candidate[] = [];
  for (const source of loaded) {
    for (const note of source.stored) {
      if (note.layer !== "note") continue;
      if (source.kind === "managed") continue;
      const { frontmatter, body } = parseFrontmatter(note.content);
      const tags = noteTags(frontmatter);
      // Uma regra aprovada na retrospectiva (tag "regra") passa na frente das outras notas curtas: é o que o dono mandou valer.
      const score = relevance(queryTerms, { title: note.title, file: note.file, tags, body, mtimeMs: note.mtimeMs }, nowMs) + SOURCE_BONUS[source.kind] + (tags.includes("regra") ? RULE_BONUS : 0);
      candidates.push({ source, note, score });
    }
  }
  candidates.sort((a, b) => b.score - a.score || b.note.mtimeMs - a.note.mtimeMs || a.note.file.localeCompare(b.note.file));
  let budget: number = BRAIN_LIMITS.notesTotal;
  for (const { source, note } of candidates) {
    const rendered = contextNote(source.id, note, BRAIN_LIMITS.note);
    if (rendered.content.length > budget) {
      omitted.get(source)!.push({ file: note.file, title: note.title });
      continue;
    }
    budget -= rendered.content.length;
    included.get(source)!.push(rendered);
  }

  const sources: BrainContextSource[] = loaded.map((source) => {
    const left = omitted.get(source)!;
    return { kind: source.kind, id: source.id, name: source.name, notes: included.get(source)!, ...(left.length > 0 ? { omitted: left } : {}) };
  });
  const text = renderContextText(room, sources);
  const includedCount = sources.reduce((sum, source) => sum + source.notes.length, 0);
  const omittedCount = sources.reduce((sum, source) => sum + (source.omitted?.length ?? 0), 0);
  return { roomId, sources, text, stats: { chars: text.length, included: includedCount, omitted: omittedCount } };
}

const FIXED_LABELS: Record<string, string> = {
  [BRAIN_FIXED_FILES.regras]: "Regras",
  [BRAIN_FIXED_FILES.briefing]: "Briefing",
  [BRAIN_FIXED_FILES.indice]: "Índice",
};

function renderSource(source: BrainContextSource): string {
  const header = `## ${BRAIN_SOURCE_LABELS[source.kind]}: ${source.name} (\`${source.id}\`)`;
  if (source.notes.length === 0) return `${header}\n\n_(nada no contexto${source.omitted?.length ? "; veja \"Também existem\"" : ""})_`;
  const notes = source.notes.map((note) => {
    const label = note.layer === "fixed" ? `${FIXED_LABELS[note.file] ?? note.title}` : note.title;
    return `### ${label} (\`${notePath(source.id, note.file)}\`)\n\n${note.content.trim()}`;
  });
  return [header, ...notes].join("\n\n");
}

/** "Também existem": as notas visíveis que não couberam (título + caminho), com teto de linhas. */
function renderOmitted(sources: BrainContextSource[]): string {
  const all = sources.flatMap((source) => (source.omitted ?? []).map((note) => `- ${note.title} — \`${notePath(source.id, note.file)}\``));
  if (all.length === 0) return "";
  const shown = all.slice(0, BRAIN_LIMITS.omittedTitles);
  const more = all.length - shown.length;
  return ["## Também existem (leia com `read_note(path)` se precisar)", ...shown, ...(more > 0 ? [`- … e mais ${more} (use \`search_notes\`)`] : [])].join("\n");
}

export function renderContextText(room: Room, sources: BrainContextSource[]): string {
  const hint =
    room.kind === "maestro"
      ? "_Das salas entram só o briefing e o índice. Notas, decisões e o histórico de tarefas: `search_notes` / `read_note`._"
      : "_O histórico de tarefas não entra aqui: use `search_notes` / `read_note` quando precisar._";
  return [`# Contexto do Cérebro para a sala ${room.name}`, hint, ...sources.map(renderSource), renderOmitted(sources)].filter(Boolean).join("\n\n") + "\n";
}
