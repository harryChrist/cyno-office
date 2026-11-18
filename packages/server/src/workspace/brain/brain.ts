import { randomUUID } from "node:crypto";
import { link, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  BRAIN_FIXED_FILES,
  BRAIN_HISTORY_DIR,
  BRAIN_RULE_TAG,
  GLOBAL_BRAIN_ID,
  isSafeId,
  slugify,
  LOBBY_BRAIN_NAME,
  type BrainContext,
  type BrainNoteResponse,
  type BrainNoteSummary,
  type BrainSummary,
  type Room,
} from "@cyno/shared";
import type { DataPaths } from "../../store/paths";
import { writeFileAtomic } from "../../store/atomic-write";
import { newestFirst, noteDate, noteTags, summarizeNote } from "./browse";
import { buildContext, type ContextAgent } from "./context";
import { parseFrontmatter, patchFrontmatter, renderFields, renderFrontmatter, replaceBody, type NoteFrontmatter } from "./frontmatter";
import { ensureFixedFiles, moveResultsToHistory } from "./migrate";
import {
  datedNoteFileName,
  historyFile,
  isFixedFile as isFixedFileName,
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
  /** Regras do próprio agente (`agents/<id>/regras.md`), para o contexto das tarefas dele. */
  readAgentRules?: (agentId: string) => Promise<string>;
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

  /**
   * Contexto de um agente no quarto: só as regras (as do `agent`, do quarto e do lobby) e o briefing;
   * `query` (o texto da tarefa) ordena a lista de títulos das outras notas.
   */
  buildContext(roomId: string, query = "", agent?: ContextAgent): Promise<BrainContext> {
    return buildContext(
      { rooms: this.deps.rooms, readNotes: (id) => this.readNotes(id), ...(this.deps.readAgentRules ? { readAgentRules: this.deps.readAgentRules } : {}), now: this.now },
      roomId,
      query,
      agent,
    );
  }

  /**
   * Troca o texto do `_regras.md` de um Cérebro (o dono edita): o frontmatter fica `tipo: regras` com
   * `atualizado`, o resto é o texto novo. Cria o arquivo se faltar. Devolve a nota como o navegador lê.
   */
  async setRules(brainId: string, content: string): Promise<BrainNoteResponse> {
    if (!this.hasBrain(brainId)) throw new Error(`Cérebro "${brainId}" não existe`);
    await this.serial(brainId, () => this.writeRules(brainId, content));
    const note = await this.readNote(brainId, BRAIN_FIXED_FILES.regras);
    if (!note) throw new Error("Não consegui ler o _regras.md depois de gravar");
    return note;
  }

  /** Grava o `_regras.md` (quem chama já está na fila de escrita do Cérebro). */
  private async writeRules(brainId: string, content: string): Promise<void> {
    const dir = this.dir(brainId);
    await mkdir(dir, { recursive: true });
    const frontmatter = renderFields({ tipo: "regras", atualizado: this.now().toISOString() });
    // A tela manda só o texto (sem o título): o título do arquivo volta aqui, para a nota não ficar sem nome.
    const body = content.trim();
    const heading = /^#\s+\S/.test(body) ? "" : `# Regras — ${this.scope(brainId)?.name ?? brainId}\n\n`;
    await writeFileAtomic(path.join(dir, BRAIN_FIXED_FILES.regras), `${frontmatter}\n${heading}${body}\n`);
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

  // ---------- Organizar o Cérebro (só depois do OK do dono; nada é apagado: o que sai da raiz vai para `historico/`) ----------

  /** Lê a nota da raiz inteira (sem o corte de leitura: o que vai para o histórico não pode perder texto). */
  private async readRootFull(brainId: string, file: string): Promise<string> {
    const dir = this.dir(brainId);
    if (!isNoteFileName(file) || (noteLayer(file) !== "note" && file !== BRAIN_FIXED_FILES.regras)) throw new Error(`Nome de nota inválido: "${file}"`);
    if (!(await listNoteFiles(dir)).includes(file)) throw new Error(`A nota "${brainId}/${file}" não existe mais na raiz do Cérebro`);
    return readFile(path.join(dir, file), "utf8");
  }

  /**
   * Grava uma cópia datada em `historico/` (nunca sobrescreve: tenta outros sufixos). A data do nome é a da
   * própria nota, quando ela tem uma; senão, agora. Devolve "historico/<nome>.md".
   */
  private async writeToHistory(brainId: string, content: string, title: string, motivo: string, sourceFile = ""): Promise<string> {
    const dir = path.join(this.dir(brainId), BRAIN_HISTORY_DIR);
    await mkdir(dir, { recursive: true });
    const { frontmatter } = parseFrontmatter(content);
    const own = noteDate(sourceFile, frontmatter);
    const date = own ? new Date(own) : this.now();
    const archived = patchFrontmatter(content, { arquivado: this.now().toISOString(), motivo });
    for (let attempt = 1; attempt <= MAX_NAME_ATTEMPTS; attempt++) {
      const name = datedNoteFileName(date, title, attempt);
      try {
        await createFileAtomic(path.join(dir, name), archived);
        return historyFile(name);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    throw new Error(`Não foi possível escolher um nome livre para a nota em ${dir}`);
  }

  /** Tira a linha da nota (`[[nome]]`) do `_indice.md`, se ele existir. */
  private async removeFromIndex(dir: string, file: string): Promise<void> {
    if (!(await listNoteFiles(dir)).includes(BRAIN_FIXED_FILES.indice)) return;
    const indexPath = path.join(dir, BRAIN_FIXED_FILES.indice);
    const current = await readFile(indexPath, "utf8");
    const mark = `[[${file.replace(/\.md$/i, "")}]]`;
    const lines = current.split("\n");
    const kept = lines.filter((line) => !line.includes(mark));
    if (kept.length !== lines.length) await writeFileAtomic(indexPath, kept.join("\n"));
  }

  /** Move a nota da raiz para o histórico: grava a nova, depois remove a antiga (uma queda no meio nunca perde a nota). */
  private async archiveUnlocked(brainId: string, file: string, motivo = "organizar"): Promise<string> {
    if (isFixedFileName(file)) throw new Error(`O arquivo fixo "${file}" não vai para o histórico`);
    const content = await this.readRootFull(brainId, file);
    const historyName = await this.writeToHistory(brainId, content, noteTitle(file, content), motivo, file);
    await rm(path.join(this.dir(brainId), file), { force: true });
    await this.removeFromIndex(this.dir(brainId), file);
    return historyName;
  }

  /** Organizar: a nota da raiz vai para `historico/` com `arquivado` e `motivo: organizar`, e sai do `_indice`. Devolve o arquivo do histórico. */
  archiveRootNote(brainId: string, file: string): Promise<string> {
    return this.serial(brainId, () => this.archiveUnlocked(brainId, file));
  }

  /**
   * Organizar: a nota vira regra (tag `regra` e `tipo: regra`; o corpo fica). Com `content`, a versão atual vai para o
   * histórico e o corpo passa a ser esse texto curto (o título `# …` fica). Devolve o arquivo do histórico, se houve.
   */
  makeRootNoteRule(brainId: string, file: string, content?: string): Promise<string | undefined> {
    return this.serial(brainId, async () => {
      const current = await this.readRootFull(brainId, file);
      const { frontmatter } = parseFrontmatter(current);
      const tags = [...new Set([...noteTags(frontmatter), BRAIN_RULE_TAG])];
      const fullPath = path.join(this.dir(brainId), file);
      if (content === undefined) {
        await writeFileAtomic(fullPath, patchFrontmatter(current, { tipo: "regra", tags }));
        return undefined;
      }
      const historyName = await this.writeToHistory(brainId, current, noteTitle(file, current), "organizar", file);
      const title = noteTitle(file, current);
      await writeFileAtomic(fullPath, replaceBody(current, `# ${title}\n\n${content.trim()}`, { tipo: "regra", tags, atualizado: this.now().toISOString() }));
      return historyName;
    });
  }

  /** Organizar: a versão atual vai para o histórico e o corpo da nota passa a ser `content` (o título e o resto do frontmatter ficam; entra `atualizado`). */
  rewriteRootNote(brainId: string, file: string, content: string): Promise<string> {
    return this.serial(brainId, async () => {
      const current = await this.readRootFull(brainId, file);
      const title = noteTitle(file, current);
      const historyName = await this.writeToHistory(brainId, current, title, "organizar", file);
      await writeFileAtomic(path.join(this.dir(brainId), file), replaceBody(current, `# ${title}\n\n${content.trim()}`, { atualizado: this.now().toISOString() }));
      return historyName;
    });
  }

  /**
   * Organizar: cria a nota nova (`tipo: doc`, autor Maestro, tags das originais sem `regra`) com o nome do título, entra no
   * `_indice`, e só então manda cada original para o histórico. Confere todas as originais antes de criar qualquer coisa.
   */
  mergeRootNotes(brainId: string, input: { files: string[]; title: string; content: string }): Promise<{ file: string; archived: string[] }> {
    return this.serial(brainId, async () => {
      const tags = new Set<string>();
      for (const file of input.files) {
        const current = await this.readRootFull(brainId, file);
        for (const tag of noteTags(parseFrontmatter(current).frontmatter)) tags.add(tag);
      }
      tags.delete(BRAIN_RULE_TAG);
      const dir = this.dir(brainId);
      const title = input.title.replace(/\s+/g, " ").trim();
      const content = `${renderFields({ tipo: "doc", autor: "Maestro", data: this.now().toISOString(), tags: [...tags] })}\n# ${title}\n\n${input.content.trim()}\n`;
      const base = slugify(title, "nota").slice(0, 48).replace(/-+$/g, "");
      let created: string | undefined;
      for (let attempt = 1; attempt <= MAX_NAME_ATTEMPTS && !created; attempt++) {
        const name = `${base}${attempt > 1 ? `-${attempt}` : ""}.md`;
        if (input.files.includes(name) || isFixedFileName(name)) continue;
        try {
          await createFileAtomic(path.join(dir, name), content);
          created = name;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
      }
      if (!created) throw new Error("Não consegui um nome livre para a nota resumida");
      await this.appendToIndex(dir, created, `- [[${created.replace(/\.md$/i, "")}]] — ${title.slice(0, 100)}`);
      const archived: string[] = [];
      for (const file of input.files) archived.push(await this.archiveUnlocked(brainId, file));
      return { file: created, archived };
    });
  }

  /** Organizar: a versão atual do `_regras.md` vai para o histórico (`regras-anteriores`) e o texto novo entra no lugar. Devolve o arquivo do histórico. */
  replaceRulesWithHistory(brainId: string, content: string): Promise<string> {
    return this.serial(brainId, async () => {
      const current = await this.readRootFull(brainId, BRAIN_FIXED_FILES.regras);
      const historyName = await this.writeToHistory(brainId, current, "regras-anteriores", "organizar");
      await this.writeRules(brainId, content);
      return historyName;
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
