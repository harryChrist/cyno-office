import type { BrainFrontmatter, BrainKind, BrainNoteSummary, BrainSummary, OfficeState, Task } from "@cyno/shared";
import { inlineText, parseInline } from "../../ui/markdown/markdown";

/** Nota escolhida no endereço (`#/biblioteca/cerebro/<ws>/<brainId>/<arquivo>`). */
export type BrainSelection = { brainId: string | null; file: string | null };

export const NO_SELECTION: BrainSelection = { brainId: null, file: null };


function decode(part: string): string | null {
  try {
    return decodeURIComponent(part);
  } catch {
    return null;
  }
}

/** Lê o sufixo do Cérebro no endereço; outro workspace ou outra página = nada escolhido. */
export function parseBrainHash(hash: string, workspaceId: string | null): BrainSelection {
  const parts = hash.replace(/^#\/?/, "").split("?")[0]!.split("/").filter(Boolean).map(decode);
  const [page, tab, ws, brainId, file] = parts;
  if (!workspaceId || page !== "biblioteca" || tab !== "cerebro" || ws !== workspaceId) return NO_SELECTION;
  return { brainId: brainId || null, file: brainId ? file || null : null };
}

/** Endereço de um Cérebro (e de uma nota dele). */
export function brainHash(workspaceId: string, brainId: string | null, file: string | null = null): string {
  const parts = ["biblioteca", "cerebro", workspaceId, ...(brainId ? [brainId, ...(file ? [file] : [])] : [])];
  return `#/${parts.map(encodeURIComponent).join("/")}`;
}

/** Minúsculas e sem acentos, para a busca. */
export function normalize(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/** Notas cujo título, tags ou trecho têm todas as palavras da busca (sem diferenciar acentos). */
export function filterNotes(notes: BrainNoteSummary[], query: string): BrainNoteSummary[] {
  const words = normalize(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return notes;
  return notes.filter((note) => {
    const haystack = normalize([note.title, ...note.tags.map((tag) => `#${tag}`), note.excerpt].join(" "));
    return words.every((word) => haystack.includes(word));
  });
}

/** Camadas da lista: fixas (regras, briefing, índice) no topo, notas curtas e o histórico. A ordem de cada grupo é a do server. */
export type NoteGroups = { fixed: BrainNoteSummary[]; notes: BrainNoteSummary[]; history: BrainNoteSummary[] };

export function groupNotes(notes: BrainNoteSummary[]): NoteGroups {
  const groups: NoteGroups = { fixed: [], notes: [], history: [] };
  for (const note of notes) {
    if (note.layer === "fixed") groups.fixed.push(note);
    else if (note.layer === "history") groups.history.push(note);
    else groups.notes.push(note);
  }
  return groups;
}

/** Nome curto das fixas na lista (o título delas leva o nome do quarto). */
const FIXED_NAMES: Record<string, string> = { "_regras.md": "Regras", "_briefing.md": "Briefing", "_indice.md": "Índice" };

export function fixedName(note: Pick<BrainNoteSummary, "file" | "title">): string {
  return FIXED_NAMES[note.file] ?? note.title;
}

export type CrewTeam = { id: string; name: string; agents: string[] };

/** Times (e os agentes de cada um) de um quarto; o lobby não tem time. */
export function brainCrew(office: Pick<OfficeState, "teams" | "agents"> | null, brainId: string): CrewTeam[] {
  if (!office) return [];
  return office.teams
    .filter((team) => team.roomId === brainId)
    .map((team) => ({
      id: team.id,
      name: team.name,
      agents: office.agents.filter((agent) => agent.teamId === team.id).map((agent) => agent.name),
    }));
}

/** "Frontend: Lia, Davi · Backend: Nina" */
export function crewLabel(crew: CrewTeam[]): string {
  return crew.map((team) => (team.agents.length ? `${team.name}: ${team.agents.join(", ")}` : `${team.name}: sem agentes`)).join(" · ");
}

export const BRAIN_KIND_LABELS: Record<BrainKind, string> = {
  lobby: "Cérebro global",
  maestro: "Gerência",
  team: "Sala",
};

/** Quem enxerga o Cérebro: o lobby vale para os quartos com porta; os outros mostram os times. */
export function brainAudience(brain: Pick<BrainSummary, "id" | "kind">, office: Pick<OfficeState, "teams" | "agents"> | null): string {
  if (brain.kind === "lobby") return "Visto pelas salas com porta para o lobby";
  return crewLabel(brainCrew(office, brain.id)) || "Sem times";
}

export type NoteRef = { brainId: string; file: string; title: string };

/** Chave de busca de wiki links: título ou nome do arquivo, sem acento, caixa e ".md". */
const wikiKey = (text: string) => normalize(text.replace(/\.md$/i, "")).replace(/\s+/g, " ").trim();

/**
 * Índice dos wiki links: cada nota entra pelo título e pelo nome do arquivo (sem ".md").
 * `[[Título]]` procura primeiro no Cérebro aberto, depois nos outros do workspace.
 */
export function buildWikiIndex(brains: BrainSummary[]): Map<string, NoteRef[]> {
  const index = new Map<string, NoteRef[]>();
  for (const brain of brains) {
    for (const note of brain.notes) {
      const ref = { brainId: brain.id, file: note.file, title: note.title };
      // Do histórico ("historico/x.md") também vale o nome sem a pasta: [[quarto/x]] acha a nota.
      const base = note.file.split("/").pop() ?? note.file;
      for (const key of new Set([wikiKey(note.title), wikiKey(note.file), wikiKey(base)])) {
        if (!key) continue;
        const refs = index.get(key) ?? [];
        refs.push(ref);
        index.set(key, refs);
      }
    }
  }
  return index;
}

export function resolveWiki(index: Map<string, NoteRef[]>, target: string, currentBrainId: string | null): NoteRef | null {
  // "pasta/Nota" procura por "Nota" (o histórico é achado pelo nome sem a pasta).
  const key = wikiKey(target.split("/").pop() ?? target);
  const refs = index.get(key);
  if (!refs?.length) return null;
  return refs.find((ref) => ref.brainId === currentBrainId) ?? refs[0]!;
}

/** `iso` vem nos chips de data: o leitor mostra a data relativa e a absoluta ao passar o mouse. */
export type Chip = { key: string; label: string; value: string; iso?: string };

function firstValue(frontmatter: BrainFrontmatter, keys: string[]): string | null {
  for (const key of keys) {
    const value = frontmatter[key];
    const text = Array.isArray(value) ? value.join(", ") : value;
    if (text?.trim()) return text.trim();
  }
  return null;
}

/**
 * Chips do frontmatter: data, atualização, autor, agente e time (com o nome atual, se o id
 * existir no escritório). As tags e o tipo vão à parte.
 */
export function frontmatterChips(
  frontmatter: BrainFrontmatter,
  office: Pick<OfficeState, "teams" | "agents"> | null,
  formatDate: (iso: string) => string,
): Chip[] {
  const chips: Chip[] = [];
  const dateChip = (key: string, label: string, raw: string) => {
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) chips.push({ key, label, value: raw });
    else chips.push({ key, label, value: formatDate(parsed.toISOString()), iso: parsed.toISOString() });
  };
  const date = firstValue(frontmatter, ["data", "date", "created"]);
  if (date) dateChip("data", "Data", date);
  const updated = firstValue(frontmatter, ["atualizado", "atualizada", "updated"]);
  if (updated && updated !== date) dateChip("atualizado", "Atualizada", updated);
  const author = firstValue(frontmatter, ["autor", "author"]);
  if (author) chips.push({ key: "autor", label: "Autor", value: author });
  const agent = firstValue(frontmatter, ["agent", "agente"]);
  if (agent) chips.push({ key: "agente", label: "Agente", value: office?.agents.find((item) => item.id === agent)?.name ?? agent });
  const team = firstValue(frontmatter, ["team", "time"]);
  if (team) chips.push({ key: "time", label: "Time", value: office?.teams.find((item) => item.id === team)?.name ?? team });
  return chips;
}

/** Tags do frontmatter (`tags`/`tag`), sem "#". */
export function frontmatterTags(frontmatter: BrainFrontmatter): string[] {
  const raw = frontmatter.tags ?? frontmatter.tag;
  if (raw === undefined) return [];
  const list = Array.isArray(raw) ? raw : raw.split(/[,\s]+/);
  return [...new Set(list.map((tag) => tag.trim().replace(/^#+/, "")).filter(Boolean))];
}

/**
 * Muda quando entra uma tarefa concluída (que vira nota no Cérebro): quantas estão em "done" e
 * a mais recente. É a deixa para recarregar a lista.
 */
export function doneSignature(tasks: Task[] | undefined): string {
  let count = 0;
  let latest = "";
  for (const task of tasks ?? []) {
    if (task.status !== "done") continue;
    count++;
    if (task.updatedAt > latest) latest = task.updatedAt;
  }
  return `${count}|${latest}`;
}

/** Tira o primeiro "# Título" do corpo se ele repete o título já mostrado no topo. */
export function stripLeadingTitle(body: string, title: string): string {
  const match = /^\s*#[ \t]+(.+?)[ \t]*#*[ \t]*(?:\r?\n|$)/.exec(body);
  if (!match || match[1]!.trim() !== title.trim()) return body;
  return body.slice(match[0].length);
}

/** Título sem marcação ("Pedido **Contexto**" -> "Pedido Contexto"): o do histórico vem do texto da tarefa. */
export function plainTitle(title: string): string {
  return inlineText(parseInline(title)).replace(/\s+/g, " ").trim() || title;
}

/** Tipo da nota pelo arquivo: as três fixas, o histórico de tarefas ou uma nota comum. */
export type NoteKind = "regras" | "briefing" | "indice" | "historico" | "nota";

const FIXED_KINDS: Record<string, NoteKind> = { "_regras.md": "regras", "_briefing.md": "briefing", "_indice.md": "indice" };

export function noteKind(note: Pick<BrainNoteSummary, "file" | "layer">): NoteKind {
  if (note.layer === "history") return "historico";
  return FIXED_KINDS[note.file] ?? "nota";
}

export const NOTE_KIND_LABELS: Record<NoteKind, string> = {
  regras: "Regras",
  briefing: "Briefing",
  indice: "Índice",
  historico: "Histórico de tarefa",
  nota: "Nota",
};

/** Rótulos com acento dos `tipo:` mais comuns (o resto só ganha a inicial maiúscula). */
const TIPO_LABELS: Record<string, string> = { indice: "Índice", decisao: "Decisão", preferencia: "Preferência", referencia: "Referência" };

/** Rótulo do tipo: o `tipo:` do frontmatter, se houver; senão o tipo pelo arquivo. */
export function noteTypeLabel(frontmatter: BrainFrontmatter, kind: NoteKind): string {
  const tipo = firstValue(frontmatter, ["tipo", "type"]);
  if (!tipo || kind === "historico") return NOTE_KIND_LABELS[kind];
  return TIPO_LABELS[normalize(tipo)] ?? tipo.charAt(0).toUpperCase() + tipo.slice(1);
}

/** Em que nível da navegação a tela estreita está: lista de Cérebros, notas de um Cérebro ou a nota aberta. */
export type BrainLevel = "brains" | "notes" | "reader";

export function brainLevel(selection: BrainSelection): BrainLevel {
  if (selection.file) return "reader";
  return selection.brainId ? "notes" : "brains";
}

const DAY_MS = 86_400_000;

function toDate(iso: string): Date | null {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

function shortDate(date: Date, now: Date): string {
  const sameYear = date.getFullYear() === now.getFullYear();
  return date.toLocaleDateString("pt-BR", sameYear ? { day: "numeric", month: "short" } : { day: "numeric", month: "short", year: "numeric" });
}

/** "agora", "há 5 min", "há 2 h", "ontem", "há 3 dias", "há 2 sem." ou a data ("9 de nov."). */
export function relativeDate(iso: string, now: Date = new Date()): string {
  const date = toDate(iso);
  if (!date) return iso;
  const seconds = Math.round((now.getTime() - date.getTime()) / 1000);
  if (seconds < 60) return seconds > -60 ? "agora" : shortDate(date, now);
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `há ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `há ${hours} h`;
  const midnight = (value: Date) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const days = Math.round((midnight(now) - midnight(date)) / DAY_MS);
  if (days <= 1) return "ontem";
  if (days < 7) return `há ${days} dias`;
  if (days < 28) return `há ${Math.floor(days / 7)} sem.`;
  return shortDate(date, now);
}

/** "9 de novembro de 2026 às 12:10" (o title das datas relativas). */
export function absoluteDate(iso: string): string {
  const date = toDate(iso);
  return date ? date.toLocaleString("pt-BR", { dateStyle: "long", timeStyle: "short" }) : iso;
}

/** A data mais recente das notas (ISO), ou null. */
export function latestDate(notes: Pick<BrainNoteSummary, "date">[]): string | null {
  let latest: string | null = null;
  for (const note of notes) if (note.date && (!latest || note.date > latest)) latest = note.date;
  return latest;
}

const unquote = (raw: string) => raw.trim().replace(/^(["'])(.*)\1$/, "$2");

/** Linhas `chave: valor` de um bloco de frontmatter (escalares, `[a, b]` e listas com "- "). */
export function parseFrontmatterFields(text: string): BrainFrontmatter {
  const fields: BrainFrontmatter = {};
  let lastKey: string | null = null;
  for (const line of text.split("\n")) {
    const pair = /^([A-Za-z_][\w-]*)[ \t]*:[ \t]*(.*)$/.exec(line);
    if (pair) {
      const key = pair[1]!;
      const value = pair[2]!.trim();
      lastKey = key;
      if (value.startsWith("[") && value.endsWith("]")) fields[key] = value.slice(1, -1).split(",").map(unquote).filter(Boolean);
      else fields[key] = value === "" ? [] : unquote(value);
      continue;
    }
    const item = /^[ \t]*-[ \t]+(.*)$/.exec(line);
    if (item && lastKey) {
      const previous = fields[lastKey];
      fields[lastKey] = [...(Array.isArray(previous) ? previous : previous ? [previous] : []), unquote(item[1]!)];
    }
  }
  return fields;
}

/** Bloco "---" no começo do texto cuja primeira linha é `chave: valor` (um frontmatter colado no corpo). */
const EMBEDDED_FRONTMATTER = /^---[ \t]*\n([A-Za-z_][\w-]*[ \t]*:[^\n]*\n(?:(?:[A-Za-z_][\w-]*[ \t]*:|[ \t]*-[ \t])[^\n]*\n)*)---[ \t]*(?:\n|$)/;

/**
 * Corpo pronto para ler: sem o "# Título" que repete o cabeçalho e sem blocos de frontmatter
 * colados no começo (acontece quando um agente regrava a nota com o frontmatter dentro do texto).
 * Os campos desses blocos voltam em `frontmatter` para virar chips.
 */
export function cleanNoteBody(body: string, title: string): { body: string; frontmatter: BrainFrontmatter } {
  let rest = body.replace(/\r\n?/g, "\n");
  const frontmatter: BrainFrontmatter = {};
  for (;;) {
    rest = rest.replace(/^(?:[ \t]*\n)+/, "");
    const withoutTitle = stripLeadingTitle(rest, title);
    if (withoutTitle !== rest) {
      rest = withoutTitle;
      continue;
    }
    const block = EMBEDDED_FRONTMATTER.exec(rest);
    if (!block) return { body: rest, frontmatter };
    Object.assign(frontmatter, parseFrontmatterFields(block[1]!));
    rest = rest.slice(block[0].length);
  }
}

/**
 * Trecho da lista sem o frontmatter colado no corpo: "tipo: regras Regras — X Texto…" vira
 * "Texto…". Só mexe quando os pares `chave: valor` vêm seguidos do título (senão o "Objetivo: …"
 * de uma nota comum sumiria).
 */
export function cleanExcerpt(excerpt: string, title: string): string {
  const text = excerpt.trim();
  const fields = /^(?:[A-Za-z_][\w-]*: \S+ )+/.exec(text);
  if (!fields) return text;
  const rest = text.slice(fields[0].length);
  const head = title.trim();
  return head && rest.startsWith(head) ? rest.slice(head.length).trim() : text;
}
