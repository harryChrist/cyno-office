import { ROUTINE_SCHEDULE_LIMITS, scheduleInputSchema, type RoutineSchedule, type ScheduleDays, type ScheduleInput, type Weekday } from "@cyno/shared";

/** Formulário de um horário da rotina: dias, horas, a ação e (opcional) outro agente e o escopo. */
export type DaysMode = ScheduleDays["kind"];

export type ScheduleFormValues = {
  /** Id do horário que já existe ("S1"); vazio = horário novo. */
  id?: string;
  label: string;
  mode: DaysMode;
  weekdays: Weekday[];
  /** Dia do mês como texto (1 a 31). */
  monthDay: string;
  /** Horas "HH:MM" (campos vazios ficam na lista até serem preenchidos ou removidos). */
  times: string[];
  action: string;
  /** Endereço "workspace/agente"; vazio = o dono da rotina. */
  agent: string;
  scope: "" | "geral" | "itens_vencidos";
  enabled: boolean;
  /** Gatilho reservado (sem tela): guardado para não se perder ao salvar. */
  trigger?: RoutineSchedule["trigger"];
};
export type ScheduleField = "label" | "days" | "times" | "action" | "agent";
export type ScheduleErrors = Partial<Record<ScheduleField, string>>;

export const WEEKDAY_OPTIONS: { value: Weekday; short: string; long: string }[] = [
  { value: 1, short: "Seg", long: "segunda" },
  { value: 2, short: "Ter", long: "terça" },
  { value: 3, short: "Qua", long: "quarta" },
  { value: 4, short: "Qui", long: "quinta" },
  { value: 5, short: "Sex", long: "sexta" },
  { value: 6, short: "Sáb", long: "sábado" },
  { value: 7, short: "Dom", long: "domingo" },
];

export const DAYS_MODE_LABELS: Record<DaysMode, string> = { todo_dia: "Todo dia", uteis: "Dias úteis", semana: "Dias da semana", mes: "Dia do mês" };

export function emptySchedule(patch: Partial<ScheduleFormValues> = {}): ScheduleFormValues {
  return { label: "", mode: "uteis", weekdays: [2, 4], monthDay: "1", times: ["09:00"], action: "", agent: "", scope: "", enabled: true, ...patch };
}

export function scheduleToForm(schedule: RoutineSchedule): ScheduleFormValues {
  const { days } = schedule;
  return {
    id: schedule.id,
    label: schedule.label,
    mode: days.kind,
    weekdays: days.kind === "semana" ? [...days.weekdays].sort() : [2, 4],
    monthDay: days.kind === "mes" ? String(days.monthDay) : "1",
    times: [...schedule.times],
    action: schedule.action,
    agent: schedule.agent ?? "",
    scope: schedule.scope ?? "",
    enabled: schedule.enabled,
    ...(schedule.trigger ? { trigger: schedule.trigger } : {}),
  };
}

function daysOf(values: ScheduleFormValues): ScheduleDays {
  switch (values.mode) {
    case "todo_dia":
      return { kind: "todo_dia" };
    case "uteis":
      return { kind: "uteis" };
    case "semana":
      return { kind: "semana", weekdays: [...new Set(values.weekdays)].sort() as Weekday[] };
    case "mes":
      return { kind: "mes", monthDay: Number(values.monthDay) };
  }
}

const LABEL_STOPWORDS = new Set(["a", "o", "as", "os", "da", "de", "do", "das", "dos", "e", "para", "em", "no", "na", "com", "que", "um", "uma", "ao", "pela", "pelo"]);

/** O nome do horário quando o usuário não deu um: as 3 primeiras palavras da ação, sem terminar em "de", "para"… */
export function shortLabel(action: string): string {
  const words = action.trim().replace(/\s+/g, " ").split(" ").filter(Boolean).slice(0, 3);
  while (words.length > 1 && LABEL_STOPWORDS.has(words.at(-1)!.toLowerCase())) words.pop();
  const text = words.join(" ");
  const label = text.length > 40 ? `${text.slice(0, 39)}…` : text;
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/** Horário como a API o espera (horas válidas e sem repetição; o resto o zod do shared confere). */
export function scheduleToInput(values: ScheduleFormValues): ScheduleInput {
  const times = [...new Set(values.times.map((time) => time.trim()).filter((time) => time !== ""))].sort();
  const label = values.label.trim() || shortLabel(values.action);
  return {
    ...(values.id ? { id: values.id } : {}),
    label,
    days: daysOf(values),
    times,
    action: values.action.trim(),
    ...(values.agent ? { agent: values.agent } : {}),
    ...(values.scope ? { scope: values.scope } : {}),
    ...(values.trigger ? { trigger: values.trigger } : {}),
    enabled: values.enabled,
  };
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Erros de um horário (mensagens em pt-BR; no fim, o zod do shared tem a última palavra). */
export function validateSchedule(values: ScheduleFormValues): ScheduleErrors {
  const errors: ScheduleErrors = {};
  if (!values.action.trim()) errors.action = "Diga o que fazer neste horário.";
  else if (values.action.trim().length > ROUTINE_SCHEDULE_LIMITS.action) errors.action = `Até ${ROUTINE_SCHEDULE_LIMITS.action} caracteres.`;
  if (values.label.trim().length > ROUTINE_SCHEDULE_LIMITS.label) errors.label = `Até ${ROUTINE_SCHEDULE_LIMITS.label} caracteres.`;
  if (values.mode === "semana" && values.weekdays.length === 0) errors.days = "Marque pelo menos um dia da semana.";
  if (values.mode === "mes") {
    const day = Number(values.monthDay);
    if (!/^\d+$/.test(values.monthDay.trim()) || day < 1 || day > 31) errors.days = "O dia do mês vai de 1 a 31.";
  }
  const filled = values.times.map((time) => time.trim()).filter((time) => time !== "");
  if (!values.trigger) {
    if (filled.length === 0) errors.times = "Informe pelo menos uma hora.";
    else if (filled.some((time) => !HHMM.test(time))) errors.times = "Use horas válidas, como 09:00.";
    else if (filled.length > ROUTINE_SCHEDULE_LIMITS.times) errors.times = `No máximo ${ROUTINE_SCHEDULE_LIMITS.times} horas.`;
  }
  if (Object.keys(errors).length > 0) return errors;
  const parsed = scheduleInputSchema.safeParse(scheduleToInput(values));
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    const field = String(issue.path[0] ?? "action");
    errors[field === "label" || field === "times" || field === "agent" || field === "days" ? field : "action"] = issue.message;
  }
  return errors;
}

// ---------- Texto do que o horário vai fazer ----------

const hourText = (time: string): string => {
  const [h, m] = time.split(":");
  return m === "00" ? `${Number(h)}h` : `${Number(h)}h${m}`;
};

/** "9h, 13h e 18h". */
export function joinList(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} e ${parts.at(-1)}`;
}

/** "9h, 13h e 18h" a partir das horas do formulário (ignora vazias e inválidas). */
export function timesText(times: readonly string[]): string {
  return joinList([...new Set(times.map((time) => time.trim()).filter((time) => HHMM.test(time)))].sort().map(hourText));
}

/** "todo dia", "todo dia útil", "toda terça e quinta", "todo sábado e domingo", "no dia 5 de cada mês". */
export function daysPhrase(values: Pick<ScheduleFormValues, "mode" | "weekdays" | "monthDay">): string {
  switch (values.mode) {
    case "todo_dia":
      return "todo dia";
    case "uteis":
      return "todo dia útil";
    case "mes":
      return `no dia ${Number(values.monthDay) || "?"} de cada mês`;
    case "semana": {
      const days = WEEKDAY_OPTIONS.filter((option) => values.weekdays.includes(option.value));
      if (days.length === 0) return "(escolha os dias)";
      return `${days.every((day) => day.value >= 6) ? "todo" : "toda"} ${joinList(days.map((day) => day.long))}`;
    }
  }
}

/** A prévia resume a ação: só o começo dela. */
const PREVIEW_ACTION_MAX = 110;

const lowerFirst = (text: string) => (text.length > 0 ? text.charAt(0).toLowerCase() + text.slice(1) : text);

/** A prévia em texto: "Todo dia útil às 9h, 13h e 18h, o ECO vai olhar posts novos." */
export function schedulePreview(values: ScheduleFormValues, who: string): string {
  const when = values.trigger ? "Quando chegar e-mail novo" : `${daysPhrase(values)} às ${timesText(values.times) || "(escolha as horas)"}`;
  const flat = values.action.trim().replace(/\s+/g, " ").replace(/[.!]+$/, "");
  const action = flat ? lowerFirst(flat.length > PREVIEW_ACTION_MAX ? `${flat.slice(0, PREVIEW_ACTION_MAX - 1).trimEnd()}…` : flat) : "…";
  const scope = values.scope === "itens_vencidos" ? " (só roda se houver item para conferir)" : "";
  const text = `${when}, ${who} vai ${action}${scope}.`;
  return text.charAt(0).toUpperCase() + text.slice(1);
}
