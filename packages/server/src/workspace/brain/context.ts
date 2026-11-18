import {
  BRAIN_FIXED_FILES,
  BRAIN_SOURCE_LABELS,
  GLOBAL_BRAIN_ID,
  isBrainRuleNote,
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
  /** Regras do próprio agente (`agents/<id>/regras.md`); ausente ou vazio = nenhuma. */
  readAgentRules?: (agentId: string) => Promise<string>;
  now?: () => Date;
};

/** O agente que vai trabalhar (só ele recebe as regras dele). */
export type ContextAgent = { id: string; name: string };

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

/**
 * Corpo da nota para o contexto: sem frontmatter e sem o título do começo (ele já vai no cabeçalho
 * da nota no contexto; repetir só gasta caracteres), com teto.
 */
function contextNote(brainId: string, note: StoredNote, max: number): BrainNote {
  const body = stripFrontmatter(note.content).trim().replace(/^#\s+[^\n]*\n*/, "").trim();
  const capped = capText(body, max, notePath(brainId, note.file));
  return { file: note.file, title: note.title, content: capped.text, layer: note.layer, ...(capped.truncated ? { truncated: true } : {}) };
}

/** Fontes "de fora" (quartos conectados e, para o Maestro, todos): só o briefing. */
const PEER_FIXED = [BRAIN_FIXED_FILES.briefing] as const;
/** Pequena preferência pela origem quando a relevância empata: o próprio quarto, depois o lobby. */
const SOURCE_BONUS: Record<BrainContextSource["kind"], number> = { agent: 0, self: 0.3, lobby: 0.15, connected: 0, managed: 0 };

/** Arquivo das regras do agente dentro do contexto. */
const AGENT_RULES_NOTE_FILE = "regras.md";

type Loaded = VisibleSource & { stored: StoredNote[] };
type Titled = { source: Loaded; note: StoredNote; score: number; rule: boolean };

const byNewest = (a: StoredNote, b: StoredNote) => b.mtimeMs - a.mtimeMs || a.file.localeCompare(b.file);

/**
 * Monta o contexto que um agente recebe ao trabalhar em `roomId`: só o que o time precisa SEGUIR,
 * com tamanho limitado por construção.
 * 1. as regras do próprio agente (se `agent` foi dado e ele tem regras): só ele as recebe;
 * 2. o próprio quarto e o lobby: `_regras`, as notas de regra (tag "regra" ou título "Regra: …",
 *    mais novas primeiro, num orçamento total) e o `_briefing`;
 * 3. quartos conectados (e, para o Maestro, todos): só o `_briefing`;
 * 4. as demais notas curtas de todas as fontes visíveis viram uma lista de títulos com o caminho,
 *    por relevância ao `query` (sem ele, as mais recentes); o agente lê com `read_note`.
 * O `_indice` e o histórico nunca entram (continuam em disco e na busca).
 */
export async function buildContext(deps: ContextDeps, roomId: string, query = "", agent?: ContextAgent): Promise<BrainContext> {
  const all = deps.rooms();
  const room = all.find((ws) => ws.id === roomId);
  if (!room) throw new HttpError(404, `Sala "${roomId}" não encontrada`);
  const nowMs = (deps.now?.() ?? new Date()).getTime();
  const [loaded, agentRules] = await Promise.all([
    Promise.all(visibleSources(room, all).map(async (source): Promise<Loaded> => ({ ...source, stored: await deps.readNotes(source.id) }))),
    agent && deps.readAgentRules ? deps.readAgentRules(agent.id).catch(() => "") : Promise.resolve(""),
  ]);

  const included = new Map<Loaded, BrainNote[]>(loaded.map((source) => [source, []]));
  const omitted = new Map<Loaded, BrainOmittedNote[]>(loaded.map((source) => [source, []]));
  const titled: Titled[] = [];
  const queryTerms = terms(query);
  const noteInfo = (note: StoredNote) => {
    const { frontmatter, body } = parseFrontmatter(note.content);
    return { tags: noteTags(frontmatter), body };
  };

  // 2 e 3. Regras e briefing.
  let peersLeft: number = BRAIN_LIMITS.peersTotal;
  let rulesLeft: number = BRAIN_LIMITS.rulesTotal;
  for (const source of loaded) {
    const own = source.kind === "self" || source.kind === "lobby";
    const fixed = (file: string) => source.stored.find((candidate) => candidate.file === file);
    const rootNotes = source.stored.filter((note) => note.layer === "note");
    const rules = own ? rootNotes.filter((note) => isBrainRuleNote({ layer: note.layer, tags: noteInfo(note).tags, title: note.title })).sort(byNewest) : [];
    if (own) {
      const regras = fixed(BRAIN_FIXED_FILES.regras);
      if (regras) included.get(source)!.push(contextNote(source.id, regras, BRAIN_LIMITS.fixed.regras));
      for (const note of rules) {
        const rendered = contextNote(source.id, note, BRAIN_LIMITS.ruleNote);
        if (rendered.content.length > rulesLeft) {
          // Não coube no orçamento das regras: vira título marcado como regra (o agente lê com read_note).
          titled.push({ source, note, score: 0, rule: true });
          continue;
        }
        rulesLeft -= rendered.content.length;
        included.get(source)!.push(rendered);
      }
      const briefing = fixed(BRAIN_FIXED_FILES.briefing);
      if (briefing) included.get(source)!.push(contextNote(source.id, briefing, BRAIN_LIMITS.fixed.briefing));
    } else {
      for (const file of PEER_FIXED) {
        const note = fixed(file);
        if (!note) continue;
        const rendered = contextNote(source.id, note, BRAIN_LIMITS.peerFixed);
        if (rendered.content.length > peersLeft) {
          omitted.get(source)!.push({ file: note.file, title: note.title });
          continue;
        }
        peersLeft -= rendered.content.length;
        included.get(source)!.push(rendered);
      }
    }
    // 4. As outras notas curtas só como título, por relevância.
    const ruleFiles = new Set(rules.map((note) => note.file));
    for (const note of rootNotes) {
      if (ruleFiles.has(note.file)) continue;
      const { tags, body } = noteInfo(note);
      const score = relevance(queryTerms, { title: note.title, file: note.file, tags, body, mtimeMs: note.mtimeMs }, nowMs) + SOURCE_BONUS[source.kind];
      titled.push({ source, note, score, rule: false });
    }
  }
  const ranked = titled.filter((entry) => !entry.rule).sort((a, b) => b.score - a.score || b.note.mtimeMs - a.note.mtimeMs || a.note.file.localeCompare(b.note.file));
  const overflowRules = titled.filter((entry) => entry.rule);
  const titles = [...overflowRules, ...ranked];
  for (const entry of titles) omitted.get(entry.source)!.push({ file: entry.note.file, title: entry.note.title });

  const sources: BrainContextSource[] = [];
  const ownRules = agent ? agentRules.trim() : "";
  if (agent && ownRules) {
    const capped = capText(ownRules, BRAIN_LIMITS.agentRules, `${agent.id}/${AGENT_RULES_NOTE_FILE}`);
    sources.push({
      kind: "agent",
      id: agent.id,
      name: agent.name,
      notes: [{ file: AGENT_RULES_NOTE_FILE, title: "Suas regras", content: capped.text, layer: "fixed", ...(capped.truncated ? { truncated: true } : {}) }],
    });
  }
  for (const source of loaded) {
    const left = omitted.get(source)!;
    sources.push({ kind: source.kind, id: source.id, name: source.name, notes: included.get(source)!, ...(left.length > 0 ? { omitted: left } : {}) });
  }
  const ruleKeys = new Set(overflowRules.map((entry) => notePath(entry.source.id, entry.note.file)));
  const text = renderContextText(room, sources, titles.map((entry) => ({ path: notePath(entry.source.id, entry.note.file), title: entry.note.title, rule: ruleKeys.has(notePath(entry.source.id, entry.note.file)) })));
  const includedCount = sources.reduce((sum, source) => sum + source.notes.length, 0);
  const omittedCount = sources.reduce((sum, source) => sum + (source.omitted?.length ?? 0), 0);
  return { roomId, sources, text, stats: { chars: text.length, included: includedCount, omitted: omittedCount } };
}

const FIXED_LABELS: Record<string, string> = {
  [BRAIN_FIXED_FILES.regras]: "Regras",
  [BRAIN_FIXED_FILES.briefing]: "Briefing",
};

function renderSource(source: BrainContextSource): string {
  if (source.kind === "agent") return [`## Suas regras (só para você, ${source.name})`, ...source.notes.map((note) => note.content.trim())].join("\n\n");
  const header = `## ${BRAIN_SOURCE_LABELS[source.kind]}: ${source.name} (\`${source.id}\`)`;
  const notes = source.notes.map((note) => {
    const label = note.layer === "fixed" ? `${FIXED_LABELS[note.file] ?? note.title}` : note.title;
    return `### ${label} (\`${notePath(source.id, note.file)}\`)\n\n${note.content.trim()}`;
  });
  return [header, ...notes].join("\n\n");
}

type TitleLine = { path: string; title: string; rule: boolean };

/** As outras notas (só título + caminho), com teto de linhas; as regras que não couberam vêm primeiro. */
function renderTitles(titles: TitleLine[]): string {
  if (titles.length === 0) return "";
  const shown = titles.slice(0, BRAIN_LIMITS.titles);
  const more = titles.length - shown.length;
  return [
    "## Notas do Cérebro (só os títulos: leia com `read_note(path)` o que for útil para a tarefa)",
    ...shown.map((line) => `- ${line.title} — \`${line.path}\`${line.rule ? " (regra)" : ""}`),
    ...(more > 0 ? [`- … e mais ${more} (use \`search_notes\`)`] : []),
  ].join("\n");
}

export function renderContextText(room: Room, sources: BrainContextSource[], titles: TitleLine[] = []): string {
  const hint = "_Aqui entram só as regras e o briefing. O resto do Cérebro você busca: `search_notes` / `read_note`._";
  return [`# Contexto do Cérebro para a sala ${room.name}`, hint, ...sources.filter((source) => source.notes.length > 0).map(renderSource), renderTitles(titles)].filter(Boolean).join("\n\n") + "\n";
}
