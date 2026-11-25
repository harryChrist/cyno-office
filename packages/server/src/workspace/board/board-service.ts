import { mkdir, readFile, realpath, rm, stat } from "node:fs/promises";
import path from "node:path";
import {
  applyMergePatch,
  BOARD_LIMITS,
  boardActivityAt,
  boardsFileSchema,
  nextBoardId,
  type Board,
  type BoardChange,
  type ServerEvent,
  type UpdateBoardBody,
} from "@cyno/shared";
import type { FastifyBaseLogger } from "fastify";
import { HttpError } from "../../platform/http/errors";
import { isPathInside } from "../../platform/os";
import { writeFileAtomic, writeJsonAtomic } from "../../store/atomic-write";
import { DataFileError } from "../../store/files";
import type { WriteQueue } from "../../store/write-queue";

/** Erro de uma ferramenta MCP (mensagem em inglês, o modelo lê). */
export class BoardToolError extends Error {}

export type BoardServiceDeps = {
  /** data/workspaces/<id>/boards/ */
  dir: string;
  /** data/workspaces/<id>/boards/boards.json */
  file: string;
  /** boards/<id>/ (page.html e data.json). */
  boardDir: (id: string) => string;
  /** A mesma fila de escrita do workspace. */
  queue: WriteQueue;
  publish: (event: ServerEvent) => void;
  log: Pick<FastifyBaseLogger, "warn" | "error">;
  now: () => Date;
};

/** O que `create` e `savePage` aceitam (tudo texto já validado em tipo pelo chamador). */
export type BoardWrite = { title?: string; description?: string; source?: string; html?: string };

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/**
 * Quadros do workspace: índice em boards/boards.json (em memória) e, por quadro, boards/<id>/page.html e
 * boards/<id>/data.json (só em disco: os dados podem passar de 10 MB e ninguém os lê ao subir). Toda mudança
 * roda dentro da fila de escrita do workspace (lê, muda, grava, avisa), então duas ferramentas ao mesmo tempo
 * nunca perdem uma a mudança da outra, e a interface é avisada por board:upserted / board:deleted.
 */
export class BoardService {
  private items: Board[] = [];

  constructor(private readonly deps: BoardServiceDeps) {}

  /** Lê o índice do disco (ausente = nenhum quadro). Chamar uma vez ao abrir o workspace. */
  async load(): Promise<void> {
    let text: string;
    try {
      text = await readFile(this.deps.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const parsed = boardsFileSchema.safeParse(JSON.parse(text));
    if (!parsed.success) throw new DataFileError(this.deps.file, parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`));
    this.items = parsed.data;
  }

  // ---------- Leitura ----------

  /** Os mexidos por último primeiro. */
  list(): Board[] {
    return structuredClone([...this.items].sort((a, b) => boardActivityAt(b).localeCompare(boardActivityAt(a)) || b.id.localeCompare(a.id)));
  }

  find(id: string): Board | undefined {
    const found = this.items.find((item) => item.id === id);
    return found ? structuredClone(found) : undefined;
  }

  get(id: string): Board {
    const found = this.find(id);
    if (!found) throw new HttpError(404, `Quadro "${id}" não encontrado`);
    return found;
  }

  /** O HTML da página ("" se o arquivo sumiu). */
  async readPage(id: string): Promise<string> {
    this.get(id);
    return readFile(path.join(this.deps.boardDir(id), "page.html"), "utf8").catch(() => "");
  }

  /** Os dados como texto JSON ("{}" se o arquivo sumiu). */
  async readData(id: string): Promise<string> {
    this.get(id);
    return readFile(path.join(this.deps.boardDir(id), "data.json"), "utf8").catch(() => "{}");
  }

  /** Espera as gravações pedidas. */
  flush(): Promise<void> {
    return this.deps.queue.idle();
  }

  // ---------- Criação e alteração (ferramentas dos agentes; erros em inglês) ----------

  /** Quadro novo com a página (os dados começam como {}). */
  create(input: BoardWrite & { title: string; description: string; html: string; createdBy: string }): Promise<Board> {
    return this.run(async () => {
      this.checkText(input);
      this.checkPage(input.html);
      if (this.items.length >= BOARD_LIMITS.max) throw new BoardToolError(`This workspace already has ${BOARD_LIMITS.max} boards (the maximum). Update an existing one (board_list) instead of creating another.`);
      const now = this.deps.now().toISOString();
      const id = nextBoardId(this.items);
      const dir = this.deps.boardDir(id);
      await mkdir(dir, { recursive: true });
      await writeFileAtomic(path.join(dir, "page.html"), input.html);
      await writeFileAtomic(path.join(dir, "data.json"), "{}");
      const board: Board = {
        id,
        title: input.title.trim(),
        description: input.description.trim(),
        ...(input.source?.trim() ? { source: input.source.trim() } : {}),
        createdBy: input.createdBy,
        createdAt: now,
        pageUpdatedAt: now,
        dataUpdatedAt: now,
        pageBytes: Buffer.byteLength(input.html),
        dataBytes: 2,
      };
      this.items.push(board);
      await this.writeIndex();
      this.deps.publish({ type: "board:upserted", board: structuredClone(board), changed: ["meta", "page", "data"], created: true });
      return structuredClone(board);
    });
  }

  /** Troca a página e/ou os detalhes de um quadro (`source: ""` apaga o campo). */
  save(id: string, input: BoardWrite): Promise<Board> {
    return this.run(async () => {
      const board = this.must(id);
      this.checkText(input);
      const changed: BoardChange[] = [];
      if (input.title !== undefined && input.title.trim() !== board.title) { board.title = input.title.trim(); changed.push("meta"); }
      if (input.description !== undefined && input.description.trim() !== board.description) { board.description = input.description.trim(); changed.push("meta"); }
      if (input.source !== undefined && (input.source.trim() || undefined) !== board.source) {
        if (input.source.trim()) board.source = input.source.trim();
        else delete board.source;
        if (!changed.includes("meta")) changed.push("meta");
      }
      if (input.html !== undefined) {
        this.checkPage(input.html);
        await writeFileAtomic(path.join(this.deps.boardDir(id), "page.html"), input.html);
        board.pageBytes = Buffer.byteLength(input.html);
        board.pageUpdatedAt = this.deps.now().toISOString();
        changed.push("page");
      }
      if (changed.length > 0) {
        await this.writeIndex();
        this.deps.publish({ type: "board:upserted", board: structuredClone(board), changed });
      }
      return structuredClone(board);
    });
  }

  /** Troca os dados inteiros (JSON em texto ou já lido). Guarda compacto. */
  setData(id: string, input: { text: string } | { value: unknown }): Promise<Board> {
    return this.run(async () => {
      const board = this.must(id);
      const compact = "text" in input ? this.parseData(input.text) : this.compact(input.value);
      return this.writeData(board, compact);
    });
  }

  /** JSON Merge Patch (RFC 7396) sobre os dados atuais. */
  patchData(id: string, patch: unknown): Promise<Board> {
    return this.run(async () => {
      const board = this.must(id);
      let current: unknown;
      try {
        current = JSON.parse(await readFile(path.join(this.deps.boardDir(id), "data.json"), "utf8"));
      } catch {
        current = {};
      }
      return this.writeData(board, this.compact(applyMergePatch(current, patch)));
    });
  }

  // ---------- Alteração do dono (rotas; erros em português) ----------

  /** O dono renomeia (título e descrição). */
  rename(id: string, patch: UpdateBoardBody): Promise<Board> {
    return this.run(async () => {
      const board = this.items.find((item) => item.id === id);
      if (!board) throw new HttpError(404, `Quadro "${id}" não encontrado`);
      if (patch.title !== undefined) board.title = patch.title.trim();
      if (patch.description !== undefined) board.description = patch.description.trim();
      await this.writeIndex();
      this.deps.publish({ type: "board:upserted", board: structuredClone(board), changed: ["meta"] });
      return structuredClone(board);
    });
  }

  /** Apaga o quadro e a pasta dele (só o dono, pela rota). */
  async delete(id: string): Promise<void> {
    await this.deps.queue.enqueue(async () => {
      const index = this.items.findIndex((item) => item.id === id);
      if (index < 0) throw new HttpError(404, `Quadro "${id}" não encontrado`);
      this.items.splice(index, 1);
      await this.writeIndex();
      await rm(this.deps.boardDir(id), { recursive: true, force: true });
      this.deps.publish({ type: "board:deleted", id });
    });
  }

  // ---------- Internos ----------

  /** Roda uma mudança dentro da fila de escrita e devolve o resultado (erros voltam a quem chamou). */
  private run<T>(task: () => Promise<T>): Promise<T> {
    let result!: T;
    return this.deps.queue
      .enqueue(async () => {
        result = await task();
      })
      .then(() => result);
  }

  private must(id: string): Board {
    const board = this.items.find((item) => item.id === id);
    if (!board) throw new BoardToolError(`Board ${id} does not exist (see board_list).`);
    return board;
  }

  private checkText(input: BoardWrite): void {
    if (input.title !== undefined && (!input.title.trim() || input.title.trim().length > BOARD_LIMITS.title)) throw new BoardToolError(`title must have 1 to ${BOARD_LIMITS.title} characters.`);
    if (input.description !== undefined && input.description.trim().length > BOARD_LIMITS.description) throw new BoardToolError(`description is too long (max ${BOARD_LIMITS.description} characters): keep it to one line.`);
    if (input.source !== undefined && input.source.trim().length > BOARD_LIMITS.source) throw new BoardToolError(`source is too long (max ${BOARD_LIMITS.source} characters).`);
  }

  private checkPage(html: string): void {
    const bytes = Buffer.byteLength(html);
    if (bytes === 0 || !html.trim()) throw new BoardToolError("The page HTML is empty.");
    if (bytes > BOARD_LIMITS.pageBytes) throw new BoardToolError(`The page is too large (${mb(bytes)}; max ${mb(BOARD_LIMITS.pageBytes)}). Keep data out of the HTML: put it in the board data and read it with Quadro.data.`);
  }

  /** Texto JSON -> JSON compacto (erro claro se inválido ou grande demais). */
  private parseData(text: string): string {
    const bytes = Buffer.byteLength(text);
    if (bytes > BOARD_LIMITS.dataBytes * 2) throw new BoardToolError(`The data is too large (${mb(bytes)}; max ${mb(BOARD_LIMITS.dataBytes)} once compact). Trim it or split it across boards.`);
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch (error) {
      throw new BoardToolError(`Invalid JSON: ${error instanceof Error ? error.message : String(error)}. Send valid JSON (double-quoted keys, no comments, no trailing commas).`);
    }
    return this.compact(value);
  }

  private compact(value: unknown): string {
    const text = JSON.stringify(value === undefined ? null : value);
    const bytes = Buffer.byteLength(text);
    if (bytes > BOARD_LIMITS.dataBytes) throw new BoardToolError(`The data is too large (${mb(bytes)}; max ${mb(BOARD_LIMITS.dataBytes)}). Trim it or split it across boards.`);
    return text;
  }

  private async writeData(board: Board, compact: string): Promise<Board> {
    await writeFileAtomic(path.join(this.deps.boardDir(board.id), "data.json"), compact);
    board.dataBytes = Buffer.byteLength(compact);
    board.dataUpdatedAt = this.deps.now().toISOString();
    await this.writeIndex();
    this.deps.publish({ type: "board:upserted", board: structuredClone(board), changed: ["data"] });
    return structuredClone(board);
  }

  private async writeIndex(): Promise<void> {
    await mkdir(this.deps.dir, { recursive: true });
    await writeJsonAtomic(this.deps.file, this.items);
  }
}

/**
 * Lê um arquivo que o agente indicou (HTML da página ou JSON dos dados): o caminho relativo vale a partir da
 * PASTA DO AGENTE; um caminho absoluto vale se estiver na pasta do agente ou numa pasta de trabalho que ele pode
 * ler (`extraRoots`). Resolvido com realpath: links simbólicos e `..` que saem dessas pastas são recusados.
 */
export async function readBoardInputFile(agentDir: string, extraRoots: readonly string[], requested: string, maxBytes: number): Promise<string> {
  const roots: string[] = [];
  for (const root of [agentDir, ...extraRoots]) {
    const real = await realpath(root).catch(() => undefined);
    if (real) roots.push(real);
  }
  if (roots.length === 0) throw new BoardToolError("Your agent folder is not available.");
  let real: string;
  try {
    real = await realpath(path.resolve(roots[0]!, requested));
  } catch {
    throw new BoardToolError(`File not found: ${requested}. Pass a path relative to your folder, or an absolute path inside a work folder you can read.`);
  }
  if (!roots.some((root) => isPathInside(real, root))) throw new BoardToolError("The file must be inside your own agent folder or a work folder you can read (links and \"..\" that leave them are refused).");
  const info = await stat(real);
  if (!info.isFile()) throw new BoardToolError(`${requested} is not a file.`);
  if (info.size > maxBytes) throw new BoardToolError(`${path.basename(real)} is too large (${mb(info.size)}; max ${mb(maxBytes)}).`);
  return readFile(real, "utf8");
}
