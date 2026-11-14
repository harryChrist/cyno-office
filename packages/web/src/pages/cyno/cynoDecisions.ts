import { isConfirmationPending, ROOM_PURPOSE_SPECS, type Confirmation, type ConfirmationStatus, type RoomPurpose, type WorkspaceProposal } from "@cyno/shared";
import { engineName } from "./cynoHome";

/** Funções puras dos cartões de confirmação e de proposta de workspace (no chat e na lista "Aguardando sua confirmação"). */

/** O estado de agora: pendente que já passou da validade conta como expirada (o cartão não espera o servidor avisar). */
export function liveStatus(confirmation: Pick<Confirmation, "status" | "expiresAt">, now: number): ConfirmationStatus {
  return confirmation.status === "pendente" && !isConfirmationPending(confirmation, now) ? "expirada" : confirmation.status;
}

/** "vence em 24 min", "vence em 45 s", "venceu". */
export function remainingLabel(expiresAt: string, now: number): string {
  const left = Date.parse(expiresAt) - now;
  if (left <= 0) return "venceu";
  const seconds = Math.ceil(left / 1000);
  if (seconds < 90) return `vence em ${seconds} s`;
  return `vence em ${Math.ceil(seconds / 60)} min`;
}

export type DecisionTone = "wait" | "ok" | "bad" | "idle";

const TONES: Record<ConfirmationStatus, DecisionTone> = { pendente: "wait", autorizada: "wait", executada: "ok", falhou: "bad", recusada: "idle", expirada: "idle" };
export const confirmationTone = (status: ConfirmationStatus): DecisionTone => TONES[status];

const LABELS: Record<ConfirmationStatus, string> = {
  pendente: "Aguardando você",
  autorizada: "Executando…",
  executada: "Confirmado e feito",
  falhou: "Confirmado, mas deu erro",
  recusada: "Você recusou",
  expirada: "Expirou",
};
export const confirmationLabel = (status: ConfirmationStatus): string => LABELS[status];

/** O que ainda espera o dono, do mais antigo ao mais novo: confirmações dentro da validade e propostas por decidir. */
export type PendingDecision =
  | { kind: "confirmation"; id: string; at: string; text: string; confirmation: Confirmation }
  | { kind: "proposal"; id: string; at: string; text: string; proposal: WorkspaceProposal };

export function pendingDecisions(confirmations: readonly Confirmation[], proposals: readonly WorkspaceProposal[], now: number): PendingDecision[] {
  const list: PendingDecision[] = [
    ...confirmations.filter((item) => isConfirmationPending(item, now)).map((confirmation) => ({ kind: "confirmation" as const, id: confirmation.id, at: confirmation.createdAt, text: confirmation.summary, confirmation })),
    ...proposals.filter((item) => item.status === "proposta").map((proposal) => ({ kind: "proposal" as const, id: proposal.id, at: proposal.createdAt, text: `Criar o workspace "${proposal.plan.name}"`, proposal })),
  ];
  return list.sort((a, b) => a.at.localeCompare(b.at));
}

/** "Claude · sonnet". */
export function agentEngineLabel(agent: { engine: string; model?: string | undefined }): string {
  return agent.model ? `${engineName(agent.engine)} · ${agent.model}` : engineName(agent.engine);
}

export function purposeLabel(purpose: string | undefined): string {
  return ROOM_PURPOSE_SPECS[(purpose ?? "geral") as RoomPurpose]?.label ?? "Geral";
}

/** "2 salas · 3 times · 4 agentes" */
export function proposalTotals(plan: WorkspaceProposal["plan"]): string {
  const rooms = plan.rooms.length;
  const teams = plan.rooms.reduce((total, room) => total + room.teams.length, 0);
  const agents = plan.rooms.reduce((total, room) => total + room.teams.reduce((sum, team) => sum + team.agents.length, 0), 0);
  const word = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  return [word(rooms, "sala", "salas"), word(teams, "time", "times"), word(agents, "agente", "agentes")].join(" · ");
}

/** Rótulo curto de uma rotina da proposta (o título e o tipo). */
export function routineLabel(routine: Record<string, unknown>): string {
  const title = typeof routine.title === "string" ? routine.title : "Rotina";
  const goal = routine.goal as { target?: number; period?: string } | undefined;
  const detail = routine.type === "tracking" ? "acompanhamento" : goal?.target ? `meta ${goal.target} por ${goal.period === "month" ? "mês" : "semana"}` : "meta";
  return `${title} (${detail})`;
}
