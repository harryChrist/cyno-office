import {
  AGENDA_TIMEZONE,
  availabilityIntervals,
  localDateKey,
  localInstant,
  shiftDay,
  zoned,
  type AgendaEvent,
  type AgendaPostItem,
  type AgendaRoutineItem,
  type Availability,
} from "@cyno/shared";

/**
 * Contas de tempo da "Sua agenda", sempre no fuso da plataforma (America/Sao_Paulo) e não no do
 * navegador: o dia de um compromisso é o mesmo em qualquer aparelho. Funções puras (o relógio entra por
 * parâmetro). Um dia é uma chave "AAAA-MM-DD".
 */

export type DateKey = string;
export const MINUTES_PER_DAY = 24 * 60;

const pad = (value: number) => String(value).padStart(2, "0");
const parts = (key: DateKey) => ({ year: Number(key.slice(0, 4)), month: Number(key.slice(5, 7)), day: Number(key.slice(8, 10)) });

/** Dia (no fuso) de um instante. */
export function dayKeyOf(at: string | number | Date, zone: string = AGENDA_TIMEZONE): DateKey {
  return localDateKey(new Date(at).getTime(), zone);
}

export const todayKey = (now: Date, zone: string = AGENDA_TIMEZONE): DateKey => dayKeyOf(now, zone);

export function addDayKeys(key: DateKey, days: number): DateKey {
  const p = parts(key);
  const next = shiftDay(p.year, p.month, p.day, days);
  return `${next.year}-${pad(next.month)}-${pad(next.day)}`;
}

/** Dia da semana de um dia (0 = domingo). */
export function weekdayOf(key: DateKey): number {
  const p = parts(key);
  return new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
}

/** Minuto do dia (0..1439) de um instante. */
export function minutesOfDay(at: string | number, zone: string = AGENDA_TIMEZONE): number {
  const p = zoned(new Date(at).getTime(), zone);
  return p.hour * 60 + p.minute;
}

/** "17:00". */
export function timeLabel(at: string | number, zone: string = AGENDA_TIMEZONE): string {
  const minutes = minutesOfDay(at, zone);
  return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

export const clockLabel = (minutes: number) => `${pad(Math.floor(minutes / 60) % 24)}:${pad(minutes % 60)}`;

/** O instante (ISO) de "HH:MM" num dia do fuso. */
export function instantOf(key: DateKey, time: string, zone: string = AGENDA_TIMEZONE): string {
  const p = parts(key);
  const [h = 0, m = 0] = time.split(":").map(Number);
  return new Date(localInstant(p, h, m, zone)).toISOString();
}

/** Início do dia (ms) no fuso. */
export function dayStartMs(key: DateKey, zone: string = AGENDA_TIMEZONE): number {
  return localInstant(parts(key), 0, 0, zone);
}

/** "17:00–18:00" (ou "17:00 – qui 12/11 01:00" quando passa da meia-noite). */
export function eventTimeLabel(event: Pick<AgendaEvent, "start" | "end">, zone: string = AGENDA_TIMEZONE): string {
  const startDay = dayKeyOf(event.start, zone);
  const endDay = dayKeyOf(event.end, zone);
  if (startDay === endDay) return `${timeLabel(event.start, zone)}–${timeLabel(event.end, zone)}`;
  const label = `${pad(parts(endDay).day)}/${pad(parts(endDay).month)}`;
  return `${timeLabel(event.start, zone)} – ${label} ${timeLabel(event.end, zone)}`;
}

/** Duração em minutos. */
export function durationMinutes(event: Pick<AgendaEvent, "start" | "end">): number {
  return Math.round((Date.parse(event.end) - Date.parse(event.start)) / 60_000);
}

export type DaySegment = {
  event: AgendaEvent;
  /** Minuto do dia em que o trecho começa e termina (0..1440), já cortado nas pontas do dia. */
  startMin: number;
  endMin: number;
  /** O compromisso veio do dia anterior / continua no dia seguinte. */
  continuesBefore: boolean;
  continuesAfter: boolean;
};

/** Os trechos dos compromissos que caem num dia (um que atravessa a meia-noite aparece nos dois dias). */
export function daySegments(events: readonly AgendaEvent[], key: DateKey, zone: string = AGENDA_TIMEZONE): DaySegment[] {
  const from = dayStartMs(key, zone);
  const to = dayStartMs(addDayKeys(key, 1), zone);
  const out: DaySegment[] = [];
  for (const event of events) {
    const start = Date.parse(event.start);
    const end = Date.parse(event.end);
    if (end <= from || start >= to) continue;
    const clippedStart = Math.max(start, from);
    const clippedEnd = Math.min(end, to);
    out.push({
      event,
      startMin: Math.round((clippedStart - from) / 60_000),
      endMin: Math.max(Math.round((clippedEnd - from) / 60_000), Math.round((clippedStart - from) / 60_000) + 1),
      continuesBefore: start < from,
      continuesAfter: end > to,
    });
  }
  return out.sort((a, b) => a.startMin - b.startMin || b.endMin - a.endMin || a.event.id.localeCompare(b.event.id));
}

export type LaidOut = DaySegment & { lane: number; lanes: number };

/**
 * Coloca os trechos lado a lado quando se sobrepõem (o dono pode ter sobreposto de propósito): cada
 * grupo de trechos ligados por sobreposição divide a largura em `lanes` faixas.
 */
export function layoutLanes(segments: readonly DaySegment[]): LaidOut[] {
  const out: LaidOut[] = [];
  let group: LaidOut[] = [];
  let groupEnd = -1;
  const flush = () => {
    const lanes = group.reduce((top, item) => Math.max(top, item.lane + 1), 1);
    for (const item of group) item.lanes = lanes;
    out.push(...group);
    group = [];
  };
  for (const segment of segments) {
    if (group.length > 0 && segment.startMin >= groupEnd) flush();
    const taken = new Set(group.filter((item) => item.endMin > segment.startMin).map((item) => item.lane));
    let lane = 0;
    while (taken.has(lane)) lane += 1;
    group.push({ ...segment, lane, lanes: 1 });
    groupEnd = Math.max(groupEnd, segment.endMin);
  }
  if (group.length > 0) flush();
  return out;
}

export type Band = { from: number; to: number };

/** As faixas de disponibilidade de um dia, em minutos (para sombrear a grade). */
export function availabilityBands(availability: Availability, key: DateKey): Band[] {
  const zone = availability.timezone;
  const from = dayStartMs(key, zone);
  const to = dayStartMs(addDayKeys(key, 1), zone);
  return availabilityIntervals(availability, from, to)
    .filter((interval) => interval.end > from && interval.start < to)
    .map((interval) => ({ from: Math.round((Math.max(interval.start, from) - from) / 60_000), to: Math.round((Math.min(interval.end, to) - from) / 60_000) }));
}

/** Horas (inteiras) que a grade da semana mostra: o padrão 7h–21h, ampliado para caber o que houver. */
export function visibleHours(minutes: readonly number[], bands: readonly Band[], defaults = { from: 7, to: 21 }): { from: number; to: number } {
  let from = defaults.from;
  let to = defaults.to;
  for (const minute of minutes) {
    from = Math.min(from, Math.floor(minute / 60));
    to = Math.max(to, Math.ceil(minute / 60));
  }
  for (const band of bands) {
    // Só amplia para uma faixa que o dono marcou como disponível se ela é razoável (não vira a grade de 24h por causa de um "00:00–24:00").
    if (band.to - band.from >= MINUTES_PER_DAY) continue;
    from = Math.min(from, Math.floor(band.from / 60));
    to = Math.max(to, Math.ceil(band.to / 60));
  }
  return { from: Math.max(0, from), to: Math.min(24, Math.max(to, from + 1)) };
}

/** Os 7 dias (domingo a sábado) da semana do dia. */
export function weekKeys(anchor: DateKey): DateKey[] {
  const start = addDayKeys(anchor, -weekdayOf(anchor));
  return Array.from({ length: 7 }, (_, index) => addDayKeys(start, index));
}

// ---------- Camadas, filtro e cor ----------

export type Layers = { mine: boolean; posts: boolean; routines: boolean };
export const DEFAULT_LAYERS: Layers = { mine: true, posts: true, routines: false };

export type AgendaData = { events: AgendaEvent[]; posts: AgendaPostItem[]; routines: AgendaRoutineItem[] };

/** Aplica o filtro de workspace e as camadas ligadas. */
export function applyView(data: AgendaData, view: { workspace: string | null; layers: Layers }): AgendaData {
  const keep = (workspace: string | undefined) => view.workspace === null || workspace === view.workspace;
  return {
    events: view.layers.mine ? data.events.filter((event) => event.status === "marcado" && keep(event.workspace)) : [],
    posts: view.layers.posts ? data.posts.filter((post) => keep(post.workspace)) : [],
    routines: view.layers.routines ? data.routines.filter((routine) => keep(routine.workspace)) : [],
  };
}

/** Cor estável de um workspace (matiz pelo id, para a legenda e o "quem marcou"). */
export function workspaceHue(id: string): number {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) % 360;
  // Evita a faixa do âmbar do Cyno (30–60) e do violeta do acento (250–270) para não confundir com a "Seu tempo".
  const hue = (hash * 7) % 360;
  return hue >= 30 && hue <= 60 ? hue + 60 : hue;
}

export const workspaceColor = (id: string | undefined) => (id ? `hsl(${workspaceHue(id)} 62% 64%)` : "var(--cyno)");

/** As `limit` próximas marcações (que ainda não terminaram), em ordem de início. */
export function upcomingEvents(events: readonly AgendaEvent[], now: Date, limit: number): AgendaEvent[] {
  return events
    .filter((event) => event.status === "marcado" && Date.parse(event.end) > now.getTime())
    .sort((a, b) => a.start.localeCompare(b.start) || a.id.localeCompare(b.id))
    .slice(0, limit);
}

/** Posts e rotinas de um dia, na ordem. */
export function postsOfDay(posts: readonly AgendaPostItem[], key: DateKey): AgendaPostItem[] {
  return posts.filter((post) => post.date === key).sort((a, b) => (a.time ?? "").localeCompare(b.time ?? "") || a.title.localeCompare(b.title));
}

export function routinesOfDay(routines: readonly AgendaRoutineItem[], key: DateKey, zone: string = AGENDA_TIMEZONE): AgendaRoutineItem[] {
  return routines.filter((routine) => dayKeyOf(routine.at, zone) === key).sort((a, b) => a.at.localeCompare(b.at));
}

/** Itens de um dia para a célula do mês e a lista: compromissos primeiro, depois posts e rotinas. */
export function eventsOfDay(events: readonly AgendaEvent[], key: DateKey, zone: string = AGENDA_TIMEZONE): AgendaEvent[] {
  return daySegments(events, key, zone).map((segment) => segment.event);
}

/** Dia da lista: "Hoje", "Amanhã" ou "qui., 12 de novembro". */
const MONTHS = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
const WEEK_SHORT = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
export function dayLabel(key: DateKey, today: DateKey): string {
  if (key === today) return "Hoje";
  if (key === addDayKeys(today, 1)) return "Amanhã";
  const p = parts(key);
  return `${WEEK_SHORT[weekdayOf(key)]}., ${p.day} de ${MONTHS[p.month - 1]}`;
}

/** "Hoje", "Amanhã" ou "qui 12/11" (para os cartões estreitos). */
export function compactDayLabel(key: DateKey, today: DateKey): string {
  if (key === today) return "Hoje";
  if (key === addDayKeys(today, 1)) return "Amanhã";
  return shortDay(key);
}

/** "qui 12/11" (para cartões e recusas). */
export function shortDay(key: DateKey): string {
  const p = parts(key);
  return `${WEEK_SHORT[weekdayOf(key)]} ${pad(p.day)}/${pad(p.month)}`;
}

/** Título da semana: "8 – 14 de novembro de 2026" (ou "30 de nov – 6 de dez de 2026"). */
export function weekTitle(keys: readonly DateKey[]): string {
  const first = parts(keys[0]!);
  const last = parts(keys[keys.length - 1]!);
  if (first.month === last.month) return `${first.day} – ${last.day} de ${MONTHS[last.month - 1]} de ${last.year}`;
  return `${first.day} de ${MONTHS[first.month - 1]!.slice(0, 3)} – ${last.day} de ${MONTHS[last.month - 1]!.slice(0, 3)} de ${last.year}`;
}

/** Valor de `<input type="datetime-local">`-like: "2026-11-12" e "17:00" a partir de um instante. */
export function splitInstant(at: string, zone: string = AGENDA_TIMEZONE): { date: DateKey; time: string } {
  return { date: dayKeyOf(at, zone), time: timeLabel(at, zone) };
}
