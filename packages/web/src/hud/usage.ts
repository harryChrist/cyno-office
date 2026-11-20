import {
  sortUsageWindows,
  type Agent,
  type AgentUsageTally,
  formatUsageDuration as duration,
  usageAgeLabel,
  usageProviderLabel,
  usageWindowLabel,
  usageWindowState,
  type SubscriptionUsage,
  type UsageReadingMeta,
  type UsageTone,
  type UsageWindow,
} from "@cyno/shared";
import type { UsageByProvider } from "../store/usageStore";
import { freebuffUsageView, hasFreebuffContent, type FreebuffUsageView } from "./freebuffUsage";

export type { UsageTone };

/** Uma janela de limite pronta para a interface. */
export type UsageWindowView = {
  id: string;
  label: string;
  /** 0..100, arredondado; null = janela renovada sem leitura nova (mostrar "renovada" e um traço). */
  percent: number | null;
  /** "27%", "renovada" ou "–": o que vai no lugar do número. */
  text: string;
  /** Cor por faixa (abaixo de 50%, 50 a 79%, 80%+); "ok" se a leitura é antiga ou a janela renovou. */
  tone: UsageTone;
  /** tone !== "ok". */
  warn: boolean;
  /** A leitura tem mais de 30 min: número esmaecido, com a idade. */
  old: boolean;
  /** O horário de renovação passou e nenhuma leitura nova chegou. */
  renewed: boolean;
  /** "há 42 min" (ou "agora"); "" se a data da leitura é desconhecida. */
  ageLabel: string;
  /** "renova às 04:40 (em 2 h 15 min)", ou "" se a fonte não disse. */
  resetLabel: string;
  /** Quando a janela renova (ISO), se a fonte disse e ainda não passou. */
  resetsAt?: string;
  /** Grupo de modelos que divide a janela (Antigravity: "Modelos Gemini", "Claude e GPT"…); ausente = a conta toda. */
  group?: string;
};

/** Janelas de um mesmo grupo de modelos, na ordem em que aparecem (grupo "" = a conta toda). */
export type UsageWindowGroup = { group: string; windows: UsageWindowView[] };

export type UsageView = {
  provider: SubscriptionUsage["provider"];
  providerLabel: string;
  windows: UsageWindowView[];
  /** Alguma janela em alerta ou a CLI disse que barrou. */
  warn: boolean;
  /** A pior cor entre as janelas. */
  tone: UsageTone;
  /** "Claude · Sessão 5h 27% · Semana 44%". */
  summary: string;
  /** "atualizado agora" / "atualizado há 3 min": sempre que houver janela. */
  updatedLabel: string;
  /** Alguma janela com leitura de mais de 30 min. */
  old: boolean;
  /** Motivo da consulta da conta estar falhando (o valor mostrado é o último conhecido). */
  stale?: string;
  /** O server consulta o uso da conta deste provedor (dá para pedir uma nova consulta). */
  account: boolean;
  /** As janelas por grupo de modelos (um grupo só, "", quando a fonte não separa). */
  groups: UsageWindowGroup[];
  /** Só no Freebuff: as horas do dia e as horas abertas por agente (a cota dele é em horas). */
  freebuff?: FreebuffUsageView;
};

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * Quando a janela renova, na hora local: "renova em 40 min (às 12:40)", "renova às 14:15 (em 2 h
 * 15 min)" ou, com um dia ou mais, "renova seg às 15:00 (em 3 d)". Sem data válida: "".
 */
export function resetLabel(iso: string | undefined, now: number): string {
  if (!iso) return "";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  // Instante passado: nunca "renova às…" no passado (a janela já renovou; quem decide o que mostrar é usageWindowState).
  if (at.getTime() <= now) return "";
  const minutes = Math.round((at.getTime() - now) / 60_000);
  if (minutes <= 0) return "renovando agora";
  const clock = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  if (minutes < 60) return `renova em ${minutes} min (às ${clock})`;
  if (minutes < 24 * 60) return `renova às ${clock} (em ${duration(minutes)})`;
  const weekday = at.toLocaleDateString("pt-BR", { weekday: "short" }).replace(".", "");
  return `renova ${weekday} às ${clock} (em ${duration(minutes)})`;
}

/** "atualizado agora", "atualizado há 3 min", "atualizado há 2 h", "atualizado há 1 d". */
export function updatedLabel(iso: string | undefined, now: number): string {
  if (!iso) return "";
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "";
  return `atualizado ${usageAgeLabel(Math.max(0, Math.floor((now - at) / 60_000)))}`;
}

const TONE_RANK: Record<UsageTone, number> = { ok: 0, warn: 1, danger: 2 };
const worst = (tones: UsageTone[]): UsageTone => tones.reduce<UsageTone>((acc, tone) => (TONE_RANK[tone] > TONE_RANK[acc] ? tone : acc), "ok");

function windowView(window: UsageWindow, meta: UsageReadingMeta, now: number): UsageWindowView {
  // A regra de honestidade mora em @cyno/shared (usageWindowState); aqui só se traduz para a tela.
  const state = usageWindowState(window, meta, now);
  return {
    id: window.id,
    label: window.label ?? usageWindowLabel(window.id),
    percent: state.percent,
    text: state.text,
    tone: state.tone,
    warn: state.tone !== "ok",
    old: state.old,
    renewed: state.renewed,
    ageLabel: state.ageLabel,
    resetLabel: state.renewed ? "" : resetLabel(window.resetsAt, now),
    ...(window.resetsAt && !state.renewed ? { resetsAt: window.resetsAt } : {}),
    ...(window.group ? { group: window.group } : {}),
  };
}

/** Separa as janelas por grupo, mantendo a ordem do primeiro aparecimento de cada grupo. */
export function groupUsageWindows(windows: UsageWindowView[]): UsageWindowGroup[] {
  const groups: UsageWindowGroup[] = [];
  for (const window of windows) {
    const name = window.group ?? "";
    const group = groups.find((candidate) => candidate.group === name);
    if (group) group.windows.push(window);
    else groups.push({ group: name, windows: [window] });
  }
  return groups;
}

/** O valor da janela em texto corrido: "27%", "27% (de há 42 min)" ou "renovada". */
export const windowText = (window: UsageWindowView) => (window.old && window.percent !== null ? `${window.text} (de ${window.ageLabel})` : window.text);

/** Nome da janela com o grupo, para texto corrido: "Claude e GPT · Sessão 5h". */
export const windowFullLabel = (window: UsageWindowView) => (window.group ? `${window.group} · ${window.label}` : window.label);

/** Motores cuja conta o server consulta (dá para pedir "atualizar agora"). */
const ACCOUNT_PROVIDERS = new Set<SubscriptionUsage["provider"]>(["claude", "gemini"]);

/** Ordem das seções: Claude, Antigravity e o resto. */
const PROVIDER_ORDER: SubscriptionUsage["provider"][] = ["claude", "gemini", "freebuff", "codex", "opencode"];
const providerRank = (provider: SubscriptionUsage["provider"]) => {
  const index = PROVIDER_ORDER.indexOf(provider);
  return index === -1 ? PROVIDER_ORDER.length : index;
};

export function usageView(usage: SubscriptionUsage, now: number): UsageView {
  const meta: UsageReadingMeta = { updatedAt: usage.updatedAt, ...(usage.fetchedAt ? { fetchedAt: usage.fetchedAt } : {}), ...(usage.stale ? { stale: usage.stale } : {}) };
  const windows = sortUsageWindows(usage.windows).map((window) => windowView(window, meta, now));
  const groups = groupUsageWindows(windows);
  // Com grupos, a ordem da tela é a dos grupos (o anel e o resumo seguem a mesma).
  const ordered = groups.flatMap((group) => group.windows);
  const providerLabel = usageProviderLabel(usage.provider);
  const tone = worst([usage.status === "rejected" ? "danger" : "ok", ...windows.map((window) => window.tone)]);
  return {
    provider: usage.provider,
    providerLabel,
    windows: ordered,
    warn: tone !== "ok",
    tone,
    summary: [providerLabel, ...ordered.map((window) => `${windowFullLabel(window)} ${windowText(window)}`)].join(" · "),
    updatedLabel: windows.length > 0 ? updatedLabel(usage.updatedAt, now) : "",
    old: windows.some((window) => window.old),
    ...(usage.stale ? { stale: usage.stale.reason } : {}),
    account: ACCOUNT_PROVIDERS.has(usage.provider) && (usage.source === "account" || usage.fetchedAt !== undefined || usage.stale !== undefined),
    groups,
    ...(usage.provider === "freebuff" ? ((fb) => (fb ? { freebuff: fb } : {}))(freebuffUsageView(usage, now)) : {}),
  };
}

/** Os usos conhecidos, prontos para a interface (sem o "mock", que não tem assinatura). */
export function usageViews(byProvider: UsageByProvider, now: number): UsageView[] {
  return Object.values(byProvider)
    .filter((usage): usage is SubscriptionUsage => usage !== undefined && usage.provider !== "mock" && (usage.windows.length > 0 || usage.stale !== undefined || hasFreebuffContent(usage.freebuff)))
    .sort((a, b) => providerRank(a.provider) - providerRank(b.provider))
    .map((usage) => usageView(usage, now));
}

/** A janela mais cheia entre as em alerta (para o chip da barra de cima); nenhuma = null. */
export function usageAlert(views: UsageView[]): { view: UsageView; window: UsageWindowView } | null {
  let best: { view: UsageView; window: UsageWindowView } | null = null;
  for (const view of views) {
    for (const window of view.windows) {
      // O chip/ponto só avisa do que é perigo de verdade (80%+, barrada ou crítica) e de leitura recente.
      if (window.tone !== "danger" || window.percent === null) continue;
      if (!best || TONE_RANK[window.tone] > TONE_RANK[best.window.tone] || (window.tone === best.window.tone && window.percent > (best.window.percent ?? 0))) {
        best = { view, window };
      }
    }
  }
  return best;
}

/** Texto do tooltip: uma linha por janela (com quando renova), quando atualizou e o aviso, se houver. */
export function usageTooltip(views: UsageView[]): string {
  return views
    .flatMap((view) => [
      ...view.windows.map((window) => `${view.providerLabel} · ${windowFullLabel(window)}: ${windowText(window)}${window.resetLabel ? ` — ${window.resetLabel}` : ""}`),
      ...(view.updatedLabel ? [`${view.providerLabel}: ${view.updatedLabel}`] : []),
      ...(view.stale ? [`${view.providerLabel}: ⚠ ${view.stale}`] : []),
    ])
    .join("\n");
}

/**
 * Renovação na forma curta, para a barra e a lista ("2 h 15 min", "3 d", "40 min"); a hora exata fica
 * na dica (resetLabel). Sem data válida ou já passada: "".
 */
export function shortReset(iso: string | undefined, now: number): string {
  if (!iso) return "";
  const at = Date.parse(iso);
  if (Number.isNaN(at) || at <= now) return "";
  return duration(Math.max(1, Math.round((at - now) / 60_000)));
}

/** A janela mais cheia do motor entre as com leitura (percent !== null); sem leitura, a primeira. */
export function tightestWindow(view: UsageView): UsageWindowView | undefined {
  let best: UsageWindowView | undefined;
  for (const window of view.windows) {
    if (window.percent === null) continue;
    if (!best || window.percent > (best.percent ?? 0)) best = window;
  }
  return best ?? view.windows[0];
}

/** Uma linha do bloco "Uso do plano" no menu: o motor e a janela mais apertada dele. */
export type PlanRow = {
  provider: UsageView["provider"];
  providerLabel: string;
  /** A janela mais apertada (ausente = sem nenhuma janela conhecida). */
  window?: UsageWindowView;
  /** 0..100 ou null (sem leitura / janela renovada). */
  percent: number | null;
  /** "91%", "renovada" ou "sem dados". */
  text: string;
  /** O que vai no lugar do número na linha do menu quando não é porcentagem (Freebuff: "4/21 h"). */
  valueText?: string;
  tone: UsageTone;
  /** A leitura tem mais de 30 min (ou a consulta da conta falha): número esmaecido, com o sinal. */
  old: boolean;
  /** Dica: a janela, quando renova e a idade do dado. */
  title: string;
};

export function planRows(views: UsageView[]): PlanRow[] {
  return views.map((view) => {
    const window = tightestWindow(view);
    const old = (window?.old ?? false) || view.stale !== undefined;
    const hours = view.freebuff;
    const text = hours ? hours.shortText : !window ? "sem dados" : window.percent !== null ? `${window.percent}%` : window.renewed ? "renovada" : "–";
    const title = [
      window ? `${view.providerLabel} · ${windowFullLabel(window)}: ${windowText(window)}${window.resetLabel ? ` — ${window.resetLabel}` : ""}` : `${view.providerLabel}: sem dados`,
      ...(view.updatedLabel ? [view.updatedLabel] : []),
      ...(view.stale ? [`⚠ ${view.stale}`] : []),
    ].join("\n");
    return {
      provider: view.provider,
      providerLabel: view.providerLabel,
      ...(window ? { window } : {}),
      percent: hours ? hours.percent : (window?.percent ?? null),
      text,
      ...(hours ? { valueText: hours.shortText } : {}),
      tone: hours ? hours.tone : (window?.tone ?? "ok"),
      old: hours ? hours.old : old,
      title: hours ? [`Freebuff · horas do dia: ${hours.shortText}${hours.resetLabel ? ` — ${hours.resetLabel}` : ""}`, ...hours.sessions.map((session) => `${session.agentName}: ${session.label}`), hours.estimated ? "Estimativa: o Cyno abriu horas depois da última leitura da tela." : hours.measuredLabel].filter(Boolean).join("\n") : title,
    };
  });
}

/** O ponto de alerta do menu recolhido: a pior cor entre os motores (ou "ok") e se algum dado é antigo. */
export function planSummary(views: UsageView[]): { tone: UsageTone; old: boolean; label: string } {
  const rows = planRows(views);
  const tone = worst(rows.map((row) => row.tone));
  const old = rows.some((row) => row.old);
  const label = `Uso do plano: ${rows.map((row) => `${row.providerLabel} ${row.text}`).join(", ")}${old ? " (dado antigo)" : ""}`;
  return { tone, old, label };
}

/**
 * A janela mais perto do limite entre todos os motores, para o destaque do topo do painel. Só conta o
 * que está de fato em atenção (50% ou mais, leitura recente): dado antigo nunca vira alarme.
 */
export function closestToLimit(views: UsageView[]): { view: UsageView; window: UsageWindowView } | null {
  let best: { view: UsageView; window: UsageWindowView } | null = null;
  for (const view of views) {
    for (const window of view.windows) {
      if (window.percent === null || window.tone === "ok") continue;
      if (!best || window.percent > (best.window.percent ?? 0)) best = { view, window };
    }
  }
  return best;
}

/**
 * Separa os grupos de modelos sem uso (todas as janelas em 0% com leitura recente) dos demais: o painel
 * mostra os sem uso numa linha só ("3 grupos sem uso"). Só vale para grupos com nome (o Antigravity);
 * a conta toda (grupo "") nunca some.
 */
export function splitIdleGroups(groups: UsageWindowGroup[]): { shown: UsageWindowGroup[]; idle: UsageWindowGroup[] } {
  const isIdle = (group: UsageWindowGroup) => group.group !== "" && group.windows.length > 0 && group.windows.every((window) => window.percent === 0 && !window.old);
  return { shown: groups.filter((group) => !isIdle(group)), idle: groups.filter(isIdle) };
}

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;

/**
 * Começo da sessão de 5 h do Claude (quando ela renova menos 5 h), para somar o uso por agente
 * "nesta sessão". Sem a janela (ou com data estranha): as últimas 5 h. Nunca no futuro.
 */
export function sessionWindowStart(usage: SubscriptionUsage | undefined, now: number): string {
  const window = usage?.windows.find((candidate) => candidate.id === "five_hour");
  const resets = window?.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;
  const start = Number.isNaN(resets) || resets <= now || resets - now > FIVE_HOURS_MS ? now - FIVE_HOURS_MS : resets - FIVE_HOURS_MS;
  return new Date(Math.min(start, now)).toISOString();
}

const compact = new Intl.NumberFormat("pt-BR", { notation: "compact", maximumFractionDigits: 1 });

/** "950", "12,3 mil", "1,2 mi". */
export function formatTokens(count: number): string {
  return compact.format(Math.max(0, Math.round(count)));
}

/** Uma linha do "Por agente" no detalhe do uso. */
export type AgentUsageRow = {
  agentId: string;
  name: string;
  /** Motor do agente (selo "Claude" / "Antigravity"). */
  provider: AgentUsageTally["provider"];
  providerLabel: string;
  /** Tokens que contam para o limite (entrada + saída + gravação no cache); null = a CLI não informa. */
  tokens: number | null;
  tokensLabel: string;
  turnsLabel: string;
  /** Custo em dólar que o próprio programa relatou (OpenClaw/Hermes com OpenRouter), se houve: informação, não alerta. */
  costLabel?: string;
  /** 0..100: tamanho da barra, relativo a quem mais gastou. */
  share: number;
  /** Detalhe para o tooltip: entrada, saída, cache e turnos. */
  detail: string;
};

/** Linhas do uso por agente (maior primeiro), com o nome atual de cada um ("Agente removido" se saiu do workspace). */
export function agentUsageRows(tallies: AgentUsageTally[], agents: Pick<Agent, "id" | "name">[]): AgentUsageRow[] {
  const names = new Map(agents.map((agent) => [agent.id, agent.name]));
  const weigh = (tally: AgentUsageTally) => (tally.measuredTurns > 0 ? tally.inputTokens + tally.outputTokens + tally.cacheCreationTokens : null);
  const max = Math.max(1, ...tallies.map((tally) => weigh(tally) ?? 0));
  return tallies
    .map((tally) => {
      const tokens = weigh(tally);
      const turnsLabel = `${tally.turns} ${tally.turns === 1 ? "turno" : "turnos"}`;
      const costLabel = tally.reportedCostUsd && tally.reportedCostUsd > 0 ? `US$ ${tally.reportedCostUsd.toLocaleString("pt-BR", { maximumFractionDigits: 4 })}` : undefined;
      const detail =
        tokens === null
          ? `${turnsLabel} · ${usageProviderLabel(tally.provider)} não informa tokens`
          : [
              `entrada ${formatTokens(tally.inputTokens)}`,
              `saída ${formatTokens(tally.outputTokens)}`,
              `cache: ${formatTokens(tally.cacheCreationTokens)} gravados, ${formatTokens(tally.cacheReadTokens)} lidos`,
              turnsLabel,
              ...(tally.estimatedTurns ? ["estimado: entrada lida do registro do chat, saída pelo tamanho do texto"] : []),
              ...(costLabel ? [`custo informado pelo programa ${costLabel}`] : []),
            ].join(" · ");
      return {
        agentId: tally.agentId,
        name: names.get(tally.agentId) ?? "Agente removido",
        provider: tally.provider,
        providerLabel: usageProviderLabel(tally.provider),
        tokens,
        tokensLabel: tokens === null ? "–" : `${tally.estimatedTurns ? "~" : ""}${formatTokens(tokens)}`,
        turnsLabel,
        ...(costLabel ? { costLabel } : {}),
        share: tokens === null ? 0 : Math.round((tokens / max) * 100),
        detail,
      };
    })
    .sort((a, b) => (b.tokens ?? -1) - (a.tokens ?? -1) || a.name.localeCompare(b.name, "pt-BR"));
}
