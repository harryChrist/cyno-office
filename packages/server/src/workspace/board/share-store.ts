import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { BOARD_SHARE_TOKEN_PATTERN, publicBoardPath, type BoardShare } from "@cyno/shared";
import { writeJsonAtomic } from "../../store/atomic-write";

/** Uma linha do arquivo `DATA_DIR/board-shares.json` (arquivo da PLATAFORMA: o token nunca entra em `Board` nem em evento). */
export type BoardShareEntry = { token: string; ws: string; boardId: string; createdAt: string; expiresAt?: string };

const DAY_MS = 86_400_000;
const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

/**
 * Os links públicos dos Quadros: um por quadro, em memória pelo sha256 do token e em disco (escrita atômica).
 * Quem tem o token vê só aquele quadro; achar por token confere a validade (vencido some do arquivo).
 */
export class BoardShareStore {
  private entries: BoardShareEntry[] = [];
  private byHash = new Map<string, BoardShareEntry>();
  /** Serializa as gravações: duas mudanças seguidas nunca se atropelam. */
  private writing: Promise<unknown> = Promise.resolve();

  private constructor(
    private readonly file: string,
    private readonly now: () => Date,
  ) {}

  static async open(file: string, now: () => Date = () => new Date()): Promise<BoardShareStore> {
    const store = new BoardShareStore(file, now);
    let text: string | undefined;
    try {
      text = await readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (text) {
      const parsed: unknown = JSON.parse(text);
      if (Array.isArray(parsed)) {
        for (const raw of parsed as Partial<BoardShareEntry>[]) {
          if (typeof raw?.token === "string" && BOARD_SHARE_TOKEN_PATTERN.test(raw.token) && typeof raw.ws === "string" && typeof raw.boardId === "string" && typeof raw.createdAt === "string") {
            store.entries.push({ token: raw.token, ws: raw.ws, boardId: raw.boardId, createdAt: raw.createdAt, ...(typeof raw.expiresAt === "string" ? { expiresAt: raw.expiresAt } : {}) });
          }
        }
      }
    }
    store.reindex();
    return store;
  }

  private reindex(): void {
    this.byHash = new Map(this.entries.map((entry) => [hashToken(entry.token), entry]));
  }

  private persist(): Promise<void> {
    const snapshot = structuredClone(this.entries);
    const run = this.writing.then(async () => {
      await mkdir(path.dirname(this.file), { recursive: true });
      await writeJsonAtomic(this.file, snapshot, 0o600);
    });
    this.writing = run.catch(() => undefined);
    return run;
  }

  private expired(entry: BoardShareEntry): boolean {
    return entry.expiresAt !== undefined && Date.parse(entry.expiresAt) <= this.now().getTime();
  }

  private view(entry: BoardShareEntry): BoardShare {
    return { shared: true, token: entry.token, path: publicBoardPath(entry.token), createdAt: entry.createdAt, ...(entry.expiresAt ? { expiresAt: entry.expiresAt } : {}) };
  }

  private entryOf(ws: string, boardId: string): BoardShareEntry | undefined {
    return this.entries.find((entry) => entry.ws === ws && entry.boardId === boardId);
  }

  private expiryFrom(days: number | undefined): string | undefined {
    return days && days > 0 ? new Date(this.now().getTime() + days * DAY_MS).toISOString() : undefined;
  }

  /** Estado do compartilhamento (vencido conta como desligado e é apagado). */
  async get(ws: string, boardId: string): Promise<BoardShare> {
    const entry = this.entryOf(ws, boardId);
    if (!entry) return { shared: false };
    if (this.expired(entry)) {
      await this.remove(ws, boardId);
      return { shared: false };
    }
    return this.view(entry);
  }

  /** Liga o link (cria se não houver) ou só troca a validade; `expiresInDays` 0 ou ausente = sem validade. */
  async set(ws: string, boardId: string, expiresInDays?: number): Promise<BoardShare> {
    let entry = this.entryOf(ws, boardId);
    if (entry && this.expired(entry)) {
      this.drop(entry);
      entry = undefined;
    }
    const expiresAt = this.expiryFrom(expiresInDays);
    if (entry) {
      if (expiresAt) entry.expiresAt = expiresAt;
      else delete entry.expiresAt;
    } else {
      entry = { token: randomBytes(32).toString("base64url"), ws, boardId, createdAt: this.now().toISOString(), ...(expiresAt ? { expiresAt } : {}) };
      this.entries.push(entry);
    }
    this.reindex();
    await this.persist();
    return this.view(entry);
  }

  /** Token novo (o antigo para de funcionar), mantendo a validade; `undefined` se o quadro não está compartilhado. */
  async rotate(ws: string, boardId: string): Promise<BoardShare | undefined> {
    const entry = this.entryOf(ws, boardId);
    if (!entry || this.expired(entry)) return undefined;
    entry.token = randomBytes(32).toString("base64url");
    this.reindex();
    await this.persist();
    return this.view(entry);
  }

  /** Desliga o link (idempotente). */
  async remove(ws: string, boardId: string): Promise<void> {
    const entry = this.entryOf(ws, boardId);
    if (!entry) return;
    this.drop(entry);
    await this.persist();
  }

  private drop(entry: BoardShareEntry): void {
    this.entries = this.entries.filter((item) => item !== entry);
    this.reindex();
  }

  /** Acha o quadro de um token; token malformado, desconhecido ou vencido (a entrada é apagada) = `undefined`. */
  async find(token: string): Promise<{ ws: string; boardId: string } | undefined> {
    if (!BOARD_SHARE_TOKEN_PATTERN.test(token)) return undefined;
    const entry = this.byHash.get(hashToken(token));
    if (!entry) return undefined;
    if (this.expired(entry)) {
      this.drop(entry);
      await this.persist().catch(() => undefined);
      return undefined;
    }
    return { ws: entry.ws, boardId: entry.boardId };
  }

  /** Espera as gravações pedidas. */
  idle(): Promise<void> {
    return this.writing.then(() => undefined);
  }
}
