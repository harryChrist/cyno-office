import type { Availability } from "@cyno/shared";

/**
 * O formulário da disponibilidade (editor da Sua agenda): janelas por dia da semana, dias bloqueados
 * ou com horário diferente, antecedência mínima, duração padrão e intervalo entre compromissos.
 * Funções puras: o formulário trabalha com texto/números e `toAvailability` devolve o corpo do PUT.
 */

export type WindowForm = { from: string; to: string };
export type ExceptionForm = { date: string; mode: "off" | "window"; from: string; to: string; note: string };
export type AvailabilityForm = {
  /** Índice = dia da semana (0 = domingo … 6 = sábado). */
  days: WindowForm[][];
  exceptions: ExceptionForm[];
  bufferMinutes: string;
  minNoticeMinutes: string;
  defaultDurationMinutes: string;
};

export const WEEKDAY_LABELS = ["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"] as const;
/** A ordem da lista no editor: começa na segunda (o dia a dia do dono). */
export const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;

export const NEW_WINDOW: WindowForm = { from: "09:00", to: "18:00" };

const minutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
const validTime = (time: string) => /^\d{2}:\d{2}$/.test(time) && ((Number(time.slice(0, 2)) < 24 && Number(time.slice(3)) < 60) || time === "24:00");

export function availabilityToForm(availability: Availability): AvailabilityForm {
  const days: WindowForm[][] = Array.from({ length: 7 }, () => []);
  for (const window of [...availability.weekly].sort((a, b) => a.from.localeCompare(b.from))) days[window.weekday]!.push({ from: window.from, to: window.to });
  return {
    days,
    exceptions: [...availability.exceptions]
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((exception) => ({ date: exception.date, mode: exception.off ? "off" : "window", from: exception.from ?? "09:00", to: exception.to ?? "12:00", note: exception.note ?? "" })),
    bufferMinutes: String(availability.bufferMinutes),
    minNoticeMinutes: String(availability.minNoticeMinutes),
    defaultDurationMinutes: String(availability.defaultDurationMinutes),
  };
}

export type AvailabilityErrors = { days: Record<number, string>; exceptions: Record<number, string>; numbers: Partial<Record<"bufferMinutes" | "minNoticeMinutes" | "defaultDurationMinutes", string>> };

const NUMBER_RULES = {
  bufferMinutes: { min: 0, max: 120, label: "O intervalo" },
  minNoticeMinutes: { min: 0, max: 7 * 24 * 60, label: "A antecedência" },
  defaultDurationMinutes: { min: 5, max: 24 * 60, label: "A duração padrão" },
} as const;

/** Confere o formulário: janela com início antes do fim, sem sobreposição no mesmo dia, datas das exceções únicas. */
export function validateAvailabilityForm(form: AvailabilityForm): AvailabilityErrors {
  const errors: AvailabilityErrors = { days: {}, exceptions: {}, numbers: {} };
  form.days.forEach((windows, weekday) => {
    const sorted = [...windows].sort((a, b) => a.from.localeCompare(b.from));
    for (const window of sorted) {
      if (!validTime(window.from) || !validTime(window.to)) {
        errors.days[weekday] = "Preencha as horas (HH:MM).";
        return;
      }
      if (minutes(window.from) >= minutes(window.to)) {
        errors.days[weekday] = "Cada janela precisa começar antes de terminar.";
        return;
      }
    }
    for (let index = 1; index < sorted.length; index += 1) {
      if (minutes(sorted[index]!.from) < minutes(sorted[index - 1]!.to)) {
        errors.days[weekday] = "As janelas do mesmo dia não podem se sobrepor.";
        return;
      }
    }
  });
  const seen = new Set<string>();
  form.exceptions.forEach((exception, index) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(exception.date)) errors.exceptions[index] = "Escolha a data.";
    else if (seen.has(exception.date)) errors.exceptions[index] = "Já existe uma exceção neste dia.";
    else if (exception.mode === "window" && (!validTime(exception.from) || !validTime(exception.to) || minutes(exception.from) >= minutes(exception.to))) errors.exceptions[index] = "A janela precisa começar antes de terminar.";
    seen.add(exception.date);
  });
  for (const key of Object.keys(NUMBER_RULES) as (keyof typeof NUMBER_RULES)[]) {
    const rule = NUMBER_RULES[key];
    const value = Number(form[key]);
    if (form[key].trim() === "" || !Number.isInteger(value) || value < rule.min || value > rule.max) errors.numbers[key] = `${rule.label} vai de ${rule.min} a ${rule.max} minutos.`;
  }
  return errors;
}

export const hasAvailabilityErrors = (errors: AvailabilityErrors) => Object.keys(errors.days).length + Object.keys(errors.exceptions).length + Object.keys(errors.numbers).length > 0;

/** O corpo do `PUT /api/agenda/availability` (o fuso continua o que já estava). */
export function toAvailability(form: AvailabilityForm, current: Availability): Availability {
  return {
    weekly: form.days.flatMap((windows, weekday) => [...windows].sort((a, b) => a.from.localeCompare(b.from)).map((window) => ({ weekday, from: window.from, to: window.to }))),
    exceptions: [...form.exceptions]
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((exception) => ({ date: exception.date, ...(exception.mode === "off" ? { off: true } : { from: exception.from, to: exception.to }), ...(exception.note.trim() ? { note: exception.note.trim() } : {}) })),
    bufferMinutes: Number(form.bufferMinutes),
    minNoticeMinutes: Number(form.minNoticeMinutes),
    defaultDurationMinutes: Number(form.defaultDurationMinutes),
    timezone: current.timezone,
  };
}

/** Resumo de uma frase da disponibilidade ("Seg a sex, 9h às 18h"), para o rodapé da página. */
export function describeAvailability(availability: Availability): string {
  if (availability.weekly.length === 0) return "Nenhum horário disponível definido";
  const label = (from: string, to: string) => `${from.replace(/^0/, "").replace(":00", "h")} às ${to.replace(/^0/, "").replace(":00", "h")}`;
  const groups = new Map<string, number[]>();
  for (const weekday of WEEKDAY_ORDER) {
    const windows = availability.weekly.filter((window) => window.weekday === weekday).sort((a, b) => a.from.localeCompare(b.from));
    if (windows.length === 0) continue;
    const key = windows.map((window) => label(window.from, window.to)).join(" e ");
    groups.set(key, [...(groups.get(key) ?? []), weekday]);
  }
  const short = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
  return [...groups]
    .map(([times, weekdays]) => {
      const consecutive = weekdays.length > 2 && weekdays.every((day, index) => index === 0 || WEEKDAY_ORDER.indexOf(day as never) === WEEKDAY_ORDER.indexOf(weekdays[index - 1] as never) + 1);
      const days = consecutive ? `${short[weekdays[0]!]} a ${short[weekdays[weekdays.length - 1]!]}` : weekdays.map((day) => short[day]).join(", ");
      return `${days[0]!.toUpperCase()}${days.slice(1)}, ${times}`;
    })
    .join(" · ");
}
