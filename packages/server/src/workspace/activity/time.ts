import { dayKeyOf, zonedParts } from "../../engines/usage/usage-time";

/** Dia (AAAA-MM-DD) de São Paulo de um instante: é o nome do arquivo da Atividade. */
export function activityDay(ms: number): string {
  return dayKeyOf(ms);
}

/** ISO 8601 no fuso de São Paulo, com o deslocamento (ex.: 2026-11-10T14:03:22.114-03:00). */
export function spIso(ms: number): string {
  const p = zonedParts(ms);
  const pad = (n: number, size = 2) => String(n).padStart(size, "0");
  const wholeSecond = Math.floor(ms / 1000) * 1000;
  const offsetMin = Math.round((Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - wholeSecond) / 60_000);
  const sign = offsetMin < 0 ? "-" : "+";
  const abs = Math.abs(offsetMin);
  const millis = ((ms % 1000) + 1000) % 1000;
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}.${pad(millis, 3)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}
