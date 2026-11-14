import { z } from "zod";
import type { AttentionKind, AttentionTarget } from "./attention";
import { MIN_WAIT_MS, ownerWaits } from "./day-stats";
import type { ForYouItem } from "./for-you";
import { maskSecrets } from "./secrets";
import type { Project } from "./projects";
import type { Task } from "./types";

/**
 * "Enquanto você estava fora" (Junção V2, J2-13). Quando o dono volta depois de 30 minutos ou mais
 * sem usar o app, um cartão discreto conta o que aconteceu: tarefas concluídas, falhas, aprovações
 * novas esperando, a espera acumulada, o gasto e os limites atingidos. É montado POR CÓDIGO, sem IA, com
 * as mesmas fontes das outras telas (tarefas, "Para você", histórico de gastos, cadeia de atenção).
 *
 * A ideia (um cartão que resume o que mudou desde a última visita, com um "Ok, vi" que zera) vem do
 * Habblaud (github.com/marmottajr/habblaud, MIT, Copyright (c) 2026 Márcio Junior); o código é nosso.
 */

export const PRESENCE_PATH = "/api/presence";
export const AWAY_PATH = "/api/away";
export const AWAY_SEEN_PATH = "/api/away/seen";

/** Ausência mínima para o cartão abrir (30 minutos sem presença). */
export const AWAY_MIN_MS = 30 * 60_000;
/** O navegador manda a presença a cada tanto (só com a aba visível e com entrada recente). */
export const PRESENCE_EVERY_MS = 60_000;
/** Entrada do dono (mouse, teclado, toque) mais velha que isto não conta como "presente". */
export const PRESENCE_IDLE_MS = 2 * 60_000;
/** Quantos itens de cada lista o cartão mostra (o resto vira "e mais N"). */
export const AWAY_LIST_MAX = 5;

/** Presença guardada no servidor (`data/platform/owner.json`): vale para todos os navegadores do dono. */
export const ownerFileSchema = z.object({
  /** A última vez em que o dono esteve com o app aberto e ativo. */
  lastActiveAt: z.string().optional(),
  /** A ausência em andamento ou a última: `since` = a última presença antes dela; `returnedAt` = quando ele voltou. */
  episode: z.object({ since: z.string(), returnedAt: z.string(), seenAt: z.string().optional() }).optional(),
});
export type OwnerFile = z.output<typeof ownerFileSchema>;

/** `POST /api/presence`: o navegador diz que o dono está aqui. */
export type PresenceResponse = { /** Há um resumo de ausência que o dono ainda não confirmou. */ awayPending: boolean };

export type AwayTaskRef = {
  id: string;
  title: string;
  agentName?: string;
  /** Quando concluiu ou falhou (ISO). */
  at: string;
  /** Primeira linha do resultado (já sem segredos), se houver. */
  headline?: string;
  target: AttentionTarget;
};

export type AwayApprovalRef = {
  id: string;
  title: string;
  agentName?: string;
  at: string;
  target: AttentionTarget;
};

export type AwayUsage = { costUsd: number; costBrl: number; tokens: number; turns: number; unmeasuredTurns: number };

export type AwayWorkspace = {
  id: string;
  name: string;
  done: AwayTaskRef[];
  doneCount: number;
  failed: AwayTaskRef[];
  failedCount: number;
  /** Aprovações (e perguntas, planos, rotinas, sprints) que chegaram na ausência e seguem esperando o dono. */
  approvals: AwayApprovalRef[];
  approvalsCount: number;
  oldestApprovalAt?: string;
  /** Tempo de relógio com alguém esperando o dono na ausência, e a maior espera. */
  waitedMs: number;
  longestWaitMs: number;
  usage?: AwayUsage;
};

export type AwayLimit = { kind: Extract<AttentionKind, "usage" | "budget">; level: "alert" | "warn" | "info"; text: string; at: string; target: AttentionTarget };

export type AwaySummary = {
  since: string;
  until: string;
  awayMs: number;
  /** Nada a dizer: o cartão não aparece. */
  empty: boolean;
  totals: { done: number; failed: number; approvals: number; waitedMs: number; longestWaitMs: number; costUsd: number; costBrl: number; tokens: number; turns: number };
  /** Só os workspaces com alguma novidade. */
  workspaces: AwayWorkspace[];
  limits: AwayLimit[];
};

/** `GET /api/away`: `pending` = há resumo a mostrar (com novidades e ainda não confirmado). */
export type AwayResponse = { pending: boolean; summary?: AwaySummary };

export type AwayWorkspaceInput = {
  id: string;
  name: string;
  tasks: readonly Task[];
  items: readonly ForYouItem[];
  projects?: readonly Project[];
  agents: readonly { id: string; name: string }[];
  usage?: AwayUsage;
};

export type AwayAlertInput = { kind: AttentionKind; level: "alert" | "warn" | "info"; text: string; at: string; target: AttentionTarget };

/** `platformUsage`: o gasto do Cyno (fora dos workspaces), que entra nos totais do período (a mesma conta do orçamento). */
export type AwayInput = { since: number; until: number; workspaces: readonly AwayWorkspaceInput[]; alerts: readonly AwayAlertInput[]; platformUsage?: AwayUsage };

const firstLine = (text: string | undefined, max: number): string => {
  const line = (text ?? "").split("\n").find((candidate) => candidate.trim().length > 0) ?? "";
  const clean = maskSecrets(line.replace(/\s+/g, " ").trim());
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
};

const inRange = (iso: string | undefined, since: number, until: number): boolean => {
  const at = iso ? Date.parse(iso) : Number.NaN;
  return Number.isFinite(at) && at > since && at <= until;
};

/**
 * O resumo da ausência `(since, until]`. Pura: o servidor passa o que leu de cada workspace.
 * - concluídas: tarefas de trabalho (não o registro do pedido do Maestro) que fecharam na janela;
 * - falhas: as que falharam de verdade (cancelar não é falha);
 * - aprovações: itens do "Para você" que nasceram na janela e ainda esperam;
 * - espera: as esperas pelo dono que tocam a janela (mesma conta do "Meu dia");
 * - gasto e limites: do histórico de gastos e dos alertas `usage` e `budget` da janela.
 */
export function buildAwaySummary(input: AwayInput): AwaySummary {
  const { since, until } = input;
  const workspaces: AwayWorkspace[] = [];
  const totals = { done: 0, failed: 0, approvals: 0, waitedMs: 0, longestWaitMs: 0, costUsd: 0, costBrl: 0, tokens: 0, turns: 0 };
  for (const workspace of input.workspaces) {
    const agentName = (id: string | undefined) => workspace.agents.find((agent) => agent.id === id)?.name;
    const taskRef = (task: Task): AwayTaskRef => {
      const title = firstLine(task.prompt, 110) || "Tarefa";
      const headline = task.status === "done" ? firstLine(task.result, 110) : "";
      const name = agentName(task.agentId);
      return {
        id: task.id,
        title,
        ...(name ? { agentName: name } : {}),
        at: task.updatedAt,
        ...(headline ? { headline } : {}),
        target: { page: "trabalho", workspaceId: workspace.id, ref: task.id },
      };
    };
    const work = workspace.tasks.filter((task) => task.role !== "request" && inRange(task.updatedAt, since, until));
    const done = work.filter((task) => task.status === "done").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const failed = work.filter((task) => task.status === "failed" && task.outcome !== "cancelled").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const waiting = workspace.items.filter((item) => item.status === "pendente" && inRange(item.createdAt, since, until)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const waits = ownerWaits(workspace.items, workspace.tasks, until, { ...(workspace.projects ? { projects: workspace.projects } : {}), range: { start: since, end: until } });
    const usage = workspace.usage && (workspace.usage.turns > 0 || workspace.usage.tokens > 0) ? workspace.usage : undefined;
    // A espera (de itens que já estavam lá antes) soma nos totais, mas sozinha não é novidade: não abre o cartão nem a linha do workspace.
    totals.waitedMs += waits.wallMs;
    totals.longestWaitMs = Math.max(totals.longestWaitMs, waits.longestMs);
    if (done.length === 0 && failed.length === 0 && waiting.length === 0 && !usage) continue;
    const approvals: AwayApprovalRef[] = waiting.slice(0, AWAY_LIST_MAX).map((item) => {
      const name = agentName(item.agentId);
      return { id: item.id, title: firstLine(item.title ?? item.text, 110) || "Item para você", ...(name ? { agentName: name } : {}), at: item.createdAt, target: { page: "para-voce", workspaceId: workspace.id, ref: item.id } };
    });
    workspaces.push({
      id: workspace.id,
      name: workspace.name,
      done: done.slice(0, AWAY_LIST_MAX).map(taskRef),
      doneCount: done.length,
      failed: failed.slice(0, AWAY_LIST_MAX).map(taskRef),
      failedCount: failed.length,
      approvals,
      approvalsCount: waiting.length,
      ...(waiting[0] ? { oldestApprovalAt: waiting[0].createdAt } : {}),
      waitedMs: waits.wallMs,
      longestWaitMs: waits.longestMs,
      ...(usage ? { usage } : {}),
    });
    totals.done += done.length;
    totals.failed += failed.length;
    totals.approvals += waiting.length;
    if (usage) {
      totals.costUsd += usage.costUsd;
      totals.costBrl += usage.costBrl;
      totals.tokens += usage.tokens;
      totals.turns += usage.turns;
    }
  }
  if (input.platformUsage && (input.platformUsage.turns > 0 || input.platformUsage.tokens > 0)) {
    totals.costUsd += input.platformUsage.costUsd;
    totals.costBrl += input.platformUsage.costBrl;
    totals.tokens += input.platformUsage.tokens;
    totals.turns += input.platformUsage.turns;
  }
  const limits: AwayLimit[] = input.alerts
    .filter((alert): alert is AwayAlertInput & { kind: AwayLimit["kind"] } => (alert.kind === "usage" || alert.kind === "budget") && inRange(alert.at, since, until))
    .sort((a, b) => a.at.localeCompare(b.at))
    .map((alert) => ({ kind: alert.kind, level: alert.level, text: alert.text, at: alert.at, target: alert.target }));
  const empty = workspaces.length === 0 && limits.length === 0 && totals.turns === 0;
  return { since: new Date(since).toISOString(), until: new Date(until).toISOString(), awayMs: Math.max(0, until - since), empty, totals, workspaces, limits };
}

// ---------- Texto (pt-BR, por código) ----------

/** "1 h 20 min", "45 min", "30 s" (a duração da ausência ou da espera). */
export function awayDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))} s`;
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    return `${days} ${days === 1 ? "dia" : "dias"}${hours % 24 ? ` e ${hours % 24} h` : ""}`;
  }
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** As linhas do cartão em texto puro, na ordem (o Cyno e os testes usam; a tela monta o mesmo conteúdo com links). */
export function awayLines(summary: AwaySummary): string[] {
  const lines: string[] = [];
  const t = summary.totals;
  if (t.done > 0) lines.push(`${plural(t.done, "tarefa concluída", "tarefas concluídas")}`);
  if (t.failed > 0) lines.push(`${plural(t.failed, "tarefa falhou", "tarefas falharam")}`);
  if (t.approvals > 0) {
    const oldest = summary.workspaces.flatMap((workspace) => (workspace.oldestApprovalAt ? [Date.parse(workspace.oldestApprovalAt)] : [])).sort((a, b) => a - b)[0];
    const age = oldest !== undefined ? `, a mais antiga há ${awayDuration(Date.parse(summary.until) - oldest)}` : "";
    lines.push(`${plural(t.approvals, "item novo espera você", "itens novos esperam você")}${age}`);
  }
  if (t.waitedMs >= MIN_WAIT_MS) lines.push(`Os agentes ficaram ${awayDuration(t.waitedMs)} esperando por você${t.longestWaitMs > 0 ? ` (a maior espera: ${awayDuration(t.longestWaitMs)})` : ""}`);
  if (t.turns > 0) lines.push(`Gasto no período: ${t.tokens.toLocaleString("pt-BR")} tokens, US$ ${t.costUsd.toFixed(2)} equivalentes`);
  for (const limit of summary.limits) lines.push(limit.text);
  return lines;
}
