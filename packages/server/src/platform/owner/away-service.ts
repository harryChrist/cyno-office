import {
  awayLines,
  buildAwaySummary,
  type AttentionAlert,
  type AwayAlertInput,
  type AwayUsage,
  type AwayResponse,
  type AwaySummary,
  type AwayWorkspaceInput,
  type UsageRecord,
} from "@cyno/shared";
import { priceRecord, totalsOf } from "../../engines/usage/usage-aggregate";
import type { OwnerEpisode, OwnerStore } from "./owner-store";

/** Um workspace como o resumo o lê (o `app.ts` monta um por runtime; os testes usam falsos). */
export type AwaySource = {
  id: string;
  name: string;
  read: () => Omit<AwayWorkspaceInput, "id" | "name" | "usage">;
  usage: (fromMs: number, toMs: number) => Promise<UsageRecord[]>;
};

export type AwayDeps = {
  owner: Pick<OwnerStore, "pending" | "episode">;
  sources: () => AwaySource[];
  alerts: () => readonly Pick<AttentionAlert, "kind" | "level" | "text" | "at" | "target">[];
  /** O gasto do Cyno (a plataforma): entra nos totais do período, como no orçamento e em Gastos. */
  platformUsage?: (fromMs: number, toMs: number) => Promise<UsageRecord[]>;
  usdBrl: () => number;
  now: () => Date;
};

/**
 * O resumo do "enquanto você estava fora", montado por código (nada de IA): o que aconteceu entre a
 * última presença do dono e a volta dele. A tela (cartão ao voltar) e a ferramenta `get_away_summary` do
 * Cyno leem a mesma conta, então nunca divergem.
 */
export class AwayService {
  constructor(private readonly deps: AwayDeps) {}

  /** O resumo da ausência pendente (com novidades) para o cartão; sem ausência ou sem novidades: `pending: false`. */
  async pending(): Promise<AwayResponse> {
    const episode = this.deps.owner.pending();
    if (!episode) return { pending: false };
    const summary = await this.summaryOf(episode);
    return summary.empty ? { pending: false } : { pending: true, summary };
  }

  /** O resumo da última ausência (confirmada ou não), para o Cyno responder "o que aconteceu enquanto eu estava fora?". */
  async last(): Promise<{ summary?: AwaySummary; seen: boolean }> {
    const episode = this.deps.owner.episode();
    if (!episode) return { seen: false };
    return { summary: await this.summaryOf(episode), seen: episode.seenAt !== undefined };
  }

  private async summaryOf(episode: OwnerEpisode): Promise<AwaySummary> {
    const since = Date.parse(episode.since);
    const until = Date.parse(episode.returnedAt);
    const usdBrl = this.deps.usdBrl();
    const workspaces: AwayWorkspaceInput[] = [];
    const usageOf = (records: UsageRecord[]): AwayUsage => {
      const priced = records
        .filter((record) => {
          const at = Date.parse(record.at);
          return at > since && at <= until;
        })
        .map((record) => priceRecord(record));
      const totals = totalsOf(priced, usdBrl);
      return { costUsd: totals.costUsd, costBrl: totals.costBrl, tokens: totals.totalTokens, turns: totals.turns, unmeasuredTurns: totals.unmeasuredTurns };
    };
    for (const source of this.deps.sources()) {
      workspaces.push({
        id: source.id,
        name: source.name,
        ...source.read(),
        usage: usageOf(await source.usage(since, until + 1)),
      });
    }
    const platformUsage = this.deps.platformUsage ? usageOf(await this.deps.platformUsage(since, until + 1)) : undefined;
    const alerts: AwayAlertInput[] = this.deps.alerts().map((alert) => ({ kind: alert.kind, level: alert.level, text: alert.text, at: alert.at, target: alert.target }));
    return buildAwaySummary({ since, until, workspaces, alerts, ...(platformUsage ? { platformUsage } : {}) });
  }
}

/** O resumo em texto compacto e em inglês (o que a ferramenta `get_away_summary` devolve ao Cyno). */
export function renderAway(result: { summary?: AwaySummary; seen: boolean }, nowMs: number): string {
  const { summary } = result;
  if (!summary) return "No absence recorded yet: the owner has not been away for 30 minutes or more since the app started tracking presence.";
  const time = (iso: string) => new Date(iso).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const ago = Math.round((nowMs - Date.parse(summary.until)) / 60_000);
  const out = [`While the owner was away: ${time(summary.since)} to ${time(summary.until)} (America/Sao_Paulo; they came back ${ago} min ago${result.seen ? "; they already dismissed the card" : ""}). Computed by code.`];
  if (summary.empty) {
    out.push("Nothing happened: no task finished or failed, nothing new is waiting for the owner, no limit was reached.");
    return out.join("\n");
  }
  const t = summary.totals;
  out.push(`Totals: ${t.done} tasks done, ${t.failed} failed, ${t.approvals} new items waiting for the owner, ${Math.round(t.waitedMs / 60_000)} min of clock time with someone waiting (longest wait ${Math.round(t.longestWaitMs / 60_000)} min), spend ${t.turns} turns, ${t.tokens} tokens, US$ ${t.costUsd.toFixed(2)} equivalent.`);
  for (const workspace of summary.workspaces) {
    out.push(`Workspace ${workspace.id} "${workspace.name}":`);
    for (const task of workspace.done) out.push(`- done: ${task.title}${task.agentName ? ` (${task.agentName})` : ""}${task.headline ? `: ${task.headline}` : ""}`);
    if (workspace.doneCount > workspace.done.length) out.push(`- done: and ${workspace.doneCount - workspace.done.length} more`);
    for (const task of workspace.failed) out.push(`- failed: ${task.title}${task.agentName ? ` (${task.agentName})` : ""}`);
    if (workspace.failedCount > workspace.failed.length) out.push(`- failed: and ${workspace.failedCount - workspace.failed.length} more`);
    for (const item of workspace.approvals) out.push(`- waiting for the owner: ${item.title}${item.agentName ? ` (${item.agentName})` : ""}`);
    if (workspace.approvalsCount > workspace.approvals.length) out.push(`- waiting for the owner: and ${workspace.approvalsCount - workspace.approvals.length} more`);
  }
  for (const limit of summary.limits) out.push(`Limit: ${limit.text}`);
  // As frases do cartão, para o Cyno repetir com as mesmas palavras do dono.
  out.push(`Card text (pt-BR): ${awayLines(summary).join(" · ")}`);
  return out.join("\n");
}
