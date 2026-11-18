import { BRAIN_ORGANIZE_ACTION_LABELS, type BrainOrganizeAction, type BrainOrganizeActionType, type BrainOrganizePlan, type BrainOrganizeWeight } from "@cyno/shared";

/** Lógica pura do cartão "organizacao" (a proposta do Maestro para organizar o Cérebro de uma sala). */

/** A ordem dos grupos no cartão. */
export const ORGANIZE_GROUP_ORDER: readonly BrainOrganizeActionType[] = ["set_rules", "make_rule", "agent_rule", "merge", "rewrite", "archive"];

/** Acima disso o grupo mostra só as primeiras linhas e "Mostrar mais N". */
export const ORGANIZE_COLLAPSE_AFTER = 8;

/** Uma ação com o lugar dela em `plan.actions` (é esse índice que vai em `skip`). */
export type OrganizeRow = { index: number; action: BrainOrganizeAction };

export type OrganizeGroup = { type: BrainOrganizeActionType; label: string; rows: OrganizeRow[] };

/** Agrupa as ações por tipo, na ordem do cartão; tipo sem ação não aparece. */
export function groupOrganizeActions(actions: readonly BrainOrganizeAction[]): OrganizeGroup[] {
  const groups: OrganizeGroup[] = [];
  for (const type of ORGANIZE_GROUP_ORDER) {
    const rows: OrganizeRow[] = [];
    actions.forEach((action, index) => {
      if (action.type === type) rows.push({ index, action });
    });
    if (rows.length > 0) groups.push({ type, label: BRAIN_ORGANIZE_ACTION_LABELS[type], rows });
  }
  return groups;
}

/** Nome do arquivo sem a pasta e sem ".md" ("historico/x.md" -> "x"). */
export function fileLabel(file: string): string {
  return (file.split("/").pop() ?? file).replace(/\.md$/i, "");
}

/** O que a linha chama a ação: o título da nota (ou o nome do arquivo), o agente ou o título do resumo. */
export function actionTitle(action: BrainOrganizeAction): string {
  switch (action.type) {
    case "set_rules":
      return "Regras da sala";
    case "agent_rule":
      return action.agentName?.trim() || action.agentId;
    case "merge":
      return action.title.trim() || action.files.map(fileLabel).join(" + ");
    default:
      return action.title?.trim() || fileLabel(action.file);
  }
}

/** Títulos das notas juntadas por um "merge" (o nome do arquivo quando o título não veio). */
export function mergeTitles(action: Extract<BrainOrganizeAction, { type: "merge" }>): string[] {
  return action.files.map((file, position) => action.titles?.[position]?.trim() || fileLabel(file));
}

/** O texto novo que a ação traz (regra, resumo, versão curta, regras da sala), ou null. */
export function actionPreview(action: BrainOrganizeAction): string | null {
  if (action.type === "agent_rule") return action.text;
  if (action.type === "archive") return null;
  return action.type === "make_rule" ? (action.content ?? null) : action.content;
}

/** "70 mil caracteres", "2,4 mil caracteres", "850 caracteres". */
export function formatChars(chars: number): string {
  if (chars < 1000) return `${chars} ${chars === 1 ? "caractere" : "caracteres"}`;
  const thousands = chars / 1000;
  const text = thousands >= 10 ? String(Math.round(thousands)) : (Math.round(thousands * 10) / 10).toString().replace(".", ",");
  return `${text} mil caracteres`;
}

const notesLabel = (count: number) => `${count} ${count === 1 ? "nota de referência" : "notas de referência"}`;
const rulesLabel = (count: number) => `${count} ${count === 1 ? "regra" : "regras"}`;

/** "Hoje: 12 notas de referência (70 mil caracteres) e 3 regras. Depois: 5 notas e 9 regras." */
export function beforeAfterLine(before: BrainOrganizeWeight, after: BrainOrganizeWeight): string {
  return `Hoje: ${notesLabel(before.notes)} (${formatChars(before.chars)}) e ${rulesLabel(before.rules)}. Depois: ${after.notes} ${after.notes === 1 ? "nota" : "notas"} e ${rulesLabel(after.rules)}.`;
}

/** Quantas mudanças vão valer com as linhas desmarcadas fora. */
export function applyCount(total: number, skipped: ReadonlySet<number>): number {
  let count = 0;
  for (let index = 0; index < total; index++) if (!skipped.has(index)) count++;
  return count;
}

/** `skip` da decisão: os índices desmarcados, em ordem e sem repetir. */
export function skipList(skipped: ReadonlySet<number>, total: number): number[] {
  return [...skipped].filter((index) => index >= 0 && index < total).sort((a, b) => a - b);
}

export const changesLabel = (count: number) => `${count} ${count === 1 ? "mudança" : "mudanças"}`;

/** Texto do botão de aprovar. */
export function applyLabel(count: number): string {
  return `Aplicar ${changesLabel(count)}`;
}

/** Depois de aprovado: quantas foram aplicadas (o total menos as desmarcadas e as que falharam). */
export function appliedCount(plan: Pick<BrainOrganizePlan, "actions" | "skipped" | "failed">): number {
  const out = new Set([...(plan.skipped ?? []), ...(plan.failed ?? []).map((failure) => failure.index)]);
  return Math.max(0, plan.actions.length - out.size);
}

/** Linhas do resumo de um cartão já decidido ("Aplicado: 7 mudanças", "2 desmarcadas"). */
export function appliedSummary(plan: Pick<BrainOrganizePlan, "actions" | "skipped" | "failed">): string[] {
  const lines = [`Aplicado: ${changesLabel(appliedCount(plan))}`];
  const skipped = plan.skipped?.length ?? 0;
  if (skipped > 0) lines.push(`${skipped} ${skipped === 1 ? "desmarcada" : "desmarcadas"}`);
  return lines;
}

/** As que não deram para aplicar, com a linha da proposta e o erro. */
export function failedRows(plan: Pick<BrainOrganizePlan, "actions" | "failed">): { index: number; title: string; error: string }[] {
  return (plan.failed ?? []).map((failure) => {
    const action = plan.actions[failure.index];
    return { index: failure.index, title: action ? actionTitle(action) : `Ação ${failure.index + 1}`, error: failure.error };
  });
}
