import {
  dayKeyOf,
  isDayKey,
  parseTimeline,
  sliceTimeline,
  spanOfTimeline,
  TIMELINE_RETENTION_DAYS,
  addDays,
  buildSceneFrame,
  emptyLogMemory,
  forgetAgentLog,
  rememberLogEntry,
  type FrameInput,
  type ServerEvent,
  type TimelineDayInfo,
  type TimelineRecord,
} from "@cyno/shared";
import { open, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { TimelineRecorder, timelineFile } from "./recorder";

export type TimelineServiceDeps = {
  dir: string;
  /** Os dados do Cyno de agora (sem o que o gravador lembra do log). */
  source: () => Omit<FrameInput, "log" | "now">;
  now: () => number;
  log: { warn: (object: unknown, message: string) => void };
  /** Desligado (CYNO_TIMELINE=0): não grava nem cria pasta; a lista de dias diz `recording: false`. */
  enabled: boolean;
};

/** A cabeça e a cauda de um arquivo (a lista de dias não carrega o dia inteiro). Leitura assíncrona: nunca trava o laço de eventos. */
async function headAndTail(file: string, size: number): Promise<string> {
  if (size <= 262_144) return readFile(file, "utf8");
  const handle = await open(file, "r");
  try {
    // O começo do arquivo (só o prefixo da primeira linha importa: `{"t":"k","at":123,`) e o fim (da primeira quebra em diante).
    const head = Buffer.alloc(128);
    await handle.read(head, 0, head.length, 0);
    const tailLength = Math.min(size, 65_536);
    const tail = Buffer.alloc(tailLength);
    await handle.read(tail, 0, tailLength, size - tailLength);
    const tailText = tail.toString("utf8");
    return `${head.toString("utf8")}\n${tailText.slice(tailText.indexOf("\n") + 1)}`;
  } finally {
    await handle.close();
  }
}

/** O "Rever o dia" de um workspace: grava (gravador) e lê (lista de dias e partes do dia). */
export class TimelineService {
  private readonly memory = emptyLogMemory();
  private readonly recorder: TimelineRecorder;

  constructor(private readonly deps: TimelineServiceDeps) {
    this.recorder = new TimelineRecorder({
      dir: deps.dir,
      now: deps.now,
      log: deps.log,
      sample: () => buildSceneFrame({ ...deps.source(), log: this.memory, now: deps.now() }),
    });
  }

  get recording(): boolean {
    return this.deps.enabled;
  }

  start(options: { timers?: boolean } = {}): void {
    if (this.deps.enabled) this.recorder.start(options);
  }

  stop(): void {
    if (this.deps.enabled) this.recorder.stop();
  }

  /** Um batimento à mão (testes e o modo de fabricar um dia). */
  tick(): void {
    if (this.deps.enabled) this.recorder.tick();
  }

  /** Um evento do hub do workspace: marca "mudou" e guarda o que só o log sabe (ferramenta e subagentes). */
  observe(event: ServerEvent): void {
    if (!this.deps.enabled) return;
    if (event.type === "agent:log") {
      if (rememberLogEntry(this.memory, event.entry, this.deps.now())) this.recorder.observe();
      return;
    }
    if (event.type === "agent:deleted") forgetAgentLog(this.memory, event.id);
    if (
      event.type === "task:upserted" ||
      event.type === "task:progress" ||
      event.type === "agent:upserted" ||
      event.type === "agent:deleted" ||
      event.type === "agent:terminal" ||
      event.type === "room:upserted" ||
      event.type === "room:deleted" ||
      event.type === "team:upserted" ||
      event.type === "team:deleted" ||
      event.type === "foryou:upserted" ||
      event.type === "foryou:deleted" ||
      event.type === "project:upserted" ||
      event.type === "project:deleted"
    )
      this.recorder.observe();
  }

  /** Os dias com gravação (os da retenção), do mais velho ao mais novo. */
  async days(): Promise<TimelineDayInfo[]> {
    const oldest = addDays(dayKeyOf(this.deps.now()), -(TIMELINE_RETENTION_DAYS - 1));
    let names: string[];
    try {
      names = await readdir(this.deps.dir);
    } catch {
      return [];
    }
    const out: TimelineDayInfo[] = [];
    for (const name of names.sort()) {
      const day = name.endsWith(".jsonl") ? name.slice(0, -6) : undefined;
      if (!day || !isDayKey(day) || day < oldest) continue;
      const file = path.join(this.deps.dir, name);
      try {
        const bytes = (await stat(file)).size;
        if (bytes === 0) continue;
        const span = spanOfTimeline(await headAndTail(file, bytes));
        if (span) out.push({ day, bytes, from: span.from, to: span.to });
      } catch {
        // Arquivo que sumiu ou não abre: fica fora da lista.
      }
    }
    return out;
  }

  /** O dia lido por inteiro (ou `undefined` se não há arquivo). Leitura defensiva: linha inválida é ignorada. */
  async readDay(day: string): Promise<TimelineRecord[] | undefined> {
    if (!isDayKey(day)) return undefined;
    try {
      return parseTimeline(await readFile(timelineFile(this.deps.dir, day), "utf8"));
    } catch {
      return undefined;
    }
  }

  /** Uma parte do dia, em NDJSON: o quadro completo que vale em `from` e tudo de `from` (exclusive) a `to` (inclusive). */
  async readPart(day: string, from: number, to: number): Promise<string | undefined> {
    const records = await this.readDay(day);
    if (!records) return undefined;
    return sliceTimeline(records, from, to)
      .map((record) => JSON.stringify(record))
      .join("\n");
  }
}
