import type { PlanApprovalNote, PlanApprovalRule } from "@cyno/shared";

/** Regra padrão de aprovação de planos de um workspace. */
export const DEFAULT_PLAN_APPROVAL_RULE: PlanApprovalRule = "maestro";

export type PlanApprovalOption = {
  rule: PlanApprovalRule;
  label: string;
  description: string;
};

/** As três opções da regra de aprovação de planos, na ordem em que aparecem no cartão. */
export const PLAN_APPROVAL_OPTIONS: readonly PlanApprovalOption[] = [
  {
    rule: "maestro",
    label: "O Maestro decide",
    description: "Ele pede sua aprovação quando a estrutura vale ser confirmada e começa direto quando você já disse como quer.",
  },
  {
    rule: "always",
    label: "Sempre pedir",
    description: "Todo projeto novo espera o seu OK antes de começar.",
  },
  {
    rule: "never",
    label: "Nunca pedir",
    description: "Projetos, módulos e tarefas começam sem pedir. Você ainda pode pausar, segurar ou apagar.",
  },
];

/** Opção da regra escolhida (cai no padrão se vier algo fora da lista). */
export function planApprovalOption(rule: PlanApprovalRule | undefined): PlanApprovalOption {
  return PLAN_APPROVAL_OPTIONS.find((option) => option.rule === rule) ?? PLAN_APPROVAL_OPTIONS[0]!;
}

/** "21/11" na data local do navegador (vazio se o ISO for inválido). */
export function formatLocalDayMonth(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${day}/${month}`;
}

/**
 * Texto da nota quando a regra foi gravada com registro de frase (ex.: quando o Maestro mudou a pedido do dono).
 * "Definido pelo Maestro em 21/11, a seu pedido: «frase»". Sem nota = null.
 */
export function formatPlanApprovalNote(note: PlanApprovalNote | undefined): string | null {
  if (!note) return null;
  const quote = note.quote.trim();
  const date = formatLocalDayMonth(note.at);
  const when = date ? ` em ${date}` : "";
  const prefix = note.by === "dono" ? `Definido por você${when}` : `Definido pelo Maestro${when}, a seu pedido`;
  return quote ? `${prefix}: «${quote}»` : prefix;
}

/** Rótulo do botão que volta a regra para o padrão e limpa a nota. */
export const PLAN_APPROVAL_RESET_LABEL = "Voltar para o Maestro decide";
