import { freebuffCostText, freebuffWalletState, openFreebuffSessions, USAGE_STALE_MS, usageAgeLabel, type FreebuffUsageDetail, type SubscriptionUsage, type UsageTone } from "@cyno/shared";

/**
 * O Freebuff no "Uso do plano": a cota dele é em HORAS, não em janelas de tokens. Aqui as horas do dia
 * (o que a tela do Freebuff disse = medido; o que o Cyno abriu depois = estimado) e uma linha por agente com
 * a hora aberta ("hora em uso: restam 37 min"). Função pura (o painel e o menu só desenham).
 */

export type FreebuffHourRow = {
  key: string;
  agentId: string;
  agentName: string;
  minutesLeft: number;
  /** 0..100: quanto da hora já passou (a barra enche até o fim da hora). */
  elapsedPercent: number;
  /** "hora em uso: restam 37 min". */
  label: string;
  /** "até 15:42". */
  untilLabel: string;
  /** "DeepSeek V4.1 Flash · gasta 2 h". */
  modelLabel: string;
  /** O processo do Freebuff está vivo (falso depois de um reinício do servidor, até reassumir). */
  hasProcess: boolean;
  /** O fim da hora foi lido do arquivo do Freebuff (medido) ou é abertura + 60 min (estimado). */
  measured: boolean;
};

export type FreebuffUsageView = {
  /** Horas usadas hoje (total - restante), com no máximo 1 casa; ausente = o total do dia ainda não foi lido. */
  used?: number;
  total?: number;
  remaining?: number;
  wallet?: number;
  /** A cota do dia acabou e o Freebuff já gasta da carteira. */
  usingWallet: boolean;
  /** 0..100 das horas do dia usadas; null = total desconhecido. */
  percent: number | null;
  tone: UsageTone;
  /** "4/21 h" (ou "1 hora aberta" / "sem leitura"): o valor curto da linha do menu. */
  shortText: string;
  /** "renova em 8 h 30 min (às 00:00)". */
  resetLabel: string;
  /** "lido na tela do Freebuff há 12 min" (medido). */
  measuredLabel: string;
  /** A leitura da tela tem mais de 30 min: o número aparece esmaecido. */
  old: boolean;
  /** O Cyno abriu horas depois da última leitura: o restante é estimativa. */
  estimated: boolean;
  openedSince: number;
  sessions: FreebuffHourRow[];
  /** Agentes com pedido que ainda estão abrindo a hora. */
  pending: string[];
  /** "DeepSeek V4.1 Flash · high · gasta 2 horas por hora aberta". */
  modelLine: string;
  maxOpenHours: number;
};

const pad = (n: number) => String(n).padStart(2, "0");
const clock = (iso: string) => {
  const at = new Date(iso);
  return `${pad(at.getHours())}:${pad(at.getMinutes())}`;
};
const hoursText = (hours: number) => `${Math.round(hours * 10) / 10}`.replace(".", ",");

function duration(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h${minutes % 60 ? ` ${minutes % 60} min` : ""}`;
}

export function hasFreebuffContent(detail: FreebuffUsageDetail | undefined): boolean {
  return detail !== undefined && (detail.hours.total !== undefined || detail.sessions.length > 0 || (detail.pending?.length ?? 0) > 0 || detail.hours.openedSince > 0);
}

export function freebuffUsageView(usage: SubscriptionUsage | undefined, now: number): FreebuffUsageView | undefined {
  const detail = usage?.freebuff;
  if (!detail || !hasFreebuffContent(detail)) return undefined;
  const { total, remaining, wallet, resetsAt, measuredAt, openedSince } = detail.hours;
  const used = total !== undefined && remaining !== undefined ? Math.max(0, Math.round((total - remaining) * 10) / 10) : undefined;
  const percent = total !== undefined && total > 0 && used !== undefined ? Math.round(Math.min(1, used / total) * 100) : null;
  const tone: UsageTone = percent === null ? "ok" : percent >= 80 ? "danger" : percent >= 50 ? "warn" : "ok";
  const measuredMs = measuredAt ? Date.parse(measuredAt) : Number.NaN;
  const old = !Number.isNaN(measuredMs) && now - measuredMs > USAGE_STALE_MS;
  const open = openFreebuffSessions(detail, now);
  const sessions: FreebuffHourRow[] = open
    .map((session) => {
      const endsMs = Date.parse(session.endsAt);
      const minutesLeft = Math.max(0, Math.ceil((endsMs - now) / 60_000));
      const total60 = 60 * 60_000;
      return {
        key: `${session.workspaceId}/${session.agentId}`,
        agentId: session.agentId,
        agentName: session.agentName ?? session.agentId,
        minutesLeft,
        elapsedPercent: Math.round(Math.min(1, Math.max(0, 1 - (endsMs - now) / total60)) * 100),
        label: `hora em uso: restam ${duration(minutesLeft)}`,
        untilLabel: `até ${clock(session.endsAt)}`,
        modelLabel: `${session.model} · gasta ${hoursText(session.multiplier)} h`,
        hasProcess: session.hasProcess,
        measured: session.endsAtSource === "measured",
      };
    })
    .sort((a, b) => a.minutesLeft - b.minutesLeft);
  const resetMs = resetsAt ? Date.parse(resetsAt) : Number.NaN;
  const resetLabel = !Number.isNaN(resetMs) && resetMs > now ? `renova em ${duration(Math.max(1, Math.round((resetMs - now) / 60_000)))} (às ${clock(resetsAt!)})` : "";
  const shortText = total !== undefined && used !== undefined ? `${hoursText(used)}/${hoursText(total)} h` : sessions.length > 0 ? (sessions.length === 1 ? "1 hora aberta" : `${sessions.length} horas abertas`) : "sem leitura";
  const modelLine = `${detail.settings.model} · ${detail.settings.effort} · gasta ${freebuffCostText(detail.settings.multiplier ?? 1)}`;
  return {
    ...(used !== undefined ? { used } : {}),
    ...(total !== undefined ? { total } : {}),
    ...(remaining !== undefined ? { remaining } : {}),
    ...(wallet !== undefined ? { wallet } : {}),
    usingWallet: freebuffWalletState(detail, now).usingWallet,
    percent,
    tone,
    shortText,
    resetLabel,
    measuredLabel: Number.isNaN(measuredMs) ? "" : `lido na tela do Freebuff ${usageAgeLabel(Math.max(0, Math.floor((now - measuredMs) / 60_000)))}`,
    old,
    estimated: openedSince > 0,
    openedSince,
    sessions,
    pending: (detail.pending ?? []).map((candidate) => candidate.agentName ?? candidate.agentId),
    modelLine,
    maxOpenHours: detail.settings.maxOpenHours,
  };
}
