import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  ACTIVITY_SYSTEM,
  ACTIVITY_USER,
  agendaEventSchema,
  AGENDA_LIMITS,
  availabilitySchema,
  checkSlot,
  describeAgendaRange,
  nextFreeSlots,
  type AgendaBy,
  type AgendaEvent,
  type AgendaKind,
  type AgendaServerEvent,
  type Availability,
  type FreeSlot,
  type SlotCheck,
} from "@cyno/shared";
import { z } from "zod";
import { writeJsonAtomic } from "../../store/atomic-write";
import { platformPaths, type PlatformPaths } from "../../store/paths";
import { WriteQueue } from "../../store/write-queue";
import { activity } from "../../workspace/activity/log";
import { HttpError } from "../http/errors";

/**
 * Quem mexe na agenda: o dono (pela tela: pode sobrepor, e não tem antecedência mínima), o Cyno ou
 * um agente (Maestro ou agente de time) de um workspace. Só o dono "força"; a IA nunca.
 */
export type AgendaActor = { kind: "dono" } | { kind: "cyno" } | { kind: "agente"; workspace: string; name?: string; address?: string };

export type BookInput = {
  title: string;
  start: string;
  end: string;
  kind?: AgendaKind;
  notes?: string;
  link?: string;
  location?: string;
  projectId?: string;
  taskId?: string;
  /** Só o dono escolhe o workspace de um compromisso (o agente marca no próprio). */
  workspace?: string;
};

export type AgendaChange = Partial<Pick<AgendaEvent, "title" | "kind" | "start" | "end">> & { notes?: string | null; link?: string | null; location?: string | null };

export type BookResult = { ok: true; event: AgendaEvent } | { ok: false; check: Extract<SlotCheck, { ok: false }> };

export type AgendaServiceDeps = {
  /** `data/platform/agenda/events.json` e `availability.json` (via `platformPaths`). */
  paths: Pick<PlatformPaths, "agendaEventsFile" | "availabilityFile">;
  now: () => Date;
  /** Nome do workspace (para a Atividade e as mensagens). */
  workspaceName?: (id: string) => string | undefined;
  queue?: WriteQueue;
};

const eventsFileSchema = z.object({ version: z.literal(1).default(1), events: z.array(agendaEventSchema).default([]) });

async function readJsonFile(file: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`Não foi possível ler ${file}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

const pad = (value: number) => String(value).padStart(4, "0");
const MINUTE = 60_000;

/**
 * "Sua agenda": os compromissos que usam o tempo do dono (de qualquer workspace) e a disponibilidade
 * dele. Lista em memória, gravada em `data/platform/agenda/` com escrita atômica. Toda marcação passa
 * por `checkSlot` (choque, disponibilidade, antecedência) de forma SÍNCRONA com a gravação na lista,
 * então dois pedidos simultâneos nunca marcam o mesmo horário. Sem IA.
 */
export class AgendaService {
  private readonly queue: WriteQueue;
  private readonly listeners = new Set<(event: AgendaServerEvent) => void>();

  private constructor(
    private events: AgendaEvent[],
    private availability: Availability,
    private readonly deps: AgendaServiceDeps,
  ) {
    this.queue = deps.queue ?? new WriteQueue();
  }

  static async open(deps: AgendaServiceDeps): Promise<AgendaService> {
    await mkdir(path.dirname(deps.paths.agendaEventsFile), { recursive: true });
    const rawEvents = await readJsonFile(deps.paths.agendaEventsFile);
    const events = rawEvents === undefined ? [] : eventsFileSchema.parse(rawEvents).events;
    const rawAvailability = await readJsonFile(deps.paths.availabilityFile);
    const availability = availabilitySchema.parse(rawAvailability ?? {});
    return new AgendaService(events, availability, deps);
  }

  /** Para os testes e para quem só tem o DATA_DIR. */
  static openAt(dataDir: string, now: () => Date, extra: Partial<AgendaServiceDeps> = {}): Promise<AgendaService> {
    return AgendaService.open({ paths: platformPaths(dataDir), now, ...extra });
  }

  // ---------- Leitura ----------

  getAvailability(): Availability {
    return structuredClone(this.availability);
  }

  get(id: string): AgendaEvent | undefined {
    const found = this.events.find((event) => event.id === id);
    return found ? structuredClone(found) : undefined;
  }

  /** Compromissos que tocam [fromMs, toMs) (cada limite opcional), em ordem de início; sem os cancelados, salvo `cancelled`. */
  list(range: { from?: number; to?: number; cancelled?: boolean } = {}): AgendaEvent[] {
    return this.events
      .filter((event) => (range.cancelled || event.status === "marcado") && (range.to === undefined || Date.parse(event.start) < range.to) && (range.from === undefined || Date.parse(event.end) > range.from))
      .sort((a, b) => a.start.localeCompare(b.start) || a.id.localeCompare(b.id))
      .map((event) => structuredClone(event));
  }

  /** Confere um horário sem marcar (a tela usa ao vivo no diálogo). */
  check(slot: { start: string; end: string }, actor: AgendaActor, ignoreId?: string): SlotCheck {
    return checkSlot(this.events, this.availability, slot, { now: this.deps.now(), skipNotice: actor.kind === "dono", ...(ignoreId ? { ignoreId } : {}) });
  }

  /** Horários livres de uma duração entre dois instantes (a ferramenta `agenda_free_slots`). */
  freeSlots(options: { from: number; to: number; durationMinutes: number; count: number }, actor: AgendaActor): FreeSlot[] {
    return nextFreeSlots(this.events, this.availability, {
      durationMs: options.durationMinutes * MINUTE,
      from: options.from,
      until: options.to,
      count: options.count,
      now: this.deps.now(),
      skipNotice: actor.kind === "dono",
    });
  }

  // ---------- Escrita ----------

  /**
   * Marca um compromisso se o horário serve; senão devolve a recusa (com o motivo e 3 horários livres)
   * e NÃO grava. `override`: só o dono (pela tela) pode marcar por cima.
   */
  async book(input: BookInput, actor: AgendaActor, options: { override?: boolean } = {}): Promise<BookResult> {
    const override = options.override === true && actor.kind === "dono";
    const slot = { start: input.start, end: input.end };
    const startMs = Date.parse(input.start);
    const endMs = Date.parse(input.end);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
      throw new HttpError(400, "O fim precisa ser depois do início");
    }
    if (override && endMs - startMs > AGENDA_LIMITS.maxDurationMinutes * MINUTE) throw new HttpError(400, "Um compromisso não pode durar mais de 24 horas");
    const check = override ? ({ ok: true } as const) : this.check(slot, actor);
    if (!check.ok) {
      this.record("recusado", actor, undefined, `Recusado por ${check.problem === "conflict" ? "choque" : check.problem === "notice" ? "antecedência" : "estar fora da disponibilidade"}: "${input.title}" ${this.describe(startMs, endMs)}. ${check.reason}`, {
        title: input.title,
        start: input.start,
        end: input.end,
        problem: check.problem,
      });
      return { ok: false, check };
    }
    const at = this.deps.now().toISOString();
    const workspace = actor.kind === "agente" ? actor.workspace : actor.kind === "dono" ? input.workspace : undefined;
    const by: AgendaBy = actor.kind === "dono" ? { kind: "dono" } : actor.kind === "cyno" ? { kind: "cyno" } : { kind: "agente", ...(actor.name ? { name: actor.name } : {}), ...(actor.address ? { address: actor.address } : {}) };
    const event = agendaEventSchema.parse({
      id: this.nextId(),
      title: input.title,
      start: new Date(startMs).toISOString(),
      end: new Date(endMs).toISOString(),
      kind: input.kind ?? "outro",
      ...(input.notes ? { notes: input.notes } : {}),
      ...(input.link ? { link: input.link } : {}),
      ...(input.location ? { location: input.location } : {}),
      ...(workspace ? { workspace } : {}),
      by,
      ...(input.projectId ? { projectId: input.projectId } : {}),
      ...(input.taskId ? { taskId: input.taskId } : {}),
      createdAt: at,
    });
    this.events.push(event);
    const write = this.writeEvents();
    this.emit({ type: "agenda:upserted", event: structuredClone(event) });
    this.record("marcado", actor, event, `Marcou "${event.title}" ${this.describe(startMs, endMs)}${override ? " (por cima de outro compromisso, a pedido do dono)" : ""}`, { id: event.id, start: event.start, end: event.end, ...(override ? { override: true } : {}) });
    await write;
    return { ok: true, event: structuredClone(event) };
  }

  /**
   * Muda um compromisso (mover = `start`/`end`). Horário novo passa pela mesma conferência (ignorando o
   * próprio compromisso); só o dono sobrepõe. Agente e Maestro só mexem no que o workspace criou.
   */
  async change(id: string, patch: AgendaChange, actor: AgendaActor, options: { override?: boolean } = {}): Promise<BookResult> {
    const current = this.require(id, actor);
    if (current.status === "cancelado") throw new HttpError(409, "Esse compromisso foi cancelado");
    const merged: Record<string, unknown> = { ...current };
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      if (value === null) delete merged[key];
      else merged[key] = value;
    }
    const startMs = Date.parse(String(merged.start));
    const endMs = Date.parse(String(merged.end));
    // Só o horário passa pela conferência: renomear ou editar notas nunca é recusado por choque.
    const moved = patch.start !== undefined || patch.end !== undefined;
    if (moved) {
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) throw new HttpError(400, "O fim precisa ser depois do início");
      const override = options.override === true && actor.kind === "dono";
      const check = override ? ({ ok: true } as const) : this.check({ start: String(merged.start), end: String(merged.end) }, actor, id);
      if (!check.ok) {
        this.record("recusado", actor, current, `Recusado mover "${current.title}" para ${this.describe(startMs, endMs)}. ${check.reason}`, { id, problem: check.problem });
        return { ok: false, check };
      }
      merged.start = new Date(startMs).toISOString();
      merged.end = new Date(endMs).toISOString();
      if (merged.start !== current.start) merged.movedFrom = current.start;
    }
    merged.updatedAt = this.deps.now().toISOString();
    const updated = agendaEventSchema.parse(merged);
    this.events = this.events.map((event) => (event.id === id ? updated : event));
    const write = this.writeEvents();
    this.emit({ type: "agenda:upserted", event: structuredClone(updated) });
    if (moved) this.record("movido", actor, updated, `Moveu "${updated.title}" de ${this.describe(Date.parse(current.start), Date.parse(current.end))} para ${this.describe(startMs, endMs)}`, { id, from: current.start, start: updated.start, end: updated.end });
    await write;
    return { ok: true, event: structuredClone(updated) };
  }

  /** Cancela (o compromisso fica na lista como "cancelado" e libera o horário). */
  async cancel(id: string, actor: AgendaActor, reason?: string): Promise<AgendaEvent> {
    const current = this.require(id, actor);
    if (current.status === "cancelado") return structuredClone(current);
    const updated = agendaEventSchema.parse({ ...current, status: "cancelado", updatedAt: this.deps.now().toISOString(), ...(reason ? { cancelReason: reason.slice(0, 300) } : {}) });
    this.events = this.events.map((event) => (event.id === id ? updated : event));
    const write = this.writeEvents();
    this.emit({ type: "agenda:upserted", event: structuredClone(updated) });
    this.record("cancelado", actor, updated, `Cancelou "${updated.title}" ${this.describe(Date.parse(updated.start), Date.parse(updated.end))}${reason ? `: ${reason}` : ""}`, { id });
    await write;
    return structuredClone(updated);
  }

  /** Só o dono grava a disponibilidade (pela tela). */
  async setAvailability(next: Availability): Promise<Availability> {
    this.availability = availabilitySchema.parse(next);
    const data = structuredClone(this.availability);
    const write = this.queue.enqueue(() => writeJsonAtomic(this.deps.paths.availabilityFile, data));
    this.emit({ type: "agenda:availability", availability: structuredClone(this.availability) });
    activity({ category: "agenda", action: "disponibilidade", actor: ACTIVITY_USER, summary: "Atualizou os horários em que está disponível" });
    await write;
    return structuredClone(this.availability);
  }

  // ---------- Eventos ----------

  subscribe(listener: (event: AgendaServerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async idle(): Promise<void> {
    await this.queue.idle();
  }

  // ---------- Internos ----------

  /** O compromisso, se o ator pode mexer nele (o dono e o Cyno: qualquer um; o agente: só os do próprio workspace). */
  private require(id: string, actor: AgendaActor): AgendaEvent {
    const found = this.events.find((event) => event.id === id);
    if (!found) throw new HttpError(404, `Compromisso "${id}" não encontrado`);
    if (actor.kind === "agente" && found.workspace !== actor.workspace) throw new HttpError(403, "Esse compromisso foi marcado por outro workspace: só o dono ou o Cyno mexem nele");
    return found;
  }

  private nextId(): string {
    const max = this.events.reduce((top, event) => Math.max(top, Number(event.id.slice(2)) || 0), 0);
    return `G-${pad(max + 1)}`;
  }

  private describe(startMs: number, endMs: number): string {
    return describeAgendaRange(startMs, endMs, this.availability.timezone);
  }

  private writeEvents(): Promise<void> {
    const data = { version: 1 as const, events: structuredClone(this.events) };
    return this.queue.enqueue(() => writeJsonAtomic(this.deps.paths.agendaEventsFile, data));
  }

  private emit(event: AgendaServerEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // um ouvinte com defeito não derruba a agenda
      }
    }
  }

  /** Atividade: marcado, movido, cancelado e recusado (na lista do workspace de origem, ou do servidor). */
  private record(action: "marcado" | "movido" | "cancelado" | "recusado", actor: AgendaActor, event: AgendaEvent | undefined, summary: string, data: Record<string, unknown>): void {
    const workspaceId = actor.kind === "agente" ? actor.workspace : event?.workspace;
    const who = actor.kind === "dono" ? ACTIVITY_USER : actor.kind === "cyno" ? "cyno" : (actor.address ?? actor.name ?? ACTIVITY_SYSTEM);
    activity({ category: "agenda", action, actor: who, ...(workspaceId ? { workspaceId } : {}), summary, data });
  }
}
