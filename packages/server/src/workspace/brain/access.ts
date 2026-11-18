import {
  BRAIN_FIXED_FILES,
  BRAIN_HISTORY_DIR,
  BRAIN_RULE_LIMITS,
  BRAIN_RULE_TAG,
  BRAIN_SOURCE_LABELS,
  GLOBAL_BRAIN_ID,
  isMaestroAgent,
  slugify,
  type Agent,
  type BrainNoteLayer,
  type OfficeState,
  type Room,
} from "@cyno/shared";
import { shorten } from "../../util/text";
import type { AgentRules } from "./agent-rules";
import type { Brain } from "./brain";
import { noteDate, noteExcerpt, noteTags } from "./browse";
import { notePath, visibleSources, type VisibleSource } from "./context";
import { parseFrontmatter, renderFields } from "./frontmatter";
import { BRAIN_LIMITS } from "./limits";
import { isFixedFile, readCapped } from "./notes";
import { relevance, snippet, terms } from "./relevance";

/** Quem usa as ferramentas do Cérebro: o agente, o quarto dele e se é o Maestro. */
export type BrainViewer = { agentId: string; agentName: string; roomId: string; maestro: boolean };

/** Tipos de nota curta que os agentes salvam (vai no frontmatter `tipo`). */
export const NOTE_KINDS = ["decisao", "doc", "aprendizado", "preferencia", "regra", "outro"] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];

/** Tipo da nota como os agentes mandam pelo MCP (em inglês) -> o gravado no frontmatter (pt-BR, igual às notas de antes). */
export const NOTE_INPUT_KINDS = ["decision", "doc", "learning", "preference", "rule", "other"] as const;
export type NoteInputKind = (typeof NOTE_INPUT_KINDS)[number];
const KIND_FROM_INPUT: Record<NoteInputKind, NoteKind> = { decision: "decisao", doc: "doc", learning: "aprendizado", preference: "preferencia", rule: "regra", other: "outro" };

export type SaveNoteInput = { title: string; content: string; kind: NoteInputKind; tags?: string[]; replace?: string; brain?: string };

const LAYER_LABELS: Record<BrainNoteLayer, string> = { fixed: "pinned", note: "note", history: "history" };
const FIXED_KIND: Record<string, string> = { [BRAIN_FIXED_FILES.regras]: "regras", [BRAIN_FIXED_FILES.indice]: "indice", [BRAIN_FIXED_FILES.briefing]: "briefing" };

/** Tags da nota: as que o agente passou (até 8) e, numa regra, sempre a tag "regra". */
function noteTagsFor(input: SaveNoteInput): string[] {
  const tags = (input.tags ?? []).map((tag) => tag.replace(/^#+/, "").trim()).filter(Boolean);
  const unique = [...new Set(input.kind === "rule" ? [BRAIN_RULE_TAG, ...tags.filter((tag) => tag !== BRAIN_RULE_TAG)] : tags)];
  return unique.slice(0, 8);
}

/** Agente -> quarto dele (pelo time) e papel. Sem agente ou sem quarto = undefined. */
export function brainViewer(state: OfficeState, agentId: string): BrainViewer | undefined {
  const agent = state.agents.find((candidate) => candidate.id === agentId);
  const team = state.teams.find((candidate) => candidate.id === agent?.teamId);
  if (!agent || !team || !state.rooms.some((room) => room.id === team.roomId)) return undefined;
  return { agentId, agentName: agent.name, roomId: team.roomId, maestro: isMaestroAgent(state, agent) };
}

/**
 * "<cérebro>/<arquivo>.md" ou "<cérebro>/historico/<arquivo>.md" (".md" opcional, "[[…]]" e "/" na
 * frente toleradas). Só separa: quem confere se existe e se pode é o Brain e as regras daqui.
 */
export function parseNotePath(caminho: string): { brainId: string; file: string } | null {
  const clean = caminho.trim().replace(/^\[\[|\]\]$/g, "").replace(/^\/+/, "");
  const slash = clean.indexOf("/");
  if (slash <= 0) return null;
  const brainId = clean.slice(0, slash);
  let file = clean.slice(slash + 1);
  if (!file) return null;
  if (!/\.md$/i.test(file)) file = `${file}.md`;
  return { brainId, file };
}

/**
 * As ferramentas do Cérebro para os agentes (MCP), com as MESMAS regras de visibilidade do contexto
 * (visibleSources): um agente só busca e lê os Cérebros que o quarto dele enxerga (a Sala do
 * Maestro enxerga todos os quartos, e o global se lê o lobby). Escrita: o agente de time só no
 * Cérebro do próprio quarto (e nunca nas `_regras`); o Maestro em qualquer quarto e no global. O
 * histórico nunca é alterado por aqui.
 */
export class BrainAccess {
  constructor(private readonly deps: { brain: Brain; rooms: () => Room[]; now: () => Date; agentRules: Pick<AgentRules, "append">; agents: () => Pick<Agent, "id" | "name">[] }) {}

  /** Cérebros que o agente pode ler (mesma regra do contexto). */
  readable(viewer: BrainViewer): VisibleSource[] {
    const all = this.deps.rooms();
    const room = all.find((candidate) => candidate.id === viewer.roomId);
    return room ? visibleSources(room, all) : [];
  }

  private canRead(viewer: BrainViewer, brainId: string): VisibleSource | undefined {
    return this.readable(viewer).find((source) => source.id === brainId);
  }

  /** `search_notes`: notas (fixas, curtas e histórico) dos Cérebros visíveis, por relevância. */
  async search(viewer: BrainViewer, query: string, limit: number = BRAIN_LIMITS.searchDefault): Promise<string> {
    const queryTerms = terms(query);
    if (queryTerms.length === 0) return "Empty query: use words from the subject (e.g. \"paleta de cores\", \"cliente\", \"prazo\").";
    const nowMs = this.deps.now().getTime();
    const hits: { source: VisibleSource; file: string; title: string; layer: BrainNoteLayer; date: string | null; body: string; score: number }[] = [];
    for (const source of this.readable(viewer)) {
      const [notes, history] = await Promise.all([this.deps.brain.readNotes(source.id), this.deps.brain.readHistory(source.id)]);
      for (const note of [...notes, ...history]) {
        const { frontmatter, body } = parseFrontmatter(note.content);
        const score = relevance(queryTerms, { title: note.title, file: note.file, tags: noteTags(frontmatter), body, mtimeMs: note.mtimeMs }, nowMs);
        // Só o que casa com a consulta (a recência sozinha vale no máximo 0,5).
        if (score < 1) continue;
        hits.push({ source, file: note.file, title: note.title, layer: note.layer, date: noteDate(note.file.split("/").pop()!, frontmatter, new Date(note.mtimeMs)), body, score });
      }
    }
    hits.sort((a, b) => b.score - a.score || (b.date ?? "").localeCompare(a.date ?? ""));
    const shown = hits.slice(0, Math.min(Math.max(1, limit), BRAIN_LIMITS.searchMax));
    if (shown.length === 0) return `Nothing found for "${query}" in the Brains you can see.`;
    const lines = shown.map((hit, index) => {
      const where = `${BRAIN_SOURCE_LABELS[hit.source.kind]} ${hit.source.name}`;
      const when = hit.date ? ` · ${hit.date.slice(0, 10)}` : "";
      const excerpt = snippet(noteExcerpt(hit.body, 4000), queryTerms, BRAIN_LIMITS.snippet);
      return `${index + 1}. ${hit.title} — \`${notePath(hit.source.id, hit.file)}\` (${where} · ${LAYER_LABELS[hit.layer]}${when})\n   ${excerpt}`;
    });
    const more = hits.length > shown.length ? `\n(+${hits.length - shown.length} more result(s); refine the query or raise the limit)` : "";
    return `${shown.length} result(s) for "${query}" (read them with read_note):\n${lines.join("\n")}${more}`;
  }

  /** `read_note`: o texto inteiro (com teto) de uma nota de um Cérebro visível. */
  async read(viewer: BrainViewer, path: string): Promise<string> {
    const parsed = parseNotePath(path);
    if (!parsed) throw new Error(`Invalid path: "${path}" (use "<brain>/<file>.md", as shown in the context or in the search)`);
    if (!this.canRead(viewer, parsed.brainId)) throw new Error(`You cannot see the Brain "${parsed.brainId}"`);
    const full = await this.deps.brain.existingFile(parsed.brainId, parsed.file);
    if (!full) throw new Error(`Note "${notePath(parsed.brainId, parsed.file)}" not found (see search_notes)`);
    const content = await readCapped(full);
    const text = content.length > BRAIN_LIMITS.readNote ? `${content.slice(0, BRAIN_LIMITS.readNote).trimEnd()}\n\n[… note cut at ${BRAIN_LIMITS.readNote} characters]` : content;
    return `\`${notePath(parsed.brainId, parsed.file)}\`\n\n${text}`;
  }

  /** `save_note`: cria uma nota curta ou troca uma existente (fixa ou curta), com frontmatter. */
  async save(viewer: BrainViewer, input: SaveNoteInput): Promise<string> {
    const target = input.replace ? parseNotePath(input.replace) : null;
    if (input.replace && !target) throw new Error(`Invalid path in replace: "${input.replace}"`);
    if (target && input.brain && input.brain !== target.brainId) throw new Error("`brain` and `replace` point to different Brains");
    const brainId = target?.brainId ?? (viewer.maestro ? (input.brain ?? viewer.roomId) : viewer.roomId);
    if (!viewer.maestro && (brainId !== viewer.roomId || (input.brain && input.brain !== viewer.roomId))) {
      throw new Error(`You can only save to your own room's Brain ("${viewer.roomId}")`);
    }
    if (viewer.maestro && brainId !== GLOBAL_BRAIN_ID && !this.deps.rooms().some((room) => room.id === brainId)) {
      throw new Error(`Brain "${brainId}" does not exist (use a room id or "global")`);
    }
    const file = target?.file ?? `${slugify(input.title, "nota").slice(0, 60).replace(/-+$/g, "")}.md`;
    if (file.startsWith(`${BRAIN_HISTORY_DIR}/`)) throw new Error("History does not change: save a new note");
    const fixed = isFixedFile(file);
    if (fixed && !target) throw new Error("To change a pinned note, pass replace with its path");
    if (fixed && file === BRAIN_FIXED_FILES.regras && !viewer.maestro) throw new Error("The room's rules belong to the user: propose the change in your result, do not edit `_regras`");
    const isRule = input.kind === "rule" && !fixed;
    const max = fixed ? BRAIN_LIMITS.saveFixed : isRule ? BRAIN_RULE_LIMITS.ruleNote : BRAIN_LIMITS.saveNote;
    const body = input.content.trim();
    if (body.length > max) {
      throw new Error(
        isRule
          ? `Rule too long (${body.length} characters; max ${max}). A rule is loaded in every task: keep it to a few lines (one or two sentences); put the details in a separate note.`
          : `Content too long (${body.length} characters; max ${max}). Brain notes are short: summarize.`,
      );
    }

    const at = this.deps.now().toISOString();
    const title = input.title.replace(/\s+/g, " ").trim();
    const frontmatter = fixed
      ? renderFields({ tipo: FIXED_KIND[file], autor: viewer.agentName, atualizado: at })
      : renderFields({ tipo: KIND_FROM_INPUT[input.kind], autor: viewer.agentName, data: at, tags: noteTagsFor(input) });
    const heading = /^#\s+\S/.test(body) ? "" : `# ${title}\n\n`;
    const content = `${frontmatter}\n${heading}${body}\n`;
    const indexLine = `- [[${file.replace(/\.md$/i, "")}]] — ${shorten(noteExcerpt(body, 100) || title, 100)}`;
    await this.deps.brain.writeRootNote(brainId, file, content, { replace: target !== null, ...(target ? {} : { indexLine }) });
    return `${target ? "Note updated" : "Note saved"}: \`${notePath(brainId, file)}\`${target ? "" : " (and listed in _indice)"}.`;
  }

  /**
   * `save_agent_rule`: acrescenta uma regra que vale só para UM agente. O agente de time só grava a
   * dele; o Maestro informa `agent` (id ou nome exato de qualquer agente do workspace).
   */
  async saveAgentRule(viewer: BrainViewer, text: string, agent?: string): Promise<string> {
    let target = { id: viewer.agentId, name: viewer.agentName };
    if (viewer.maestro) {
      const wanted = agent?.trim();
      if (!wanted) throw new Error("Pass `agent`: the id or exact name of the agent the rule is for (your own id if it is for you)");
      const agents = this.deps.agents();
      const found = agents.find((candidate) => candidate.id === wanted) ?? agents.find((candidate) => candidate.name === wanted) ?? agents.find((candidate) => candidate.name.toLowerCase() === wanted.toLowerCase());
      if (!found) throw new Error(`Agent "${wanted}" not found in this workspace (use an agent id or exact name; see get_team)`);
      target = { id: found.id, name: found.name };
    } else if (agent && agent !== viewer.agentId && agent !== viewer.agentName) {
      throw new Error("You can only save rules for yourself");
    }
    const result = await this.deps.agentRules.append(target.id, text);
    return result.added
      ? `Rule saved for ${target.name}: it will be loaded in every task of ${target.name} and of nobody else.`
      : `${target.name} already has this rule (nothing changed).`;
  }
}
