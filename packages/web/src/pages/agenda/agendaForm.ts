import { AGENDA_LIMITS, type AgendaEvent, type AgendaKind, type CreateAgendaEventBody, type UpdateAgendaEventBody } from "@cyno/shared";
import { clockLabel, instantOf, splitInstant } from "./agendaTime";

/** O formulário de um compromisso (criar, editar ou mover pela tela). Funções puras. */
export type AgendaFormValues = {
  title: string;
  kind: AgendaKind;
  /** AAAA-MM-DD, no fuso da agenda. */
  date: string;
  start: string;
  end: string;
  /** Id do workspace de origem ("" = nenhum). */
  workspace: string;
  location: string;
  link: string;
  notes: string;
};
export type AgendaFormField = "title" | "date" | "start" | "end" | "link" | "notes";
export type AgendaFormErrors = Partial<Record<AgendaFormField, string>>;

/** Novo compromisso no dia e na hora (padrão: 1 hora de duração, ou a duração padrão da disponibilidade). */
export function emptyAgendaForm(date: string, startMinutes = 9 * 60, durationMinutes = 60, workspace = ""): AgendaFormValues {
  const start = Math.min(startMinutes, 24 * 60 - 15);
  const end = Math.min(start + durationMinutes, 24 * 60 - 1);
  return { title: "", kind: "reuniao", date, start: clockLabel(start), end: clockLabel(end), workspace, location: "", link: "", notes: "" };
}

export function eventToAgendaForm(event: AgendaEvent): AgendaFormValues {
  const start = splitInstant(event.start);
  const end = splitInstant(event.end);
  return {
    title: event.title,
    kind: event.kind,
    date: start.date,
    start: start.time,
    // Um compromisso que passa da meia-noite aparece até 23:59 no formulário (o resto só se edita pelo MCP).
    end: end.date === start.date ? end.time : "23:59",
    workspace: event.workspace ?? "",
    location: event.location ?? "",
    link: event.link ?? "",
    notes: event.notes ?? "",
  };
}

export function validateAgendaForm(values: AgendaFormValues): AgendaFormErrors {
  const errors: AgendaFormErrors = {};
  if (values.title.trim() === "") errors.title = "Dê um título ao compromisso.";
  else if (values.title.trim().length > AGENDA_LIMITS.title) errors.title = `No máximo ${AGENDA_LIMITS.title} caracteres.`;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(values.date)) errors.date = "Escolha o dia.";
  if (!/^\d{2}:\d{2}$/.test(values.start)) errors.start = "Escolha a hora de início.";
  if (!/^\d{2}:\d{2}$/.test(values.end)) errors.end = "Escolha a hora de término.";
  else if (!errors.start && values.end <= values.start) errors.end = "O fim precisa ser depois do início.";
  if (values.link.length > AGENDA_LIMITS.link) errors.link = `No máximo ${AGENDA_LIMITS.link} caracteres.`;
  if (values.notes.length > AGENDA_LIMITS.notes) errors.notes = `No máximo ${AGENDA_LIMITS.notes} caracteres.`;
  return errors;
}

/** O início e o fim (ISO) do formulário, ou null se ainda não estão completos. */
export function slotOf(values: Pick<AgendaFormValues, "date" | "start" | "end">): { start: string; end: string } | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(values.date) || !/^\d{2}:\d{2}$/.test(values.start) || !/^\d{2}:\d{2}$/.test(values.end) || values.end <= values.start) return null;
  return { start: instantOf(values.date, values.start), end: instantOf(values.date, values.end) };
}

export function toCreateBody(values: AgendaFormValues, override: boolean): CreateAgendaEventBody {
  const slot = slotOf(values);
  if (!slot) throw new Error("Horário incompleto");
  return {
    title: values.title.trim(),
    ...slot,
    kind: values.kind,
    ...(values.workspace ? { workspace: values.workspace } : {}),
    ...(values.location.trim() ? { location: values.location.trim() } : {}),
    ...(values.link.trim() ? { link: values.link.trim() } : {}),
    ...(values.notes.trim() ? { notes: values.notes.trim() } : {}),
    ...(override ? { override: true } : {}),
  };
}

/** Só o que mudou (o servidor só confere o horário se `start`/`end` vierem). */
export function toUpdateBody(values: AgendaFormValues, event: AgendaEvent, override: boolean): UpdateAgendaEventBody {
  const slot = slotOf(values);
  const body: UpdateAgendaEventBody = {};
  if (values.title.trim() !== event.title) body.title = values.title.trim();
  if (values.kind !== event.kind) body.kind = values.kind;
  if (slot && (slot.start !== new Date(event.start).toISOString() || slot.end !== new Date(event.end).toISOString())) {
    body.start = slot.start;
    body.end = slot.end;
  }
  const same = (value: string, current: string | undefined) => value.trim() === (current ?? "");
  if (!same(values.location, event.location)) body.location = values.location.trim() || null;
  if (!same(values.link, event.link)) body.link = values.link.trim() || null;
  if (!same(values.notes, event.notes)) body.notes = values.notes.trim() || null;
  if (override && (body.start || body.end)) body.override = true;
  return body;
}
