import { WORK_TIME_ZONE, workClock } from "@cyno/shared";

/**
 * Horários da tela Trabalho: tudo no fuso de São Paulo (o do dono e o do servidor: prazo, "começa em",
 * janela do ritmo e virada do dia valem nele), seja qual for o fuso do navegador.
 */

const parts = new Intl.DateTimeFormat("en-CA", { timeZone: WORK_TIME_ZONE, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });

type Clock = { year: number; month: number; day: number; hour: number; minute: number };

/** Dia e hora de `ms` no relógio de São Paulo. */
export function brasiliaClock(ms: number): Clock {
  const found: Record<string, string> = {};
  for (const part of parts.formatToParts(new Date(ms))) found[part.type] = part.value;
  return { year: Number(found.year), month: Number(found.month), day: Number(found.day), hour: Number(found.hour), minute: Number(found.minute) };
}

const pad = (n: number) => String(n).padStart(2, "0");

/** ISO -> valor de `<input type="datetime-local">` no horário de Brasília. */
export function toBrasiliaInput(iso: string | undefined): string {
  if (!iso) return "";
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "";
  const c = brasiliaClock(ms);
  return `${c.year}-${pad(c.month)}-${pad(c.day)}T${pad(c.hour)}:${pad(c.minute)}`;
}

/** Valor de `<input type="datetime-local">` (horário de Brasília) -> ISO (null = vazio ou inválido). */
export function fromBrasiliaInput(value: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const [year, month, day, hour, minute] = match.slice(1).map(Number) as [number, number, number, number, number];
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  // O deslocamento de São Paulo naquele instante (duas passadas cobrem uma virada de horário de verão).
  let guess = wall;
  for (let i = 0; i < 2; i += 1) {
    const c = brasiliaClock(guess);
    guess += wall - Date.UTC(c.year, c.month - 1, c.day, c.hour, c.minute);
  }
  return Number.isNaN(guess) ? null : new Date(guess).toISOString();
}

/** O navegador está num fuso com hora diferente da de Brasília agora? (aí a tela avisa) */
export function browserOutsideBrasilia(now: number = Date.now()): boolean {
  const local = new Date(now);
  const c = brasiliaClock(now);
  const localWall = Date.UTC(local.getFullYear(), local.getMonth(), local.getDate(), local.getHours(), local.getMinutes());
  return localWall !== Date.UTC(c.year, c.month - 1, c.day, c.hour, c.minute);
}

/** " (horário de Brasília)" quando o navegador está em outro fuso; vazio quando já é o mesmo. */
export function brasiliaNote(now?: number): string {
  return browserOutsideBrasilia(now) ? " (horário de Brasília)" : "";
}

/** "13/11" e, se tem hora marcada, " 18:00" (horário de Brasília). */
export function brasiliaShortDate(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  const c = brasiliaClock(ms);
  const hasTime = c.hour !== 0 || c.minute !== 0;
  return `${pad(c.day)}/${pad(c.month)}${hasTime ? ` ${pad(c.hour)}:${pad(c.minute)}` : ""}`;
}

/** "13/11/2026 18:00" (horário de Brasília), para dicas e detalhes. */
export function brasiliaDateTime(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  const c = brasiliaClock(ms);
  return `${pad(c.day)}/${pad(c.month)}/${c.year} ${pad(c.hour)}:${pad(c.minute)}`;
}

/** Dia de São Paulo ("AAAA-MM-DD"): a chave de `worked`. */
export function brasiliaDay(date: Date): string {
  return workClock(date.getTime()).day;
}
