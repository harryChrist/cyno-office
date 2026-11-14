import {
  cloneFrame,
  dayKeyOf,
  diffFrames,
  HARD_LIMIT_BYTES,
  isDayKey,
  KEYFRAME_MS,
  keyframeOf,
  SOFT_KEYFRAME_MS,
  SOFT_LIMIT_BYTES,
  SOFT_THROTTLE_MS,
  THROTTLE_MS,
  TIMELINE_RETENTION_DAYS,
  addDays,
  type SceneFrame,
  type TimelineRecord,
} from "@cyno/shared";
import { mkdirSync, readdirSync, rmSync, statSync, openSync, readSync, closeSync, appendFileSync } from "node:fs";
import path from "node:path";

/** Pasta da linha do tempo de um workspace: `<workspace>/timeline/AAAA-MM-DD.jsonl`. */
export function timelineDir(workspaceDir: string): string {
  return path.join(workspaceDir, "timeline");
}

export const timelineFile = (dir: string, day: string): string => path.join(dir, `${day}.jsonl`);

/** O relógio interno do gravador. */
export const RECORDER_TICK_MS = 500;
/** Mesmo sem evento, o estado é relido de tempos em tempos (a ferramenta que vence, a cota que volta). */
export const RECORDER_POLL_MS = 2_000;
/** Depois de uma falha de disco, tenta de novo (com quadro completo) depois disto. */
export const RETRY_AFTER_FAILURE_MS = 60_000;

export type RecorderDeps = {
  dir: string;
  /** O quadro de agora. */
  sample: () => SceneFrame;
  now: () => number;
  log: { warn: (object: unknown, message: string) => void };
};

/**
 * O gravador do "Rever o dia": a cada instante em que algo que a cena desenha mudou (no máximo uma vez por
 * segundo) acrescenta ao arquivo do dia um registro com as mudanças, e a cada 5 minutos um quadro completo.
 *
 * - Primeiro registro depois de subir: quadro completo com `boot` (o que existia antes não vira tempo).
 * - Um arquivo por dia de São Paulo; na virada, o novo começa por um quadro completo. Retenção de 7 dias.
 * - Acima de 8 MB no dia: mudança a cada 15 s e quadro completo a cada 15 min; acima de 12 MB: para até a virada.
 * - Falha de disco: avisa uma vez, tenta de novo em 1 min com quadro completo. Escrita por acréscimo: uma linha
 *   por registro; se o processo morrer no meio, só a última linha fica cortada (a leitura a ignora e este
 *   gravador começa a próxima numa linha nova).
 * - Observação: `observe()` só marca "mudou"; quem lê o estado é `sample()`, no ritmo do gravador. O relógio de
 *   estados da diária e este compartilham o mesmo ouvinte de eventos do workspace (ver runtime.ts).
 */
export class TimelineRecorder {
  private day = "";
  private bytes = 0;
  private prev: SceneFrame | null = null;
  private lastWrite = 0;
  private lastKeyframe = 0;
  private lastSample = 0;
  private dirty = true;
  private boot = true;
  private halted = false;
  private needsNewline = false;
  private failedAt: number | null = null;
  private warned = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;

  constructor(private readonly deps: RecorderDeps) {}

  start(options: { timers?: boolean } = {}): void {
    try {
      mkdirSync(this.deps.dir, { recursive: true });
    } catch (error) {
      this.fail(error);
    }
    this.openDay(this.deps.now());
    this.prune(this.deps.now());
    if (options.timers !== false) {
      this.timer = setInterval(() => this.tick(), RECORDER_TICK_MS);
      this.timer.unref?.();
    }
  }

  /** Algo que pode ter mudado o que a cena desenha aconteceu. */
  observe(): void {
    this.dirty = true;
  }

  /** O que já foi gravado hoje (bytes). */
  size(): number {
    return this.bytes;
  }

  /** Um batimento: lê o estado se mudou (ou se passou o tempo da releitura) e grava o que for preciso. */
  tick(): void {
    if (this.stopped) return;
    const now = this.deps.now();
    if (dayKeyOf(now) !== this.day) this.rollOver(now);
    if (this.halted) return;
    if (this.failedAt !== null) {
      if (now - this.failedAt < RETRY_AFTER_FAILURE_MS) return;
      this.failedAt = null;
      this.prev = null; // volta com quadro completo
    }
    const soft = this.bytes >= SOFT_LIMIT_BYTES;
    const keyframeEvery = soft ? SOFT_KEYFRAME_MS : KEYFRAME_MS;
    const throttle = soft ? SOFT_THROTTLE_MS : THROTTLE_MS;
    const keyframeDue = this.prev === null || now - this.lastKeyframe >= keyframeEvery;
    const sinceWrite = now - this.lastWrite;
    if (!keyframeDue && !(sinceWrite >= throttle && (this.dirty || now - this.lastSample >= RECORDER_POLL_MS))) return;
    if (this.bytes >= HARD_LIMIT_BYTES) {
      this.append({ t: "end", at: now, reason: "limit" });
      this.halted = true;
      return;
    }
    const frame = this.deps.sample();
    this.lastSample = now;
    this.dirty = false;
    if (keyframeDue) {
      if (this.append(keyframeOf(frame, now, keyframeEvery, this.boot))) {
        this.boot = false;
        this.prev = cloneFrame(frame);
        this.lastKeyframe = now;
        this.lastWrite = now;
      }
      return;
    }
    const changes = diffFrames(this.prev!, frame);
    if (!changes) return;
    if (this.append({ t: "d", at: now, ...changes })) {
      this.prev = cloneFrame(frame);
      this.lastWrite = now;
    }
  }

  /** Para os batimentos e marca o fim do que foi gravado. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.prev !== null && !this.halted && this.failedAt === null) this.append({ t: "end", at: this.deps.now(), reason: "stop" });
  }

  // ---------------------------------------------------------------- internos

  private append(record: TimelineRecord): boolean {
    const line = `${this.needsNewline ? "\n" : ""}${JSON.stringify(record)}\n`;
    try {
      appendFileSync(timelineFile(this.deps.dir, this.day), line);
    } catch (error) {
      this.fail(error);
      return false;
    }
    this.needsNewline = false;
    this.bytes += Buffer.byteLength(line);
    this.warned = false;
    return true;
  }

  private fail(error: unknown): void {
    this.failedAt = this.deps.now();
    if (this.warned) return;
    this.warned = true;
    this.deps.log.warn({ err: error }, "não foi possível gravar a linha do tempo do dia; tento de novo em 1 minuto");
  }

  /** Abre o dia: o tamanho que o arquivo já tem (reinício no meio do dia) e se a última linha ficou cortada. */
  private openDay(now: number): void {
    this.day = dayKeyOf(now);
    this.bytes = 0;
    this.halted = false;
    this.needsNewline = false;
    this.prev = null;
    this.dirty = true;
    const file = timelineFile(this.deps.dir, this.day);
    try {
      const size = statSync(file).size;
      this.bytes = size;
      if (size > 0) {
        const fd = openSync(file, "r");
        try {
          const last = Buffer.alloc(1);
          readSync(fd, last, 0, 1, size - 1);
          this.needsNewline = last[0] !== 0x0a;
        } finally {
          closeSync(fd);
        }
      }
    } catch {
      // Sem arquivo ainda: o primeiro registro o cria.
    }
  }

  private rollOver(now: number): void {
    this.openDay(now);
    this.boot = false; // não é um reinício: o servidor seguiu de pé
    this.prune(now);
  }

  /** Apaga os dias mais velhos que a retenção. */
  private prune(now: number): void {
    const oldest = addDays(dayKeyOf(now), -(TIMELINE_RETENTION_DAYS - 1));
    let names: string[];
    try {
      names = readdirSync(this.deps.dir);
    } catch {
      return;
    }
    for (const name of names) {
      const day = name.endsWith(".jsonl") ? name.slice(0, -6) : undefined;
      if (!day || !isDayKey(day) || day >= oldest) continue;
      try {
        rmSync(path.join(this.deps.dir, name), { force: true });
      } catch {
        // Fica para a próxima.
      }
    }
  }
}
