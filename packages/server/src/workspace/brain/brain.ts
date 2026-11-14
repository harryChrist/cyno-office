import { randomUUID } from "node:crypto";
import { link, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  BRAIN_FIXED_FILES,
  BRAIN_HISTORY_DIR,
  GLOBAL_BRAIN_ID,
  isSafeId,
  LOBBY_BRAIN_NAME,
  type BrainContext,
  type BrainNoteResponse,
  type BrainNoteSummary,
  type BrainSummary,
  type Room,
} from "@cyno/shared";
import type { DataPaths } from "../../store/paths";
import { writeFileAtomic } from "../../store/atomic-write";
import { newestFirst, summarizeNote } from "./browse";
import { buildContext } from "./context";
import { parseFrontmatter, renderFrontmatter, type NoteFrontmatter } from "./frontmatter";
import { ensureFixedFiles, moveResultsToHistory } from "./migrate";
import {
  datedNoteFileName,
  historyFile,
  isNoteFileName,
  listHistoryFiles,
  listNoteFiles,
  noteLayer,
  noteTitle,
  readCapped,
  readHistoryDir,
  readNotesDir,
  type StoredNote,
} from "./notes";
import type { BrainScope } from "./templates";

export type NewNote = { title: string; body: string; frontmatter: NoteFrontmatter };
export type WrittenNote = { file: string; path: string };

export type BrainDeps = {
  paths: DataPaths;
  /** Quartos atuais (para saber o que cada quarto pode ver). */
  rooms: () => Room[];
  now?: () => Date;
};

/** O que a migração fez (para o log do boot). */
export type BrainMigrationReport = { moved: string[]; created: string[] };

const MAX_NAME_ATTEMPTS = 100;

/** Ordem das fixas na lista do navegador: regras, briefing, índice. */
const FIXED_RANK: Record<string, number> = { [BRAIN_FIXED_FILES.regras]: 0, [BRAIN_FIXED_FILES.briefing]: 1, [BRAIN_FIXED_FILES.indice]: 2 };
const LAYER_RANK = { fixed: 0, note: 1, history: 2 } as const;

/** Fixas primeiro (na ordem delas), depois as notas e o histórico, cada grupo mais recente primeiro. */
function browserOrder(a: BrainNoteSummary, b: BrainNoteSummary): number {
  if (a.layer !== b.layer) return LAYER_RANK[a.layer] - LAYER_RANK[b.layer];
  if (a.layer === "fixed") return (FIXED_RANK[a.file] ?? 9) - (FIXED_RANK[b.file] ?? 9);
  return newestFirst(a, b);
}

/** Cria o arquivo sem nunca sobrescrever e sem deixá-lo pela metade (temporário + link). */
async function createFileAtomic(file: string, content: string): Promise<void> {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  await writeFile(tmp, content, { flag: "wx" });
  try {
    await link(tmp, file);
  } finally {
    await rm(tmp, { force: true });
  }
}

/**
 * Cérebros em disco: brains/global/ e brains/<roomId>/, só notas .md. Em cada pasta:
 * `_regras.md`, `_indice.md` e `_briefing.md` (fixos), as notas curtas na raiz e o histórico de
 * tarefas em `historico/`. Ids passam por dataPaths.brainDir, que recusa qualquer coisa fora do
 * padrão seguro (sem "..", barras etc.), e os nomes de arquivo são conferidos contra a listagem,
 * então nada é lido ou escrito fora de brains/.
 */
export class Brain {
  private readonly now: () => Date;
  /** Escritas por Cérebro em fila (o índice e as notas nunca se atropelam). */
  private readonly writes = new Map<string, Promise<unknown>>();

  constructor(private readonly deps: BrainDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  dir(brainId: string): string {
    return this.deps.paths.brainDir(brainId);
  }

  /** Notas da raiz de um Cérebro (fixas e curtas); pasta ausente = nenhuma nota. */
  readNotes(brainId: string): Promise<StoredNote[]> {
    return readNotesDir(this.dir(brainId));
  }

  /** Histórico de um Cérebro (`historico/`). */
  readHistory(brainId: string): Promise<StoredNote[]> {
    return readHistoryDir(this.dir(brainId));
  }

  /**
   * Cérebros do navegador (página "Cérebro"): lobby, Sala do Maestro e os quartos atuais, nesta
   * ordem. Pastas de quartos já removidos não entram.
   */
  async listBrains(): Promise<BrainSummary[]> {
    const rooms = this.deps.rooms();
    const ordered = [...rooms.filter((room) => room.kind === "maestro"), ...rooms.filter((room) => room.kind !== "maestro")];
    const brains = [
      { id: GLOBAL_BRAIN_ID, kind: "lobby" as const, name: LOBBY_BRAIN_NAME },
      ...ordered.map((room) => ({ id: room.id, kind: room.kind, name: room.name })),
    ];
    return Promise.all(brains.map(async (brain) => ({ ...brain, notes: await this.noteSummaries(brain.id) })));
  }

  /** O Cérebro existe neste workspace? ("global" ou um quarto atual.) */
  hasBrain(brainId: string): boolean {
    return brainId === GLOBAL_BRAIN_ID || this.deps.rooms().some((room) => room.id === brainId);
  }

  /** O que o Cérebro é (nome e tipo), ou undefined se não existe mais. */
  scope(brainId: string): BrainScope | undefined {
    if (brainId === GLOBAL_BRAIN_ID) return { name: LOBBY_BRAIN_NAME, kind: "lobby" };
    const room = this.deps.rooms().find((candidate) => candidate.id === brainId);
    return room ? { name: room.name, kind: room.kind } : undefined;
  }

  /** Resumos das notas de um Cérebro: fixas, notas curtas e histórico. */
  async noteSummaries(brainId: string): Promise<BrainNoteSummary[]> {
    const [notes, history] = await Promise.all([this.readNotes(brainId), this.readHistory(brainId)]);
    return [...notes, ...history]
      .map((note) => ({ ...summarizeNote(note.file, note.content, new Date(note.mtimeMs)), title: note.title, layer: note.layer }))
      .sort(browserOrder);
  }

  /**
   * Arquivo de uma nota existente: `file` é o nome exato de uma nota .md da raiz ou
   * "historico/<nome>.md" (comparado com a listagem, então "..", barras extras e afins nunca chegam
   * ao disco). Senão, null.
   */
  async existingFile(brainId: string, file: string): Promise<string | null> {
    if (!this.hasBrain(brainId)) return null;
    const dir = this.dir(brainId);
    const prefix = `${BRAIN_HISTORY_DIR}/`;
    if (file.startsWith(prefix)) {
      const name = file.slice(prefix.length);
      return isNoteFileName(name) && (await listHistoryFiles(dir)).includes(name) ? path.join(dir, BRAIN_HISTORY_DIR, name) : null;
    }
    return isNoteFileName(file) && (await listNoteFiles(dir)).includes(file) ? path.join(dir, file) : null;
  }

  /** Uma nota do Cérebro (raiz ou histórico). Nota ou Cérebro inexistente = null. */
  async readNote(brainId: string, file: string): Promise<BrainNoteResponse | null> {
    const fullPath = await this.existingFile(brainId, file);
    if (!fullPath) return null;
    let content: string;
    try {
      content = await readCapped(fullPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    const { frontmatter, body } = parseFrontmatter(content);
    return { file, title: noteTitle(path.basename(file), content), frontmatter, body };
  }

  /** Contexto de um agente no quarto; `query` (o texto da tarefa) escolhe as notas curtas. */
  buildContext(roomId: string, query = ""): Promise<BrainContext> {
    return buildContext({ rooms: this.deps.rooms, readNotes: (id) => this.readNotes(id), now: this.now }, roomId, query);
  }

  /** Cria a pasta do Cérebro de um quarto e os fixos que faltarem (sem apagar nada que já exista). */
  async ensureBrain(roomId: string): Promise<void> {
    const scope = this.scope(roomId);
    if (!scope) {
      await mkdir(this.dir(roomId), { recursive: true });
      return;
    }
    await this.serial(roomId, () => ensureFixedFiles(this.dir(roomId), scope));
  }

  /**
   * Migração para o Cérebro em camadas (idempotente e conservadora: move, nunca apaga): em cada
   * pasta de Cérebro, os resultados de tarefa datados vão para `historico/`; o lobby e os quartos
   * atuais ganham os fixos que faltarem (o índice inicial lista as notas curtas que já existem).
   */
  async migrate(): Promise<BrainMigrationReport> {
    const report: BrainMigrationReport = { moved: [], created: [] };
    const ids = new Set([GLOBAL_BRAIN_ID, ...(await this.brainIds()), ...this.deps.rooms().map((room) => room.id)]);
    for (const brainId of ids) {
      const dir = this.dir(brainId);
      const moved = await this.serial(brainId, () => moveResultsToHistory(dir));
      report.moved.push(...moved.map((file) => `${brainId}/${file}`));
      const scope = this.scope(brainId);
      if (!scope) continue;
      const created = await this.serial(brainId, () => ensureFixedFiles(dir, scope));
      report.created.push(...created.map((file) => `${brainId}/${file}`));
    }
    return report;
  }

  /** Ids de todas as pastas de Cérebro no disco, inclusive de quartos já removidos. */
  async brainIds(): Promise<string[]> {
    try {
      const entries = await readdir(this.deps.paths.brainsDir, { withFileTypes: true });
      return entries.filter((entry) => entry.isDirectory() && isSafeId(entry.name)).map((entry) => entry.name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  /**
   * Resultado de tarefa no histórico: "historico/YYYY-MM-DD-HHmmss-<slug>.md" com frontmatter
   * YAML; nunca sobrescreve outra nota. Nunca entra no contexto sozinho (só por busca).
   */
  async writeHistoryNote(brainId: string, note: NewNote): Promise<WrittenNote> {
    const dir = path.join(this.dir(brainId), BRAIN_HISTORY_DIR);
    await mkdir(dir, { recursive: true });
    const title = note.title.replace(/\s+/g, " ").trim();
    const content = `${renderFrontmatter(note.frontmatter)}\n# ${title}\n\n${note.body.trim()}\n`;
    const date = this.now();
    for (let attempt = 1; attempt <= MAX_NAME_ATTEMPTS; attempt++) {
      const name = datedNoteFileName(date, title, attempt);
      const fullPath = path.join(dir, name);
      try {
        await writeFile(fullPath, content, { flag: "wx" });
        return { file: historyFile(name), path: fullPath };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    throw new Error(`Não foi possível escolher um nome livre para a nota em ${dir}`);
  }

  /**
   * Grava uma nota da raiz (nota curta ou fixo): `replace` = o arquivo já existe e é trocado de uma
   * vez (escrita atômica); senão cria um arquivo novo e falha se o nome já existir. Nota nova entra
   * no `_indice` (uma linha com o link). Nunca escreve no histórico.
   */
  async writeRootNote(brainId: string, file: string, content: string, options: { replace: boolean; indexLine?: string }): Promise<string> {
    if (!this.hasBrain(brainId)) throw new Error(`Cérebro "${brainId}" não existe`);
    if (!isNoteFileName(file) || noteLayer(file) === "history") throw new Error(`Nome de nota inválido: "${file}"`);
    const dir = this.dir(brainId);
    return this.serial(brainId, async () => {
      await mkdir(dir, { recursive: true });
      const fullPath = path.join(dir, file);
      const existing = (await listNoteFiles(dir)).includes(file);
      if (options.replace) {
        if (!existing) throw new Error(`A nota "${brainId}/${file}" não existe`);
        await writeFileAtomic(fullPath, content);
        return file;
      }
      try {
        await createFileAtomic(fullPath, content);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new Error(`The note "${brainId}/${file}" already exists: to change it, pass replace="${brainId}/${file}"`, { cause: error });
        }
        throw error;
      }
      if (options.indexLine) await this.appendToIndex(dir, file, options.indexLine);
      return file;
    });
  }

  /** Acrescenta a linha da nota nova ao `_indice.md` (se o índice existe e ainda não tem o link). */
  private async appendToIndex(dir: string, file: string, line: string): Promise<void> {
    if (!(await listNoteFiles(dir)).includes(BRAIN_FIXED_FILES.indice)) return;
    const indexPath = path.join(dir, BRAIN_FIXED_FILES.indice);
    const current = await readCapped(indexPath);
    if (current.includes(`[[${file.replace(/\.md$/i, "")}]]`)) return;
    const cleaned = current.replace(/^- \(ainda sem notas\)\s*$/m, "").trimEnd();
    await writeFileAtomic(indexPath, `${cleaned}\n${line}\n`);
  }

  /** Roda `task` depois das outras escritas deste Cérebro. */
  private serial<T>(brainId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.writes.get(brainId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(task);
    this.writes.set(brainId, next);
    void next.finally(() => {
      if (this.writes.get(brainId) === next) this.writes.delete(brainId);
    }).catch(() => undefined);
    return next;
  }
}
