import {
  usageWindowState,
  type ForYouItem,
  ROUTINE_ALLOWED_LABELS,
  daysToExpire,
  type TrackedItem,
  type TrackingSummary,
  ROUTINE_KIND_LABELS,
  ROUTINE_LIMITS_TABLE,
  dailyCapOf,
  describeDays,
  describeTimes,
  type EntryStage,
  type GoalVerdict,
  type ManagementSummary,
  type PaceStatus,
  type Routine,
  type RoutineDecision,
  type RoutineEntry,
  type RoutineKind,
  type RoutineOverviewItem,
  type RoutinePeriod,
  type RoutinePeriodOutcome,
  type RoutineRun,
  type RoutineSchedule,
} from "@cyno/shared";

/** Contas e textos da página Gestão (funções puras; a tela só desenha). */

// ---------- Ritmo ----------

export type PaceTone = "ok" | "info" | "danger" | "muted" | "done";
export type PaceIcon = "check" | "up" | "alert" | "pause" | "flag";

/** Rótulo, cor e ícone do selo de ritmo: o texto sempre acompanha a cor e o ícone. */
export const PACE_VIEW: Record<PaceStatus, { label: string; tone: PaceTone; icon: PaceIcon }> = {
  no_ritmo: { label: "No ritmo", tone: "ok", icon: "check" },
  adiantada: { label: "Adiantada", tone: "info", icon: "up" },
  atrasada: { label: "Atrasada", tone: "danger", icon: "alert" },
  pausada: { label: "Pausada", tone: "muted", icon: "pause" },
  concluida: { label: "Batida", tone: "done", icon: "flag" },
};

/** Fatias da barra de progresso em % da meta: entregue (sólido) e registrado ainda não entregue (listrado). */
export function progressSplit(delivered: number, registered: number, target: number): { deliveredPct: number; registeredPct: number } {
  if (target <= 0) return { deliveredPct: 0, registeredPct: 0 };
  const deliveredPct = Math.min(100, (Math.max(0, delivered) / target) * 100);
  const registeredPct = Math.min(100 - deliveredPct, (Math.max(0, registered) / target) * 100);
  return { deliveredPct, registeredPct };
}

/** Posição (em %) do traço "esperado até agora" na barra. */
export function expectedPct(expected: number, target: number): number {
  return target <= 0 ? 0 : Math.min(100, Math.max(0, (expected / target) * 100));
}

/** "falta 1 dia", "faltam 4 dias", "termina hoje". */
export function daysLeftLabel(daysLeft: number): string {
  if (daysLeft <= 0) return "termina hoje";
  return daysLeft === 1 ? "falta 1 dia" : `faltam ${daysLeft} dias`;
}

/** "3 de 10 entregues · faltam 4 dias · esperado até agora: 5". */
export function progressText(item: Pick<RoutineOverviewItem, "delivered" | "daysLeft" | "expected"> & { routine: Pick<Routine, "target"> }): string {
  const { delivered, daysLeft, expected, routine } = item;
  return `${delivered} de ${routine.target} ${delivered === 1 && routine.target === 1 ? "entregue" : "entregues"} · ${daysLeftLabel(daysLeft)} · esperado até agora: ${expected}`;
}

/** "esta semana" / "este mês". */
export function periodNoun(period: RoutinePeriod): string {
  return period === "month" ? "este mês" : "esta semana";
}

/**
 * A linha da Meta no cartão: "2 de 5 esta semana · 3 em preparo · no ritmo". "Em preparo" soma o que
 * foi aprovado e espera execução e as opções esperando o seu OK (nada some do que foi entregue).
 */
export function metaSummary(item: Pick<RoutineOverviewItem, "delivered" | "inFlight" | "pending" | "pace" | "period"> & { routine: Pick<Routine, "target"> }): string {
  const parts = [`${item.delivered} de ${item.routine.target} ${periodNoun(item.period)}`];
  const preparing = item.inFlight + item.pending;
  if (preparing > 0) parts.push(`${preparing} em preparo`);
  parts.push(PACE_VIEW[item.pace].label.toLowerCase());
  return parts.join(" · ");
}

export type ProjectionView = { text: string; tone: "ok" | "warn" | "danger"; /** Explicação inteira (o ritmo e a base), para o `title`. */ detail: string };

/**
 * A projeção da meta no cartão ("no ritmo atual fecha em 7 de 10 (poucos dados)"). Some quando a meta já foi batida,
 * está pausada ou ainda não tem ritmo medido (o selo e o resumo já dizem o que importa).
 */
export function projectionView(item: Pick<RoutineOverviewItem, "projection" | "delivered" | "pace"> & { routine: Pick<Routine, "target"> }): ProjectionView | null {
  const projection = item.projection;
  if (!projection || item.pace === "pausada" || item.delivered >= item.routine.target || projection.projected === null) return null;
  const rate = projection.ratePerDay === null ? "" : `${projection.ratePerDay.toLocaleString("pt-BR", { maximumFractionDigits: 2 })} por dia útil nos últimos 7 dias, `;
  const confidence = { baixa: "baixa", media: "média", alta: "alta" }[projection.confidence];
  return {
    text: projection.text,
    tone: projection.closes ? "ok" : item.pace === "atrasada" ? "danger" : "warn",
    detail: `${rate}${projection.daysLeft.toLocaleString("pt-BR", { maximumFractionDigits: 1 })} dias úteis restantes · confiança ${confidence}`,
  };
}

/** "6 preparadas · 3 aprovadas · 3 dispensadas" (vazio se a meta não preparou nada no período). */
export function statsText(stats: { prepared?: number; approved?: number; dismissed?: number }): string {
  if (!stats.prepared) return "";
  return `${stats.prepared} ${stats.prepared === 1 ? "preparada" : "preparadas"} · ${stats.approved ?? 0} ${stats.approved === 1 ? "aprovada" : "aprovadas"} · ${stats.dismissed ?? 0} ${stats.dismissed === 1 ? "dispensada" : "dispensadas"}`;
}

/** "3 aprovadas, falta registrar o link" (vazio se não há): aprovadas que ainda não contam como entregues. */
export function noLinkNote(approvedNoLink: number | undefined): string {
  const n = approvedNoLink ?? 0;
  if (n <= 0) return "";
  return n === 1 ? "1 aprovada, falta registrar o link" : `${n} aprovadas, falta registrar o link`;
}

/** "+2 registrados, esperando a entrega" (vazio se não há). */
export function registeredNote(registered: number): string {
  if (registered <= 0) return "";
  return registered === 1 ? "1 registrado, esperando a entrega" : `${registered} registrados, esperando a entrega`;
}

// ---------- Veredito e resumo ----------

export type VerdictTone = "ok" | "warn" | "muted";

/** A frase do topo: "Você está no ritmo: 3 de 3 metas em dia" ou "Atenção: 1 meta atrasada". */
export function verdictSentence(goals: GoalVerdict, trackings = 0): { text: string; tone: VerdictTone } {
  if (goals.total === 0) {
    if (trackings > 0) return { text: `Sem metas ativas · ${trackings} ${trackings === 1 ? "acompanhamento ativo" : "acompanhamentos ativos"}`, tone: "muted" };
    return { text: "Nenhuma meta ativa ainda", tone: "muted" };
  }
  if (goals.behind > 0) return { text: `Atenção: ${goals.behind} ${goals.behind === 1 ? "meta atrasada" : "metas atrasadas"}`, tone: "warn" };
  const counted = goals.total - goals.paused;
  if (counted <= 0) return { text: goals.paused === 1 ? "A meta está pausada" : "Todas as metas estão pausadas", tone: "muted" };
  const inPace = goals.onTrack + goals.ahead + goals.done;
  return { text: `Você está no ritmo: ${inPace} de ${counted} ${counted === 1 ? "meta em dia" : "metas em dia"}`, tone: "ok" };
}

/** "há 35 min", "há 10 h", "há 3 dias". */
export function ageLabel(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return "agora";
  if (minutes < 60) return `há ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `há ${hours} h`;
  const days = Math.floor(hours / 24);
  return `há ${days} dias`;
}

/** A linha "Esperando você": contagem, a mais antiga e quantas passam de 24 h. */
export function waitingParts(waiting: ManagementSummary["waiting"]): { headline: string; details: string[] } {
  if (waiting.count === 0) return { headline: "Nada esperando você", details: [] };
  const details = [`a mais antiga ${ageLabel(waiting.oldestAgeMs)}`];
  if (waiting.olderThan24h > 0) details.push(`${waiting.olderThan24h} há mais de 24 h`);
  return { headline: `Esperando você: ${waiting.count}`, details };
}

/** Tarefas com problema hoje: falhas e paradas por motor sem cota. */
export function troubleParts(tasks: ManagementSummary["tasks"]): { failed: number; blocked: number; text: string } {
  const failed = tasks.failedToday.length;
  const blocked = tasks.blockedByEngine.length;
  const parts: string[] = [];
  if (failed > 0) parts.push(failed === 1 ? "1 falhou hoje" : `${failed} falharam hoje`);
  if (blocked > 0) parts.push(blocked === 1 ? "1 parada sem cota" : `${blocked} paradas sem cota`);
  return { failed, blocked, text: parts.length > 0 ? parts.join(" · ") : "Nenhuma falha hoje" };
}

/** Uma barra da faixa de cota da Gestão (as regras de honestidade vêm de `usageWindowState`, as mesmas do anel). */
export type QuotaBar = {
  key: string;
  label: string;
  /** null = janela renovada sem leitura nova (mostrar "renovada" e um traço). */
  percent: number | null;
  tone: "ok" | "warn" | "danger";
  /** Texto no lugar do número: "42%", "renovada". */
  text: string;
  /** Leitura de mais de 30 min. */
  old: boolean;
  renewed: boolean;
  /** "há 42 min"; "" se a data é desconhecida. */
  ageLabel: string;
};

/** Janelas de cota que a faixa mostra (5 h e semanal da assinatura; as por modelo ficam de fora). */
export function quotaBars(quota: ManagementSummary["quota"], now: number = Date.now()): QuotaBar[] {
  const wanted: Record<string, string> = { five_hour: "5 h", seven_day: "Semana" };
  const bars: QuotaBar[] = [];
  // Com mais de uma assinatura (Claude e Antigravity), o nome vai na frente: "Claude · 5 h".
  const NAMES: Record<string, string> = { claude: "Claude", gemini: "Antigravity" };
  const several = quota.filter((provider) => provider.windows.some((window) => wanted[window.id])).length > 1;
  for (const provider of quota) {
    for (const window of provider.windows) {
      const base = wanted[window.id];
      if (!base) continue;
      const label = several ? `${NAMES[provider.provider] ?? provider.provider} · ${base}` : base;
      const state = usageWindowState(window, { updatedAt: provider.updatedAt }, now);
      bars.push({ key: `${provider.provider}:${window.id}`, label, percent: state.percent, tone: state.tone, text: state.text, old: state.old, renewed: state.renewed, ageLabel: state.ageLabel });
    }
  }
  return bars;
}

const BRL = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
/** "R$ 12,40" (nunca "0" solto: custo zero vira "R$ 0,00"). */
export function formatBrl(value: number): string {
  return BRL.format(value);
}

// ---------- Cartão da meta ----------

export const KIND_ICON_PATHS: Record<RoutineKind, string[]> = {
  post: ["M12 20h9", "M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"],
  comment: ["M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"],
  invite: ["M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2", "M9 3a4 4 0 1 0 0 8a4 4 0 1 0 0-8Z", "M19 8v6", "M22 11h-6"],
  like: ["M7 10v12", "M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z"],
  other: ["M12 2a10 10 0 1 0 0 20a10 10 0 1 0 0-20Z", "M12 8v8", "M8 12h8"],
};

/** O dono por extenso: "Clara" ou "time Conteúdo". */
export function ownerLabel(item: Pick<RoutineOverviewItem, "owner">): string {
  if (!item.owner) return "sem dono";
  return item.owner.kind === "team" ? `time ${item.owner.name}` : item.owner.name;
}

/** O que a rotina faz sem pedir OK ou o que sempre pede (para o selo e a dica). */
export function approvalView(routine: Pick<Routine, "needsApproval" | "kind" | "dailyCap">): { label: string; short: boolean; hint: string } {
  if (routine.needsApproval) {
    return { label: "Precisa do meu OK", short: false, hint: "Cada ação sensível (comentar, publicar, enviar convite) espera o seu OK em Aprovações." };
  }
  const allowed = ROUTINE_ALLOWED_LABELS[routine.kind];
  const cap = dailyCapOf(routine);
  const buttons = allowed.length > 0 ? `só clica em botões como ${allowed.slice(0, 3).join(", ")}${allowed.length > 3 ? " e outros da lista do tipo" : ""}` : "sem botões liberados neste tipo (tudo pede OK)";
  return {
    label: "Automático",
    short: true,
    hint: `Sem OK, ${buttons}; só no site da rotina${cap !== undefined ? ` e até ${cap} por dia` : ""}. Conectar, mensagem, seguir, compartilhar e apagar sempre pedem o seu OK.`,
  };
}

const NEXT_STATE_LABELS: Record<RoutineOverviewItem["nextDispatch"]["state"], string> = { agora: "Cobra agora", aguardando: "Aguardando", sem_cobranca: "Sem cobrança" };

/** "Aguardando · limite diário atingido". */
export function nextDispatchText(next: RoutineOverviewItem["nextDispatch"]): string {
  return next.reason ? `${NEXT_STATE_LABELS[next.state]} · ${next.reason}` : NEXT_STATE_LABELS[next.state];
}

export const OUTCOME_VIEW: Record<RoutinePeriodOutcome, { mark: string; label: string; tone: "ok" | "danger" | "muted" }> = {
  bateu: { mark: "✓", label: "bateu a meta", tone: "ok" },
  nao_bateu: { mark: "✗", label: "não bateu a meta", tone: "danger" },
  pulada: { mark: "⏸", label: "semana pulada", tone: "muted" },
};

const MONTH_NAMES = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];

/** "2026-W45" → "semana 45"; "2026-M11" → "nov/2026". */
export function weekLabel(periodKey: string): string {
  const month = /^(\d{4})-M(\d{2})$/.exec(periodKey);
  if (month) return `${MONTH_NAMES[Number(month[2]) - 1] ?? month[2]}/${month[1]}`;
  const match = /W(\d{2})$/.exec(periodKey);
  return match ? `semana ${Number(match[1])}` : periodKey;
}

/** "R$ 0,40 por convite · R$ 3,20 na semana" (custo por unidade some se ainda não há entrega). */
export function costText(cost: RoutineOverviewItem["cost"], unit: string, period: RoutinePeriod = "week"): string {
  const week = `${formatBrl(cost.periodBrl)} ${period === "month" ? "no mês" : "na semana"}`;
  return cost.perUnitBrl === null ? week : `${formatBrl(cost.perUnitBrl)} por ${unit} · ${week}`;
}

/** Meta que o usuário não quer deixar passar do que o site aguenta: aviso do campo (vazio = ok). */
export function targetWarning(kind: RoutineKind, target: number): string {
  const limit = ROUTINE_LIMITS_TABLE[kind];
  const week = limit.weekly ?? (limit.daily !== undefined ? limit.daily * 7 : undefined);
  if (week === undefined || target <= week) return "";
  return `O teto do ${ROUTINE_KIND_LABELS[kind].toLowerCase()} é ${week} por semana: a meta será limitada a ${week}.`;
}

/** Texto curto do limite do tipo para dicas ("até 15 por dia, 60 por semana"). */
export function limitsText(limits: { daily?: number; weekly?: number }): string {
  const parts: string[] = [];
  if (limits.daily !== undefined) parts.push(`até ${limits.daily} por dia`);
  if (limits.weekly !== undefined) parts.push(`${limits.weekly} por semana`);
  return parts.length > 0 ? parts.join(", ") : "sem limite conhecido";
}

// ---------- Detalhe ----------

export const STAGE_LABELS: Record<EntryStage, string> = { entregue: "Entregue", registrado: "Registrado", descartado: "Descartado" };

export type WeekGroup = { periodKey: string; entries: RoutineEntry[] };

/** Itens agrupados por semana (a mais nova primeiro; dentro dela, o mais novo primeiro). */
export function groupEntriesByWeek(entries: readonly RoutineEntry[]): WeekGroup[] {
  const groups = new Map<string, RoutineEntry[]>();
  for (const entry of entries) groups.set(entry.periodKey, [...(groups.get(entry.periodKey) ?? []), entry]);
  return [...groups.entries()]
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([periodKey, list]) => ({ periodKey, entries: [...list].sort((a, b) => b.at.localeCompare(a.at)) }));
}

export const VIA_LABELS: Record<"aprovacao" | "rotina" | "livre", string> = { aprovacao: "com sua aprovação", rotina: "liberada pela rotina", livre: "workspace sem aprovação" };

export const DECISION_LABELS: Record<RoutineDecision["kind"], string> = { dispatched: "Mandou tarefa", skipped: "Não mandou", closed: "Fechou a semana", wake: "Avisou o Maestro", ask: "Perguntou a você" };

/** Host curto de um link, para a lista ("linkedin.com/in/ana…"). */
/** Texto de uma entrega no lugar do link: entrega ao dono não tem link (a nota diz o que foi). */
export function entryLabel(entry: { url: string; deliveredTo?: "owner" }): string {
  return entry.url ? shortUrl(entry.url) : entry.deliveredTo === "owner" ? "Entregue ao dono" : "(sem link)";
}

export function shortUrl(url: string, max = 52): string {
  const bare = url.replace(/^https?:\/\/(www\.)?/i, "").replace(/\/$/, "");
  return bare.length > max ? `${bare.slice(0, max - 1)}…` : bare;
}

// ---------- Cartão "rotina" do Para você ----------

export type ProposalMode = "criar" | "ajustar" | "revisar" | "alterar";

/** Modo do cartão: "revisar" (pausada depois de tentativas vazias) pode chegar antes de entrar no tipo do shared. */
export function proposalModeOf(payload: { mode: string } | undefined): ProposalMode {
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

export type PendingChange = { itemId: string; routineId: string; title: string; text: string };

/** Mudanças de rotina propostas pelo Maestro e ainda sem decisão (cartões "alterar" pendentes do Para você). */
export function pendingChangeProposals(items: readonly Pick<ForYouItem, "id" | "status" | "routineId" | "routine">[] | null): PendingChange[] {
  if (!items) return [];
  return items
    .filter((item) => item.status === "pendente" && item.routine !== undefined && proposalModeOf(item.routine) === "alterar")
    .map((item) => ({ itemId: item.id, routineId: item.routine!.routineId ?? item.routineId ?? "", title: item.routine!.title, text: "Ajuste proposto pelo Maestro" }));
}

/** Número digitado → inteiro de 1 até `max` (vazio ou inválido = null). */
export function parseWhole(text: string, max: number): number | null {
  if (!/^\d+$/.test(text.trim())) return null;
  return Math.min(max, Math.max(1, Number(text.trim())));
}

// ---------- Horários e execuções ----------

/** "Dias úteis · 9h, 13h, 18h → E-mail" (horário desligado ganha o aviso; gatilho reservado não tem hora). */
export function scheduleLine(schedule: Pick<RoutineSchedule, "days" | "times" | "label" | "enabled" | "trigger">): string {
  const when = schedule.trigger ? "Quando chegar e-mail" : `${describeDays(schedule.days)} · ${describeTimes(schedule.times)}`;
  return `${when} → ${schedule.label}${schedule.enabled ? "" : " (desligado)"}`;
}

/** "11/11 09:00" a partir da chave do horário ("2026-11-11T09:00"). */
export function slotLabel(slotKey: string | undefined): string {
  const match = /^\d{4}-(\d{2})-(\d{2})T(\d{2}:\d{2})$/.exec(slotKey ?? "");
  return match ? `${match[2]}/${match[1]} ${match[3]}` : "";
}

export type RunTone = "ok" | "danger" | "muted" | "info";
/** Texto e cor de uma execução de horário (a cor nunca vem sem o texto). */
export function runView(run: Pick<RoutineRun, "outcome" | "skipReason" | "summary">): { label: string; tone: RunTone } {
  switch (run.outcome) {
    case "rodando":
      return { label: "Rodando", tone: "info" };
    case "ok":
      return { label: run.summary ? `Rodou: ${run.summary}` : "Rodou", tone: "ok" };
    case "falhou":
      return { label: run.summary ? `Falhou: ${run.summary}` : "Falhou", tone: "danger" };
    case "pulada":
      return { label: run.skipReason ? `Pulada: ${run.skipReason}` : "Pulada", tone: "muted" };
  }
}

/** "7 itens acompanhados · 2 mudaram hoje" (o resumo do cartão do acompanhamento). */
export function trackingText(summary: TrackingSummary): string {
  const total = summary.active + summary.ended + summary.stopped;
  if (total === 0) return "Nenhum item acompanhado ainda";
  const itens = `${summary.active} ${summary.active === 1 ? "item acompanhado" : "itens acompanhados"}`;
  const changed = summary.changedToday === 0 ? "nada mudou hoje" : `${summary.changedToday} ${summary.changedToday === 1 ? "mudou" : "mudaram"} hoje`;
  const closed = summary.ended + summary.stopped;
  return `${itens} · ${changed}${closed > 0 ? ` · ${closed} ${closed === 1 ? "encerrado" : "encerrados"}` : ""}`;
}

/** "vence em 3 dias" / "vence hoje" / "sem fim"; item que não está ativo mostra o motivo. */
export function expiryText(item: Pick<TrackedItem, "state" | "expiresAt" | "endReason">, now: Date): string {
  if (item.state === "parado") return "Parado por você";
  if (item.state === "encerrado") return item.endReason === "expirou" ? "Terminou o prazo" : item.endReason === "rotina_encerrada" ? "Rotina encerrada" : "Terminou";
  const days = daysToExpire(item, now);
  if (days === undefined) return "Sem fim";
  return days === 0 ? "Vence hoje" : days === 1 ? "Vence amanhã" : `Vence em ${days} dias`;
}
