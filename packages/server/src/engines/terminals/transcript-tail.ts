import { open, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

const SESSION_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

/** Mais que isto por leitura fica para a próxima volta (uma conversa enorme não trava o server). */
const MAX_READ_BYTES = 4 * 1024 * 1024;

export type TranscriptTailOptions = {
  /** Pasta das conversas do cwd do agente (`~/.claude/projects/<cwd codificado>`). */
  dir: string;
  /** Sessão a seguir (o arquivo `<sessionId>.jsonl`, que pode ainda não existir). */
  sessionId: string;
  /** Começar do fim do arquivo (sessão retomada: o que já estava lá não é novidade). */
  fromEnd: boolean;
  /** Intervalo da consulta ao disco (ms). */
  pollMs: number;
  onLine: (line: string, sessionId: string) => void;
  /** O agente passou a escrever em outra conversa (ex.: `/clear` ou `/resume` no terminal). */
  onSession: (sessionId: string) => void;
};

/**
 * Acompanha a conversa que o Claude Code interativo grava em disco (`<sessão>.jsonl`), como um
 * `tail -f` por consulta (fs.watch não é confiável em todos os sistemas de arquivos): a cada volta lê
 * o que entrou desde a última e entrega as linhas completas. Se outra conversa da mesma pasta cresce
 * depois desta (o `/clear` abre uma sessão nova; o `/resume` volta a uma antiga), segue essa (só o
 * que ela ganhou de novo) e avisa. Nunca lança.
 */
export class TranscriptTail {
  private sessionId: string;
  private offset = -1;
  private pending = "";
  private decoder = new StringDecoder("utf8");
  private currentMtime = 0;
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private stopped = false;
  private ticks = 0;
  /** Até onde já se conhece cada conversa da pasta (as que existiam antes e as que já foram seguidas). */
  private readonly known = new Map<string, number>();

  constructor(private readonly options: TranscriptTailOptions) {
    this.sessionId = options.sessionId;
  }

  current(): string {
    return this.sessionId;
  }

  /**
   * Anota até onde cada conversa que já está na pasta vai (chame antes de subir a CLI): o que já
   * estava lá nunca é novidade (um `/resume` numa antiga só traz o que vier depois).
   */
  async prime(): Promise<void> {
    if (this.offset < 0) {
      try {
        this.offset = this.options.fromEnd ? (await stat(this.file())).size : 0;
      } catch {
        this.offset = 0; // ainda não existe: tudo o que vier é novo
      }
    }
    let names: string[];
    try {
      names = await readdir(this.options.dir);
    } catch {
      return;
    }
    for (const name of names) {
      const match = SESSION_FILE.exec(name);
      if (!match || match[1] === this.sessionId) continue;
      try {
        this.known.set(match[1]!, (await stat(path.join(this.options.dir, name))).size);
      } catch {
        // sumiu no meio: não importa
      }
    }
  }

  start(): void {
    if (this.timer || this.stopped) return;
    this.schedule(0);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** Lê já o que houver (testes e antes de decisões que dependem do fim do turno). */
  async poll(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.readCurrent();
      // A pasta é varrida a cada 4 voltas (sessões novas são raras).
      if (this.ticks++ % 4 === 0) await this.scanForNewer();
    } catch {
      // Disco indisponível por um instante: tenta na próxima volta.
    } finally {
      this.running = false;
    }
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.poll().finally(() => this.schedule(this.options.pollMs));
    }, ms);
    this.timer.unref();
  }

  private file(sessionId = this.sessionId): string {
    return path.join(this.options.dir, `${sessionId}.jsonl`);
  }

  private async readCurrent(): Promise<void> {
    let info;
    try {
      info = await stat(this.file());
    } catch {
      return; // ainda não existe (sessão nova sem mensagem)
    }
    if (this.offset < 0) this.offset = this.options.fromEnd ? info.size : 0;
    if (info.size < this.offset) {
      // Encolheu (reescrita): lê de novo do começo.
      this.offset = 0;
      this.pending = "";
      this.decoder = new StringDecoder("utf8");
    }
    this.currentMtime = info.mtimeMs;
    if (info.size === this.offset) return;
    const length = Math.min(info.size - this.offset, MAX_READ_BYTES);
    const handle = await open(this.file(), "r");
    try {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, this.offset);
      this.offset += bytesRead;
      this.pending += this.decoder.write(buffer.subarray(0, bytesRead));
    } finally {
      await handle.close();
    }
    const lines = this.pending.split("\n");
    this.pending = lines.pop() ?? "";
    const sessionId = this.sessionId;
    for (const line of lines) if (line.trim()) this.options.onLine(line, sessionId);
  }

  /** Outra conversa da pasta escrita depois desta (e depois do início) passa a ser a seguida. */
  private async scanForNewer(): Promise<void> {
    let names: string[];
    try {
      names = await readdir(this.options.dir);
    } catch {
      return;
    }
    let best: { sessionId: string; mtime: number } | undefined;
    for (const name of names) {
      const match = SESSION_FILE.exec(name);
      if (!match || match[1] === this.sessionId) continue;
      let info;
      try {
        info = await stat(path.join(this.options.dir, name));
      } catch {
        continue;
      }
      // Só conta uma conversa que cresceu além do que já se conhecia dela, escrita depois da atual.
      if (info.size <= (this.known.get(match[1]!) ?? 0) || info.mtimeMs <= this.currentMtime) continue;
      if (!best || info.mtimeMs > best.mtime) best = { sessionId: match[1]!, mtime: info.mtimeMs };
    }
    if (!best) return;
    if (this.offset >= 0) this.known.set(this.sessionId, this.offset);
    this.sessionId = best.sessionId;
    this.offset = this.known.get(best.sessionId) ?? 0;
    this.pending = "";
    this.decoder = new StringDecoder("utf8");
    this.currentMtime = best.mtime;
    this.options.onSession(best.sessionId);
    await this.readCurrent();
  }
}
