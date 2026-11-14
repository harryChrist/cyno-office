import { awayDuration, type AttentionTarget, type AwayApprovalRef, type AwayLimit, type AwaySummary, type AwayTaskRef, type AwayWorkspace } from "@cyno/shared";

/** O cartão "Enquanto você estava fora" montado a partir do resumo do servidor (funções puras, testáveis sem tela). */

export type AwayItem = {
  label: string;
  /** Quem fez ou o resultado, em letra menor. */
  sub?: string;
  /** Onde o clique leva (tarefa, item de Aprovações, Gastos). */
  target?: AttentionTarget;
  /** O tipo que o `openAlert` usa para decidir o destino. */
  kind: "failed" | "approval" | "usage" | "budget" | "delivery";
};

export type AwaySection = {
  key: "done" | "failed" | "approvals" | "wait" | "spend" | "limits";
  tone: "ok" | "danger" | "warn" | "info";
  /** "3 tarefas concluídas". */
  heading: string;
  items: AwayItem[];
  /** "e mais 2" quando a lista foi cortada. */
  more?: string;
  /** Workspace da seção (só no cartão com mais de um workspace). */
  workspace?: string;
};

export type AwayCardView = {
  title: string;
  /** "desde ontem, 18:42 · fora há 3 h 20 min". */
  since: string;
  /** O cartão tem mais de um workspace com novidade: mostra o nome de cada um. */
  multi: boolean;
  sections: AwaySection[];
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Quantas linhas de cada lista o cartão mostra (o servidor manda até cinco; o resto vira "e mais N"). */
export const AWAY_CARD_ITEMS = 3;

const SAO_PAULO = "America/Sao_Paulo";

function dayKey(ms: number): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: SAO_PAULO, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(ms));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** "hoje, 14:10", "ontem, 18:42" ou "10/11, 18:42" (horário de São Paulo). */
export function sinceLabel(sinceMs: number, nowMs: number): string {
  const clock = new Intl.DateTimeFormat("pt-BR", { timeZone: SAO_PAULO, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(sinceMs));
  const day = dayKey(sinceMs);
  if (day === dayKey(nowMs)) return `hoje, ${clock}`;
  if (day === dayKey(nowMs - 86_400_000)) return `ontem, ${clock}`;
  const date = new Intl.DateTimeFormat("pt-BR", { timeZone: SAO_PAULO, day: "2-digit", month: "2-digit" }).format(new Date(sinceMs));
  return `${date}, ${clock}`;
}

const taskItem = (ref: AwayTaskRef, kind: "failed" | "delivery"): AwayItem => ({
  label: ref.title,
  ...(ref.headline || ref.agentName ? { sub: [ref.agentName, ref.headline].filter(Boolean).join(" · ") } : {}),
  target: ref.target,
  kind,
});

const approvalItem = (ref: AwayApprovalRef): AwayItem => ({ label: ref.title, ...(ref.agentName ? { sub: ref.agentName } : {}), target: ref.target, kind: "approval" });

const limitItem = (limit: AwayLimit): AwayItem => ({ label: limit.text, target: limit.target, kind: limit.kind });

export function awayCardView(summary: AwaySummary, nowMs: number): AwayCardView {
  const sections: AwaySection[] = [];
  const multi = summary.workspaces.length > 1;
  const named = (workspace: AwayWorkspace) => (multi ? { workspace: workspace.name } : {});
  for (const workspace of summary.workspaces) {
    if (workspace.doneCount > 0) {
      sections.push({
        key: "done",
        tone: "ok",
        heading: plural(workspace.doneCount, "tarefa concluída", "tarefas concluídas"),
        items: workspace.done.slice(0, AWAY_CARD_ITEMS).map((ref) => taskItem(ref, "delivery")),
        ...(workspace.doneCount > AWAY_CARD_ITEMS ? { more: `e mais ${workspace.doneCount - AWAY_CARD_ITEMS}` } : {}),
        ...named(workspace),
      });
    }
    if (workspace.failedCount > 0) {
      sections.push({
        key: "failed",
        tone: "danger",
        heading: plural(workspace.failedCount, "tarefa falhou", "tarefas falharam"),
        items: workspace.failed.slice(0, AWAY_CARD_ITEMS).map((ref) => taskItem(ref, "failed")),
        ...(workspace.failedCount > AWAY_CARD_ITEMS ? { more: `e mais ${workspace.failedCount - AWAY_CARD_ITEMS}` } : {}),
        ...named(workspace),
      });
    }
    if (workspace.approvalsCount > 0) {
      const age = workspace.oldestApprovalAt ? `, a mais antiga há ${awayDuration(Math.max(0, nowMs - Date.parse(workspace.oldestApprovalAt)))}` : "";
      sections.push({
        key: "approvals",
        tone: "warn",
        heading: `${plural(workspace.approvalsCount, "item novo espera você", "itens novos esperam você")}${age}`,
        items: workspace.approvals.slice(0, AWAY_CARD_ITEMS).map(approvalItem),
        ...(workspace.approvalsCount > AWAY_CARD_ITEMS ? { more: `e mais ${workspace.approvalsCount - AWAY_CARD_ITEMS}` } : {}),
        ...named(workspace),
      });
    }
  }
  const t = summary.totals;
  if (t.waitedMs >= 3_000) {
    sections.push({
      key: "wait",
      tone: "info",
      heading: `Os agentes ficaram ${awayDuration(t.waitedMs)} esperando por você`,
      items: t.longestWaitMs > 0 ? [{ label: `A maior espera: ${awayDuration(t.longestWaitMs)}`, kind: "approval" }] : [],
    });
  }
  if (t.turns > 0) {
    sections.push({
      key: "spend",
      tone: "info",
      heading: `Gasto no período: US$ ${t.costUsd.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} equivalentes`,
      items: [{ label: `${t.tokens.toLocaleString("pt-BR")} tokens em ${plural(t.turns, "turno", "turnos")}`, target: { page: "gestao", ref: "gastos" }, kind: "usage" }],
    });
  }
  if (summary.limits.length > 0) {
    sections.push({ key: "limits", tone: "warn", heading: summary.limits.length === 1 ? "Um limite foi atingido" : `${summary.limits.length} limites foram atingidos`, items: summary.limits.map(limitItem) });
  }
  const sinceMs = Date.parse(summary.since);
  return { title: "Enquanto você estava fora", since: `desde ${sinceLabel(sinceMs, nowMs)} · fora há ${awayDuration(summary.awayMs)}`, multi, sections };
}
