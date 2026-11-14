import {
  FIELD_TYPES,
  ROUTINE_LIMITS,
  clampTarget,
  createRoutineBodySchema,
  goalOf,
  parseAddress,
  updateRoutineBodySchema,
  type CreateRoutineBody,
  type FieldDef,
  type FieldType,
  type Routine,
  type RoutineKind,
  type RoutinePeriod,
  type RoutineType,
  type TrackingSpec,
  type UpdateRoutineBody,
  type Weekday,
} from "@cyno/shared";
import type { FieldErrors } from "../../ui/validation";
import { WEEKDAY_OPTIONS, emptySchedule, scheduleToForm, scheduleToInput, validateSchedule, type ScheduleErrors, type ScheduleFormValues } from "./scheduleForm";

/** Campo da tabela do acompanhamento no formulário (`locked` = já existe: só se acrescenta, não se muda nem remove). */
export type FieldFormValues = { key: string; label: string; type: FieldType; /** Opções separadas por vírgula (tipo "opcao"). */ options: string; required: boolean; locked: boolean };
export type StatusFormValues = { name: string; terminal: boolean; alert: boolean; locked: boolean };

/** Formulário de criar/editar uma rotina (campos como texto; o corpo da API sai de `toCreateBody`). */
export type RoutineFormValues = {
  type: RoutineType;
  title: string;
  /** "agent:<id>" ou "team:<id>" ("" = nenhum ainda). */
  owner: string;
  instruction: string;
  needsApproval: boolean;
  dailyCap: string;
  schedules: ScheduleFormValues[];
  // Meta
  unit: string;
  kind: RoutineKind;
  site: string;
  target: string;
  period: RoutinePeriod;
  preferredDays: Weekday[];
  stopOnHit: boolean;
  /** "1", "2" ou "3". */
  prepareFactor: string;
  // Acompanhamento
  fields: FieldFormValues[];
  statuses: StatusFormValues[];
  lifespanDays: string;
  untilTerminal: boolean;
  expireStatus: string;
  checkEveryHours: string;
};
export type RoutineFormField = keyof RoutineFormValues | "general";

export type RoutineFormErrors = {
  fields: FieldErrors<RoutineFormField>;
  /** Um item por horário (vazio = sem erro). */
  schedules: ScheduleErrors[];
  /** Um texto por campo e por status da tabela ("" = sem erro). */
  trackingFields: string[];
  trackingStatuses: string[];
};

export type RoutineTemplate = {
  id: string;
  name: string;
  description: string;
  type: RoutineType;
  values: Partial<RoutineFormValues>;
};

const POST_ACTION = "Escreva e publique 1 post por semana no LinkedIn, no tom da marca e sobre um assunto novo. Registre o link do post publicado.";

/** Modelos de partida. Todos pedem OK por padrão: quem liberar o "age sozinho" decide depois. */
export const ROUTINE_TEMPLATES: RoutineTemplate[] = [
  {
    id: "meta-semanal",
    name: "Meta semanal",
    description: "3 itens por semana, preparando o dobro para você escolher.",
    type: "meta",
    values: {
      type: "meta",
      title: "3 frases por semana",
      unit: "frase",
      kind: "other",
      site: "exemplo.com",
      target: "3",
      period: "week",
      stopOnHit: true,
      prepareFactor: "2",
      needsApproval: true,
      instruction: "Prepare frases curtas e originais sobre o tema da semana. Registre o link de cada uma entregue.",
    },
  },
  {
    id: "inscricoes",
    name: "Acompanhar inscrições",
    description: "Vagas em que você se inscreveu: status, histórico e prazo de 15 dias.",
    type: "acompanhamento",
    values: {
      type: "acompanhamento",
      title: "Inscrições de emprego",
      needsApproval: true,
      instruction: "Acompanhe as candidaturas: crie um item para cada inscrição nova e atualize o status quando a empresa responder.",
      fields: [
        { key: "empresa", label: "Empresa", type: "texto", options: "", required: true, locked: false },
        { key: "vaga", label: "Vaga", type: "texto", options: "", required: false, locked: false },
        { key: "link", label: "Link", type: "link", options: "", required: false, locked: false },
        { key: "inscritoEm", label: "Inscrito em", type: "data", options: "", required: false, locked: false },
      ],
      statuses: [
        { name: "Inscrito", terminal: false, alert: false, locked: false },
        { name: "Em análise", terminal: false, alert: false, locked: false },
        { name: "Entrevista", terminal: false, alert: true, locked: false },
        { name: "Oferta", terminal: true, alert: true, locked: false },
        { name: "Recusado", terminal: true, alert: false, locked: false },
        { name: "Sem resposta", terminal: false, alert: false, locked: false },
      ],
      lifespanDays: "15",
      untilTerminal: true,
      expireStatus: "Sem resposta",
      checkEveryHours: "24",
      schedules: [
        emptySchedule({ label: "Procurar novidades", mode: "todo_dia", times: ["08:00", "18:00"], scope: "geral", action: "Procure inscrições novas (e-mails de confirmação ou o site) e crie um item para cada uma. Atualize o status das que já existem." }),
        emptySchedule({ label: "Conferir vencidos", mode: "todo_dia", times: ["10:00"], scope: "itens_vencidos", action: "Para cada item ativo vencido, abra o link, leia o status da candidatura e atualize o item." }),
      ],
    },
  },
  {
    id: "post-semanal",
    name: "Post semanal",
    description: "1 post por semana no LinkedIn, com o seu OK.",
    type: "meta",
    values: { type: "meta", title: "Post semanal no LinkedIn", unit: "post", kind: "post", site: "linkedin.com", target: "1", needsApproval: true, instruction: POST_ACTION },
  },
  {
    id: "comentarios",
    name: "Comentários",
    description: "5 comentários por semana em posts do seu nicho.",
    type: "meta",
    values: {
      type: "meta",
      title: "Comentários no LinkedIn",
      unit: "comentário",
      kind: "comment",
      site: "linkedin.com",
      target: "5",
      needsApproval: true,
      instruction: "Comente em posts relevantes do nosso nicho, com algo útil e específico (nunca genérico). Registre o link de cada comentário.",
    },
  },
  {
    id: "convites",
    name: "Convites",
    description: "10 convites de conexão por semana.",
    type: "meta",
    values: {
      type: "meta",
      title: "Convites no LinkedIn",
      unit: "convite",
      kind: "invite",
      site: "linkedin.com",
      target: "10",
      needsApproval: true,
      instruction: "Envie convites de conexão para pessoas do nosso público, com nota curta e personalizada. Registre o link do perfil de cada convidado.",
    },
  },
];

export function emptyRoutineForm(type: RoutineType = "meta"): RoutineFormValues {
  return {
    type,
    title: "",
    owner: "",
    instruction: "",
    needsApproval: true,
    dailyCap: "",
    schedules: type === "acompanhamento" ? [emptySchedule({ mode: "todo_dia", scope: "geral" })] : [],
    unit: "",
    kind: "other",
    site: "",
    target: "1",
    period: "week",
    preferredDays: [],
    stopOnHit: true,
    prepareFactor: "1",
    fields: [{ key: "nome", label: "Nome", type: "texto", options: "", required: true, locked: false }],
    statuses: [{ name: "Ativo", terminal: false, alert: false, locked: false }],
    lifespanDays: "",
    untilTerminal: true,
    expireStatus: "",
    checkEveryHours: "",
  };
}

export function templateToForm(template: RoutineTemplate): RoutineFormValues {
  return { ...emptyRoutineForm(template.type), ...template.values };
}

function fieldToForm(field: FieldDef): FieldFormValues {
  return { key: field.key, label: field.label, type: field.type, options: (field.options ?? []).join(", "), required: field.required === true, locked: true };
}

export function routineToForm(routine: Routine): RoutineFormValues {
  const base = emptyRoutineForm(routine.type);
  const goal = goalOf(routine);
  const owner = routine.agentId ? `agent:${routine.agentId}` : routine.teamId ? `team:${routine.teamId}` : routine.owner && "address" in routine.owner ? `agent:${parseAddress(routine.owner.address)?.agentId ?? ""}` : "";
  const tracking = routine.tracking;
  return {
    ...base,
    type: routine.type,
    title: routine.title,
    owner,
    instruction: routine.instruction,
    needsApproval: routine.needsApproval,
    dailyCap: routine.dailyCap === undefined ? "" : String(routine.dailyCap),
    schedules: routine.schedules.map(scheduleToForm),
    unit: routine.unit,
    kind: routine.kind,
    site: routine.site,
    target: String(routine.target),
    period: goal.period,
    preferredDays: [...(goal.preferredDays ?? [])],
    stopOnHit: goal.stopOnHit,
    prepareFactor: String(goal.prepareFactor),
    ...(tracking
      ? {
          fields: tracking.fields.map(fieldToForm),
          statuses: tracking.statuses.map((status) => ({ name: status.name, terminal: status.terminal === true, alert: status.alert === true, locked: true })),
          lifespanDays: tracking.lifespan.days === undefined ? "" : String(tracking.lifespan.days),
          untilTerminal: tracking.lifespan.untilTerminal,
          expireStatus: tracking.expireStatus ?? "",
          checkEveryHours: tracking.checkEveryHours === undefined ? "" : String(tracking.checkEveryHours),
        }
      : {}),
  };
}

const wholeNumber = (text: string): number | null => (/^\d+$/.test(text.trim()) ? Number(text.trim()) : null);

/** "Inscrito em" → "inscritoEm" (chave estável do campo; sem acento, começa com letra, até 40 caracteres). */
export function fieldKeyFor(label: string, taken: readonly string[] = []): string {
  const words = label
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
  let key = words.map((word, index) => (index === 0 ? word.toLowerCase() : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())).join("");
  if (!/^[a-zA-Z]/.test(key)) key = `campo${key}`;
  key = key.slice(0, 36);
  let candidate = key;
  for (let n = 2; taken.includes(candidate); n += 1) candidate = `${key}${n}`;
  return candidate;
}

const optionsOf = (text: string): string[] => [...new Set(text.split(",").map((option) => option.trim()).filter(Boolean))];

/** Campos como a API quer: as chaves novas saem do rótulo (sem repetir as que existem). */
export function toFieldDefs(fields: readonly FieldFormValues[]): FieldDef[] {
  const taken: string[] = fields.filter((field) => field.locked).map((field) => field.key);
  return fields.map((field) => {
    let key = field.key;
    if (!field.locked) {
      key = fieldKeyFor(field.label, taken);
      taken.push(key);
    }
    return { key, label: field.label.trim(), type: field.type, ...(field.type === "opcao" ? { options: optionsOf(field.options) } : {}), ...(field.required ? { required: true } : {}) };
  });
}

function toTrackingSpec(values: RoutineFormValues): TrackingSpec {
  const days = wholeNumber(values.lifespanDays);
  const every = wholeNumber(values.checkEveryHours);
  return {
    fields: toFieldDefs(values.fields),
    statuses: values.statuses.map((status) => ({ name: status.name.trim(), ...(status.terminal ? { terminal: true } : {}), ...(status.alert ? { alert: true } : {}) })),
    lifespan: { ...(days !== null ? { days } : {}), untilTerminal: values.untilTerminal },
    ...(values.expireStatus.trim() ? { expireStatus: values.expireStatus.trim() } : {}),
    ...(every !== null ? { checkEveryHours: every } : {}),
  };
}

export const emptyErrors = (): RoutineFormErrors => ({ fields: {}, schedules: [], trackingFields: [], trackingStatuses: [] });

export function hasFormErrors(errors: RoutineFormErrors): boolean {
  return Object.keys(errors.fields).length > 0 || errors.schedules.some((e) => Object.keys(e).length > 0) || errors.trackingFields.some(Boolean) || errors.trackingStatuses.some(Boolean);
}

export function validateRoutineForm(values: RoutineFormValues, editing: boolean): RoutineFormErrors {
  const errors = emptyErrors();
  const set = errors.fields;
  const meta = values.type === "meta";
  if (!values.title.trim()) set.title = "Dê um nome à rotina.";
  else if (values.title.trim().length > ROUTINE_LIMITS.title) set.title = `Até ${ROUTINE_LIMITS.title} caracteres.`;
  if (!values.owner) set.owner = "Escolha quem executa.";
  if (values.instruction.length > ROUTINE_LIMITS.instruction) set.instruction = `Até ${ROUTINE_LIMITS.instruction} caracteres.`;
  if (values.dailyCap.trim() !== "") {
    const cap = wholeNumber(values.dailyCap);
    if (cap === null || cap < 1 || cap > 1000) set.dailyCap = "Um número inteiro entre 1 e 1000, ou deixe vazio.";
  }
  errors.schedules = values.schedules.map(validateSchedule);

  if (meta) {
    if (!values.unit.trim()) set.unit = "Diga o que se conta (ex.: post).";
    else if (values.unit.trim().length > ROUTINE_LIMITS.unit) set.unit = `Até ${ROUTINE_LIMITS.unit} caracteres.`;
    if (!/^(?:www\.)?(?:[a-z0-9-]+\.)+[a-z]{2,}$/i.test(values.site.trim())) set.site = "Use só o domínio, ex.: linkedin.com.";
    const target = wholeNumber(values.target);
    if (target === null || target < 1 || target > ROUTINE_LIMITS.target) set.target = "Um número inteiro, de 1 para cima.";
  } else {
    if (values.schedules.length === 0) set.schedules = "O acompanhamento precisa de pelo menos um horário.";
    const taken = new Set<string>();
    errors.trackingFields = values.fields.map((field) => {
      if (!field.label.trim()) return "Dê um nome à coluna.";
      if (field.label.trim().length > 80) return "Até 80 caracteres.";
      const key = field.locked ? field.key : fieldKeyFor(field.label, []);
      if (taken.has(key)) return "Já existe uma coluna com esse nome.";
      taken.add(key);
      if (field.type === "opcao" && optionsOf(field.options).length === 0) return "Liste as opções, separadas por vírgula.";
      return "";
    });
    if (values.fields.length > 30) set.fields = "No máximo 30 colunas.";
    const names = new Set<string>();
    errors.trackingStatuses = values.statuses.map((status) => {
      const name = status.name.trim();
      if (!name) return "Dê um nome ao status.";
      if (name.length > 60) return "Até 60 caracteres.";
      if (names.has(name.toLowerCase())) return "Já existe um status com esse nome.";
      names.add(name.toLowerCase());
      return "";
    });
    if (values.statuses.length === 0) set.statuses = "Defina pelo menos um status.";
    if (values.lifespanDays.trim() !== "") {
      const days = wholeNumber(values.lifespanDays);
      if (days === null || days < 1 || days > 3650) set.lifespanDays = "Dias inteiros, de 1 a 3650, ou deixe vazio.";
    }
    if (values.checkEveryHours.trim() !== "") {
      const hours = wholeNumber(values.checkEveryHours);
      if (hours === null || hours < 1 || hours > 2160) set.checkEveryHours = "Horas inteiras, de 1 a 2160, ou deixe vazio.";
    }
    if (values.expireStatus.trim() && !values.statuses.some((status) => status.name.trim() === values.expireStatus.trim())) set.expireStatus = "Escolha um dos status da lista.";
    if (values.lifespanDays.trim() === "" && values.expireStatus.trim()) set.expireStatus = "O status ao vencer só vale com uma vida em dias.";
  }

  // As mesmas regras do shared (zod) têm a última palavra, para o formulário nunca aceitar o que a API recusa.
  if (!hasFormErrors(errors) && !editing) {
    const parsed = createRoutineBodySchema.safeParse(toCreateBody(values));
    if (!parsed.success) set.general = parsed.error.issues[0]?.message ?? "Confira os campos.";
  }
  return errors;
}

function ownerIds(owner: string): { agentId: string } | { teamId: string } {
  return owner.startsWith("team:") ? { teamId: owner.slice(5) } : { agentId: owner.slice(6) };
}

/** Corpo do POST /routines (a meta já sai limitada ao teto do tipo). */
export function toCreateBody(values: RoutineFormValues): CreateRoutineBody {
  const cap = wholeNumber(values.dailyCap);
  const common = {
    title: values.title.trim(),
    instruction: values.instruction.trim(),
    needsApproval: values.needsApproval,
    ...ownerIds(values.owner),
    ...(cap !== null ? { dailyCap: cap } : {}),
    schedules: values.schedules.map(scheduleToInput),
  };
  if (values.type === "acompanhamento") return { ...common, type: "acompanhamento", unit: "item", tracking: toTrackingSpec(values) };
  const target = clampTarget(values.kind, Number(values.target), values.period);
  return {
    ...common,
    type: "meta",
    unit: values.unit.trim(),
    kind: values.kind,
    site: values.site.trim().toLowerCase(),
    target,
    period: values.period,
    goal: { target, period: values.period, ...(values.preferredDays.length > 0 ? { preferredDays: [...values.preferredDays].sort() } : {}), stopOnHit: values.stopOnHit, prepareFactor: Number(values.prepareFactor) },
  };
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Corpo do PATCH: só o que mudou (vazio = nada a salvar). Mudar o dono manda um e limpa o outro. */
export function toUpdateBody(values: RoutineFormValues, routine: Routine): UpdateRoutineBody {
  const body: UpdateRoutineBody = {};
  const before = routineToForm(routine);
  if (values.title.trim() !== routine.title) body.title = values.title.trim();
  if (values.instruction.trim() !== routine.instruction) body.instruction = values.instruction.trim();
  if (values.needsApproval !== routine.needsApproval) body.needsApproval = values.needsApproval;
  const cap = wholeNumber(values.dailyCap);
  if (cap !== (routine.dailyCap ?? null)) body.dailyCap = cap;
  if (values.owner !== before.owner) {
    const ids = ownerIds(values.owner);
    if ("agentId" in ids) Object.assign(body, { agentId: ids.agentId, teamId: null });
    else Object.assign(body, { teamId: ids.teamId, agentId: null });
  }
  const nextSchedules = values.schedules.map(scheduleToInput);
  if (!sameJson(nextSchedules, before.schedules.map(scheduleToInput))) body.schedules = nextSchedules;

  if (routine.type === "meta") {
    if (values.unit.trim() !== routine.unit) body.unit = values.unit.trim();
    if (values.kind !== routine.kind) body.kind = values.kind;
    const site = values.site.trim().toLowerCase().replace(/^www\./, "");
    if (site !== routine.site) body.site = site;
    const target = clampTarget(values.kind, Number(values.target), values.period);
    if (target !== routine.target) body.target = target;
    const goal: NonNullable<UpdateRoutineBody["goal"]> = {};
    if (values.period !== before.period) goal.period = values.period;
    if (!sameJson([...values.preferredDays].sort(), [...before.preferredDays].sort())) goal.preferredDays = values.preferredDays.length > 0 ? [...values.preferredDays].sort() : null;
    if (values.stopOnHit !== before.stopOnHit) goal.stopOnHit = values.stopOnHit;
    if (values.prepareFactor !== before.prepareFactor) goal.prepareFactor = Number(values.prepareFactor);
    if (Object.keys(goal).length > 0) body.goal = goal;
  } else if (routine.tracking) {
    const next = toTrackingSpec(values);
    const old = routine.tracking;
    const tracking: NonNullable<UpdateRoutineBody["tracking"]> = {};
    if (!sameJson(next.fields, old.fields)) tracking.fields = next.fields;
    if (!sameJson(next.statuses, old.statuses)) tracking.statuses = next.statuses;
    if (!sameJson(next.lifespan, old.lifespan)) tracking.lifespan = next.lifespan;
    if (next.expireStatus !== old.expireStatus) tracking.expireStatus = next.expireStatus ?? null;
    if (next.checkEveryHours !== old.checkEveryHours) tracking.checkEveryHours = next.checkEveryHours ?? null;
    if (Object.keys(tracking).length > 0) body.tracking = tracking;
  }
  return body;
}

/** O PATCH que a API aceitaria? (devolve a primeira mensagem do zod, ou vazio.) */
export function checkUpdateBody(body: UpdateRoutineBody): string {
  const parsed = updateRoutineBodySchema.safeParse(body);
  return parsed.success ? "" : (parsed.error.issues[0]?.message ?? "Confira os campos.");
}

export { FIELD_TYPES };
export const FIELD_TYPE_LABELS: Record<FieldType, string> = { texto: "Texto", link: "Link", data: "Data", numero: "Número", opcao: "Opções" };

// ---------- Prévia em texto ----------

/** O que a meta vai fazer, em frases ("3 frases por semana, prepara 2x…; para quando bater o alvo."). */
export function metaPreview(values: Pick<RoutineFormValues, "target" | "unit" | "period" | "preferredDays" | "stopOnHit" | "prepareFactor" | "kind">): string {
  const target = wholeNumber(values.target);
  if (target === null || target < 1) return "Defina o alvo para ver a prévia.";
  const effective = clampTarget(values.kind, target, values.period);
  const unit = values.unit.trim() || "item";
  const plural = effective === 1 ? unit : unit.endsWith("m") ? `${unit.slice(0, -1)}ns` : unit.endsWith("ão") ? `${unit.slice(0, -2)}ões` : unit.endsWith("l") ? `${unit.slice(0, -1)}is` : `${unit}s`;
  const parts = [`${effective} ${plural} por ${values.period === "month" ? "mês" : "semana"}`];
  if (effective !== target) parts.push(`(limitado de ${target} pelo teto do tipo)`);
  const days = WEEKDAY_OPTIONS.filter((day) => values.preferredDays.includes(day.value)).map((day) => day.short.toLowerCase());
  if (days.length > 0) parts.push(`preferindo ${days.join(", ")}`);
  const factor = Number(values.prepareFactor);
  if (factor > 1) parts.push(`prepara ${factor}x mais opções para você escolher`);
  parts.push(values.stopOnHit ? "para quando bater o alvo" : "continua depois de bater o alvo");
  return `${parts[0]}${parts.length > 1 ? `, ${parts.slice(1).join("; ")}` : ""}.`;
}
