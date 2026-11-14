import { autoUsageLabel, autoUsedToday, type AutoGrant, type Project, type ProjectModeBody } from "@cyno/shared";

/** Visão do Modo do projeto (cartão "Modo"): o que mostrar e o que mandar para `POST /projects/:id/mode`. */

/** Tipos que nunca rodam sozinhos: a pergunta precisa da sua resposta. */
export const NEVER_AUTO_TYPES: readonly string[] = ["pergunta"];

/** Quando a lista só tem "Outro" (os agentes ainda não criaram tipos), um texto explica por quê (senão null). */
export function onlyOtherTypesNote(options: readonly { id: string }[]): string | null {
  if (options.length === 0 || options.some((option) => option.id !== "outro")) return null;
  return 'Só há o tipo "Outro" porque os agentes ainda não criaram tipos de aprovação (comentário, post, convite…). Eles escolhem o tipo ao pedir sua aprovação; depois de alguns pedidos a lista fica mais útil.';
}

export const DEFAULT_DAILY_CAP = 8;

export type ModeForm = { actions: string[]; cap: string; sites: string };

/** Formulário "Ligar Automático" -> corpo da rota (ou o problema, em pt-BR). */
export function buildModeBody(form: ModeForm): { body: Extract<ProjectModeBody, { kind: "automatico" }> } | { problem: string } {
  if (form.actions.length === 0) return { problem: "Marque ao menos um tipo de ação para liberar." };
  const cap = Number(form.cap.trim());
  if (!Number.isInteger(cap) || cap < 1 || cap > 1000) return { problem: "O teto por dia é um número inteiro de 1 a 1000." };
  const sites = form.sites
    .split(/[\s,;]+/)
    .map((site) => site.trim())
    .filter(Boolean);
  return { body: { kind: "automatico", actions: form.actions, dailyCap: cap, ...(sites.length > 0 ? { sites } : {}) } };
}

/** Formulário inicial: o que o Maestro sugeriu, ou o padrão. */
export function initialForm(grant: AutoGrant | undefined): ModeForm {
  return { actions: grant?.actions ?? [], cap: String(grant?.dailyCap ?? DEFAULT_DAILY_CAP), sites: (grant?.sites ?? []).join(", ") };
}

/** "comentário, convite" a partir dos ids (com o nome do tipo quando existe). */
export function actionNames(actions: readonly string[], names: ReadonlyMap<string, string>): string {
  return actions.map((id) => names.get(id)?.toLowerCase() ?? id).join(", ");
}

/** O que está liberado e o uso de hoje, em uma frase ("3 de 8 hoje"). */
export function grantSummary(grant: AutoGrant, used: number, names: ReadonlyMap<string, string>): string {
  const sites = grant.sites && grant.sites.length > 0 ? ` · só em ${grant.sites.join(", ")}` : "";
  return `Libera sozinho: ${actionNames(grant.actions, names)}${sites} · ${autoUsageLabel(used, grant.dailyCap)}`;
}

export type ModeView =
  | { kind: "pede-ok"; proposal?: AutoGrant & { by: "maestro" | "cyno" } }
  | { kind: "automatico"; grant: AutoGrant; used: number; capReached: boolean; paused: boolean };

export function modeView(project: Pick<Project, "mode" | "modeProposal" | "autoUsage" | "status">, now: number): ModeView {
  if (project.mode.kind === "automatico") {
    const used = autoUsedToday(project, now);
    const cap = project.mode.grant.dailyCap;
    return { kind: "automatico", grant: project.mode.grant, used, capReached: cap !== undefined && used >= cap, paused: project.status === "pausado" };
  }
  return { kind: "pede-ok", ...(project.modeProposal ? { proposal: { ...project.modeProposal.grant, by: project.modeProposal.by } } : {}) };
}
