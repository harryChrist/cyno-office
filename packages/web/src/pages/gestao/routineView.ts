import {
  ROUTINE_TYPE_LABELS,
  DEFAULT_USD_BRL,
  daysToExpire,
  describeTimes,
  localDayKey,
  summarizeChanges,
  type FieldDef,
  type RoutineCost,
  type RoutineOverviewItem,
  type RoutinePeriodOutcome,
  type RoutineRun,
  type RoutineSchedule,
  type TrackedItem,
  type TrackedItemChange,
  type TrackedItemHistory,
  type TrackingStatus,
} from "@cyno/shared";
import { noLinkNote, slotLabel } from "./gestaoView";
import { joinList } from "./scheduleForm";

/** Contas e textos do detalhe da rotina e da lista (funções puras; a tela só desenha). */

// ---------- Lista: filtro e títulos ----------

export const ROUTINE_FILTERS = ["todas", "metas", "acompanhamentos", "pausadas"] as const;
export type RoutineFilter = (typeof ROUTINE_FILTERS)[number];
export const ROUTINE_FILTER_LABELS: Record<RoutineFilter, string> = { todas: "Todas", metas: "Metas", acompanhamentos: "Acompanhamentos", pausadas: "Pausadas" };

/** A rotina está pausada agora? (status pausada, `pausedUntil` no futuro ou ritmo "pausada"). */
export function isPausedItem(item: Pick<RoutineOverviewItem, "routine" | "pace">): boolean {
  return item.routine.status === "pausada" || item.pace === "pausada";
}

export function matchesRoutineFilter(item: Pick<RoutineOverviewItem, "routine" | "pace">, filter: RoutineFilter): boolean {
  switch (filter) {
    case "todas":
      return true;
    case "metas":
      return item.routine.type === "meta";
    case "acompanhamentos":
      return item.routine.type === "acompanhamento";
    case "pausadas":
      return isPausedItem(item);
  }
}

export function filterRoutines<T extends Pick<RoutineOverviewItem, "routine" | "pace">>(items: readonly T[], filter: RoutineFilter): T[] {
  return items.filter((item) => matchesRoutineFilter(item, filter));
}

/** Quantas rotinas cada filtro mostra (para o número ao lado do rótulo). */
export function filterCounts(items: readonly Pick<RoutineOverviewItem, "routine" | "pace">[]): Record<RoutineFilter, number> {
  const counts = { todas: 0, metas: 0, acompanhamentos: 0, pausadas: 0 } satisfies Record<RoutineFilter, number>;
  for (const filter of ROUTINE_FILTERS) counts[filter] = filterRoutines(items, filter).length;
  return counts;
}

/** Título da seção: "Rotinas", "Metas", "Acompanhamentos" ou "Rotinas pausadas" (segue o filtro). */
export function sectionTitle(filter: RoutineFilter): string {
  return filter === "metas" ? "Metas" : filter === "acompanhamentos" ? "Acompanhamentos" : filter === "pausadas" ? "Rotinas pausadas" : "Rotinas";
}

/** Texto de "nada aqui" por filtro (o vazio geral é outro cartão). */
export function emptyFilterText(filter: RoutineFilter): string {
  switch (filter) {
    case "metas":
      return "Nenhuma meta ativa. Uma meta é um combinado como “2 posts por semana”.";
    case "acompanhamentos":
      return "Nenhum acompanhamento ativo. Um acompanhamento confere itens (inscrições, pedidos…) em horários fixos.";
    case "pausadas":
      return "Nenhuma rotina pausada.";
    case "todas":
      return "Nenhuma rotina ainda.";
  }
}

/** "Acompanhamento · 3 horários" (o subtítulo do cartão). */
export function typeLine(item: Pick<RoutineOverviewItem, "routine">): string {
  const count = item.routine.schedules.length;
  return `${ROUTINE_TYPE_LABELS[item.routine.type]}${count > 0 ? ` · ${count} ${count === 1 ? "horário" : "horários"}` : ""}`;
}

/** O estado da rotina por extenso, com o motivo quando o servidor a pausou. */
export function stateText(item: Pick<RoutineOverviewItem, "routine" | "pace">): string {
  const { routine } = item;
  if (routine.status === "encerrada") return "Encerrada";
  if (routine.status === "proposta") return "Proposta, esperando o seu OK";
  if (routine.status === "pausada") return routine.pausedReason ? `Pausada: ${routine.pausedReason}` : "Pausada";
  if (routine.pausedUntil && Date.parse(routine.pausedUntil) > Date.now()) return "Pausada por um tempo";
  return "Ativa";
}

// ---------- Ações (o que mostrar) ----------

export type RoutineActions = { pause: boolean; resume: boolean; skip: boolean; unskip: boolean; end: boolean };

/**
 * Botões que fazem sentido agora. Meta já batida ou encerrada não oferece "Pausar" nem "Pular o
 * período" (não há o que cobrar); "Retomar" só existe para quem está pausada; "Encerrar" some quando
 * já está encerrada.
 */
export function routineActions(item: Pick<RoutineOverviewItem, "routine" | "pace" | "periodKey">): RoutineActions {
  const { routine } = item;
  const ended = routine.status === "encerrada" || routine.status === "proposta";
  const isMeta = routine.type === "meta";
  const batida = isMeta && item.pace === "concluida";
  const skipped = routine.skipPeriods.includes(item.periodKey);
  const paused = routine.status === "pausada";
  return {
    pause: !ended && !paused && !batida,
    resume: !ended && paused,
    skip: isMeta && !ended && !batida && !skipped,
    unskip: isMeta && !ended && skipped,
    end: !ended,
  };
}

/** "Pular esta semana" / "Pular este mês". */
export const skipLabel = (period: RoutineOverviewItem["period"]): string => (period === "month" ? "Pular este mês" : "Pular esta semana");

// ---------- Modo (explicação) ----------

/** "Pede OK" ou "Automático", com o que isso significa (só leitura no detalhe). */
export function modeView(routine: Pick<RoutineOverviewItem["routine"], "mode" | "needsApproval">): { label: string; auto: boolean; hint: string } {
  if (routine.mode.kind === "automatico") {
    const grant = routine.mode.grant;
    const where = grant.sites && grant.sites.length > 0 ? ` só em ${joinList(grant.sites)}` : "";
    const cap = grant.dailyCap !== undefined ? ` e até ${grant.dailyCap} por dia` : "";
    return { label: "Automático", auto: true, hint: `O agente age sozinho${where}${cap}, só com os botões liberados. Conectar, mandar mensagem, seguir, compartilhar e apagar sempre pedem o seu OK.` };
  }
  return { label: "Pede OK", auto: false, hint: "Cada ação sensível (comentar, publicar, enviar convite) espera o seu OK em Aprovações. Ler e conferir nunca pede." };
}

/**
 * Como o cartão "Modo" se comporta para esta rotina: pausada não aprova nada sozinha; encerrada ou
 * ainda em proposta não muda de modo (a rota responde 409), então o cartão só mostra.
 */
export function modeCardState(routine: Pick<RoutineOverviewItem["routine"], "status">): { paused: boolean; open: boolean; closed: boolean } {
  const closed = routine.status === "encerrada" || routine.status === "proposta";
  return { paused: routine.status === "pausada", open: !closed, closed };
}

// ---------- Horários: a árvore do desenho do dono ----------

export type ScheduleRow = { id: string; when: string; what: string; agent: string | null; scope: string | null; off: boolean };

/** Uma linha por horário: "Dias úteis · 9h, 13h, 18h" → a ação. `agentName` traduz o endereço do agente próprio. */
export function scheduleRows(schedules: readonly RoutineSchedule[], agentName: (address: string) => string, describeDays: (days: RoutineSchedule["days"]) => string): ScheduleRow[] {
  return schedules.map((schedule) => ({
    id: schedule.id,
    when: schedule.trigger ? "Quando chegar e-mail" : `${describeDays(schedule.days)} · ${describeTimes(schedule.times)}`,
    what: schedule.action,
    agent: schedule.agent ? agentName(schedule.agent) : null,
    scope: schedule.scope === "itens_vencidos" ? "só itens vencidos" : null,
    off: !schedule.enabled,
  }));
}

// ---------- Execuções ----------

export type RunLine = { id: string; when: string; schedule: string; label: string; tone: "ok" | "danger" | "muted" | "info"; taskId?: string; projectId?: string; changes: string; /** O texto completo do agente (só quando é maior que o resumo curto). */ detail?: string };

/** "11/11 09:00" a partir do instante ISO (fuso de São Paulo, dia e hora). */
export function dayHour(iso: string, timeZone = "America/Sao_Paulo"): string {
  const parts = new Intl.DateTimeFormat("pt-BR", { timeZone, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(iso));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("day")}/${get("month")} ${get("hour")}:${get("minute")}`;
}

const RUN_LABELS: Record<RoutineRun["outcome"], { text: string; tone: RunLine["tone"] }> = {
  rodando: { text: "Rodando", tone: "info" },
  ok: { text: "Concluída", tone: "ok" },
  falhou: { text: "Falhou", tone: "danger" },
  pulada: { text: "Pulada", tone: "muted" },
};

/** Resumo do agente em uma linha: sem markdown (listas, negrito, títulos), espaços simples e no máximo `max` caracteres. */
export function cleanSummary(text: string, max = 160): string {
  const flat = text
    .replace(/([.:;])\s+[-*]\s+/g, "$1 ")
    .replace(/\*\*|__|`/g, "")
    .replace(/^\s*(?:[-*]|\d+[.)]|#{1,6})\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/** Uma execução para a lista: resultado, motivo (pulada), resumo e o que mudou. */
export function runLine(run: RoutineRun, schedules: readonly Pick<RoutineSchedule, "id" | "label">[]): RunLine {
  const base = RUN_LABELS[run.outcome];
  const detail = run.outcome === "pulada" ? run.skipReason : run.summary ? cleanSummary(run.summary) : undefined;
  return {
    id: run.id,
    when: slotLabel(run.slotKey) || dayHour(run.startedAt),
    schedule: schedules.find((schedule) => schedule.id === run.scheduleId)?.label ?? "",
    label: detail ? `${base.text}: ${detail}` : base.text,
    tone: base.tone,
    ...(run.taskId ? { taskId: run.taskId } : {}),
    ...(run.projectId ? { projectId: run.projectId } : {}),
    changes: summarizeChanges(run.changes, 220),
    ...(run.detail && run.detail.replace(/\s+/g, " ").trim() !== (run.summary ?? "") ? { detail: run.detail } : {}),
  };
}

// ---------- Meta: período atual e histórico ----------

export type PeriodView = { headline: string; lines: string[]; tone: "ok" | "info" | "danger" | "muted" | "done" };

/** O período atual por extenso: alvo, entregue, em preparo, falta e o ritmo. */
export function periodView(item: Pick<RoutineOverviewItem, "delivered" | "inFlight" | "pending" | "missing" | "pace" | "period" | "expected" | "daysLeft" | "routine"> & { approvedNoLink?: number }): PeriodView {
  const target = item.routine.target;
  const noun = item.period === "month" ? "este mês" : "esta semana";
  const preparing = item.inFlight + item.pending;
  const lines = [`Alvo ${target} ${noun}`, `${item.delivered} ${item.delivered === 1 ? "entregue" : "entregues"}`];
  if (preparing > 0) lines.push(`${preparing} em preparo`);
  const noLink = noLinkNote(item.approvedNoLink);
  if (noLink) lines.push(noLink);
  if (item.pace === "concluida") lines.push("meta batida");
  else lines.push(`falta${item.missing === 1 ? "" : "m"} ${Math.max(0, item.missing)}`);
  const tone = item.pace === "atrasada" ? "danger" : item.pace === "concluida" ? "done" : item.pace === "pausada" ? "muted" : item.pace === "adiantada" ? "info" : "ok";
  const headline = item.pace === "concluida" ? "Meta batida" : item.pace === "atrasada" ? "Atrasada" : item.pace === "pausada" ? "Pausada" : item.pace === "adiantada" ? "Adiantada" : "No ritmo";
  return { headline, lines, tone };
}

/** "Preparadas 6 · aprovadas 3 · dispensadas 3" para os contadores do período. */
export function counterCells(stats: { prepared: number; approved: number; dismissed: number }): { label: string; value: number }[] {
  return [
    { label: "Preparadas", value: stats.prepared },
    { label: "Aprovadas", value: stats.approved },
    { label: "Dispensadas", value: stats.dismissed },
  ];
}

export const HISTORY_MARKS: Record<RoutinePeriodOutcome, { mark: string; label: string; tone: "ok" | "danger" | "muted" }> = {
  bateu: { mark: "✓", label: "Bateu", tone: "ok" },
  nao_bateu: { mark: "✗", label: "Não bateu", tone: "danger" },
  pulada: { mark: "⏸", label: "Pulado", tone: "muted" },
};

/** "3 de 3 · 6 preparadas · 3 aprovadas · R$ 1,20" (a linha de um período fechado; o custo vem formatado). */
export function periodHistoryLine(point: { delivered: number; target: number; prepared?: number; approved?: number; dismissed?: number; costUsd?: number }, formatCost: (usd: number) => string): string {
  const parts = [`${point.delivered} de ${point.target}`];
  if (point.prepared) parts.push(`${point.prepared} ${point.prepared === 1 ? "preparada" : "preparadas"}`, `${point.approved ?? 0} ${point.approved === 1 ? "aprovada" : "aprovadas"}`);
  if (point.costUsd !== undefined && point.costUsd > 0) parts.push(formatCost(point.costUsd));
  return parts.join(" · ");
}

/** Câmbio que o servidor usou nos custos (o padrão do app quando ainda não há gasto). */
export function usdRate(cost: Pick<RoutineCost, "periodUsd" | "periodBrl" | "totalUsd" | "totalBrl">): number {
  if (cost.periodUsd > 0) return cost.periodBrl / cost.periodUsd;
  if (cost.totalUsd > 0) return cost.totalBrl / cost.totalUsd;
  return DEFAULT_USD_BRL;
}

// ---------- Acompanhamento: tabela de itens ----------

export const ITEM_FILTERS = ["ativos", "alerta", "encerrados", "parados", "todos"] as const;
export type ItemFilter = (typeof ITEM_FILTERS)[number];
export const ITEM_FILTER_LABELS: Record<ItemFilter, string> = { ativos: "Ativos", alerta: "Com alerta", encerrados: "Encerrados", parados: "Parados", todos: "Todos" };

/** Primeiro valor preenchido do item (empresa, nome…): o rótulo da linha. */
export function itemLabel(fields: readonly FieldDef[], item: Pick<TrackedItem, "id" | "values">): string {
  for (const field of fields) {
    const value = item.values[field.key];
    if (value !== undefined && String(value).trim() !== "") return String(value);
  }
  return item.id;
}

export const alertStatuses = (statuses: readonly TrackingStatus[]): Set<string> => new Set(statuses.filter((status) => status.alert).map((status) => status.name));

/** O item passa no filtro? "alerta" = ativo (ou não) num status de alerta. */
export function matchesItemFilter(item: Pick<TrackedItem, "state" | "status">, filter: ItemFilter, alerts: ReadonlySet<string>): boolean {
  switch (filter) {
    case "todos":
      return true;
    case "ativos":
      return item.state === "ativo";
    case "encerrados":
      return item.state === "encerrado";
    case "parados":
      return item.state === "parado";
    case "alerta":
      return alerts.has(item.status);
  }
}

/** Busca sem acento nem caixa em todos os valores, no status e no id. */
export function matchesItemSearch(item: Pick<TrackedItem, "id" | "status" | "values">, query: string): boolean {
  const needle = fold(query);
  if (!needle) return true;
  return [item.id, item.status, ...Object.values(item.values).map(String)].some((text) => fold(text).includes(needle));
}

const fold = (text: string): string => text.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().trim();

/** Filtra, busca e ordena: ativos primeiro (os que vencem antes no topo), depois os encerrados e parados (os mais recentes antes). */
export function visibleItems(items: readonly TrackedItem[], filter: ItemFilter, query: string, alerts: ReadonlySet<string>): TrackedItem[] {
  const rank = (item: TrackedItem) => (item.state === "ativo" ? 0 : 1);
  return items
    .filter((item) => matchesItemFilter(item, filter, alerts) && matchesItemSearch(item, query))
    .sort((a, b) => rank(a) - rank(b) || (rank(a) === 0 ? (a.expiresAt ?? "9").localeCompare(b.expiresAt ?? "9") : (b.endedAt ?? b.createdAt).localeCompare(a.endedAt ?? a.createdAt)));
}

/** Quantos itens cada filtro mostra. */
export function itemFilterCounts(items: readonly TrackedItem[], alerts: ReadonlySet<string>): Record<ItemFilter, number> {
  const counts = { ativos: 0, alerta: 0, encerrados: 0, parados: 0, todos: 0 } satisfies Record<ItemFilter, number>;
  for (const filter of ITEM_FILTERS) counts[filter] = items.filter((item) => matchesItemFilter(item, filter, alerts)).length;
  return counts;
}

/** "11/11/2026" para valores de data; link vira o endereço curto; o resto, o texto. */
export function cellText(field: FieldDef, value: string | number | undefined): string {
  if (value === undefined || String(value).trim() === "") return "–";
  const text = String(value);
  if (field.type === "data") {
    const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
    return match ? `${match[3]}/${match[2]}/${match[1]}` : text;
  }
  if (field.type === "link") return text.replace(/^https?:\/\/(www\.)?/i, "").replace(/\/$/, "");
  return text;
}

export const isHttpUrl = (text: string): boolean => /^https?:\/\//i.test(text);

/** "vence em 3 dias" / "vence hoje" / "sem fim"; item que não está ativo mostra o motivo. */
export function dueText(item: Pick<TrackedItem, "state" | "expiresAt" | "endReason">, now: Date): string {
  if (item.state === "parado") return "Parado por você";
  if (item.state === "encerrado") return item.endReason === "expirou" ? "Prazo acabou" : item.endReason === "rotina_encerrada" ? "Rotina encerrada" : "Status final";
  const days = daysToExpire(item, now);
  if (days === undefined) return "Sem fim";
  return days === 0 ? "Vence hoje" : days === 1 ? "Vence amanhã" : `Vence em ${days} dias`;
}

/** Uma linha do histórico do item: "Em análise → Entrevista" (ou a nota, ou o campo corrigido). */
export function historyText(entry: TrackedItemHistory, fieldLabel: (key: string) => string = (key) => key): string {
  if (entry.field === "criado") return `Criado${entry.to ? ` como ${entry.to}` : ""}`;
  if (entry.field === "nota") return "Anotação";
  if (entry.field === "status" || entry.field === "estado") return `${entry.from ?? "?"} → ${entry.to ?? "?"}`;
  if (entry.field) return `${fieldLabel(entry.field)}: ${entry.from ?? "vazio"} → ${entry.to ?? "vazio"}`;
  return entry.note ? "Anotação" : "Atualizado";
}

export const BY_LABELS: Record<TrackedItemHistory["by"], string> = { agente: "agente", servidor: "servidor", usuario: "você" };

// ---------- Mudanças recentes (acompanhamento) ----------

export type ChangeDay = { day: string; label: string; summary: string; changes: TrackedItemChange[] };

/** Agrupa as mudanças por dia: "Hoje: 2 novos; Acme → Entrevista" (até 3 mudanças soltas, o resto vira "+N"). */
export function changesByDay(changes: readonly TrackedItemChange[], now: Date): ChangeDay[] {
  const today = localDayKey(now);
  const yesterday = localDayKey(new Date(now.getTime() - 86_400_000));
  const groups = new Map<string, TrackedItemChange[]>();
  for (const change of changes) {
    const day = localDayKey(new Date(change.at));
    groups.set(day, [...(groups.get(day) ?? []), change]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([day, list]) => {
      const news = list.filter((change) => change.text.startsWith("Novo:")).length;
      const others = list.filter((change) => !change.text.startsWith("Novo:")).map((change) => change.text);
      const parts = [...(news > 0 ? [`${news} ${news === 1 ? "novo" : "novos"}`] : []), ...others.slice(0, 3), ...(others.length > 3 ? [`e mais ${others.length - 3}`] : [])];
      const label = day === today ? "Hoje" : day === yesterday ? "Ontem" : `${day.slice(8, 10)}/${day.slice(5, 7)}`;
      return { day, label, summary: parts.join("; "), changes: list };
    });
}

/** Do mais novo para o mais antigo. */
export const historyNewestFirst = (history: readonly TrackedItemHistory[]): TrackedItemHistory[] => [...history].sort((a, b) => b.at.localeCompare(a.at));
