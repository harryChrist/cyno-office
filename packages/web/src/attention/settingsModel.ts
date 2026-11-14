import { doNotDisturbActive, untilTomorrow, workspaceMuted, type AttentionPrefs } from "@cyno/shared";

/** As escolhas de duração do silêncio (por workspace e do "não perturbe"). */
export const SILENCE_CHOICES = [
  { id: "off", label: "Avisando" },
  { id: "1h", label: "Silenciar por 1 hora" },
  { id: "tomorrow", label: "Silenciar até amanhã" },
  { id: "always", label: "Silenciar sempre" },
] as const;
export type SilenceChoice = (typeof SILENCE_CHOICES)[number]["id"];

const HOUR_MS = 3_600_000;

/** Até quando vale a escolha (ISO); `always` e `off` não têm prazo. */
export function silenceUntil(choice: Exclude<SilenceChoice, "off" | "always">, now: number): string {
  return choice === "1h" ? new Date(now + HOUR_MS).toISOString() : untilTomorrow(now);
}

/** O que o workspace está agora: "off" (avisando), "always" ou "until" (com prazo, ainda valendo). */
export function muteState(prefs: AttentionPrefs, workspaceId: string, now: number): { state: "off" | "always" | "until"; until?: string } {
  if (!workspaceMuted(prefs, workspaceId, now)) return { state: "off" };
  const until = prefs.mutedWorkspaces[workspaceId]?.until;
  return until ? { state: "until", until } : { state: "always" };
}

/** O mapa de workspaces silenciados depois da escolha (tira os prazos que já passaram, para o arquivo não crescer). */
export function withMute(muted: AttentionPrefs["mutedWorkspaces"], workspaceId: string, choice: SilenceChoice, now: number): AttentionPrefs["mutedWorkspaces"] {
  const next: AttentionPrefs["mutedWorkspaces"] = {};
  for (const [id, entry] of Object.entries(muted)) {
    if (id === workspaceId) continue;
    if (entry.until && Date.parse(entry.until) <= now) continue;
    next[id] = entry;
  }
  if (choice === "always") next[workspaceId] = {};
  else if (choice !== "off") next[workspaceId] = { until: silenceUntil(choice, now) };
  return next;
}

/** O "não perturbe" que o botão pede: o ISO do fim, ou null para desligar. */
export function dndChoice(choice: "off" | "1h" | "tomorrow", now: number): string | null {
  return choice === "off" ? null : silenceUntil(choice, now);
}

/** Texto do estado do "não perturbe". */
export function dndText(prefs: AttentionPrefs, now: number, clock: (iso: string) => string): string {
  return doNotDisturbActive(prefs, now) && prefs.dndUntil ? `Ligado até ${clock(prefs.dndUntil)}` : "Desligado";
}

/** "15:30" (ou "amanhã 00:00"), no horário de São Paulo. */
export function clockLabel(iso: string, now: number): string {
  const zone = "America/Sao_Paulo";
  const when = new Date(iso);
  const time = new Intl.DateTimeFormat("pt-BR", { timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(when);
  const day = (date: Date) => new Intl.DateTimeFormat("pt-BR", { timeZone: zone, day: "2-digit", month: "2-digit" }).format(date);
  return day(when) === day(new Date(now)) ? time : `${day(when)} ${time}`;
}
