import { describeDays, describeTimes, type FieldDef, type MetaGoal, type RoutineProposalPayload, type RoutineProposalSchedule, type RoutineProposalView, type RoutineSuggestedMode, type TrackingSpec } from "@cyno/shared";

/* Lógica pura do cartão de proposta de rotina (R5): textos legíveis, antes e depois, modo sugerido. */

export type ProposalMode = "criar" | "ajustar" | "revisar" | "alterar";

export function proposalMode(payload: { mode: string } | undefined): ProposalMode {
  const mode = payload?.mode;
  return mode === "ajustar" || mode === "revisar" || mode === "alterar" ? mode : "criar";
}

export const PROPOSAL_TITLES: Record<ProposalMode, string> = {
  criar: "Nova rotina proposta",
  ajustar: "Meta em risco: 2 semanas sem bater",
  revisar: "Rotina pausada: tentativas sem resultado",
  alterar: "Mudança proposta numa rotina",
};
export const PROPOSAL_ROW_LABELS: Record<ProposalMode, string> = { criar: "Rotina", ajustar: "Meta em risco", revisar: "Rotina pausada", alterar: "Mudança em rotina" };

export const TYPE_LABELS = { meta: "Meta", acompanhamento: "Acompanhamento" } as const;

/** "Dias úteis · 9h, 13h, 18h". */
export function whenText(schedule: Pick<RoutineProposalSchedule, "days" | "times">): string {
  return `${describeDays(schedule.days)} · ${describeTimes(schedule.times)}`;
}

/** Quem executa o horário: o agente do horário ou o dono da rotina. */
export function whoText(schedule: Pick<RoutineProposalSchedule, "agent" | "agentName">, owner: string): string {
  return schedule.agentName ?? (schedule.agent ? schedule.agent.split("/").at(-1)! : owner);
}

/** "5 comentários por semana". */
export function goalLine(goal: MetaGoal, unit: string): string {
  return `${goal.target} ${unit}${goal.target === 1 ? "" : "s"} por ${goal.period === "month" ? "mês" : "semana"}`;
}

const DAY_NAMES = ["segunda", "terça", "quarta", "quinta", "sexta", "sábado", "domingo"];
/** Detalhes da meta em frases curtas. */
export function goalDetails(goal: MetaGoal): string[] {
  const out: string[] = [];
  if (goal.preferredDays?.length) out.push(`De preferência: ${goal.preferredDays.map((day) => DAY_NAMES[day - 1]).join(", ")}`);
  out.push(goal.stopOnHit ? "Para ao bater a meta, até o próximo período" : "Continua depois de bater a meta");
  if (goal.prepareFactor > 1) out.push(`Prepara ${goal.prepareFactor}x mais opções para você escolher`);
  return out;
}

export const FIELD_TYPE_LABELS: Record<FieldDef["type"], string> = { texto: "texto", link: "link", data: "data", numero: "número", opcao: "opção" };

/** "15 dias ou até um status final". */
export function lifespanText(tracking: TrackingSpec): string {
  const { days, untilTerminal } = tracking.lifespan;
  const parts = [days !== undefined ? `${days} dias` : "", untilTerminal ? "até um status final" : ""].filter(Boolean);
  const base = parts.length > 0 ? parts.join(" ou ") : "sem prazo";
  return `${base}${tracking.expireStatus ? ` · ao expirar vira “${tracking.expireStatus}”` : ""}${tracking.checkEveryHours ? ` · conferido a cada ${tracking.checkEveryHours} h` : ""}`;
}

/** O que o Automático liberaria, em frases. */
export function suggestedModeText(mode: RoutineSuggestedMode): string[] {
  const out = [`Decide sozinho: ${mode.actions.join(", ")}`];
  if (mode.sites?.length) out.push(`Só em: ${mode.sites.join(", ")}`);
  if (mode.connectors?.length) out.push(`Conectores: ${mode.connectors.join(", ")}`);
  out.push(mode.dailyCap !== undefined ? `Teto de ${mode.dailyCap} por dia, somando todas as execuções da rotina` : "Sem teto por dia");
  return out;
}

export type ScheduleDiff = { schedule: RoutineProposalSchedule; status: "igual" | "novo" | "mudou"; before?: RoutineProposalSchedule };
export type ProposalDiff = { schedules: ScheduleDiff[]; removed: RoutineProposalSchedule[]; notes: string[] };

const scheduleKey = (schedule: RoutineProposalSchedule) => JSON.stringify([schedule.days, schedule.times, schedule.action, schedule.agent ?? "", schedule.scope ?? "", schedule.enabled, schedule.label]);

/** Antes e depois de uma rotina: horários novos, mudados e removidos, e as outras mudanças em frases. */
export function diffViews(before: RoutineProposalView | undefined, after: RoutineProposalView): ProposalDiff {
  const schedules: ScheduleDiff[] = after.schedules.map((schedule) => {
    const was = before?.schedules.find((candidate) => candidate.id !== undefined && candidate.id === schedule.id);
    if (!was) return { schedule, status: before ? "novo" : "igual" };
    return scheduleKey(was) === scheduleKey(schedule) ? { schedule, status: "igual" } : { schedule, status: "mudou", before: was };
  });
  const removed = before ? before.schedules.filter((schedule) => !after.schedules.some((candidate) => candidate.id === schedule.id)) : [];
  const notes: string[] = [];
  if (before) {
    if (before.title !== after.title) notes.push(`Título: ${before.title} → ${after.title}`);
    if (before.owner !== after.owner) notes.push(`Dono: ${before.owner} → ${after.owner}`);
    if (before.instruction !== after.instruction) notes.push("Instruções gerais atualizadas");
    if (JSON.stringify(before.goal) !== JSON.stringify(after.goal) && after.goal && before.goal) notes.push(`Meta: ${goalLine(before.goal, "item")} → ${goalLine(after.goal, "item")}${JSON.stringify(before.goal.preferredDays) !== JSON.stringify(after.goal.preferredDays) ? " (dias preferidos mudaram)" : ""}`);
    if (before.tracking && after.tracking && JSON.stringify(before.tracking) !== JSON.stringify(after.tracking)) {
      const newFields = after.tracking.fields.filter((field) => !before.tracking!.fields.some((candidate) => candidate.key === field.key));
      const newStatuses = after.tracking.statuses.filter((status) => !before.tracking!.statuses.some((candidate) => candidate.name === status.name));
      if (newFields.length) notes.push(`Campos novos: ${newFields.map((field) => field.label).join(", ")}`);
      if (newStatuses.length) notes.push(`Status novos: ${newStatuses.map((status) => status.name).join(", ")}`);
      if (lifespanText(before.tracking) !== lifespanText(after.tracking)) notes.push(`Vida do item: ${lifespanText(before.tracking)} → ${lifespanText(after.tracking)}`);
    }
  }
  return { schedules, removed, notes };
}

/** Padrão do cartão: Pede OK. O seletor só existe se o Maestro sugeriu Automático. */
export function defaultChoice(_payload: Pick<RoutineProposalPayload, "suggestedMode">): "pede-ok" | "automatico" {
  return "pede-ok";
}
