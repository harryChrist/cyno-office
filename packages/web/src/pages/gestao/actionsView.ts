import {
  batchPlan,
  clampTarget,
  DISPATCH_LIMITS,
  FOR_YOU_BATCH_MAX,
  forYouKind,
  type ForYouItem,
  type MetricGroup,
  type MetricsReport,
  type ModelSaving,
  type Routine,
} from "@cyno/shared";
import { formatRate, plural } from "./metricsFormat";

/**
 * Ações do gestor na Gestão (Painel, Pessoas e cartão da meta): o que cada botão e cada diálogo escreve. Funções puras,
 * sem relógio: o `MetricsReport` e a lista do "Para você" chegam de fora. As regras do lote (quem entra e por quê) vêm de
 * `@cyno/shared` (`batchPlan`), as mesmas que o servidor aplica.
 */

// ---------- Reatribuir: o seletor de agentes ----------

export type AgentChoice = {
  id: string;
  name: string;
  /** "livre" ou "fazendo 1 · fila 2 · esperando 1": a carga de agora. */
  load: string;
  /** Tem trabalho agora (a tela marca). */
  busy: boolean;
  /** No limite de tarefas ao mesmo tempo por agente: entra na fila. */
  atLimit: boolean;
  /** "sem cota, volta às 15h" quando o motor dele está parado. */
  blocked?: string;
  /** É o agente de hoje da tarefa. */
  current: boolean;
};

/** Os agentes que podem receber a tarefa, os livres primeiro (o motor parado e o de hoje por último), cada um com a carga de agora. */
export function agentChoices(report: Pick<MetricsReport, "load" | "quota">, agents: readonly { id: string; name: string }[], currentId?: string): AgentChoice[] {
  const blockedBy = new Map(report.quota.blocked.map((entry) => [entry.agentId, entry.label]));
  const choices = agents.map((agent): AgentChoice => {
    const load = report.load.agents.find((entry) => entry.id === agent.id);
    const doing = load?.doing ?? 0;
    const queued = load?.queued ?? 0;
    const waiting = load?.waiting ?? 0;
    const parts = [doing > 0 ? `fazendo ${doing}` : "", queued > 0 ? `fila ${queued}` : "", waiting > 0 ? `esperando ${waiting}` : ""].filter(Boolean);
    const blocked = blockedBy.get(agent.id);
    return { id: agent.id, name: agent.name, load: parts.length > 0 ? parts.join(" · ") : "livre", busy: parts.length > 0, atLimit: doing >= report.load.perAgentLimit, ...(blocked ? { blocked } : {}), current: agent.id === currentId };
  });
  const weight = (choice: AgentChoice): number => {
    const load = report.load.agents.find((entry) => entry.id === choice.id);
    return (load?.doing ?? 0) * 10 + (load?.queued ?? 0) * 3 + (load?.waiting ?? 0);
  };
  return choices.sort((a, b) => Number(a.current) - Number(b.current) || Number(Boolean(a.blocked)) - Number(Boolean(b.blocked)) || weight(a) - weight(b) || a.name.localeCompare(b.name, "pt-BR") || a.id.localeCompare(b.id));
}

/** Um agente pode receber a tarefa travada? (O de hoje só se ela está travada por cota, acesso ou falha: aí vale como "tentar de novo".) */
export const BLOCK_TYPES_WITH_REASSIGN = ["agente", "cota", "acesso", "espera", "falha"] as const;
export const canReassign = (type: string): boolean => (BLOCK_TYPES_WITH_REASSIGN as readonly string[]).includes(type);

// ---------- Aprovar em lote ----------

/** "12% recusado (25 decisões)", "1 de 3 recusados (poucos dados)" ou "sem decisões suas ainda". */
export function rejectionText(group: Pick<MetricGroup, "n" | "value" | "hits"> | undefined): string {
  if (!group || group.n === 0) return "sem decisões suas ainda";
  if (group.n < 5 || group.value === null) return `${group.hits ?? 0} de ${group.n} recusados (poucos dados)`;
  return `${formatRate(group.value)} recusado (${plural(group.n, "decisão", "decisões")})`;
}

export type BatchRow = { id: string; title: string; text: string; agentName: string; rejection: string };
export type BatchLeftOut = { id: string; title: string; agentName: string; reason: string };
export type BatchTypeChoice = { type: string; label: string; /** Quantos desse tipo podem entrar. */ eligible: number; /** Quantos pendentes desse tipo ficam de fora. */ left: number };

export type BatchView = {
  types: BatchTypeChoice[];
  type: string | null;
  rows: BatchRow[];
  leftOut: BatchLeftOut[];
  /** Passaram do teto de 20 e ficam para um segundo lote. */
  over: number;
  /** Pendentes que nem são aprovação de texto (plano, rotina, sprint, pergunta): não vão em lote. */
  notApproval: number;
  /** "Aprovar 3 comentários" (vazio sem itens). */
  action: string;
  /** Texto do passo de confirmação. */
  confirm: string;
};

const MAX = FOR_YOU_BATCH_MAX;

/**
 * O diálogo "Aprovar em lote": um tipo por vez (o com mais itens liberados, ou o escolhido), o texto de cada item, a taxa de
 * recusa do agente de cada um e quem ficou de fora com o motivo. `items` = o "Para você" inteiro (o histórico decide o convite e o post).
 */
export function batchView(input: { items: readonly ForYouItem[]; report: Pick<MetricsReport, "rejectionRate"> | null; typeName: (type: string) => string; agentName: (id: string) => string; pick?: string | null }): BatchView {
  const pending = input.items.filter((item) => item.status === "pendente");
  const approvals = pending.filter((item) => forYouKind(item) === "aprovacao");
  const types = [...new Set(approvals.map((item) => item.type))].map((type): BatchTypeChoice => {
    const ofType = approvals.filter((item) => item.type === type);
    const plan = batchPlan(input.items, ofType.map((item) => item.id));
    return { type, label: input.typeName(type), eligible: plan.eligible.length, left: plan.excluded.length };
  });
  types.sort((a, b) => b.eligible - a.eligible || b.left - a.left || a.label.localeCompare(b.label, "pt-BR"));
  const type = input.pick && types.some((choice) => choice.type === input.pick) ? input.pick : (types[0]?.type ?? null);
  const ofType = approvals.filter((item) => item.type === type);
  const plan = batchPlan(input.items, ofType.map((item) => item.id));
  const title = (item: ForYouItem): string => item.where ?? item.title ?? item.why ?? input.typeName(item.type);
  const groups = input.report?.rejectionRate.byAgent ?? [];
  const taken = plan.eligible.slice(0, MAX);
  const rows = taken.map((item) => ({ id: item.id, title: title(item), text: item.text, agentName: input.agentName(item.agentId), rejection: rejectionText(groups.find((group) => group.key === item.agentId)) }));
  const byId = new Map(input.items.map((item) => [item.id, item]));
  const leftOut = plan.excluded.map((entry) => {
    const item = byId.get(entry.id);
    return { id: entry.id, title: item ? title(item) : entry.id, agentName: item ? input.agentName(item.agentId) : "", reason: entry.text };
  });
  const label = type ? input.typeName(type).toLowerCase() : "itens";
  return {
    types,
    type,
    rows,
    leftOut,
    over: Math.max(0, plan.eligible.length - MAX),
    notApproval: pending.length - approvals.length,
    action: rows.length === 0 ? "" : `Aprovar ${rows.length} ${rows.length === 1 ? "item" : "itens"} de ${label}`,
    confirm: `Aprovar ${plural(rows.length, "texto", "textos")} de ${label} sem abrir um por um? Eles seguem como estão, sem edição. A decisão vale para os agentes na hora.`,
  };
}

// ---------- Trocar o modelo ----------

export type SavingView = { tone: "ok" | "warn" | "neutral"; headline: string; lines: string[]; warning: string | null };

/** O que o diálogo escreve sobre a estimativa: a frase principal, a fatia da assinatura, o que ficou de fora e o aviso da recusa. */
export function savingView(saving: ModelSaving): SavingView {
  if (saving.state === "sem_dados") return { tone: "neutral", headline: "Sem dados para estimar", lines: saving.note ? [saving.note] : [], warning: saving.warning };
  const better = (saving.savingPerWeekUsd ?? 0) > 0.005;
  const worse = (saving.savingPerWeekUsd ?? 0) < -0.005;
  const lines = [`Com base em ${plural(saving.records, "turno", "turnos")} dos últimos ${saving.days} dias, repreçados no modelo novo. É custo equivalente à API, não o que a assinatura cobra.`];
  if (saving.quotaText) lines.push(saving.quotaText[0]!.toUpperCase() + saving.quotaText.slice(1));
  if (saving.note) lines.push(saving.note);
  return { tone: better ? "ok" : worse ? "warn" : "neutral", headline: saving.text[0]!.toUpperCase() + saving.text.slice(1), lines, warning: saving.warning };
}

// ---------- Trabalho em paralelo ----------

/** "agora 2 de 3 rodando; fila de 4" (ou "fila vazia"). */
export function dispatchSentence(report: Pick<MetricsReport, "load">): string {
  const { running, maxRunning, queued } = report.load;
  return `agora ${running} de ${maxRunning} rodando; ${queued === 0 ? "fila vazia" : `fila de ${queued}`}`;
}

/** As opções dos dois controles, dentro de `DISPATCH_LIMITS`. */
export function dispatchOptions(kind: "maxRunning" | "perAgent"): number[] {
  const { min, max } = DISPATCH_LIMITS[kind];
  return Array.from({ length: max - min + 1 }, (_, index) => min + index);
}

/** O valor atual cabe nas opções? (Valor antigo fora do intervalo ainda aparece, para o controle não mentir.) */
export function dispatchChoices(kind: "maxRunning" | "perAgent", current: number): number[] {
  const options = dispatchOptions(kind);
  return options.includes(current) ? options : [...options, current].sort((a, b) => a - b);
}

// ---------- Baixar ou subir a meta ----------

export type TargetStep = { delta: 1 | -1; /** O alvo novo (o mesmo de hoje se estiver no limite). */ next: number; disabled: boolean; label: string; hint: string };

/** O botão "−1" ou "+1" da meta: o alvo novo pelo mesmo `clampTarget` do servidor e se já está no mínimo ou no teto. */
export function targetStep(routine: Pick<Routine, "kind" | "target" | "period">, delta: 1 | -1): TargetStep {
  const next = clampTarget(routine.kind, routine.target + delta, routine.period);
  const disabled = next === routine.target;
  const label = delta === 1 ? "+1" : "−1";
  const hint = disabled ? (delta === 1 ? `Já está no teto do tipo (${routine.target})` : "A meta mínima é 1") : `${delta === 1 ? "Subir" : "Baixar"} a meta de ${routine.target} para ${next}`;
  return { delta, next, disabled, label, hint };
}

/** A confirmação curta ao lado do botão. */
export function targetNote(next: number, period: "week" | "month"): string {
  return `Salvo: ${period === "month" ? "meta do mês" : "meta da semana"} em ${next}`;
}
