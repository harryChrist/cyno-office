import {
  addDays,
  CLOCK_STATES,
  dayKeyOf,
  DAY_STATS_RETENTION_DAYS,
  emptyClockBucket,
  emptyStateDayFile,
  forEachHour,
  MAX_GAP_MS,
  parseDayKey,
  parseStateDayFile,
  STATE_FLUSH_MS,
  STATE_TICK_MS,
  type ClockMs,
  type ClockState,
  type StateDayFile,
} from "@cyno/shared";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { writeJsonAtomic } from "../../store/atomic-write";
import type { WriteQueue } from "../../store/write-queue";

/** Pasta do relógio de estados de um workspace: `<workspace>/day-stats/AAAA-MM-DD.json` (e `meta.json`). */
export function dayStatsDir(workspaceDir: string): string {
  return path.join(workspaceDir, "day-stats");
}

/** O estado que uma tarefa deveria ter agora e a quem atribuir (o servidor calcula com `taskState`). */
export type DesiredSpan = { taskId: string; state: ClockState; agentId: string; projectId?: string; sprintId?: string };

export type StateClockDeps = {
  dir: string;
  queue: Pick<WriteQueue, "enqueue" | "idle">;
  /** O estado de cada tarefa agora (só as que contam). */
  states: () => readonly DesiredSpan[];
  /** Nomes de agora (o arquivo guarda os últimos vistos: o agente ou o projeto podem sumir depois). */
  names?: () => { agents?: ReadonlyMap<string, string>; projects?: ReadonlyMap<string, string>; sprints?: ReadonlyMap<string, string> };
  now: () => number;
  log: { warn: (object: unknown, message: string) => void };
};

type OpenSpan = DesiredSpan & { since: number };

const NAMES_CAP = 500;
const PAIRS_CAP = 500;

const keyOf = (span: DesiredSpan) => `${span.state}|${span.agentId}|${span.projectId ?? ""}|${span.sprintId ?? ""}`;

/**
 * O relógio de estados ("Meu dia"): registra, por tarefa, os trechos em que ela esteve trabalhando, na fila,
 * esperando outro agente, esperando o Maestro ou sem cota, e soma em baldes de 1 hora (um arquivo por dia de
 * São Paulo, `day-stats/AAAA-MM-DD.json`). "Esperando você" não passa por aqui: vem dos itens do "Para você".
 *
 * - O estado vem de `states()` (calculado do que o servidor sabe: tarefa, projeto, terminal); `observe()` compara
 *   com os trechos abertos a cada evento relevante e fecha/abre o que mudou. Por isso a ordem dos eventos não importa.
 * - A cada `STATE_TICK_MS` soma o parcial dos trechos abertos (o gráfico do dia anda ao vivo) e grava o arquivo
 *   a cada `STATE_FLUSH_MS`, quando mudou (escrita atômica, pela fila do workspace).
 * - Servidor parado não vira tempo: os trechos só vivem em memória, então no boot nada está aberto e o que já foi
 *   somado fica como está (`liveAt` = o último batimento gravado). Um buraco maior que `MAX_GAP_MS` entre dois
 *   batimentos (a máquina dormiu) é cortado: o trecho só conta até o último batimento.
 * - Arquivo ilegível vira `*.corrupt` e o dia recomeça. Arquivos com mais de 90 dias são apagados.
 */
export class StateClock {
  private readonly open = new Map<string, OpenSpan>();
  private readonly files = new Map<string, StateDayFile>();
  private readonly dirty = new Set<string>();
  private lastBeat: number;
  private lastFlush = 0;
  private lastPrune = "";
  private timer: ReturnType<typeof setInterval> | undefined;
  private sinceMs: number | undefined;
  private started = false;
  private stopped = false;

  constructor(private readonly deps: StateClockDeps) {
    this.lastBeat = deps.now();
  }

  /** Abre o relógio: lê o dia de hoje e a data de início, poda os dias velhos e começa a bater. */
  start(options: { timers?: boolean } = {}): void {
    const now = this.deps.now();
    try {
      mkdirSync(this.deps.dir, { recursive: true });
    } catch (error) {
      this.deps.log.warn({ err: error }, "não foi possível criar a pasta do relógio de estados");
    }
    this.loadSince(now);
    this.prune(now);
    this.fileOf(dayKeyOf(now));
    this.lastBeat = now;
    this.started = true;
    this.observe();
    if (options.timers !== false) {
      this.timer = setInterval(() => this.tick(), STATE_TICK_MS);
      this.timer.unref?.();
    }
  }

  /** A partir de quando há registro de estados (ms); `undefined` só antes de `start()`. */
  since(): number | undefined {
    return this.sinceMs;
  }

  /** Quantos trechos estão abertos agora. */
  openCount(): number {
    return this.open.size;
  }

  /** Um evento que pode ter mudado o estado de alguma tarefa: fecha e abre o que mudou. */
  observe(): void {
    this.run(false);
  }

  /** O batimento de `STATE_TICK_MS`: soma o parcial de todos os trechos abertos e grava se passou o tempo. */
  tick(): void {
    this.run(true);
    if (this.dirty.size > 0 && this.deps.now() - this.lastFlush >= STATE_FLUSH_MS) void this.flush();
  }

  /** Para os batimentos, fecha os trechos abertos em "agora" e grava tudo. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    const now = this.deps.now();
    const end = this.integrableEnd(now);
    const hadOpen = this.open.size > 0;
    for (const span of this.open.values()) this.addSpan(span, end);
    this.open.clear();
    this.lastBeat = now;
    if (hadOpen) this.touchLive(now);
    await this.flush();
    await this.deps.queue.idle();
  }

  /** Grava os dias que mudaram (pela fila do workspace; uma falha vai para o log e tenta de novo no próximo batimento). */
  async flush(): Promise<void> {
    this.lastFlush = this.deps.now();
    const days = [...this.dirty];
    this.dirty.clear();
    for (const day of days) {
      const file = this.files.get(day);
      if (!file) continue;
      const content = structuredClone(file);
      await this.deps.queue
        .enqueue(async () => {
          mkdirSync(this.deps.dir, { recursive: true });
          await writeJsonAtomic(this.fileName(day), content);
        })
        .catch((error: unknown) => {
          this.dirty.add(day);
          this.deps.log.warn({ err: error, day }, "não foi possível gravar o relógio de estados");
        });
    }
  }

  /** O arquivo de um dia (o da memória se o relógio mexeu nele; senão o do disco, sem guardar). */
  read(day: string): StateDayFile | undefined {
    const cached = this.files.get(day);
    if (cached) return cached;
    return this.loadFile(day);
  }

  /** Os dias que têm arquivo (do disco e da memória), do mais antigo para o mais novo. */
  days(): string[] {
    const days = new Set<string>();
    try {
      for (const name of readdirSync(this.deps.dir)) {
        const match = /^(\d{4}-\d{2}-\d{2})\.json$/.exec(name);
        if (match && parseDayKey(match[1]!)) days.add(match[1]!);
      }
    } catch {
      // pasta ainda não existe
    }
    for (const [day, file] of this.files) if (file.buckets.length > 0) days.add(day);
    return [...days].sort();
  }

  // ---------- Dentro do relógio ----------

  private run(partial: boolean): void {
    if (!this.started || this.stopped) return;
    const now = this.deps.now();
    const gap = now - this.lastBeat > MAX_GAP_MS;
    const end = this.integrableEnd(now);
    const desired = new Map<string, DesiredSpan>();
    for (const span of this.deps.states()) desired.set(span.taskId, span);

    for (const [taskId, span] of [...this.open]) {
      const want = desired.get(taskId);
      if (!want || keyOf(want) !== keyOf(span)) {
        this.addSpan(span, end);
        this.open.delete(taskId);
      } else if (partial || gap) {
        this.addSpan(span, end);
        span.since = Math.max(span.since, now);
      }
    }
    for (const [taskId, want] of desired) {
      if (!this.open.has(taskId)) this.open.set(taskId, { ...want, since: now });
    }
    this.lastBeat = Math.max(this.lastBeat, now);
    // Parado (nenhum trecho aberto) não há o que gravar: só o carimbo `liveAt` mudaria e custaria um fsync a cada 30 s.
    if (partial && this.open.size > 0) this.touchLive(now);
    if (this.lastPrune !== dayKeyOf(now)) this.prune(now);
  }

  /** Até onde o tempo pode ser integrado: "agora", ou o último batimento se o servidor ficou um bom tempo sem bater. */
  private integrableEnd(now: number): number {
    return now - this.lastBeat > MAX_GAP_MS ? this.lastBeat : now;
  }

  private touchLive(now: number): void {
    const day = dayKeyOf(now);
    const file = this.fileOf(day);
    file.liveAt = Math.max(file.liveAt, now);
    this.dirty.add(day);
  }

  /** Soma `span.since -> end` nos baldes de hora (partindo nas viradas de hora e de dia). */
  private addSpan(span: OpenSpan, end: number): void {
    const from = span.since;
    if (end <= from) return;
    forEachHour(from, end, (hour, ms) => this.bump(hour, span, ms));
    this.rememberNames(span, dayKeyOf(end - 1));
  }

  private bump(hour: number, span: DesiredSpan, ms: number): void {
    const day = dayKeyOf(hour);
    const file = this.fileOf(day);
    let bucket = file.buckets.find((candidate) => candidate.t === hour);
    if (!bucket) {
      bucket = emptyClockBucket(hour);
      file.buckets.push(bucket);
      file.buckets.sort((a, b) => a.t - b.t);
    }
    bucket.ms[span.state] += ms;
    addTo(bucket.byAgent, span.agentId, span.state, ms);
    if (span.projectId) addTo(bucket.byProject, span.projectId, span.state, ms);
    if (span.projectId && span.sprintId) addTo(bucket.bySprint, `${span.projectId}:${span.sprintId}`, span.state, ms);
    this.dirty.add(day);
  }

  private rememberNames(span: DesiredSpan, day: string): void {
    const names = this.deps.names?.();
    if (!names) return;
    const file = this.fileOf(day);
    const put = (list: Array<[string, string]>, key: string | undefined, map: ReadonlyMap<string, string> | undefined) => {
      const name = key ? map?.get(key) : undefined;
      if (!key || !name) return;
      const found = list.find((entry) => entry[0] === key);
      if (found) found[1] = name.slice(0, 120);
      else if (list.length < NAMES_CAP) list.push([key, name.slice(0, 120)]);
    };
    put(file.names.agents, span.agentId, names.agents);
    put(file.names.projects, span.projectId, names.projects);
    if (span.projectId && span.sprintId) put(file.names.sprints, `${span.projectId}:${span.sprintId}`, names.sprints);
  }

  private fileName(day: string): string {
    return path.join(this.deps.dir, `${day}.json`);
  }

  private fileOf(day: string): StateDayFile {
    let file = this.files.get(day);
    if (!file) {
      file = this.loadFile(day) ?? emptyStateDayFile(day);
      this.files.set(day, file);
    }
    return file;
  }

  /** Lê o arquivo do dia sem confiar nele: ausente = `undefined`; ilegível vira `.corrupt` e também `undefined`. */
  private loadFile(day: string): StateDayFile | undefined {
    const file = this.fileName(day);
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      return undefined;
    }
    let parsed: StateDayFile | null;
    try {
      parsed = parseStateDayFile(JSON.parse(text), day);
    } catch {
      parsed = null;
    }
    if (parsed) return parsed;
    try {
      renameSync(file, `${file}.${this.deps.now()}.corrupt`);
    } catch {
      // se nem renomear dá, o dia recomeça e o próximo flush sobrescreve
    }
    this.deps.log.warn({ day }, "relógio de estados ilegível: o arquivo foi separado (.corrupt) e o dia recomeça");
    return undefined;
  }

  private metaFile(): string {
    return path.join(this.deps.dir, "meta.json");
  }

  /** A data de início do registro: a do `meta.json`; sem ele, a do primeiro balde que existir; sem nada (o primeiro boot com o relógio), a de agora. */
  private loadSince(now: number): void {
    try {
      const raw = JSON.parse(readFileSync(this.metaFile(), "utf8")) as { since?: unknown };
      if (typeof raw.since === "number" && Number.isFinite(raw.since) && raw.since > 0) {
        this.sinceMs = raw.since;
        return;
      }
    } catch {
      // sem meta
    }
    const first = this.days()[0];
    const bucket = first ? this.read(first)?.buckets[0] : undefined;
    if (bucket) this.setSince(bucket.t);
    else this.setSince(now);
  }

  private setSince(at: number): void {
    this.sinceMs = at;
    const content = { since: at };
    void this.deps.queue
      .enqueue(async () => {
        mkdirSync(this.deps.dir, { recursive: true });
        await writeJsonAtomic(this.metaFile(), content);
      })
      .catch((error: unknown) => this.deps.log.warn({ err: error }, "não foi possível gravar a data de início do relógio de estados"));
  }

  /** Apaga os arquivos de dias com mais de `DAY_STATS_RETENTION_DAYS` dias (e os `.corrupt` velhos). */
  private prune(now: number): void {
    this.lastPrune = dayKeyOf(now);
    const cutoff = addDays(this.lastPrune, -DAY_STATS_RETENTION_DAYS);
    let names: string[];
    try {
      names = readdirSync(this.deps.dir);
    } catch {
      return;
    }
    for (const name of names) {
      const match = /^(\d{4}-\d{2}-\d{2})\.json(?:\.\d+\.corrupt)?$/.exec(name);
      if (!match || match[1]! >= cutoff) continue;
      this.files.delete(match[1]!);
      this.dirty.delete(match[1]!);
      try {
        rmSync(path.join(this.deps.dir, name), { force: true });
      } catch (error) {
        this.deps.log.warn({ err: error, name }, "não foi possível apagar um dia antigo do relógio de estados");
      }
    }
  }
}

function addTo(list: Array<[string, ClockMs]>, key: string, state: ClockState, ms: number): void {
  let entry = list.find((candidate) => candidate[0] === key);
  if (!entry) {
    if (list.length >= PAIRS_CAP) return;
    entry = [key, Object.fromEntries(CLOCK_STATES.map((name) => [name, 0])) as ClockMs];
    list.push(entry);
  }
  entry[1][state] += ms;
}

