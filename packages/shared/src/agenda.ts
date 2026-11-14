import { z } from "zod";
import { MAX_ID_LENGTH } from "./ids";

/**
 * "Sua agenda": só o que consome o TEMPO DO DONO (reunião, call, gravação, prazo), de qualquer
 * workspace. A agenda de postagens de cada workspace (calendar.json) é outra coisa e não é conferida:
 * ela aparece na mesma grade como a camada "Postagens", só leitura. Os horários são instantes (ISO 8601);
 * o dia, a hora e a disponibilidade valem no fuso da plataforma (America/Sao_Paulo).
 */

export const AGENDA_KINDS = ["reuniao", "call", "gravacao", "prazo", "pessoal", "outro"] as const;
export type AgendaKind = (typeof AGENDA_KINDS)[number];
export const AGENDA_KIND_LABELS: Record<AgendaKind, string> = {
  reuniao: "Reunião",
  call: "Call",
  gravacao: "Gravação",
  prazo: "Prazo",
  pessoal: "Pessoal",
  outro: "Outro",
};

export const AGENDA_ID_PATTERN = /^G-\d{4,}$/;
export const AGENDA_TIMEZONE = "America/Sao_Paulo";
export const AGENDA_LIMITS = { title: 200, notes: 1000, link: 500, location: 200, maxDurationMinutes: 24 * 60 } as const;
/** Quantas sugestões de horário livre uma recusa devolve. */
export const AGENDA_SUGGESTIONS = 3;
/** Quanto adiante a busca por horários livres procura. */
export const AGENDA_SEARCH_DAYS = 30;
/** Passo (em minutos) dos horários sugeridos. */
export const AGENDA_STEP_MINUTES = 15;

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const timeSchema = z.string().regex(/^\d{2}:\d{2}$/);

/** Instante com fuso (`2026-11-12T17:00:00-03:00` ou `...Z`). */
export const agendaInstantSchema = z.iso.datetime({ offset: true });

/** Quem marcou: o dono (na tela), um agente ou Maestro de um workspace, ou o Cyno. */
export const agendaByActorSchema = z.object({
  kind: z.enum(["dono", "agente", "cyno"]),
  /** Nome de quem marcou (agente ou Maestro), para a tela. */
  name: z.string().max(140).optional(),
  address: z.string().max(140).optional(),
});
export type AgendaBy = z.output<typeof agendaByActorSchema>;

export const agendaEventSchema = z.object({
  id: z.string().regex(AGENDA_ID_PATTERN),
  title: z.string().trim().min(1).max(AGENDA_LIMITS.title),
  /** Início e fim (instantes ISO). O fim é sempre depois do início; pode passar da meia-noite. */
  start: agendaInstantSchema,
  end: agendaInstantSchema,
  kind: z.enum(AGENDA_KINDS).default("outro"),
  notes: z.string().max(AGENDA_LIMITS.notes).optional(),
  /** Link da call (ou de qualquer coisa ligada ao compromisso). */
  link: z.string().max(AGENDA_LIMITS.link).optional(),
  location: z.string().max(AGENDA_LIMITS.location).optional(),
  /** Workspace de origem (ausente = o dono marcou direto, sem workspace). */
  workspace: z.string().max(MAX_ID_LENGTH).optional(),
  by: agendaByActorSchema.default({ kind: "dono" }),
  /** Projeto e tarefa ligados (para abrir a partir da agenda). */
  projectId: z.string().max(MAX_ID_LENGTH).optional(),
  taskId: z.string().max(MAX_ID_LENGTH).optional(),
  /** Origem do compromisso: o modelo já comporta uma agenda externa (Google Calendar), ainda não implementada. */
  source: z.enum(["local", "google"]).default("local"),
  externalId: z.string().max(200).optional(),
  status: z.enum(["marcado", "cancelado"]).default("marcado"),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime().optional(),
  /** Início anterior, quando foi movido (ISO). */
  movedFrom: z.string().max(80).optional(),
  cancelReason: z.string().max(300).optional(),
});
export type AgendaEvent = z.output<typeof agendaEventSchema>;

/** Janela de disponibilidade num dia da semana (0 = domingo … 6 = sábado). `to` pode ser "24:00" (até o fim do dia). */
export const availabilityWindowSchema = z.object({ weekday: z.number().int().min(0).max(6), from: timeSchema, to: timeSchema });
export type AvailabilityWindow = z.output<typeof availabilityWindowSchema>;

/** Exceção de um dia: `off` bloqueia o dia inteiro; `from`/`to` trocam as janelas daquele dia por uma só. */
export const availabilityExceptionSchema = z.object({ date: dateSchema, off: z.boolean().optional(), from: timeSchema.optional(), to: timeSchema.optional(), note: z.string().max(120).optional() });
export type AvailabilityException = z.output<typeof availabilityExceptionSchema>;

/** Disponibilidade do dono, definida uma vez (`data/platform/agenda/availability.json`). */
export const availabilitySchema = z.object({
  weekly: z.array(availabilityWindowSchema).max(70).default([1, 2, 3, 4, 5].map((weekday) => ({ weekday, from: "09:00", to: "18:00" }))),
  exceptions: z.array(availabilityExceptionSchema).max(400).default([]),
  /** Intervalo mínimo entre dois compromissos. */
  bufferMinutes: z.number().int().min(0).max(120).default(15),
  /** Antecedência mínima para marcar (quem não é o dono não marca para daqui a menos disso). */
  minNoticeMinutes: z.number().int().min(0).max(7 * 24 * 60).default(60),
  /** Duração quando quem marca não diz. */
  defaultDurationMinutes: z.number().int().min(5).max(AGENDA_LIMITS.maxDurationMinutes).default(60),
  timezone: z.string().max(60).default(AGENDA_TIMEZONE),
});
export type Availability = z.output<typeof availabilitySchema>;

const clockMinutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
const badClock = (time: string) => !(Number(time.slice(0, 2)) < 24 && Number(time.slice(3)) < 60) && time !== "24:00";

/** `PUT /api/agenda/availability`: o mesmo formato, com janelas conferidas (`from` antes de `to`). */
export const availabilityBodySchema = availabilitySchema.superRefine((value, ctx) => {
  value.weekly.forEach((window, index) => {
    if (badClock(window.from) || badClock(window.to) || clockMinutes(window.from) >= clockMinutes(window.to)) {
      ctx.addIssue({ code: "custom", path: ["weekly", index], message: "A janela precisa começar antes de terminar (HH:MM)" });
    }
  });
  value.exceptions.forEach((exception, index) => {
    if (exception.off) return;
    if (!exception.from || !exception.to || badClock(exception.from) || badClock(exception.to) || clockMinutes(exception.from) >= clockMinutes(exception.to)) {
      ctx.addIssue({ code: "custom", path: ["exceptions", index], message: "A exceção precisa de bloqueio (off) ou de uma janela com início antes do fim" });
    }
  });
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value.timezone });
  } catch {
    ctx.addIssue({ code: "custom", path: ["timezone"], message: "Fuso horário desconhecido" });
  }
});

export type SlotConflict = { id: string; title: string; start: string; end: string; workspace?: string };
export type FreeSlot = { start: string; end: string };
/** Por que um horário não serve: choque, fora da disponibilidade, antecedência, duração inválida. */
export type SlotProblem = "conflict" | "outside_availability" | "notice" | "invalid";

/** Resultado de `checkSlot`. */
export type SlotCheck = { ok: true } | { ok: false; problem: SlotProblem; conflicts: SlotConflict[]; reason: string; nextFree: FreeSlot[] };

// ---------- Rotas e respostas ----------

export const AGENDA_PATH = "/api/agenda";
export const AGENDA_AVAILABILITY_PATH = "/api/agenda/availability";
export const AGENDA_CHECK_PATH = "/api/agenda/check";

/** O que o dono marca pela tela (pode sobrepor com `override`, depois de confirmar). */
export const createAgendaEventBodySchema = z.strictObject({
  title: z.string().trim().min(1).max(AGENDA_LIMITS.title),
  start: agendaInstantSchema,
  end: agendaInstantSchema,
  kind: z.enum(AGENDA_KINDS).optional(),
  notes: z.string().max(AGENDA_LIMITS.notes).optional(),
  link: z.string().max(AGENDA_LIMITS.link).optional(),
  location: z.string().max(AGENDA_LIMITS.location).optional(),
  workspace: z.string().max(MAX_ID_LENGTH).optional(),
  override: z.boolean().optional(),
});
export type CreateAgendaEventBody = z.input<typeof createAgendaEventBodySchema>;

/** Mover/editar: só o que veio muda; `null` apaga um campo opcional. */
export const updateAgendaEventBodySchema = z.strictObject({
  title: z.string().trim().min(1).max(AGENDA_LIMITS.title).optional(),
  start: agendaInstantSchema.optional(),
  end: agendaInstantSchema.optional(),
  kind: z.enum(AGENDA_KINDS).optional(),
  notes: z.string().max(AGENDA_LIMITS.notes).nullable().optional(),
  link: z.string().max(AGENDA_LIMITS.link).nullable().optional(),
  location: z.string().max(AGENDA_LIMITS.location).nullable().optional(),
  override: z.boolean().optional(),
});
export type UpdateAgendaEventBody = z.input<typeof updateAgendaEventBodySchema>;

export const checkAgendaBodySchema = z.strictObject({ start: agendaInstantSchema, end: agendaInstantSchema, ignoreId: z.string().max(40).optional() });
export type CheckAgendaBody = z.input<typeof checkAgendaBodySchema>;

export const listAgendaQuerySchema = z.object({
  from: dateSchema.optional(),
  to: dateSchema.optional(),
  /** Camadas extras na grade (por padrão, "Postagens" ligada e "Rotinas" desligada). */
  posts: z.enum(["0", "1"]).optional(),
  routines: z.enum(["0", "1"]).optional(),
  /** Inclui os cancelados. */
  cancelled: z.enum(["0", "1"]).optional(),
});
export type ListAgendaQuery = z.output<typeof listAgendaQuerySchema>;

/** Um evento do calendário de postagens de um workspace, como a Sua agenda o mostra (só leitura). */
export type AgendaPostItem = {
  id: string;
  workspace: string;
  workspaceName: string;
  title: string;
  /** AAAA-MM-DD */
  date: string;
  time?: string;
  endTime?: string;
  done: boolean;
};

/** Um horário de rotina (próxima execução) na grade. */
export type AgendaRoutineItem = { routineId: string; workspace: string; workspaceName: string; title: string; at: string; label?: string };

export type AgendaResponse = {
  events: AgendaEvent[];
  posts: AgendaPostItem[];
  routines: AgendaRoutineItem[];
  availability: Availability;
  /** Nomes dos workspaces (id -> nome), para a legenda e o "quem marcou". */
  workspaces: { id: string; name: string }[];
};

/** Resposta (409) de `POST /api/agenda` e dos PATCH quando há choque e o dono não confirmou. */
export type AgendaRefusal = { error: string; check: Extract<SlotCheck, { ok: false }> };

/** Eventos ao vivo da Sua agenda (websocket do Cyno). */
export type AgendaServerEvent = { type: "agenda:upserted"; event: AgendaEvent } | { type: "agenda:availability"; availability: Availability };
export const AGENDA_EVENT_TYPES = ["agenda:upserted", "agenda:availability"] as const;
